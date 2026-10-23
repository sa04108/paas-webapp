// =============================================================================
// routes/apps.js - /apps 라우트 핸들러
// =============================================================================
// 역할:
//   앱 생명주기 관련 모든 HTTP 엔드포인트를 제공한다.
//   장시간 작업(create/deploy/delete/start/stop)은 즉시 202 + jobId를 반환하고
//   백그라운드에서 비동기 실행한다. 짧은 작업(logs/exec/env 읽기)은 동기 처리한다.
//   인증/권한 미들웨어는 server.js에서 이 라우터 앞에 적용된다.
// =============================================================================
"use strict";

const fs   = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const express = require("express");
const { ROLE_ADMIN } = require("../authService");
const { AppError, normalizeBoolean, sendOk } = require("../utils");
const { config, IS_DEV, RUNNER_SCRIPTS } = require("../config");
const {
  validateAppParams,
  assertUserId,
  assertAppName,
  buildAppInfo,
  ensureAppExists,
  findDockerApp,
  findDockerService,
  waitForServices,
  getAppDir,
  readAppMeta,
  dockerAppsCache,
  normalizeStatus,
  listDockerApps,
  getDockerContainerStatus,
  runRunnerScript,
  runDockerCompose,
  patchComposeEnvFile,
  readEnvFile,
  writeEnvFile,
  runContainerExec,
  runContainerComplete,
} = require("../appManager");
const jobStore = require("../jobStore");
const { normalizeBuildConfig, saveAppMetadata } = require("../../scripts/lib/build-config");
const { listRootDockerfiles } = require("../repositoryFiles");
const { normalizeCreateEnv } = require("../appEnvironment");
const appReadiness = require("../appReadiness");
const { normalizeRuntime } = require("../composeConfig");
const { withDeploymentBaseline, deploymentStatus } = require("../../scripts/lib/deployment-config");
const { confirmDeployment } = require("../../scripts/lib/compose-project");
const { AppLogSession, parseLogOptions } = require("../appLogs");

const router = express.Router();

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

// POST /apps 요청 바디에서 앱 생성에 필요한 필드를 추출하고 검증한다.
function validateCreateBody(body) {
  if (!body || typeof body !== "object") {
    throw new AppError(400, "Request body is required");
  }
  const appname    = String(body.appname    || "").trim().toLowerCase();
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

  let build;
  try {
    build = normalizeBuildConfig(body.build);
  } catch (error) {
    throw new AppError(400, error.message);
  }
  const env = normalizeCreateEnv(body.env);
  let runtime;
  try { runtime = normalizeRuntime(body.runtime); }
  catch (error) { throw new AppError(400, error.message); }
  return { appname, repoUrl, branch, usePrivate, build, runtime, env };
}

// 로그인된 사용자의 userid를 req.auth에서 추출한다.
function resolveRequestUserId(req) {
  const userid = String(req.auth?.user?.username || "").trim().toLowerCase();
  if (!userid) throw new AppError(401, "Unauthorized");
  assertUserId(userid);
  return userid;
}

// URL 파라미터(:userid, :appname)를 검증하고 접근 권한을 확인한다.
async function resolveAppRequestContext(req) {
  const userid  = String(req.params?.userid  || "").trim().toLowerCase();
  const appname = String(req.params?.appname || "").trim().toLowerCase();
  validateAppParams(userid, appname);

  const user = req.auth?.user;
  if (user?.role !== ROLE_ADMIN && user?.username !== userid) {
    throw new AppError(403, "Forbidden");
  }

  const appDir = await ensureAppExists(userid, appname);
  return { userid, appname, appDir };
}

// 비동기 job 생성을 담당하고 즉시 202 응답을 반환하는 공통 헬퍼
function dispatchJob(res, type, meta, userid, extraData = {}, privateInput = {}) {
  const metadata = JSON.parse(fs.readFileSync(path.join(getAppDir(meta.userid, meta.appname), ".paas-meta.json"), "utf8"));
  const jobId = jobStore.createJob(type, { ...meta, instanceId: metadata.instanceId }, userid, privateInput);
  res.status(202).json({ ok: true, data: { jobId, ...extraData } });
  setImmediate(() => executeJob(jobStore.getJob(jobId)));
}

// ── 공용 job 실행 함수 (재시도에도 재사용) ───────────────────────────────────

const appJobQueues = new Map();

