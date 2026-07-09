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
