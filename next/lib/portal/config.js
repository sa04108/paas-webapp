// =============================================================================
// config.js - 환경 설정 로딩
// =============================================================================
// 역할:
//   .env 파일을 읽어 서버 전반에서 공유되는 설정 객체와 상수를 제공한다.
//   dotenv를 가장 먼저 실행해야 하므로 server.js 진입 직후 require된다.
// =============================================================================
"use strict";

const path = require("node:path");
const fs = require("node:fs");
const dotenv = require("dotenv");
const { toPositiveInt, normalizeBoolean } = require("./utils");

// Next.js가 lib/portal을 번들하면 __dirname이 .next/server/... 로 바뀌므로
// 경로 계산에 __dirname을 쓰지 않는다. cwd는 항상 next/ (npm scripts / compose)를 가정.
function resolveRepoRoot() {
  if (process.env.PAAS_ROOT) {
    return path.resolve(process.env.PAAS_ROOT);
  }
  const cwd = process.cwd();
  if (path.basename(cwd) === "next") {
    return path.resolve(cwd, "..");
  }
  if (fs.existsSync(path.join(cwd, "next")) && fs.existsSync(path.join(cwd, "scripts"))) {
    return cwd;
  }
  return path.resolve(cwd, "..");
}

const repoRoot = resolveRepoRoot();
const envFilePath = process.env.PAAS_ENV_FILE || path.join(repoRoot, ".env");

// dotenv는 이미 설정된 환경변수를 덮어쓰지 않는다.
// Docker Compose나 CI/CD 환경에서 미리 주입한 값이 .env보다 우선된다.
dotenv.config({ path: envFilePath });

const paasRoot = process.env.PAAS_ROOT || repoRoot;

const config = {
  PAAS_DOMAIN:        process.env.PAAS_DOMAIN || "my.domain.com",
  TRAEFIK_HOST_PORT:  toPositiveInt(process.env.TRAEFIK_HOST_PORT, 18080),
  PAAS_APPS_DIR:      process.env.PAAS_APPS_DIR || path.join(paasRoot, "apps"),
  PAAS_SCRIPTS_DIR:   process.env.PAAS_SCRIPTS_DIR || path.join(paasRoot, "scripts"),
  PORTAL_PORT:        toPositiveInt(process.env.PORTAL_PORT, 3000),
  PORTAL_DB_PATH:     process.env.PORTAL_DB_PATH || path.join(paasRoot, "portal-data", "portal.sqlite3"),
  SESSION_COOKIE_NAME:  process.env.SESSION_COOKIE_NAME || "portal_session",
  SESSION_TTL_HOURS:    toPositiveInt(process.env.SESSION_TTL_HOURS, 168),
  PORTAL_COOKIE_SECURE: normalizeBoolean(process.env.PORTAL_COOKIE_SECURE, false),
  BCRYPT_ROUNDS:        toPositiveInt(process.env.BCRYPT_ROUNDS, 10),
  MAX_APPS_PER_USER:    toPositiveInt(process.env.MAX_APPS_PER_USER, 5),
  MAX_TOTAL_APPS:       toPositiveInt(process.env.MAX_TOTAL_APPS, 20),
  PORTAL_TRUST_PROXY:   normalizeBoolean(process.env.PORTAL_TRUST_PROXY, true),

  // ── GitHub App (private repo 배포) ──────────────────────────────────────
  GITHUB_APP_ID:      process.env.GITHUB_APP_ID || "",
  GITHUB_APP_SLUG:    process.env.GITHUB_APP_SLUG || "",
  GITHUB_APP_CLIENT_ID: process.env.GITHUB_APP_CLIENT_ID || "",
  // 개인키는 PEM 본문(개행 포함) 또는 파일 경로 중 하나로 주입한다.
  GITHUB_APP_PRIVATE_KEY:      process.env.GITHUB_APP_PRIVATE_KEY || "",
  GITHUB_APP_PRIVATE_KEY_PATH: process.env.GITHUB_APP_PRIVATE_KEY_PATH || "",
  // CLIENT_SECRET, STATE_SECRET은 비밀이므로 config 객체에 두지 않고 githubService가 process.env에서 직접 읽는다.
};

// =============================================================================
// 실행 환경 판별 — RUN_MODE 환경변수로 dev/prod를 구분한다.
// =============================================================================
// RUN_MODE=development (docker-compose.dev.yml이 주입):
//   scripts/generate-compose.js → 호스트 포트 직접 노출 (20000-29999 범위)
//                                  로컬 브릿지 네트워크 (external 없음)
// RUN_MODE=production (기본값):
//   scripts/generate-compose.js → 포트 노출 없음, external 네트워크 사용
// .sh 스크립트(create, deploy, delete)는 dev/prod 공통이다.
const IS_DEV = process.env.RUN_MODE === "development";

// 앱 생명주기를 처리하는 셸 스크립트 파일명 목록
const RUNNER_SCRIPTS = {
  create: "create.sh",
  deploy: "deploy.sh",
  delete: "delete.sh",
};

// 입력값 검증용 정규식
const USER_ID_REGEX  = /^[A-Za-z0-9]{3,20}$/;
const APP_NAME_REGEX = /^[A-Za-z0-9-]{3,30}$/;

// 앱 디렉터리 내 관리 파일명
const APP_META_FILE    = ".paas-meta.json";
const APP_COMPOSE_FILE = "docker-compose.yml";

module.exports = {
  config,
  envFilePath,
  IS_DEV,
  RUNNER_SCRIPTS,
  USER_ID_REGEX,
  APP_NAME_REGEX,
  APP_META_FILE,
  APP_COMPOSE_FILE,
};