// 설정 저장도 배포와 같은 큐를 사용해 최신 메타데이터에 변경 사항을 반영한다.
async function withAppQueue(userid, appname, action) {
  const key = `${userid}/${appname}`.toLowerCase();
  const previous = appJobQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  appJobQueues.set(key, current);
  try {
    return await current;
  } finally {
    if (appJobQueues.get(key) === current) appJobQueues.delete(key);
  }
}

/**
 * job 객체를 받아 type에 따라 적절한 작업을 실행한다.
 * jobStore.recoverOnStartup() 및 /jobs/:id/retry 엔드포인트에서도 호출된다.
 */
// 같은 앱의 생명주기 작업은 순서대로 실행해 소스와 빌드 설정의 교체가 겹치지 않게 한다.
async function executeJob(job) {
  return withAppQueue(job.meta.userid, job.meta.appname, () => runJob(job));
}

async function runJob(job) {
  const { id, type, meta } = job;
  const onLog = (line) => jobStore.appendLog(id, line);

  jobStore.startJob(id);
  const requiresReadiness = ["create", "deploy", "start", "env-restart"].includes(type);
  const readinessGeneration = randomUUID();
  try {
    const appDir = getAppDir(meta.userid, meta.appname);
    const metadata = await readAppMeta(appDir);
    if (!metadata?.instanceId || metadata.instanceId !== meta.instanceId) throw new AppError(409, "This job belongs to a different app creation");
    const projectState = await fs.promises.readFile(path.join(appDir, ".paas-project.json"), "utf8").then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
    if (type !== "delete" && ["deleting", "delete-failed"].includes(projectState?.phase)) throw new AppError(409, "Finish deleting this app before starting another operation");
    saveAppMetadata(path.join(appDir, ".paas-meta.json"), { ...metadata, lastJobId: id }, metadata.build);
    if (requiresReadiness) appReadiness.begin(meta.userid, meta.appname, readinessGeneration);
    switch (type) {
      case "create": {
        const { userid, appname, repoUrl, branch, installationId, build, runtime } = meta;
        const env = { PAAS_DEFER_CONFIG_CONFIRMATION: "1" };
        const initialEnv = jobStore.getJobEnvironment(id);
        if (initialEnv !== undefined) {
          const appDir = path.join(config.PAAS_APPS_DIR, userid, appname);
          await fs.promises.mkdir(appDir, { recursive: true });
          await writeEnvFile(appDir, initialEnv);
        }
        if (installationId && _githubService) {
          // 매 실행 시 fresh installation token을 발급해 env로만 전달 (askpass가 소비)
          env.GIT_TOKEN = await _githubService.getCloneToken(installationId);
          // create.sh가 .paas-meta.json에 기록하도록 비밀 아닌 installationId를 전달
          env.PAAS_INSTALLATION_ID = installationId;
        }
        // 긴 빌드 설정을 환경변수나 인자 대신 권한이 제한된 임시 파일로 전달한다.
        const inputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "paas-build-"));
        try {
          const inputPath = path.join(inputDir, "build.json");
          await fs.promises.writeFile(inputPath, JSON.stringify(normalizeBuildConfig(build)), { mode: 0o600 });
          env.PAAS_BUILD_CONFIG_PATH = inputPath;
          const runtimePath = path.join(inputDir, "runtime.json");
          await fs.promises.writeFile(runtimePath, JSON.stringify(normalizeRuntime(runtime)), { mode: 0o600 });
          env.PAAS_RUNTIME_CONFIG_PATH = runtimePath;
          await runRunnerScript(RUNNER_SCRIPTS.create, [userid, appname, repoUrl, branch], { onLog, env });
        } finally {
          await fs.promises.rm(inputDir, { recursive: true, force: true });
        }
        await appReadiness.waitUntilReady(userid, appname, readinessGeneration, onLog);
        confirmDeployment(userid, appname);
        const appInfo = await buildAppInfo(userid, appname, null);
        jobStore.finishJob(id, JSON.stringify({ app: appInfo }));
        break;
      }
      case "deploy": {
        const { userid, appname } = meta;
        const env = { PAAS_DEFER_CONFIG_CONFIRMATION: "1" };
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
        await appReadiness.waitUntilReady(userid, appname, readinessGeneration, onLog);
        confirmDeployment(userid, appname);
        jobStore.finishJob(id, "deployed");
        break;
      }
      case "delete": {
        const { userid, appname, keepData } = meta;
        const args = [userid, appname];
        if (keepData) args.push("--keep-data");
        await runRunnerScript(RUNNER_SCRIPTS.delete, args, { onLog });
        appReadiness.remove(userid, appname);
        if (_onAppDeletedHook) _onAppDeletedHook(userid, appname);
        jobStore.finishJob(id, "deleted");
        break;
      }
      case "start": {
        const { userid, appname, appDir } = meta;
        const result = await runDockerCompose(appDir, ["up", "-d"]);
        await waitForServices(userid, appname, onLog);
        await appReadiness.waitUntilReady(userid, appname, readinessGeneration, onLog);
        const status = await getDockerContainerStatus(appDir);
        jobStore.finishJob(id, JSON.stringify({ status: normalizeStatus(status) }));
        break;
      }
      case "stop": {
        const { appDir } = meta;
        await runDockerCompose(appDir, ["stop"]);
        appReadiness.remove(meta.userid, meta.appname);
        jobStore.finishJob(id, "stopped");
        break;
      }
      case "env-restart": {
        const { userid, appname, appDir } = meta;
        await runDockerCompose(appDir, ["up", "-d", "--force-recreate"]);
        await waitForServices(userid, appname, onLog);
        await appReadiness.waitUntilReady(userid, appname, readinessGeneration, onLog);
        jobStore.finishJob(id, "restarted");
        break;
      }
      default:
        throw new AppError(500, `Unknown job type: ${type}`);
    }
  } catch (error) {
    if (requiresReadiness) appReadiness.fail(meta.userid, meta.appname, readinessGeneration);
    const message = error instanceof AppError
      ? error.message
      : (error.message || "Unknown error");
    jobStore.failJob(id, message);
  }
}

