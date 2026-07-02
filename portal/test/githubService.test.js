"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { __test } = require("../githubService");

// base64url 디코드 헬퍼 (테스트 전용)
function decodeSeg(seg) {
  return JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
}

test("createAppJwt: header/payload 구조와 클레임이 올바르다", () => {
  // 테스트용 RSA 키쌍 생성
  const { generateKeyPairSync } = require("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" });

  const nowSec = 1_700_000_000;
  const jwt = __test.createAppJwt("123456", pem, nowSec);
  const [h, p, sig] = jwt.split(".");

  assert.deepStrictEqual(decodeSeg(h), { alg: "RS256", typ: "JWT" });
  const payload = decodeSeg(p);
  assert.strictEqual(payload.iss, "123456");
  assert.strictEqual(payload.iat, nowSec - 60);
  assert.strictEqual(payload.exp, nowSec + 540);
  assert.ok(sig && sig.length > 0, "서명 세그먼트가 존재해야 한다");
});

test("signState/verifyState: 라운드트립 성공, 변조/만료 실패", () => {
  const secret = "test-state-secret";
  const nowMs = 1_700_000_000_000;
  const token = __test.signState({ uid: 42 }, secret, nowMs);

  const ok = __test.verifyState(token, secret, nowMs + 60_000);
  assert.strictEqual(ok.uid, 42);

  // 변조: payload 한 글자 바꾸면 검증 실패(null)
  const tampered = "x" + token.slice(1);
  assert.strictEqual(__test.verifyState(tampered, secret, nowMs + 60_000), null);

  // 만료: 10분 초과 시 실패
  assert.strictEqual(__test.verifyState(token, secret, nowMs + 11 * 60_000), null);
});

test("mapRepositories: GitHub 응답을 UI용 형태로 정규화한다", () => {
  const apiJson = {
    repositories: [
      { full_name: "me/private-repo", clone_url: "https://github.com/me/private-repo.git", private: true, default_branch: "main" },
      { full_name: "me/pub", clone_url: "https://github.com/me/pub.git", private: false, default_branch: "master" },
    ],
  };
  const repos = __test.mapRepositories(apiJson);
  assert.deepStrictEqual(repos, [
    { fullName: "me/private-repo", cloneUrl: "https://github.com/me/private-repo.git", private: true, defaultBranch: "main" },
    { fullName: "me/pub", cloneUrl: "https://github.com/me/pub.git", private: false, defaultBranch: "master" },
  ]);
});

test("token 캐시: 만료 5분 전이면 재사용, 그 이후면 재발급", async () => {
  let mintCalls = 0;
  const fakeMint = async () => {
    mintCalls += 1;
    return { token: `tok-${mintCalls}`, expiresAtMs: 1_700_000_000_000 + 60 * 60_000 };
  };
  const cache = __test.createTokenCache(fakeMint);

  const t1 = await cache.get("inst1", 1_700_000_000_000);
  assert.strictEqual(t1, "tok-1");
  // 30분 뒤: 아직 만료 5분 전 여유 있음 → 재사용
  const t2 = await cache.get("inst1", 1_700_000_000_000 + 30 * 60_000);
  assert.strictEqual(t2, "tok-1");
  assert.strictEqual(mintCalls, 1);
  // 56분 뒤: 만료 4분 전 → 재발급
  const t3 = await cache.get("inst1", 1_700_000_000_000 + 56 * 60_000);
  assert.strictEqual(t3, "tok-2");
  assert.strictEqual(mintCalls, 2);
});
