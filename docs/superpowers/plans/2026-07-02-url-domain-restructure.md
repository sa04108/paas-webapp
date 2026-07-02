# URL/도메인 체계 개편 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 포털 UI에 화면별 path 라우팅(History API)을 도입하고, JSON API를 `/api/*`로 격리하며, 포털을 `portal.{도메인}`으로 이동(루트는 301 리다이렉트), 유저 앱을 `*.apps.{도메인}`으로 격리한다.

**Architecture:** 프론트에 순수 라우트 모듈(`app-router.js`: parsePath/buildPath)을 신설하고 기존 `switchView`/`navigateToApp`이 URL을 push하도록 확장한다(상태→URL 동기화). URL→상태 동기화는 부트스트랩과 popstate에서 `applyRouteFromUrl`이 담당한다. 서버는 모든 JSON API를 express.Router 하나(`api`)에 모아 `/api`로 마운트하고, UI 경로들은 index.html을 서빙한다(SPA fallback). 도메인 토폴로지는 Traefik 라벨과 generate-compose.js의 도메인 생성식만으로 변경한다.

**Tech Stack:** Node.js ≥20, Express 4, 브라우저 ES modules(빌드 없음), node:test(신규 npm 의존성 없음), Traefik v3 라벨, docker compose.

**Spec:** `docs/superpowers/specs/2026-07-02-url-domain-restructure-design.md`

## Global Constraints

