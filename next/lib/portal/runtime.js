// =============================================================================
// runtime.js - 포털 런타임 싱글턴 부트스트랩
// =============================================================================
// 역할:
//   Next.js는 요청마다가 아니라 프로세스당 한 번만 존재해야 하는 서비스
//   (SQLite 연결, Docker 훅, GitHub App, jobStore)를 조립한다.
//   과거 portal/server.js의 start() 함수가 하던 조립 책임을 그대로 옮기되,
//   HTTP 프레임워크(Express)와 무관하게 서비스 인스턴스만 생성/캐시한다.
//
//   Route Handler에서는 다음과 같이 사용한다:
//     const { getRuntime } = require("@/lib/portal/runtime");
//     const runtime = await getRuntime();
//     const authService = runtime.authService;
// =============================================================================
"use strict";

const { createAuthService } = require("./authService");
const { AppError } = require("./utils");
const { config, envFilePath, IS_DEV } = require("./config");
const { ensureBaseDirectories, findDockerApp, getDockerContainer } = require("./appManager");
const appsHandlers = require("./routes/apps");
const jobsHandlers = require("./routes/jobs");
const createDomainsHandlers = require("./routes/domains");
const createGithubHandlers = require("./routes/github");
const createUsersHandlers = require("./routes/users");
const jobStore = require("./jobStore");
const { createDomainManager } = require("./domainManager");
const { createGithubService } = require("./githubService");

// custom server(server.mjs)의 require 경로와 Next Route Handler 번들이 서로 다른
// 모듈 인스턴스를 가질 수 있으므로, 프로세스 전역에 싱글턴을 저장한다.
const RUNTIME_GLOBAL_KEY = Symbol.for("paas.portal.runtime");

async function buildRuntime() {
  await ensureBaseDirectories();

  const authService = createAuthService({
    dbPath: config.PORTAL_DB_PATH,
    sessionCookieName: config.SESSION_COOKIE_NAME,
    sessionTtlHours: config.SESSION_TTL_HOURS,
    cookieSecure: config.PORTAL_COOKIE_SECURE,
    bcryptRounds: config.BCRYPT_ROUNDS,
    isDev: IS_DEV,
    AppError,
  });
  await authService.init();

  // domainManager 초기화 (authService DB가 열린 뒤에 prepared statements 사용)
  const domainManager = createDomainManager({ statements: authService.getStatements() });
  await domainManager.init();

  // 앱 삭제 시 커스텀 도메인 정리 훅
  appsHandlers.setOnAppDeletedHook((userid, appname) => domainManager.removeAppDomains(userid, appname));
  // 재배포 완료 시 포트 갱신 훅
  appsHandlers.setOnAppDeployedHook((userid, appname, port) => domainManager.refreshAppPort(userid, appname, port));
  // GET /apps 응답에 active 커스텀 도메인을 포함시키기 위한 주입
  appsHandlers.setListActiveDomainsForApp((userid, appname) => domainManager.listActiveDomains(userid, appname));

  // GitHub App 서비스 (private repo 배포)
  const githubService = createGithubService({
    config,
    statements: authService.getStatements(),
  });
  appsHandlers.setGithubService(githubService);

  // jobStore 초기화 및 서버 재시작 복원
  jobStore.init(config.PORTAL_DB_PATH);
  await jobStore.recoverOnStartup(appsHandlers.executeJob);

  console.log(`[portal] runtime ready — env: ${envFilePath}`);
  console.log(`[portal] apps dir: ${config.PAAS_APPS_DIR}`);
  console.log(`[portal] db: ${authService.getDbPath()}`);

  return {
    config,
    envFilePath,
    IS_DEV,
    authService,
    domainManager,
    githubService,
    jobStore,
    appsHandlers,
    jobsHandlers,
    domainsHandlers: createDomainsHandlers(domainManager),
    githubHandlers: createGithubHandlers(githubService),
    usersHandlers: createUsersHandlers(authService),
    findDockerApp,
    getDockerContainer,
  };
}

/**
 * 프로세스당 한 번만 런타임을 초기화하고, 이후 호출은 동일한 인스턴스를 재사용한다.
 * 동시에 여러 요청이 최초 호출을 트리거해도 buildRuntime()은 한 번만 실행된다
 * (in-flight Promise를 공유).
 */
function getRuntime() {
  const g = globalThis;
  if (!g[RUNTIME_GLOBAL_KEY]) {
    g[RUNTIME_GLOBAL_KEY] = buildRuntime().catch((error) => {
      // 초기화 실패 시 다음 요청에서 재시도할 수 있도록 캐시를 비운다.
      g[RUNTIME_GLOBAL_KEY] = null;
      throw error;
    });
  }
  return g[RUNTIME_GLOBAL_KEY];
}

module.exports = { getRuntime };
