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