- 새 npm 의존성 추가 금지 (테스트는 node:test)
- 클린 브레이크: 구 API 경로·구 앱 도메인 호환 레이어 없음
- `.env`의 `PAAS_DOMAIN`은 루트 도메인 의미 유지, 새 env 변수 추가 금지 — `portal.${PAAS_DOMAIN}` / `apps.${PAAS_DOMAIN}` 파생
- 프론트 public/*.js는 브라우저 ES module — node로 단위 테스트할 파일은 DOM 의존이 없어야 한다(dynamic import로 로드)
- 루트 유지 경로: `/health`(인프라), `/auth`(로그인 HTML 페이지), 정적 파일
- UI 경로: `/dashboard`, `/create`, `/users`, `/admin`, `/apps/{userid}/{appname}` (서브탭은 URL 미반영)
- 커밋 메시지는 한국어, 기존 리포 컨벤션(`feat:`, `fix:`, `docs:`) 준수

---

### Task 1: app-router.js — 순수 라우트 모듈 (TDD)

**Files:**
- Create: `portal/public/app-router.js`
- Test: `portal/test/appRouter.test.js`

**Interfaces:**
- Produces:
  - `parsePath(pathname: string) -> { view: string, params: object } | null`
    - view는 `"dashboard" | "create" | "users" | "admin-dashboard" | "app-detail"`
    - `app-detail`일 때 `params = { userid, appname }` (URI 디코딩됨)
    - 매칭 실패 시 `null`
  - `buildPath(view: string, params?: object) -> string`
    - `buildPath("admin-dashboard")` → `"/admin"`
    - `buildPath("app-detail", { userid, appname })` → `"/apps/{userid}/{appname}"` (URI 인코딩됨)
    - 알 수 없는 view → `"/dashboard"`
- 주의: 이 모듈은 **어떤 것도 import하지 않는다** (DOM 전역 접근 금지). node 테스트에서 dynamic import로 로드하기 위한 조건이다.

- [ ] **Step 1: 실패하는 테스트 작성**

Create `portal/test/appRouter.test.js`:
```js
"use strict";
const test = require("node:test");
const assert = require("node:assert");

// app-router.js는 브라우저 ES module이므로 dynamic import로 로드한다.
// (DOM 의존이 없어 node에서도 그대로 동작한다)
async function loadRouter() {
  return import("../public/app-router.js");
}

test("parsePath: 최상위 뷰 경로를 뷰 이름으로 매핑한다", async () => {
  const { parsePath } = await loadRouter();
  assert.deepStrictEqual(parsePath("/dashboard"), { view: "dashboard", params: {} });
  assert.deepStrictEqual(parsePath("/create"), { view: "create", params: {} });
  assert.deepStrictEqual(parsePath("/users"), { view: "users", params: {} });
  assert.deepStrictEqual(parsePath("/admin"), { view: "admin-dashboard", params: {} });
});

test("parsePath: 루트와 /index.html은 dashboard로 매핑한다", async () => {
  const { parsePath } = await loadRouter();
  assert.deepStrictEqual(parsePath("/"), { view: "dashboard", params: {} });
  assert.deepStrictEqual(parsePath("/index.html"), { view: "dashboard", params: {} });
});

test("parsePath: 앱 상세 경로에서 userid/appname을 추출한다 (URI 디코딩)", async () => {
  const { parsePath } = await loadRouter();
  assert.deepStrictEqual(parsePath("/apps/alice/myapp"), {
    view: "app-detail",
    params: { userid: "alice", appname: "myapp" },
  });
  assert.deepStrictEqual(parsePath("/apps/alice/my%20app"), {
    view: "app-detail",
    params: { userid: "alice", appname: "my app" },
  });
});

test("parsePath: 알 수 없는 경로는 null을 반환한다", async () => {
  const { parsePath } = await loadRouter();
  assert.strictEqual(parsePath("/unknown"), null);
  assert.strictEqual(parsePath("/apps/alice"), null);
  assert.strictEqual(parsePath("/apps/alice/myapp/extra"), null);
  assert.strictEqual(parsePath(""), null);
});

test("buildPath: 뷰 이름을 경로로 변환한다", async () => {
  const { buildPath } = await loadRouter();
  assert.strictEqual(buildPath("dashboard"), "/dashboard");
  assert.strictEqual(buildPath("create"), "/create");
  assert.strictEqual(buildPath("users"), "/users");
  assert.strictEqual(buildPath("admin-dashboard"), "/admin");
});

test("buildPath: app-detail은 params를 URI 인코딩해 경로를 만든다", async () => {
  const { buildPath } = await loadRouter();
  assert.strictEqual(
    buildPath("app-detail", { userid: "alice", appname: "my app" }),
    "/apps/alice/my%20app"
  );
});

test("buildPath: 알 수 없는 뷰는 /dashboard로 폴백한다", async () => {
  const { buildPath } = await loadRouter();
  assert.strictEqual(buildPath("nope"), "/dashboard");
});

test("parsePath/buildPath 라운드트립", async () => {
  const { parsePath, buildPath } = await loadRouter();
  for (const view of ["dashboard", "create", "users", "admin-dashboard"]) {
    assert.deepStrictEqual(parsePath(buildPath(view)), { view, params: {} });
  }
  const params = { userid: "alice", appname: "myapp" };
  assert.deepStrictEqual(parsePath(buildPath("app-detail", params)), {
    view: "app-detail",
    params,
  });
});
```

- [ ] **Step 2: 테스트 실행 → 실패 확인**

Run:
```bash
cd portal && node --test test/appRouter.test.js
```
Expected: FAIL — `Cannot find module '../public/app-router.js'` (ERR_MODULE_NOT_FOUND)

- [ ] **Step 3: app-router.js 구현**

Create `portal/public/app-router.js`:
```js
// =============================================================================
// app-router.js - URL 경로 ↔ 뷰 매핑 (순수 모듈)
// =============================================================================
// 역할:
//   pathname을 뷰 이름/파라미터로 파싱(parsePath)하고, 뷰 이름을 경로로
//   변환(buildPath)한다. History API push/pop 등 부수효과는 여기 두지 않는다
//   (app-ui.js의 switchView/navigateToApp과 app.js의 applyRouteFromUrl이 담당).
//   이 모듈은 아무것도 import하지 않는다 — node:test에서 dynamic import로
//   그대로 로드해 단위 테스트한다.
// =============================================================================

const VIEW_TO_PATH = {
  dashboard: "/dashboard",
  create: "/create",
  users: "/users",
  "admin-dashboard": "/admin",
};

const PATH_TO_VIEW = Object.fromEntries(
  Object.entries(VIEW_TO_PATH).map(([view, path]) => [path, view])
);

const APP_DETAIL_PATH = /^\/apps\/([^/]+)\/([^/]+)$/;

// pathname → { view, params } | null (매칭 실패)
function parsePath(pathname) {
  const path = String(pathname || "");
  if (path === "/" || path === "/index.html") {
    return { view: "dashboard", params: {} };
  }
  if (PATH_TO_VIEW[path]) {
    return { view: PATH_TO_VIEW[path], params: {} };
  }
  const m = path.match(APP_DETAIL_PATH);
  if (m) {
    try {
      return {
        view: "app-detail",
        params: { userid: decodeURIComponent(m[1]), appname: decodeURIComponent(m[2]) },
      };
    } catch {
      return null; // 잘못된 퍼센트 인코딩
    }
  }
  return null;
}

// view(+params) → pathname. 알 수 없는 뷰는 dashboard로 폴백한다.
function buildPath(view, params = {}) {
  if (view === "app-detail") {
    return `/apps/${encodeURIComponent(params.userid)}/${encodeURIComponent(params.appname)}`;
  }
  return VIEW_TO_PATH[view] || VIEW_TO_PATH.dashboard;
}

export { parsePath, buildPath };
```

- [ ] **Step 4: 테스트 실행 → 통과 확인**

Run:
```bash
cd portal && node --test test/appRouter.test.js
```
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add portal/public/app-router.js portal/test/appRouter.test.js
git commit -m "feat: app-router — URL 경로/뷰 매핑 순수 모듈"
```

---

### Task 2: 서버 — API를 /api/*로 이동 + SPA fallback + appsDomain

**Files:**
- Modify: `portal/server.js`
- Modify: `portal/routes/exec-ws.js:24` (EXEC_WS_PATH)
- Modify: `portal/routes/github.js` (콜백 복귀 경로)

**Interfaces:**
- Produces (프론트 Task 3/4가 의존):
  - 모든 JSON API가 `/api/*`로 이동: `/api/auth/*`, `/api/apps/*`, `/api/jobs/*`, `/api/users/*`, `/api/admin/portal-logs`, `/api/github/*`, `/api/config`
  - exec WS 경로: `/api/apps/:userid/:appname/exec/ws`
  - `GET /api/config` 응답에 `appsDomain: "apps.<PAAS_DOMAIN>"` 필드 추가
  - UI 경로 `/dashboard`, `/create`, `/users`, `/admin`, `/apps/:userid/:appname` GET → index.html (미인증 시 `/auth` 리다이렉트)
  - GitHub 콜백 성공 시 `/create?github=connected`로 복귀
- 루트 유지: `GET /health`, `GET /auth`(HTML), 정적 파일

- [ ] **Step 1: server.js — api 라우터 도입 및 공개 엔드포인트 이동**

`portal/server.js`의 `// ── 공개 엔드포인트 ──` 블록을 다음으로 교체한다.
(`/health`는 app에 남고, `/config`는 api로 이동한다. `api` 라우터는 이 시점에 선언만 하고 마운트는 정적 서빙 뒤에서 한다)

```js
// ── 공개 엔드포인트 ───────────────────────────────────────────────────────────

app.get("/health", (_req, res) =>
  sendOk(res, { service: "portal", status: "ok", now: new Date().toISOString() })
);

// ── API 라우터 ────────────────────────────────────────────────────────────────
// 모든 JSON API는 이 라우터에 모아 /api 아래로 마운트한다.
// UI 경로(path 라우팅)와 API 경로가 섞이지 않도록 격리하기 위함이다.

const api = express.Router();

api.get("/config", (_req, res) =>
  sendOk(res, {
    domain: config.PAAS_DOMAIN,
    appsDomain: `apps.${config.PAAS_DOMAIN}`,
    devMode: IS_DEV,
    traefikPort: IS_DEV ? config.TRAEFIK_HOST_PORT : null,
    limits: {
      maxAppsPerUser: config.MAX_APPS_PER_USER,
      maxTotalApps: config.MAX_TOTAL_APPS,
    },
    auth: authService.getPublicConfig(),
  })
);
```

- [ ] **Step 2: server.js — UI 라우팅을 SPA fallback으로 확장**

기존 `app.get(["/", "/index.html"], ...)` 를 다음으로 교체한다:

```js
// UI 경로(SPA): 어떤 화면이든 index.html을 서빙하고, 실제 뷰 결정은
// 프론트 라우터(app-router.js)가 pathname을 파싱해 수행한다.
const UI_PATHS = ["/", "/index.html", "/dashboard", "/create", "/users", "/admin", "/apps/:userid/:appname"];

app.get(UI_PATHS, (req, res) => {
  if (!canAccessDashboardUi(req)) return res.redirect("/auth");
  return serveHtmlWithVersion(res, dashboardPagePath);
});
```

`app.get("/auth", ...)` 은 그대로 둔다.

- [ ] **Step 3: server.js — 보호 라우트들을 api 라우터로 이전**

정적 서빙(`app.use(express.static(...))`) 바로 아래를 다음과 같이 바꾼다.
`authService.attachRoutes`는 `app.post("/auth/login", ...)` 형태로 붙이므로
express.Router를 넘기면 `/api/auth/*`가 된다.

```js
// ── 인증 라우트 (/api/auth/login, /api/auth/logout, /api/auth/me, /api/auth/change-password) ──

authService.attachRoutes(api);

// ── 보호된 라우트 ─────────────────────────────────────────────────────────────

// 미들웨어 체인: 세션 검증 → 비밀번호 변경 여부 확인 → 라우터
api.use(
  "/apps",
  authService.requireSessionAuth,
  authService.requirePasswordUpdated,
  appsRouter
);

// /api/jobs: 세션 검증 → 비밀번호 변경 여부 확인 → job 라우터
api.use(
  "/jobs",
  authService.requireSessionAuth,
  authService.requirePasswordUpdated,
  jobsRouter
);

// 미들웨어 체인: 세션 검증 → admin 권한 확인 → 비밀번호 변경 여부 확인 → 라우터
api.use(
  "/users",
  authService.requireSessionAuth,
  authService.requirePaasAdmin,
  authService.requirePasswordUpdated,
  createUsersRouter(authService)
);
```

Admin 로그 엔드포인트도 `app.get("/admin/portal-logs", ...)` → `api.get("/admin/portal-logs", ...)`로 바꾼다 (핸들러 본문은 그대로).

그리고 admin 로그 엔드포인트 정의 **다음 줄**에 api 마운트를 추가한다:

```js
// /api 마운트. 하위 라우트 일부(domains/github)는 start()에서 추가되지만,
// express 라우팅은 요청 시점에 해석되므로 문제 없다.
app.use("/api", api);
```

- [ ] **Step 4: server.js — start() 내 domains/github 마운트와 404 catch-all 이전**

`start()` 안에서:

```js
  // 커스텀 도메인 라우터: /api/apps/:userid/:appname/domains
  api.use(
    "/apps/:userid/:appname/domains",
    authService.requireSessionAuth,
    authService.requirePasswordUpdated,
    createDomainsRouter(domainManager)
  );
```

github 마운트도 동일하게 `app.use("/github", ...)` → `api.use("/github", ...)`.

기존 열거식 catch-all 라인:
```js
app.use(["/apps", "/users", "/admin", "/github"], (_req, res) => sendError(res, 404, "Not found"));
```
을 삭제하고, 그 자리에 api 라우터 말미 catch-all을 추가한다:
```js
  // 매칭되지 않은 /api/* 경로는 모두 404 JSON으로 처리한다.
  // domains·github 라우터 등록 이후에 위치해야 순서가 보장된다.
  api.use((_req, res) => sendError(res, 404, "Not found"));
```

- [ ] **Step 5: exec WS 경로를 /api로 변경**

`portal/routes/exec-ws.js:24`:
```js
const EXEC_WS_PATH = /^\/api\/apps\/([^/]+)\/([^/]+)\/exec\/ws$/;
```
(server.js의 upgrade 핸들러는 `parseExecWsUrl`을 그대로 쓰므로 추가 변경 없음)

- [ ] **Step 6: GitHub 콜백 복귀 경로 변경**

`portal/routes/github.js`의 `/callback` 핸들러에서:
```js
      // 대시보드로 복귀 (앱 생성 화면)
      return res.redirect("/create?github=connected");
```
(기존 `"/?github=connected#create"` 대체)

- [ ] **Step 7: server.js 헤더 주석 갱신**

`portal/server.js` 상단 주석의 라우트 설명을 현행화한다:
```js
//     routes/apps.js     — /api/apps 라우트 핸들러
//     routes/users.js    — /api/users 라우트 핸들러 팩토리
//     routes/domains.js  — /api/apps/:userid/:appname/domains 라우트 핸들러
```

- [ ] **Step 8: 구문 검증 + 부팅 스모크 테스트**

Run:
```bash
cd portal && node -c server.js && node -c routes/exec-ws.js && node -c routes/github.js && echo SYNTAX_OK
```
Expected: `SYNTAX_OK`

Run (서버 기동 후 신구 경로 확인):
```bash
cd portal && (node server.js &) && sleep 3 && \
  curl -s -o /dev/null -w "health:%{http_code} " localhost:3000/health && \
  curl -s -o /dev/null -w "api-config:%{http_code} " localhost:3000/api/config && \
  curl -s -o /dev/null -w "old-config:%{http_code} " localhost:3000/config && \
  curl -s -o /dev/null -w "api-404:%{http_code} " localhost:3000/api/nope && \
  curl -s -o /dev/null -w "ui-dashboard:%{http_code}\n" localhost:3000/dashboard ; \
  kill %1 2>/dev/null
```
Expected: `health:200 api-config:200 old-config:404 api-404:404 ui-dashboard:302`
(`/dashboard`는 미인증이라 `/auth`로 302. `/config`는 정적 파일도 라우트도 아니므로 404)

- [ ] **Step 9: Commit**

```bash
git add portal/server.js portal/routes/exec-ws.js portal/routes/github.js
git commit -m "feat: JSON API를 /api/*로 격리하고 UI 경로 SPA fallback 추가"
```

---

### Task 3: 프론트 — API 호출 경로를 /api로 전환

**Files:**
- Modify: `portal/public/app-api.js:31-49` (apiFetch)
- Modify: `portal/public/auth.js:21-40` (apiFetch)
- Modify: `portal/public/app-exec.js:77` (WS URL)

**Interfaces:**
- Consumes: Task 2의 `/api/*` 서버 경로
- Produces: 프론트 전 모듈의 API 호출이 `/api` prefix로 나간다. 개별 호출부(`apiFetch("/apps")` 등)는 수정하지 않는다 — prefix는 apiFetch 한 곳에서 부여.

- [ ] **Step 1: app-api.js apiFetch에 /api prefix 부여**

`portal/public/app-api.js`의 apiFetch에서 fetch 호출만 변경:
```js
// 모든 API 호출의 기반 함수. 응답이 ok: false이거나 HTTP 오류면 예외를 던진다.
// 서버 JSON API는 /api 아래에 마운트되어 있으므로 prefix를 여기서 일괄 부여한다.
async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers,
  });
```
(나머지 본문 동일)

- [ ] **Step 2: auth.js apiFetch에도 동일 적용**

`portal/public/auth.js`:
```js
async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  // 서버 JSON API는 /api 아래에 마운트되어 있으므로 prefix를 여기서 일괄 부여한다.
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    headers
  });
```
(나머지 본문 동일)

- [ ] **Step 3: exec WS URL 변경**

`portal/public/app-exec.js:77`:
```js
  const url = `${proto}//${location.host}/api/apps/${userid}/${appname}/exec/ws?cols=${cols}&rows=${rows}`;
```

- [ ] **Step 4: 구문 검증**

Run:
```bash
cd portal && for f in public/app-api.js public/auth.js public/app-exec.js; do node --input-type=module --check < "$f" || exit 1; done && echo OK
```
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add portal/public/app-api.js portal/public/auth.js portal/public/app-exec.js
git commit -m "feat: 프론트 API 호출을 /api prefix로 전환 (apiFetch 일원화)"
```

---

### Task 4: 프론트 — 라우터 통합 (URL push/복원, sessionStorage 제거)

**Files:**
- Modify: `portal/public/app-ui.js` (switchView, navigateToApp, import)
- Modify: `portal/public/app.js` (bootstrap, popstate, import)
- Modify: `portal/public/app-utils.js` (persistUiState/readPersistedUiState 제거, syncDomainPreview)
- Modify: `portal/public/app-state.js` (UI_STATE_STORAGE_KEY 제거, appsDomain 추가)
- Modify: `portal/public/app-api.js` (loadConfig의 appsDomain)

**Interfaces:**
- Consumes: Task 1의 `parsePath`/`buildPath`, Task 2의 `/api/config` `appsDomain`
- Produces:
  - `switchView(viewName, { updateUrl = true })` — 기존 `{ persist }` 옵션 대체. updateUrl이면 `history.pushState`로 URL 동기화 (app-detail 제외 — params를 모르므로)
  - `navigateToApp(userid, appname, { updateUrl = true })` — app-detail URL push 포함
  - `applyRouteFromUrl()` (app.js 내부 함수) — URL → 뷰 적용. 부트스트랩/popstate에서 호출
  - sessionStorage 뷰 영속화(`portal.uiState`) 완전 제거

- [ ] **Step 1: app-state.js — UI_STATE_STORAGE_KEY 제거, appsDomain 추가**

`portal/public/app-state.js`에서 `export const UI_STATE_STORAGE_KEY = "portal.uiState";` 줄을 삭제한다.

state 객체에 appsDomain을 추가한다:
```js
export const state = {
  domain: "my.domain.com",
  appsDomain: "apps.my.domain.com",
  devMode: false,
```

- [ ] **Step 2: app-utils.js — 영속화 함수 제거, 도메인 프리뷰 갱신**

`portal/public/app-utils.js`에서:

1. import 블록에서 `UI_STATE_STORAGE_KEY,` 줄 삭제
2. `// ── UI 상태 영속성 (sessionStorage) ──` 섹션 전체(주석 포함, `readPersistedUiState`와 `persistUiState` 두 함수) 삭제
3. export 블록에서 `persistUiState,`와 `readPersistedUiState,` 삭제
4. `syncDomainPreview`를 appsDomain 기준으로 변경:
```js
// 앱 생성 폼의 appname 입력에 따라 예상 도메인 주소를 실시간으로 업데이트한다.
function syncDomainPreview() {
  const userid  = String(state.user?.username || "").trim() || "owner";
  const appname = el.appnameInput.value.trim() || "appname";
  el.domainPreview.textContent = `${userid}-${appname}.${state.appsDomain}`;
}
```

- [ ] **Step 3: app-api.js — loadConfig에서 appsDomain 수신**

`portal/public/app-api.js`의 loadConfig:
```js
async function loadConfig() {
  const data = await apiFetch("/config");
  state.domain      = data.domain || "my.domain.com";
  state.appsDomain  = data.appsDomain || `apps.${state.domain}`;
  state.devMode     = Boolean(data.devMode);
  state.traefikPort = data.traefikPort || null;
  el.domainChip.textContent = state.appsDomain;
  el.limitChip.textContent  = `${data.limits.maxAppsPerUser}/${data.limits.maxTotalApps}`;
  el.devModeBadge.hidden = !state.devMode;
  syncDomainPreview();
}
```

- [ ] **Step 4: app-ui.js — switchView/navigateToApp이 URL을 push하도록 변경**

`portal/public/app-ui.js`에서:

1. import에 라우터 추가 (파일 상단 import 블록):
```js
import { buildPath } from "./app-router.js";
```
2. app-state.js/app-utils.js import에서 `persistUiState` 제거
3. switchView 교체:
```js
// 뷰 전환 + URL 동기화. app-detail은 URL에 userid/appname이 필요하므로
// navigateToApp이 직접 push한다 (updateUrl: false로 호출됨).
function switchView(viewName, { updateUrl = true } = {}) {
  const nextView = AVAILABLE_VIEWS.includes(viewName) ? viewName : DEFAULT_VIEW;
  state.activeView = nextView;

  el.viewDashboard.hidden = nextView !== "dashboard";
  el.viewCreate.hidden = nextView !== "create";
  el.viewAppDetail.hidden = nextView !== "app-detail";
  el.viewUsers.hidden = nextView !== "users";
  if (el.viewAdminDashboard) el.viewAdminDashboard.hidden = nextView !== "admin-dashboard";

  el.gnbItems.forEach((item) => {
    // app-detail은 별도 GNB 항목이 없으므로 dashboard를 active로 표시한다.
    const viewKey = nextView === "app-detail" ? "dashboard" : nextView;
    item.classList.toggle("active", item.dataset.view === viewKey);
  });

  if (updateUrl && nextView !== "app-detail") {
    const path = buildPath(nextView);
    if (window.location.pathname !== path) {
      window.history.pushState(null, "", path);
    }
  }
  closeMobileMenu();
}
```
4. navigateToApp에 URL push 추가 (switchView는 updateUrl: false로):
```js
async function navigateToApp(userid, appname, { updateUrl = true } = {}) {
  uiHandlers.closeExecSocket(); // 이전 앱 소켓 정리
  state.selectedApp = { userid, appname };
  uiHandlers.resetExecForApp();
  el.appDetailAppname.textContent = `${userid} / ${appname}`;
  switchDetailTab(DEFAULT_DETAIL_TAB);
  switchView("app-detail", { updateUrl: false });
  if (updateUrl) {
    const path = buildPath("app-detail", { userid, appname });
    if (window.location.pathname !== path) {
      window.history.pushState(null, "", path);
    }
  }
  try {
    await uiHandlers.loadDetailLogs();
  } catch (error) {
    await uiHandlers.handleRequestError(error);
  }
  uiHandlers.loadDetailEnv().catch(() => { });
  uiHandlers.loadDetailDomains().catch(() => { });
}
```
5. 파일 내 나머지 `switchView(DEFAULT_VIEW)` 호출(admin 메뉴 숨김 fallback 2곳, app-ui.js:318-319, 337-338)은 그대로 둔다 — updateUrl 기본값으로 URL이 함께 정리된다.

- [ ] **Step 5: app.js — 부트스트랩을 URL 기반으로 전환 + popstate**

`portal/public/app.js`에서:

1. import 추가/제거:
   - 추가: `import { parsePath, buildPath } from "./app-router.js";`
   - app-utils.js import 블록에서 `persistUiState,` 삭제 (`readPersistedUiState`는 import되어 있지 않다면 무시)
   - app-utils.js import에 `showToast`가 없으면 추가 (applyRouteFromUrl에서 사용)
2. 부트스트랩 위(`// ── 부트스트랩 ──` 섹션 바로 앞)에 라우트 적용 함수를 추가:
```js
// ── URL 라우팅 ────────────────────────────────────────────────────────────────

// 현재 URL(pathname)을 뷰 상태에 적용한다. 부트스트랩과 popstate에서 호출된다.
// URL이 뷰의 canonical 경로와 다르면(루트 / , 알 수 없는 경로, 권한 fallback 등)
// replaceState로 정규화한다 — 히스토리에 잘못된 항목을 남기지 않기 위함이다.
async function applyRouteFromUrl() {
  const route = parsePath(window.location.pathname);

  // 알 수 없는 경로 → dashboard
  if (!route) {
    switchView(DEFAULT_VIEW, { updateUrl: false });
    window.history.replaceState(null, "", buildPath(DEFAULT_VIEW));
    return;
  }

  if (route.view === "app-detail") {
    const { userid, appname } = route.params;
    // 본인 앱 목록에 없으면 진입하지 않는다. (admin은 타 사용자 앱 접근이
    // 가능하므로 목록 검사를 생략하고 서버 응답에 맡긴다)
    const known = state.apps.some((a) => a.userid === userid && a.appname === appname);
    if (!known && !isAdminUser()) {
      showToast(`앱을 찾을 수 없습니다: ${userid}/${appname}`, "error");
      switchView(DEFAULT_VIEW, { updateUrl: false });
      window.history.replaceState(null, "", buildPath(DEFAULT_VIEW));
      return;
    }
    await navigateToApp(userid, appname, { updateUrl: false });
    return;
  }

  // 앱 상세를 벗어나는 라우팅이면 exec 소켓을 정리한다.
  closeExecSocket();

  // admin 전용 뷰 권한 확인
  if ((route.view === "users" || route.view === "admin-dashboard") && !canManageUsers()) {
    switchView(DEFAULT_VIEW, { updateUrl: false });
    window.history.replaceState(null, "", buildPath(DEFAULT_VIEW));
    return;
  }

  switchView(route.view, { updateUrl: false });
  // 루트("/")로 진입한 경우 canonical 경로로 정규화
  const canonical = buildPath(route.view);
  if (window.location.pathname !== canonical) {
    window.history.replaceState(null, "", canonical);
  }
}

// 뒤로/앞으로가기: URL → 뷰 동기화
window.addEventListener("popstate", () => {
  applyRouteFromUrl().catch(handleRequestError);
});
```
   (`isAdminUser`, `canManageUsers`가 app.js의 app-utils import 목록에 없으면 추가한다. `navigateToApp`은 app-ui import 목록에 없으면 추가한다.)
3. bootstrap을 다음으로 교체:
```js
async function bootstrap() {
  switchView(DEFAULT_VIEW, { updateUrl: false });
  updateAuthUi();
  await loadConfig();
  syncDomainPreview();

  const loggedIn = await loadSession();
  if (!loggedIn) {
    redirectToAuth();
    return;
  }
  updateAuthUi();

  await refreshDashboardData();
  await loadGithubStatus();

  // URL이 가리키는 뷰로 진입 (새로고침/딥링크/북마크 복원)
  await applyRouteFromUrl();

  // /create?github=connected 복귀 시 배너 안내
  if (new URLSearchParams(window.location.search).get("github") === "connected") {
    setBanner("GitHub 연결이 완료되었습니다.", "success");
    // 쿼리스트링을 히스토리에서 제거하여 새로고침 시 중복 표시 방지
    window.history.replaceState(null, "", window.location.pathname);
  }

  // 로그 자동 갱신 타이머는 항상 켜진 상태로 유지한다.
  // 타이머 내부에서 activeView를 체크하므로 원치 않는 빗치는 발생하지 않는다.
  startDetailLogsAutoRefresh();
  startAdminLogsAutoRefresh();
  syncLogRefreshBtn(el.detailRefreshLogsBtn, true);
  syncLogRefreshBtn(el.adminRefreshPortalLogsBtn, true);

  // 새로고침/재방문 시 진행중 job 복원
  await loadAndRecoverJobs();

  if (isPasswordLocked()) {
    setBanner("초기 비밀번호를 우상단 설정에서 변경하세요.", "error");
    return;
  }
  setBanner("로그인 상태가 확인되었습니다.", "success");
}
```
   (기존 `readPersistedUiState()`/`persistUiState()`/restoredView 로직이 사라진 것 외에는 기존 흐름 유지. 기존 한국어 주석·배너 문구는 원문 그대로 유지한다)

- [ ] **Step 6: 구문 검증 + 전체 테스트**

Run:
```bash
cd portal && for f in public/app.js public/app-ui.js public/app-utils.js public/app-state.js public/app-api.js; do node --input-type=module --check < "$f" || exit 1; done && npm test
```
Expected: 구문 OK + 전체 테스트 PASS (appRouter 8 + githubService 4 + githubInstallations 1)

- [ ] **Step 7: 잔존 참조 확인**

Run:
```bash
cd portal && grep -rn "persistUiState\|readPersistedUiState\|UI_STATE_STORAGE_KEY\|portal.uiState" public/ || echo CLEAN
```
Expected: `CLEAN`

- [ ] **Step 8: Commit**

```bash
git add portal/public/
git commit -m "feat: 프론트 path 라우팅 — URL push/복원, sessionStorage 뷰 영속화 제거"
```

---

### Task 5: 인프라 — portal 서브도메인 + 루트 리다이렉트 + 앱 도메인 격리

**Files:**
- Modify: `docker-compose.yml:69-75` (portal labels)
- Modify: `scripts/generate-compose.js:12,44`

**Interfaces:**
- Consumes: `.env`의 `PAAS_DOMAIN` (루트 도메인)
- Produces:
  - 포털: `portal.${PAAS_DOMAIN}` 서빙, `${PAAS_DOMAIN}` → 301 리다이렉트 (경로 보존)
  - 신규 배포 앱: `{userid}-{appname}.apps.${PAAS_DOMAIN}`

- [ ] **Step 1: docker-compose.yml portal 라벨 교체**

portal 서비스의 labels를 다음으로 교체한다.
(compose에서 `$`를 Traefik에 literal로 넘기려면 `$$`로 이스케이프한다.
루트 라우터도 service 지정이 필수라 portal 서비스를 붙이지만,
redirectregex 미들웨어가 서비스 도달 전에 301을 반환한다)

```yaml
        labels:
            - 'paas.type=core'
            - 'traefik.enable=true'
            # 포털: portal.{루트도메인} 에서 서빙
            - 'traefik.http.routers.portal.rule=Host(`portal.${PAAS_DOMAIN}`)'
            - 'traefik.http.routers.portal.entrypoints=websecure'
            - 'traefik.http.routers.portal.tls.certresolver=letsencrypt'
            - 'traefik.http.services.portal.loadbalancer.server.port=${PORTAL_PORT:-3000}'
            # 루트 도메인 접속 → portal 서브도메인으로 301 (경로 보존)
            - 'traefik.http.routers.portal-root.rule=Host(`${PAAS_DOMAIN}`)'
            - 'traefik.http.routers.portal-root.entrypoints=websecure'
            - 'traefik.http.routers.portal-root.tls.certresolver=letsencrypt'
            - 'traefik.http.routers.portal-root.service=portal'
            - 'traefik.http.routers.portal-root.middlewares=portal-root-redirect'
            - 'traefik.http.middlewares.portal-root-redirect.redirectregex.regex=^https?://[^/]+/(.*)'
            - 'traefik.http.middlewares.portal-root-redirect.redirectregex.replacement=https://portal.${PAAS_DOMAIN}/$${1}'
            - 'traefik.http.middlewares.portal-root-redirect.redirectregex.permanent=true'
```

- [ ] **Step 2: generate-compose.js 앱 도메인 변경**

`scripts/generate-compose.js:44`:
```js
  const domain = `${userid}-${appname}.apps.${PAAS_DOMAIN}`;
```

12행 주석도 갱신:
```js
 * dev 환경에서는 PAAS_DOMAIN=localhost 설정으로 *.apps.localhost 도메인을 통해 접근한다.
```
(`TLS_ENABLED`의 `endsWith('localhost')` 판정은 `*.apps.localhost`에도 그대로 성립하므로 변경 없음)

- [ ] **Step 3: 검증 — compose 문법 + 생성 도메인 확인**

Run:
```bash
node -c scripts/generate-compose.js && \
PAAS_DOMAIN=hyunbbai.com docker compose -f docker-compose.yml config --quiet && echo COMPOSE_OK
```
Expected: `COMPOSE_OK` (경고 없이 종료. `ACME_EMAIL` 등 미설정 env 경고는 무시 가능)

Run (라벨 값 확인):
```bash
PAAS_DOMAIN=hyunbbai.com docker compose -f docker-compose.yml config | grep -E "portal(-root)?\.(rule|middlewares)|redirectregex"
```
Expected: `Host(\`portal.hyunbbai.com\`)`, `Host(\`hyunbbai.com\`)`, replacement에 `https://portal.hyunbbai.com/$${1}`(config 출력에서는 `$$`가 `$`로 표시될 수 있음) 포함

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml scripts/generate-compose.js
git commit -m "feat: 포털 portal. 서브도메인 이동 + 루트 301 리다이렉트 + 앱 도메인 *.apps. 격리"
```

---

### Task 6: 문서 갱신 + 최종 검증

**Files:**
- Modify: `.env.example` (PAAS_DOMAIN·GitHub 콜백 주석)
- Modify: `docs/github-app-setup.md` (Callback URL)

**Interfaces:**
- Consumes: Task 2(콜백 경로), Task 5(도메인 토폴로지)

- [ ] **Step 1: .env.example 주석 갱신**

`PAAS_DOMAIN` 라인의 주석을 도메인 토폴로지에 맞게 갱신한다:
```bash
# 루트 도메인. 포털은 portal.{PAAS_DOMAIN}, 유저 앱은 {user}-{app}.apps.{PAAS_DOMAIN} 으로 서빙된다.
# DNS: 루트 A, portal A/CNAME, *.apps 와일드카드 3건을 등록해야 한다.
PAAS_DOMAIN=my.domain.com
```

GitHub App 블록의 콜백 주석도 갱신:
```bash
# GitHub App 설정의 Callback URL을 "https://portal.<PAAS_DOMAIN>/api/github/callback" 으로 맞춘다. (포털 코드가 별도로 읽는 env는 아니며, GitHub App 측 설정값이다)
```

- [ ] **Step 2: docs/github-app-setup.md 콜백 URL 갱신**

3번 항목을 다음으로 교체:
```markdown
3. **Callback URL**: `https://portal.<루트도메인>/api/github/callback` (이 값은 GitHub App 측 설정이며, 포털 env로는 주입하지 않는다)
```

- [ ] **Step 3: 전체 테스트 + 스모크 재실행**

Run:
```bash
cd portal && npm test && (node server.js &) && sleep 3 && \
  curl -s -o /dev/null -w "api:%{http_code} ui:%{http_code}\n" localhost:3000/api/config localhost:3000/dashboard ; kill %1 2>/dev/null
```
Expected: 전체 테스트 PASS + `api:200 ui:302`

- [ ] **Step 4: Commit**

```bash
git add .env.example docs/github-app-setup.md
git commit -m "docs: 도메인 토폴로지·GitHub 콜백 URL 문서 갱신"
```

- [ ] **Step 5: 수동 검증 체크리스트 (운영자/테스터)**

dev 환경(`docker compose up`) 또는 스테이징에서:

1. 로그인 → 대시보드 진입 시 URL이 `/dashboard`
2. GNB로 Create/Users/Admin 이동 시 URL이 `/create`, `/users`, `/admin`으로 변경
3. 앱 카드 클릭 → `/apps/{user}/{app}`, 뒤로가기 → 대시보드 복귀 (exec 소켓 정리 확인)
4. `/apps/{user}/{app}` URL 직접 접속(새 탭) → 해당 앱 상세로 진입
5. 존재하지 않는 앱 URL → 대시보드 + "앱을 찾을 수 없습니다" 토스트
6. 비관리자 계정으로 `/users` 직접 접속 → 대시보드로 정규화
7. 새로고침 시 현재 화면 유지 (모든 뷰에서)
8. 로그아웃 상태로 `/dashboard` 접속 → `/auth` 리다이렉트 → 로그인 → 대시보드
9. Exec 탭 정상 동작 (WS가 `/api/apps/.../exec/ws`로 연결)
10. GitHub 연결 플로우: 연결 → GitHub 설치 → `/create?github=connected` 복귀 + 배너
    (사전에 GitHub App 설정의 Callback URL 변경 필요)
11. 운영 배포 후: `https://{루트도메인}/users` 접속 → `https://portal.{루트도메인}/users` 301
12. 앱 재배포 → `{user}-{app}.apps.{루트도메인}`으로 서빙 + TLS 발급 확인
13. 앱 생성 폼 도메인 프리뷰가 `{user}-{app}.apps.{루트도메인}` 표시

---

## Self-Review (작성자 점검 결과)

**Spec coverage:**
- 도메인 토폴로지(포털 이동/루트 리다이렉트/앱 격리) → Task 5 ✅
- API /api/* 이동 + 404 단순화 + apiFetch 일원화 → Task 2, 3 ✅
- path 라우팅(5개 경로 + 딥링크 + 권한 fallback + 알 수 없는 경로) → Task 1, 4 ✅
- sessionStorage 영속화 제거 → Task 4 ✅ (스펙의 "localStorage"는 실제 구현이 sessionStorage였음 — 동일 대상)
- GitHub 콜백 `/create?github=connected` → Task 2 Step 6 + Task 4 Step 5 ✅
- `/health`·`/auth` 루트 유지 → Task 2 ✅
- 도메인 프리뷰 appsDomain → Task 2(서버) + Task 4(프론트) ✅
- 검증(단위 + 수동 체크리스트) → Task 1, 6 ✅
- 클린 브레이크(리다이렉트 레이어 없음) → 전 Task 일관 ✅

**Type/네이밍 일관성:**
- `parsePath`/`buildPath` 시그니처: Task 1 정의 = Task 4 사용 ✅
- `switchView(view, { updateUrl })` / `navigateToApp(userid, appname, { updateUrl })`: Task 4 내 정의·호출 일치 ✅
- `/api/config`의 `appsDomain`: Task 2 서버 = Task 4 프론트 ✅
- exec WS 경로: Task 2(서버 정규식) = Task 3(클라이언트 URL) = `/api/apps/{u}/{a}/exec/ws` ✅

**알려진 한계 (범위 밖, 의도됨):**
- 로그아웃 상태에서 딥링크 접속 시 로그인 후 원래 URL로 복귀하지 않음 (`/auth`에 next 파라미터 없음) — YAGNI, 필요 시 후속
- dev 환경에서는 Traefik constraint가 user-app만 노출하므로 포털은 `localhost:3000` 직접 접속 (루트 리다이렉트는 운영 전용)

**Placeholder scan:** 없음 — 모든 코드 단계에 실제 코드/명령 포함.
