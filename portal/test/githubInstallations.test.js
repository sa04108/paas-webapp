"use strict";
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createAuthService } = require("../authService");
const { AppError, sendOk, sendError } = require("../utils");

async function makeService() {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "paas-test-")), "t.sqlite3");
  const svc = createAuthService({
    dbPath,
    sessionCookieName: "s",
    sessionTtlHours: 1,
    cookieSecure: false,
    bcryptRounds: 4,
    isDev: true,
    sendOk,
    sendError,
    AppError,
  });
  await svc.init();
  return svc;
}

test("github_installations: upsert → select → delete 라운드트립", async () => {
  const svc = await makeService();
  const st = svc.getStatements();
  // 매핑 대상 사용자 1명 생성
  const user = svc.createUser({ username: "alice", password: "password123", isAdmin: true });

  // 최초 upsert
  st.upsertGithubInstallation.run(user.id, "inst-100", "2026-06-15T00:00:00.000Z", "2026-06-15T00:00:00.000Z");
  let row = st.selectGithubInstallationByUserId.get(user.id);
  assert.strictEqual(row.github_installation_id, "inst-100");

  // 같은 user 재설치 → installation_id 갱신 (UNIQUE user_id, ON CONFLICT)
  st.upsertGithubInstallation.run(user.id, "inst-200", "2026-06-15T01:00:00.000Z", "2026-06-15T01:00:00.000Z");
  row = st.selectGithubInstallationByUserId.get(user.id);
  assert.strictEqual(row.github_installation_id, "inst-200");

  // 삭제
  st.deleteGithubInstallationByUserId.run(user.id);
  assert.strictEqual(st.selectGithubInstallationByUserId.get(user.id), undefined);
});
