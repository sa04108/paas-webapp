// =============================================================================
// githubService.js - GitHub App 인증 코어
// =============================================================================
// 역할:
//   GitHub App 개인키(PEM)로 JWT를 서명하고, 그것으로 installation access token
//   (1시간 만료, repo 스코프)을 발급/캐시한다. 설치된 repo 목록 조회와
//   OAuth 설치 플로우의 CSRF용 state 서명/검증도 담당한다.
//   비밀(PEM, state secret)은 이 모듈만 메모리에 보유한다. 토큰은 디스크에 저장하지 않는다.
// =============================================================================
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const { AppError } = require("./utils");

const GITHUB_API = "https://api.github.com";

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// ── 순수 로직 (테스트 대상) ──────────────────────────────────────────────────

// App JWT 서명 (RS256). nowSec를 인자로 받아 테스트 가능하게 한다.
function createAppJwt(appId, privateKeyPem, nowSec) {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // GitHub 권장: iat는 시계 오차 대비 60초 과거, exp는 최대 10분(여기선 9분)
  const payload = base64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: String(appId) }));
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKeyPem);
  return `${signingInput}.${base64url(signature)}`;
}

// CSRF/세션 바인딩용 stateless 서명 토큰: base64url(payload).hmac
function signState(payloadObj, secret, nowMs) {
  const body = base64url(JSON.stringify({ ...payloadObj, ts: nowMs }));
  const mac = base64url(crypto.createHmac("sha256", secret).update(body).digest());
  return `${body}.${mac}`;
}

// 10분 이내 + HMAC 일치면 payload 반환, 아니면 null
function verifyState(token, secret, nowMs) {
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;
  const [body, mac] = parts;
  const expected = base64url(crypto.createHmac("sha256", secret).update(body).digest());
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed.ts !== "number" || nowMs - parsed.ts > 10 * 60_000) return null;
  return parsed;
}

function mapRepositories(apiJson) {
  const list = Array.isArray(apiJson?.repositories) ? apiJson.repositories : [];
  return list.map((r) => ({
    fullName: r.full_name,
    cloneUrl: r.clone_url,
    private: Boolean(r.private),
    defaultBranch: r.default_branch || "main",
  }));
}

// installationId별 토큰 캐시. mintFn(installationId) -> { token, expiresAtMs }
function createTokenCache(mintFn) {
  const cache = new Map();   // installationId -> { token, expiresAtMs }
  const inflight = new Map(); // installationId -> Promise<{ token, expiresAtMs }>
  const SKEW_MS = 5 * 60_000; // 만료 5분 전이면 갱신
  async function get(installationId, nowMs) {
    const hit = cache.get(installationId);
    if (hit && hit.expiresAtMs - nowMs > SKEW_MS) return hit.token;
    // 동일 installationId에 대한 동시 발급 요청을 하나로 합친다.
    let pending = inflight.get(installationId);
    if (!pending) {
      pending = mintFn(installationId).finally(() => inflight.delete(installationId));
      inflight.set(installationId, pending);
    }
    const fresh = await pending;
    cache.set(installationId, fresh);
    return fresh.token;
  }
  return { get };
}

// ── 팩토리 (I/O 결합) ────────────────────────────────────────────────────────

function loadPrivateKey(config) {
  if (config.GITHUB_APP_PRIVATE_KEY) return config.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  if (config.GITHUB_APP_PRIVATE_KEY_PATH) return fs.readFileSync(config.GITHUB_APP_PRIVATE_KEY_PATH, "utf8");
  return "";
}

/**
 * @param {object} deps
 * @param {object} deps.config         - config.js의 config 객체
 * @param {object} deps.statements     - authService.getStatements() (github_installations 쿼리 포함)
 * @param {() => number} [deps.now]    - 현재 ms (테스트 주입용, 기본 Date.now)
 */