// executeJob을 jobs 라우터에 주입 (재시도 기능을 위해)
const jobsRouter = require("./jobs");
jobsRouter.setExecuteJobFn(executeJob);
jobsRouter.setCleanupJobFn((job) => withAppQueue(job.meta.userid, job.meta.appname, async () => {
  const metadata = await readAppMeta(getAppDir(job.meta.userid, job.meta.appname));
  // 다른 배포가 소유권을 이어받았거나 앱이 재생성됐다면 이전 작업만 정리한다.
  if (!metadata || metadata.instanceId !== job.meta.instanceId || metadata.lastJobId !== job.id) return;
  await runRunnerScript(RUNNER_SCRIPTS.delete, [job.meta.userid, job.meta.appname]);
  appReadiness.remove(job.meta.userid, job.meta.appname);
}));

// ── 앱 이벤트 훅 ─────────────────────────────────────────────────────────────
// server.js에서 domainManager 의존성을 순환 없이 주입하기 위한 훅 패턴
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

// POST /apps/dockerfiles — 선택한 브랜치의 GitHub 루트 파일만 조회한다.
router.post("/dockerfiles", async (req, res, next) => {
  try {
    resolveRequestUserId(req);
    const { repoUrl, branch = "main", usePrivate } = req.body || {};
    if (typeof repoUrl !== "string") throw new AppError(400, "repoUrl is required");
    let token = "";
    if (usePrivate === true) {
      if (!_githubService) throw new AppError(503, "GitHub integration is disabled.");
      const installationId = _githubService.getInstallationId(req.auth.user.id);
      if (!installationId) throw new AppError(400, "GitHub is not connected.");
      token = await _githubService.getCloneToken(installationId);
    }
    return sendOk(res, await listRootDockerfiles(repoUrl, branch, token));
  } catch (error) {
    return next(error);
  }
});

// POST /apps — 앱 생성 (비동기 job)
let creationQueue = Promise.resolve();

