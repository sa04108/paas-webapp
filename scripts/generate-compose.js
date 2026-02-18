#!/usr/bin/env node
'use strict';

/**
 * generate-compose.js <userid> <appname> <runtimeJson>
 *
 * detect-runtime.js의 출력(JSON)을 받아 {APP_DIR}/docker-compose.yml을 생성한다.
 * - 앱 코드는 이미지에 번들됨 (volumes에 app 디렉토리 미포함)
 * - data 디렉토리만 볼륨으로 마운트
 * - 사용자 repo에 Dockerfile이 있으면 그것을 사용, 없으면 .paas.Dockerfile 사용
 */

const fs = require('node:fs');
const path = require('node:path');

// 환경변수 로드 (common.sh와 동일한 기본값)
const PAAS_ROOT = process.env.PAAS_ROOT || '/paas';
const PAAS_HOST_ROOT = process.env.PAAS_HOST_ROOT || PAAS_ROOT;
const PAAS_APPS_DIR = process.env.PAAS_APPS_DIR || `${PAAS_ROOT}/apps`;
const PAAS_DOMAIN = process.env.PAAS_DOMAIN || 'my.domain.com';
const APP_NETWORK = process.env.APP_NETWORK || 'paas-proxy';
const APP_CONTAINER_PREFIX = process.env.APP_CONTAINER_PREFIX || 'paas-app';
const DEFAULT_MEM_LIMIT = process.env.DEFAULT_MEM_LIMIT || '256m';
const DEFAULT_CPU_LIMIT = process.env.DEFAULT_CPU_LIMIT || '0.5';
const DEFAULT_RESTART_POLICY = process.env.DEFAULT_RESTART_POLICY || 'unless-stopped';

/**
 * common.sh의 to_host_path()와 동일한 역할.
 * 포털 컨테이너 내부 경로 → 호스트 경로로 변환한다.
 * Docker-out-of-Docker 환경에서 볼륨/빌드 컨텍스트 경로는 호스트 관점이어야 한다.
 */
function toHostPath(containerPath) {
  if (!PAAS_HOST_ROOT || PAAS_HOST_ROOT === PAAS_ROOT) {
    return containerPath;
  }
  return containerPath.replace(PAAS_ROOT, PAAS_HOST_ROOT);
}

function normalizeSlash(p) {
  return p.replaceAll('\\', '/');
}

function buildCompose({ userid, appname, runtime, appDir }) {
  const containerName = `${APP_CONTAINER_PREFIX}-${userid}-${appname}`;
  const domain = `${userid}-${appname}.${PAAS_DOMAIN}`;

  const hostAppDir = normalizeSlash(toHostPath(path.join(appDir, 'app')));
  const hostDataDir = normalizeSlash(toHostPath(path.join(appDir, 'data')));

  // 사용자 자체 Dockerfile 여부에 따라 참조할 파일명 결정
  const hasUserDockerfile = fs.existsSync(path.join(appDir, 'app', 'Dockerfile'));
  const dockerfileRef = hasUserDockerfile ? 'Dockerfile' : '.paas.Dockerfile';

  const lines = [
    'services:',
    '  app:',
    '    build:',
    `      context: ${JSON.stringify(hostAppDir)}`,
    `      dockerfile: ${JSON.stringify(dockerfileRef)}`,
    `    container_name: ${JSON.stringify(containerName)}`,
    `    restart: ${JSON.stringify(DEFAULT_RESTART_POLICY)}`,
    '    volumes:',
    `      - ${JSON.stringify(`${hostDataDir}:/data`)}`,
    '    environment:',
    `      - ${JSON.stringify(`PORT=${runtime.port}`)}`,
    `      - ${JSON.stringify(`APP_ID=${userid}-${appname}`)}`,
    '      - "NODE_ENV=production"',
    `    mem_limit: ${JSON.stringify(DEFAULT_MEM_LIMIT)}`,
    `    cpus: ${DEFAULT_CPU_LIMIT}`,
    '    networks:',
    '      - paas-proxy',
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
    '  paas-proxy:',
    '    external: true',
    `    name: ${JSON.stringify(APP_NETWORK)}`,
    '',
  ];

  return lines.join('\n');
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
const composePath = path.join(appDir, 'docker-compose.yml');

try {
  const content = buildCompose({ userid, appname, runtime, appDir });
  fs.writeFileSync(composePath, content);
  process.stdout.write(`[generate-compose] 생성 완료: ${composePath}\n`);
} catch (e) {
  process.stderr.write(`docker-compose.yml 생성 실패: ${e.message}\n`);
  process.exit(1);
}
