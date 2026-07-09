// =============================================================================
// routes/apps.js - 앱 관련 비즈니스 로직 핸들러
// =============================================================================
// 역할:
//   앱 생명주기 관련 모든 엔드포인트의 로직을 프레임워크 독립적인 함수로 제공한다.
//   장시간 작업(create/deploy/delete/start/stop)은 즉시 { jobId, ... }를 반환하고
//   백그라운드에서 비동기 실행한다. 짧은 작업(logs/exec/env 읽기)은 동기 처리한다.
//   HTTP 어댑터(Next.js Route Handler)가 인증/권한 확인 후 이 함수들을 호출하고,
//   반환값을 { ok: true, data } 로 감싼다.
// =============================================================================
"use strict";

const fs   = require("node:fs");
const path = require("node:path");
const { ROLE_ADMIN } = require("../authService");
const { AppError, normalizeBoolean } = require("../utils");
const { config, RUNNER_SCRIPTS } = require("../config");
const {
  validateAppParams,
  assertUserId,
  assertAppName,
  buildAppInfo,
  ensureAppExists,
  findDockerApp,
  normalizeStatus,
  listDockerApps,
  getDockerContainerStatus,
  runRunnerScript,
  runDockerCompose,
  patchComposeEnvFile,
  readEnvFile,
  writeEnvFile,
  getComposeLogs,
  runContainerExec,
  runContainerComplete,
} = require("../appManager");
const jobStore = require("../jobStore");