router.post("/", async (req, res, next) => {
  try {
    const userid = resolveRequestUserId(req);
    const { appname, repoUrl, branch, usePrivate, build, runtime, env } = validateCreateBody(req.body);

    // private 저장소 의도인 경우, 본인 GitHub 설치에서 installationId를 조회한다.
    let installationId = "";
    if (usePrivate) {
      if (!_githubService) throw new AppError(503, "GitHub integration is disabled.");
      installationId = String(_githubService.getInstallationId(req.auth.user.id) || "");
      if (!installationId) throw new AppError(400, "GitHub is not connected.");
    }

    const reserve = creationQueue.catch(() => {}).then(async () => {
      dockerAppsCache.ts = 0;
      const { apps: existingApps, dockerAvailable } = await listDockerApps();
      if (dockerAvailable === false) throw new AppError(503, "Docker is unavailable");
      if (existingApps.some((item) => item.userid === userid && item.appname === appname)) throw new AppError(409, "App already exists");
      if (existingApps.length >= config.MAX_TOTAL_APPS) throw new AppError(429, `MAX_TOTAL_APPS exceeded (${config.MAX_TOTAL_APPS})`);
      if (existingApps.filter((item) => item.userid === userid).length >= config.MAX_APPS_PER_USER) throw new AppError(429, `MAX_APPS_PER_USER exceeded (${config.MAX_APPS_PER_USER})`);
      const appDir = getAppDir(userid, appname);
      await fs.promises.mkdir(appDir, { recursive: true });
      await fs.promises.writeFile(path.join(appDir, ".paas-meta.json"), JSON.stringify({ instanceId: randomUUID(), repoUrl, branch, installationId, build, runtime, createdAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
      dockerAppsCache.ts = 0;
      dispatchJob(res, "create", { userid, appname, repoUrl, branch, installationId, build, runtime }, userid, {}, { env });
    });
    creationQueue = reserve;
    await reserve;
  } catch (error) {
    return next(error);
  }
});

// GET /apps — 앱 목록 조회 (기본: 본인 앱, ?all=true & admin: 전체 앱 조회)
router.get("/", async (req, res, next) => {
  try {
    const { apps: dockerApps, hasLabelErrors } = await listDockerApps();
    const user = req.auth?.user;
    const fetchAll = req.query.all === "true" && user?.role === ROLE_ADMIN;
    
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

    return sendOk(res, { apps, total: apps.length, hasLabelErrors });
  } catch (error) {
    return next(error);
  }
});

// GET /apps/:userid/:appname — 단일 앱 정보 조회
router.get("/:userid/:appname", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);
    const appInfo = await buildAppInfo(userid, appname, null);
    return sendOk(res, { app: appInfo });
  } catch (error) {
    return next(error);
  }
});

// ── 앱 생명주기 제어 ──────────────────────────────────────────────────────────

// POST /apps/:userid/:appname/start — docker compose up -d (비동기 job)
router.post("/:userid/:appname/start", async (req, res, next) => {
  try {
    const { userid, appname, appDir } = await resolveAppRequestContext(req);
    dispatchJob(res, "start", { userid, appname, appDir }, userid);
  } catch (error) {
    return next(error);
  }
});

// POST /apps/:userid/:appname/stop — docker compose stop (비동기 job)
router.post("/:userid/:appname/stop", async (req, res, next) => {
  try {
    const { userid, appname, appDir } = await resolveAppRequestContext(req);
    dispatchJob(res, "stop", { userid, appname, appDir }, userid);
  } catch (error) {
    return next(error);
  }
});

// POST /apps/:userid/:appname/deploy — deploy.sh (비동기 job)
router.post("/:userid/:appname/deploy", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);
    dispatchJob(res, "deploy", { userid, appname }, userid);
  } catch (error) {
    return next(error);
  }
});

// DELETE /apps/:userid/:appname — delete.sh (비동기 job)
router.delete("/:userid/:appname", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);
    const keepData = normalizeBoolean(req.body?.keepData, false);
    dispatchJob(res, "delete", { userid, appname, keepData }, userid);
  } catch (error) {
    return next(error);
  }
});

// ── 로그 ──────────────────────────────────────────────────────────────────────

// 선택한 서비스들의 Docker 로그를 기록 시각으로 병합한다.
router.get("/:userid/:appname/logs", async (req, res, next) => {
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  let session;
  try {
    const context = await resolveAppRequestContext(req);
    session = new AppLogSession(context, parseLogOptions(req.query), controller.signal);
    const snapshot = await session.snapshot();
    if (!controller.signal.aborted) return sendOk(res, snapshot);
  } catch (error) {
    if (!controller.signal.aborted) return next(error);
  } finally { session?.close(); controller.abort(); }
});

let resolveLogSessionAuth = () => null;
const logConnections = new Map();