function createGithubService({ config, statements, now = () => Date.now() }) {
  const privateKey = loadPrivateKey(config);
  const stateSecret = process.env.GITHUB_STATE_SECRET || "";
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET || "";

  const configured = Boolean(
    config.GITHUB_APP_ID &&
    privateKey &&
    config.GITHUB_APP_SLUG &&
    config.GITHUB_APP_CLIENT_ID &&
    clientSecret &&
    stateSecret
  );

  function assertConfigured() {
    if (!configured) {
      throw new AppError(503, "GitHub App이 설정되지 않았습니다. 운영자에게 문의하세요.");
    }
  }

  async function githubApi(pathname, { method = "GET", token, jwt } = {}) {
    if (!jwt && !token) {
      throw new Error("githubApi: jwt 또는 token이 필요합니다");
    }
    const res = await fetch(`${GITHUB_API}${pathname}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "paas-portal",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${jwt || token}`,
      },
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new AppError(502, `GitHub API ${pathname} 응답 파싱 실패`);
    }
    if (!res.ok) {
      throw new AppError(res.status === 404 ? 404 : 502, `GitHub API ${pathname} 실패 (${res.status})`);
    }
    return json;
  }

  async function mintInstallationToken(installationId) {
    assertConfigured();
    const jwt = createAppJwt(config.GITHUB_APP_ID, privateKey, Math.floor(now() / 1000));
    const json = await githubApi(`/app/installations/${installationId}/access_tokens`, { method: "POST", jwt });
    return { token: json.token, expiresAtMs: Date.parse(json.expires_at) };
  }

  const tokenCache = createTokenCache(mintInstallationToken);

  // OAuth: 설치 콜백의 code를 user access token으로 교환한다.
  async function exchangeCodeForUserToken(code) {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "paas-portal",
      },
      body: JSON.stringify({
        client_id: config.GITHUB_APP_CLIENT_ID,
        client_secret: clientSecret,
        code,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      throw new AppError(502, "GitHub OAuth 토큰 교환에 실패했습니다.");
    }
    return json.access_token;
  }

  // 해당 user token이 접근 가능한 App 설치 목록
  async function listUserInstallations(userToken) {
    const json = await githubApi("/user/installations?per_page=100", { token: userToken });
    return Array.isArray(json.installations) ? json.installations : [];
  }

  // ── 공개 API ──
  function isConfigured() {
    return configured;
  }

  function buildInstallUrl(userId) {
    assertConfigured();
    // "OAuth during installation"이 켜져 있으면 설치 후 Callback URL로 code+state+installation_id가 온다.
    const state = signState({ uid: userId }, stateSecret, now());
    return `https://github.com/apps/${config.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}`;
  }

  // OAuth Callback: state 검증 → code 교환 → 사용자가 해당 설치 권한자인지 확인 → 매핑 저장.
  // 반환: { userId } | null(검증 실패)
  async function completeInstall({ code, state, installationId }) {
    assertConfigured();
    const parsed = verifyState(state, stateSecret, now());
    if (!parsed) return null;

    // code → user token → /user/installations로 소유 검증 (위변조된 installation_id 방지)
    const userToken = await exchangeCodeForUserToken(code);
    const installations = await listUserInstallations(userToken);
    const owns = installations.some((i) => String(i.id) === String(installationId));
    if (!owns) return null;

    const nowIso = new Date(now()).toISOString();
    statements.upsertGithubInstallation.run(parsed.uid, String(installationId), nowIso, nowIso);
    return { userId: parsed.uid };
  }

  function getInstallationId(userId) {
    const row = statements.selectGithubInstallationByUserId.get(userId);
    return row ? row.github_installation_id : null;
  }

  function disconnect(userId) {
    statements.deleteGithubInstallationByUserId.run(userId);
  }

  // 사용자에게 설치된 repo 목록
  async function listReposForUser(userId) {
    assertConfigured();
    const installationId = getInstallationId(userId);
    if (!installationId) return { connected: false, repos: [] };
    const token = await tokenCache.get(installationId, now());
    const json = await githubApi("/installation/repositories?per_page=100", { token });
    return { connected: true, repos: mapRepositories(json) };
  }

  // git 작업용 fresh 토큰 (apps.js executeJob에서 호출)
  async function getCloneToken(installationId) {
    assertConfigured();
    return tokenCache.get(installationId, now());
  }

  return {
    isConfigured,
    buildInstallUrl,
    completeInstall,
    getInstallationId,
    disconnect,
    listReposForUser,
    getCloneToken,
  };
}

module.exports = {
  createGithubService,
  // 단위 테스트 전용 노출
  __test: { createAppJwt, signState, verifyState, mapRepositories, createTokenCache },
};