// .paas-meta.json에서 installationId를 읽는다. 파일 없거나 파싱 실패 시 빈 문자열 반환.
function readMetaInstallationId(userid, appname) {
  try {
    const metaPath = path.join(config.PAAS_APPS_DIR, userid, appname, ".paas-meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return String(meta.installationId || "");
  } catch {
    return "";
  }
}

// ── 요청 컨텍스트 파싱 ───────────────────────────────────────────────────────

// 앱 생성 요청 바디에서 필요한 필드를 추출하고 검증한다.
function validateCreateBody(body) {
  if (!body || typeof body !== "object") {
    throw new AppError(400, "Request body is required");
  }
  const appname    = String(body.appname    || "").trim();
  const repoUrl    = String(body.repoUrl    || "").trim();
  const branch     = String(body.branch     || "main").trim() || "main";
  const usePrivate = body.usePrivate === true;

  assertAppName(appname);

  if (!repoUrl) {
    throw new AppError(400, "repoUrl is required");
  }
  if (!/^https?:\/\//.test(repoUrl)) {
    throw new AppError(400, "repoUrl must start with http:// or https://");
  }

  return { appname, repoUrl, branch, usePrivate };
}

// 로그인된 사용자의 userid를 auth에서 추출한다.
function resolveRequestUserId(auth) {
  const userid = String(auth?.user?.username || "").trim().toLowerCase();
  if (!userid) throw new AppError(401, "Unauthorized");
  assertUserId(userid);
  return userid;
}

// URL 파라미터(userid, appname)를 검증하고 접근 권한을 확인한다.
async function resolveAppRequestContext(auth, params) {
  const userid  = String(params?.userid  || "").trim();
  const appname = String(params?.appname || "").trim();
  validateAppParams(userid, appname);

  const user = auth?.user;
  if (user?.role !== ROLE_ADMIN && user?.username !== userid) {
    throw new AppError(403, "Forbidden");
  }

  const appDir = await ensureAppExists(userid, appname);
  return { userid, appname, appDir };
}

// 비동기 job을 생성하고 즉시 반환할 데이터를 만드는 공통 헬퍼.
// 실제 job 실행은 setImmediate로 넘겨 응답을 블로킹하지 않는다.
function dispatchJob(type, meta, userid, extraData = {}) {
  const jobId = jobStore.createJob(type, meta, userid);
  setImmediate(() => executeJob(jobStore.getJob(jobId)));
  return { jobId, ...extraData };
}

// ── 공용 job 실행 함수 (재시도에도 재사용) ───────────────────────────────────

/**
 * job 객체를 받아 type에 따라 적절한 작업을 실행한다.
 * jobStore.recoverOnStartup() 및 /jobs/:id/retry 엔드포인트에서도 호출된다.
 */
async function executeJob(job) {
  const { id, type, meta } = job;
  const onLog = (line) => jobStore.appendLog(id, line);

  jobStore.startJob(id);
  try {
    switch (type) {
      case "create": {
        const { userid, appname, repoUrl, branch, installationId } = meta;
        const env = {};
        if (installationId && _githubService) {
          // 매 실행 시 fresh installation token을 발급해 env로만 전달 (askpass가 소비)
          env.GIT_TOKEN = await _githubService.getCloneToken(installationId);
          // create.sh가 .paas-meta.json에 기록하도록 비밀 아닌 installationId를 전달
          env.PAAS_INSTALLATION_ID = installationId;
        }
        await runRunnerScript(RUNNER_SCRIPTS.create, [userid, appname, repoUrl, branch], { onLog, env });
        const appInfo = await buildAppInfo(userid, appname, null);
        jobStore.finishJob(id, JSON.stringify({ app: appInfo }));
        break;
      }
      case "deploy": {
        const { userid, appname } = meta;
        const env = {};
        const installationId = readMetaInstallationId(userid, appname);
        if (installationId && _githubService) {
          env.GIT_TOKEN = await _githubService.getCloneToken(installationId);
        }
        await runRunnerScript(RUNNER_SCRIPTS.deploy, [userid, appname], { onLog, env });
        if (_onAppDeployedHook) {
          const deployed = await findDockerApp(userid, appname);
          const port = Number(deployed?.port) || 5000;
          _onAppDeployedHook(userid, appname, port);
        }
        jobStore.finishJob(id, "deployed");
        break;
      }
      case "delete": {
        const { userid, appname, keepData } = meta;
        const args = [userid, appname];
        if (keepData) args.push("--keep-data");
        await runRunnerScript(RUNNER_SCRIPTS.delete, args, { onLog });
        if (_onAppDeletedHook) _onAppDeletedHook(userid, appname);
        jobStore.finishJob(id, "deleted");
        break;
      }
      case "start": {
        const { appDir } = meta;
        await runDockerCompose(appDir, ["up", "-d"]);
        const status = await getDockerContainerStatus(appDir);
        jobStore.finishJob(id, JSON.stringify({ status: normalizeStatus(status) }));
        break;
      }
      case "stop": {
        const { appDir } = meta;
        await runDockerCompose(appDir, ["stop"]);
        jobStore.finishJob(id, "stopped");
        break;
      }
      case "env-restart": {
        const { appDir } = meta;
        await runDockerCompose(appDir, ["up", "-d", "--force-recreate"]);
        jobStore.finishJob(id, "restarted");
        break;
      }
      default:
        throw new AppError(500, `Unknown job type: ${type}`);
    }
  } catch (error) {
    const message = error instanceof AppError
      ? error.message
      : (error.message || "Unknown error");
    jobStore.failJob(id, message);
  }
}

// executeJob을 jobs 모듈에 주입 (재시도 기능을 위해)
const jobsHandlers = require("./jobs");
jobsHandlers.setExecuteJobFn(executeJob);

// ── 앱 이벤트 훅 ─────────────────────────────────────────────────────────────
// runtime.js에서 domainManager 의존성을 순환 없이 주입하기 위한 훅 패턴
// (jobs.js의 setExecuteJobFn 패턴과 동일)

let _onAppDeletedHook = null;
let _onAppDeployedHook = null;
let _listActiveDomainsForApp = null;
let _githubService = null;

function setOnAppDeletedHook(fn) { _onAppDeletedHook = fn; }
function setOnAppDeployedHook(fn) { _onAppDeployedHook = fn; }
function setListActiveDomainsForApp(fn) { _listActiveDomainsForApp = fn; }
function setGithubService(svc) { _githubService = svc; }

// ── 앱 CRUD ───────────────────────────────────────────────────────────────────

// 앱 생성 (비동기 job) — 202 상태로 { jobId }를 반환할 데이터를 만든다.
async function createApp({ auth, body }) {
  const userid = resolveRequestUserId(auth);
  const { appname, repoUrl, branch, usePrivate } = validateCreateBody(body);

  // private 저장소 의도인 경우, 본인 GitHub 설치에서 installationId를 조회한다.
  let installationId = "";
  if (usePrivate) {
    if (!_githubService) throw new AppError(503, "GitHub 연동이 비활성화되어 있습니다.");
    installationId = String(_githubService.getInstallationId(auth.user.id) || "");
    if (!installationId) throw new AppError(400, "GitHub가 연결되어 있지 않습니다.");
  }

  const { apps: existingApps } = await listDockerApps();
  if (existingApps.length >= config.MAX_TOTAL_APPS) {
    throw new AppError(429, `MAX_TOTAL_APPS exceeded (${config.MAX_TOTAL_APPS})`);
  }
  const userAppCount = existingApps.filter((item) => item.userid === userid).length;
  if (userAppCount >= config.MAX_APPS_PER_USER) {
    throw new AppError(429, `MAX_APPS_PER_USER exceeded (${config.MAX_APPS_PER_USER})`);
  }

  return dispatchJob("create", { userid, appname, repoUrl, branch, installationId }, userid);
}

// 앱 목록 조회 (기본: 본인 앱, ?all=true & admin: 전체 앱 조회)
async function listApps({ auth, query }) {
  const { apps: dockerApps, hasLabelErrors } = await listDockerApps();
  const user = auth?.user;
  const fetchAll = query?.all === "true" && user?.role === ROLE_ADMIN;

  // fetchAll이 true이면 전체 앱을 보이고, 아니면 본인 앱만 필터링한다.
  const visibleApps = fetchAll
    ? dockerApps
    : dockerApps.filter((item) => String(item.userid).toLowerCase() === String(user?.username || "").toLowerCase());

  const appDetails = await Promise.all(
    visibleApps.map((appItem) => buildAppInfo(appItem.userid, appItem.appname, appItem))
  );

  const apps = appDetails
    .filter(Boolean)
    .sort((a, b) => {
      const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
      if (aTime !== bTime) return bTime - aTime;
      return `${a.userid}/${a.appname}`.localeCompare(`${b.userid}/${b.appname}`);
    });

  if (_listActiveDomainsForApp) {
    for (const app of apps) {
      app.activeCustomDomains = _listActiveDomainsForApp(app.userid, app.appname);
    }
  }

  return { apps, total: apps.length, hasLabelErrors };
}

// 단일 앱 정보 조회
async function getApp({ auth, params }) {
  const { userid, appname } = await resolveAppRequestContext(auth, params);
  const appInfo = await buildAppInfo(userid, appname, null);
  return { app: appInfo };
}

// ── 앱 생명주기 제어 ──────────────────────────────────────────────────────────

// docker compose up -d (비동기 job)
async function startApp({ auth, params }) {
  const { userid, appname, appDir } = await resolveAppRequestContext(auth, params);
  return dispatchJob("start", { userid, appname, appDir }, userid);
}

// docker compose stop (비동기 job)
async function stopApp({ auth, params }) {
  const { userid, appname, appDir } = await resolveAppRequestContext(auth, params);
  return dispatchJob("stop", { userid, appname, appDir }, userid);
}

// deploy.sh (비동기 job)
async function deployApp({ auth, params }) {
  const { userid, appname } = await resolveAppRequestContext(auth, params);
  return dispatchJob("deploy", { userid, appname }, userid);
}

// delete.sh (비동기 job)
async function deleteApp({ auth, params, body }) {
  const { userid, appname } = await resolveAppRequestContext(auth, params);
  const keepData = normalizeBoolean(body?.keepData, false);
  return dispatchJob("delete", { userid, appname, keepData }, userid);
}

// ── 로그 ──────────────────────────────────────────────────────────────────────

// docker compose logs (동기, 멀티 컨테이너 지원)
async function getLogs({ auth, params, query }) {
  const { appDir } = await resolveAppRequestContext(auth, params);
  const requestedLines = Number.parseInt(String(query?.lines || "120"), 10);
  const lines = Number.isFinite(requestedLines) ? Math.max(1, Math.min(1000, requestedLines)) : 120;

  const logs = await getComposeLogs(appDir, lines);
  return { lines, logs };
}

// ── Exec ──────────────────────────────────────────────────────────────────────

// 컨테이너 내부에서 임의 명령 실행
async function execCommand({ auth, params, body }) {
  const { userid, appname } = await resolveAppRequestContext(auth, params);

  const command = String(body?.command || "").trim();
  if (!command) throw new AppError(400, "command is required");
  if (command.length > 2048) throw new AppError(400, "command too long (max 2048 chars)");

  const cwd = String(body?.cwd || "").trim();

  const app = await findDockerApp(userid, appname);
  if (!app?.containerName) throw new AppError(404, "Container not found for this app");

  const { stdout, stderr } = await runContainerExec(app.containerName, command, cwd);
  return { command, output: stdout, stderr };
}

// 탭 완성
async function execComplete({ auth, params, body }) {
  const { userid, appname } = await resolveAppRequestContext(auth, params);

  const partial = String(body?.partial ?? "");
  if (partial.length > 512) throw new AppError(400, "partial too long (max 512 chars)");

  const cwd = String(body?.cwd || "").trim();

  const app = await findDockerApp(userid, appname);
  if (!app?.containerName) throw new AppError(404, "Container not found for this app");

  const completions = await runContainerComplete(app.containerName, partial, cwd);
  return { completions };
}

// ── 환경변수 ──────────────────────────────────────────────────────────────────

// .env.paas 파일 내용 조회
async function getEnv({ auth, params }) {
  const { appDir } = await resolveAppRequestContext(auth, params);
  const env = await readEnvFile(appDir);
  return { env };
}

// .env.paas 파일 저장 후 컨테이너 재시작 (비동기 job)
async function putEnv({ auth, params, body }) {
  const { userid, appname, appDir } = await resolveAppRequestContext(auth, params);
  const content = String(body?.env || "");

  await patchComposeEnvFile(appDir);
  await writeEnvFile(appDir, content);

  return dispatchJob("env-restart", { userid, appname, appDir }, userid, { saved: true });
}

module.exports = {
  createApp,
  listApps,
  getApp,
  startApp,
  stopApp,
  deployApp,
  deleteApp,
  getLogs,
  execCommand,
  execComplete,
  getEnv,
  putEnv,
  executeJob,
  setOnAppDeletedHook,
  setOnAppDeployedHook,
  setListActiveDomainsForApp,
  setGithubService,
};