router.get("/:userid/:appname/logs/stream", async (req, res, next) => {
  const controller = new AbortController();
  let session, keepalive, reserved = false;
  const owner = req.auth.user.username;
  const cleanup = () => {
    controller.abort(); session?.close(); clearInterval(keepalive);
    if (reserved) {
      const count = logConnections.get(owner) - 1;
      if (count) logConnections.set(owner, count); else logConnections.delete(owner);
      reserved = false;
    }
  };
  res.on("close", cleanup);
  function send(message) {
    if (controller.signal.aborted) return;
    // 느린 브라우저가 Docker 로그를 무제한으로 쌓게 하지 않는다.
    if (res.writableLength > 2 * 1024 * 1024) { cleanup(); res.destroy(); return; }
    res.write(`data: ${JSON.stringify(message)}\n\n`);
  }
  try {
    const context = await resolveAppRequestContext(req);
    const options = parseLogOptions(req.query);
    if (controller.signal.aborted) return;
    if ((logConnections.get(owner) || 0) >= 8 || [...logConnections.values()].reduce((a, b) => a + b, 0) >= 128) throw new AppError(429, "Too many live log connections");
    logConnections.set(owner, (logConnections.get(owner) || 0) + 1); reserved = true;
    session = new AppLogSession(context, options, controller.signal);
    const snapshot = await session.snapshot();
    if (controller.signal.aborted) return;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    send({ type: "snapshot", ...snapshot });
    session.start(send, () => { cleanup(); res.end(); });
    keepalive = setInterval(() => {
      const auth = resolveLogSessionAuth(req);
      if (!auth || auth.user.mustChangePassword || (auth.user.role !== ROLE_ADMIN && auth.user.username !== context.userid)) {
        send({ type: "end", message: "Log access expired; sign in again" }); cleanup(); res.end();
      } else if (!controller.signal.aborted) res.write(": ping\n\n");
    }, 15000);
  } catch (error) {
    cleanup();
    if (!res.headersSent && !res.destroyed) return next(error);
    res.end();
  }
});

// ── Exec ──────────────────────────────────────────────────────────────────────

// POST /apps/:userid/:appname/exec — 컨테이너 내부에서 임의 명령 실행
router.post("/:userid/:appname/exec", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);

    const command = String(req.body?.command || "").trim();
    if (!command) throw new AppError(400, "command is required");
    if (command.length > 2048) throw new AppError(400, "command too long (max 2048 chars)");

    const cwd = String(req.body?.cwd || "").trim();

    const app = await findDockerService(userid, appname, req.body?.service);
    if (!app?.containerName) throw new AppError(404, "Container not found for this app");

    const { stdout, stderr } = await runContainerExec(app.containerName, command, cwd);
    return sendOk(res, { command, output: stdout, stderr });
  } catch (error) {
    return next(error);
  }
});

// POST /apps/:userid/:appname/exec/complete — 탭 완성
router.post("/:userid/:appname/exec/complete", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);

    const partial = String(req.body?.partial ?? "");
    if (partial.length > 512) throw new AppError(400, "partial too long (max 512 chars)");

    const cwd = String(req.body?.cwd || "").trim();

    const app = await findDockerService(userid, appname, req.body?.service);
    if (!app?.containerName) throw new AppError(404, "Container not found for this app");

    const completions = await runContainerComplete(app.containerName, partial, cwd);
    return sendOk(res, { completions });
  } catch (error) {
    return next(error);
  }
});

// ── 빌드 설정 ────────────────────────────────────────────────────────────────

router.get("/:userid/:appname/runtime", async (req, res, next) => {
  try {
    const { appDir } = await resolveAppRequestContext(req);
    const metadata = await readBuildMetadata(appDir);
    return sendOk(res, { runtime: normalizeRuntime(metadata.runtime), ...deploymentStatus(metadata) });
  } catch (error) { next(error); }
});

router.put("/:userid/:appname/runtime", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);
    let runtime;
    try {
      if (!req.body || !Object.hasOwn(req.body, "runtime")) throw new Error("runtime is required");
      runtime = normalizeRuntime(req.body.runtime);
    } catch (error) { throw new AppError(400, error.message); }
    const status = await withAppQueue(userid, appname, async () => {
      const appDir = await ensureAppExists(userid, appname);
      const metadata = await readBuildMetadata(appDir);
      const updated = { ...withDeploymentBaseline(metadata), runtime };
      saveAppMetadata(path.join(appDir, ".paas-meta.json"), updated, metadata.build);
      dockerAppsCache.ts = 0;
      return deploymentStatus(updated);
    });
    return sendOk(res, { saved: true, runtime, ...status });
  } catch (error) { next(error); }
});

