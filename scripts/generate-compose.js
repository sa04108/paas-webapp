#!/usr/bin/env node
'use strict';

/**
 * generate-compose.js <userid> <appname> <runtimeJson>
 *
 * detect-runtime.js의 출력(JSON)을 받아 {APP_DIR}/docker-compose.yml을 생성한다.
 *
 * 환경 분기:
 *   RUN_MODE=development  → 호스트 포트 직접 노출.
 *                           사용자 Dockerfile에 EXPOSE가 있으면 그 포트를 호스트 포트로 사용.
 *                           없으면 djb2 해시로 20000-29999 범위에서 결정.
 *   RUN_MODE=production   → 포트 노출 없음, external 네트워크 사용 (리버스 프록시 라우팅)
 */

const fs = require('node:fs');
const path = require('node:path');

// --- 환경변수 (common.sh / .env 와 동일한 이름) ---
const PAAS_ROOT             = process.env.PAAS_ROOT             || '/paas';
const PAAS_APPS_DIR         = process.env.PAAS_APPS_DIR         || `${PAAS_ROOT}/apps`;
const PAAS_DOMAIN           = process.env.PAAS_DOMAIN           || 'my.domain.com';
const APP_NETWORK           = process.env.APP_NETWORK           || 'paas-app';
const APP_CONTAINER_PREFIX  = process.env.APP_CONTAINER_PREFIX  || 'paas-app';
const APP_SOURCE_SUBDIR     = process.env.APP_SOURCE_SUBDIR     || 'app';
const APP_DATA_SUBDIR       = process.env.APP_DATA_SUBDIR       || 'data';
const APP_COMPOSE_FILE      = process.env.APP_COMPOSE_FILE      || 'docker-compose.yml';
const DEFAULT_MEM_LIMIT     = process.env.DEFAULT_MEM_LIMIT     || '256m';
const DEFAULT_CPU_LIMIT     = process.env.DEFAULT_CPU_LIMIT     || '0.5';
const DEFAULT_RESTART_POLICY = process.env.DEFAULT_RESTART_POLICY || 'unless-stopped';

// --- 내부 규약 파일명 ---
const PAAS_DOCKERFILE_NAME = '.paas.Dockerfile';

const IS_DEV = process.env.RUN_MODE === 'development';

// --- 유틸 ---

/**
 * Dockerfile의 첫 번째 EXPOSE 포트를 파싱한다.
 * 없거나 읽기 실패 시 null 반환.
 */
function parseDockerfileExposePort(dockerfilePath) {
  try {
    const content = fs.readFileSync(dockerfilePath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (/^EXPOSE\s+\d+/i.test(trimmed)) {
        const port = Number.parseInt(trimmed.split(/\s+/)[1], 10);
        if (port > 0 && port <= 65535) return port;
      }
    }
  } catch {
    // Dockerfile 없음 또는 읽기 실패 → null 반환
  }
  return null;
}

/**
 * 앱별 결정적 호스트 포트 산출 (djb2 변형, 20000-29999 범위).
 * dev 환경에서만 사용.
 */
function resolveHostPort(userid, appname) {
  let hash = 5381;
  for (const ch of `${userid}/${appname}`) {
    hash = (((hash << 5) + hash) ^ ch.charCodeAt(0)) >>> 0;
  }
  return 20000 + (hash % 10000);
}

// --- compose 생성 ---

/**
 * @returns {{ content: string, hostPort: number, containerPort: number }}
 */
function buildCompose({ userid, appname, runtime, appDir }) {
  const containerName = `${APP_CONTAINER_PREFIX}-${userid}-${appname}`;
  const domain = `${userid}-${appname}.${PAAS_DOMAIN}`;

  const userDockerfilePath = path.join(appDir, APP_SOURCE_SUBDIR, 'Dockerfile');
  const hasUserDockerfile = fs.existsSync(userDockerfilePath);
  const dockerfileRef = hasUserDockerfile ? 'Dockerfile' : PAAS_DOCKERFILE_NAME;

  // dev 모드 포트: 사용자 Dockerfile의 EXPOSE 포트 우선, 없으면 djb2 해시 산출
  const exposePort = (IS_DEV && hasUserDockerfile)
    ? parseDockerfileExposePort(userDockerfilePath)
    : null;
  const hostPort = exposePort ?? resolveHostPort(userid, appname);
  const containerPort = exposePort ?? runtime.port;

  const portsLines = IS_DEV
    ? ['    ports:', `      - "0.0.0.0:${hostPort}:${containerPort}"`]
    : [];

  const content = [
    'services:',
    '  app:',
    '    build:',
    `      context: ./${APP_SOURCE_SUBDIR}`,
    `      dockerfile: ${JSON.stringify(dockerfileRef)}`,
    `    container_name: ${JSON.stringify(containerName)}`,
    `    restart: ${JSON.stringify(DEFAULT_RESTART_POLICY)}`,
    ...portsLines,
    '    volumes:',
    `      - "./${APP_DATA_SUBDIR}:/data"`,
    '    environment:',
    `      - ${JSON.stringify(`PORT=${containerPort}`)}`,
    `      - ${JSON.stringify(`APP_ID=${userid}-${appname}`)}`,
    '      - "NODE_ENV=production"',
    `    mem_limit: ${JSON.stringify(DEFAULT_MEM_LIMIT)}`,
    `    cpus: ${DEFAULT_CPU_LIMIT}`,
    '    networks:',
    `      - ${APP_NETWORK}`,
    '    labels:',
    `      - ${JSON.stringify('paas.type=user-app')}`,
    `      - ${JSON.stringify(`paas.userid=${userid}`)}`,
    `      - ${JSON.stringify(`paas.appname=${appname}`)}`,
    `      - ${JSON.stringify(`paas.domain=${domain}`)}`,
    '    logging:',
    '      driver: json-file',
    '      options:',
    '        max-size: "10m"',
    '        max-file: "3"',
    '',
    'networks:',
    `  ${APP_NETWORK}:`,
    '    external: true',
    `    name: ${JSON.stringify(APP_NETWORK)}`,
    '',
  ].join('\n');

  return { content, hostPort, containerPort };
}

// --- CLI entry point ---

const userid = process.argv[2];
const appname = process.argv[3];
const runtimeJson = process.argv[4];

if (!userid || !appname || !runtimeJson) {
  process.stderr.write('Usage: generate-compose.js <userid> <appname> <runtimeJson>\n');
  process.exit(1);
}

let runtime;
try {
  runtime = JSON.parse(runtimeJson);
} catch (e) {
  process.stderr.write(`runtimeJson 파싱 실패: ${e.message}\n`);
  process.exit(1);
}

const appDir = path.resolve(PAAS_APPS_DIR, userid, appname);
const composePath = path.join(appDir, APP_COMPOSE_FILE);

try {
  const { content, hostPort, containerPort } = buildCompose({ userid, appname, runtime, appDir });
  fs.writeFileSync(composePath, content);
  process.stdout.write(`[generate-compose] 생성 완료: ${composePath}\n`);
  if (IS_DEV) {
    process.stdout.write(`[generate-compose] 호스트 포트: ${hostPort} → 컨테이너 포트: ${containerPort}\n`);
  }
} catch (e) {
  process.stderr.write(`docker-compose.yml 생성 실패: ${e.message}\n`);
  process.exit(1);
}