async function readBuildMetadata(appDir) {
  try {
    const metadata = JSON.parse(await fs.promises.readFile(path.join(appDir, ".paas-meta.json"), "utf8"));
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new Error();
    return metadata;
  } catch (error) {
    if (error.code === "ENOENT") throw new AppError(404, "App repository metadata is unavailable");
    throw new AppError(500, "Unable to read app repository metadata");
  }
}

router.get("/:userid/:appname/build", async (req, res, next) => {
  try {
    const { appDir } = await resolveAppRequestContext(req);
    const metadata = await readBuildMetadata(appDir);
    return sendOk(res, {
      build: normalizeBuildConfig(metadata.build),
      ...deploymentStatus(metadata),
      repoUrl: metadata.repoUrl || "",
      branch: metadata.branch || "main",
    });
  } catch (error) {
    return next(error);
  }
});

router.put("/:userid/:appname/build", async (req, res, next) => {
  try {
    const { userid, appname } = await resolveAppRequestContext(req);
    let build;
    try {
      if (!req.body || !Object.hasOwn(req.body, "build")) throw new Error("build is required");
      build = normalizeBuildConfig(req.body.build);
    } catch (error) {
      throw new AppError(400, error.message);
    }
    const status = await withAppQueue(userid, appname, async () => {
      const appDir = await ensureAppExists(userid, appname);
      const metadata = await readBuildMetadata(appDir);
      const updated = { ...withDeploymentBaseline(metadata), build };
      saveAppMetadata(path.join(appDir, ".paas-meta.json"), updated, build);
      dockerAppsCache.ts = 0;
      return deploymentStatus(updated);
    });
    return sendOk(res, { saved: true, build, ...status });
  } catch (error) {
    return next(error);
  }
});

// 앱 소유자의 기존 설치 권한으로 조회하므로 관리자가 다른 사용자의 앱도 편집할 수 있다.
router.get("/:userid/:appname/dockerfiles", async (req, res, next) => {
  try {
    const { appDir } = await resolveAppRequestContext(req);
    const metadata = await readBuildMetadata(appDir);
    if (!metadata.repoUrl) throw new AppError(404, "App repository metadata is unavailable");
    let token = "";
    if (metadata.installationId) {
      if (!_githubService) throw new AppError(503, "GitHub integration is disabled.");
      token = await _githubService.getCloneToken(metadata.installationId);
    }
    return sendOk(res, await listRootDockerfiles(metadata.repoUrl, metadata.branch || "main", token));
  } catch (error) {
    return next(error);
  }
});

// ── 환경변수 ──────────────────────────────────────────────────────────────────

// GET /apps/:userid/:appname/env — .env.paas 파일 내용 조회
router.get("/:userid/:appname/env", async (req, res, next) => {
  try {
    const { appDir } = await resolveAppRequestContext(req);
    const env = await readEnvFile(appDir);
    return sendOk(res, { env });
  } catch (error) {
    return next(error);
  }
});

// PUT /apps/:userid/:appname/env — .env.paas 파일 저장 후 컨테이너 재시작 (비동기 job)
router.put("/:userid/:appname/env", async (req, res, next) => {
  try {
    const { userid, appname, appDir } = await resolveAppRequestContext(req);
    const content = String(req.body?.env || "");

    const normalized = normalizeCreateEnv(content);
    await withAppQueue(userid, appname, async () => {
      await ensureAppExists(userid, appname);
      await patchComposeEnvFile(appDir);
      await writeEnvFile(appDir, normalized);
      dispatchJob(res, "env-restart", { userid, appname, appDir }, userid, { saved: true });
    });
  } catch (error) {
    return next(error);
  }
});

// module.exports = router 이후에도 접근 가능하도록 router 객체에 직접 부착
router.executeJob                  = executeJob;
router.setOnAppDeletedHook         = setOnAppDeletedHook;
router.setOnAppDeployedHook        = setOnAppDeployedHook;
router.setListActiveDomainsForApp  = setListActiveDomainsForApp;
router.setGithubService            = setGithubService;
router.setLogSessionAuthResolver   = (resolve) => { resolveLogSessionAuth = resolve; };

module.exports = router;
