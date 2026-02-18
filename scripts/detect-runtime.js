#!/usr/bin/env node
'use strict';

/**
 * detect-runtime.js <appDir>
 *
 * 주어진 디렉토리의 package.json을 분석하여 런타임 정보를 stdout에 JSON으로 출력한다.
 * create.sh / deploy.sh에서 호출된다.
 */

const fs = require('fs');
const path = require('path');

// 우선순위 순서로 정의. 앞에 있을수록 먼저 감지됨.
const RUNTIME_RULES = [
  {
    dep: 'next',
    runtime: 'nextjs',
    displayName: 'Next.js',
    icon: 'nextjs',
    port: 3000,
    hasBuild: true,
    defaultStartCmd: 'next start',
  },
  {
    dep: '@nestjs/core',
    runtime: 'nestjs',
    displayName: 'NestJS',
    icon: 'nestjs',
    port: 3000,
    hasBuild: true,
    defaultStartCmd: 'node dist/main',
  },
  {
    dep: 'nuxt',
    runtime: 'nuxt',
    displayName: 'Nuxt.js',
    icon: 'nuxt',
    port: 3000,
    hasBuild: true,
    defaultStartCmd: 'node .output/server/index.mjs',
  },
  {
    dep: 'vite',
    runtime: 'vite',
    displayName: 'Vite',
    icon: 'vite',
    port: 4173,
    hasBuild: true,
    defaultStartCmd: 'vite preview',
  },
  {
    dep: 'express',
    runtime: 'express',
    displayName: 'Express',
    icon: 'express',
    port: 3000,
    hasBuild: false,
    defaultStartCmd: null,
  },
  {
    dep: 'fastify',
    runtime: 'fastify',
    displayName: 'Fastify',
    icon: 'fastify',
    port: 3000,
    hasBuild: false,
    defaultStartCmd: null,
  },
  {
    dep: 'koa',
    runtime: 'koa',
    displayName: 'Koa',
    icon: 'koa',
    port: 3000,
    hasBuild: false,
    defaultStartCmd: null,
  },
];

function parseNodeVersion(enginesNode) {
  if (!enginesNode) return '22';
  // ">=18.0.0", "^20", "20.x" 등에서 major 버전 숫자 추출
  const match = enginesNode.match(/(\d+)/);
  return match ? match[1] : '22';
}

function detect(appDir) {
  const pkgPath = path.join(appDir, 'package.json');

  if (!fs.existsSync(pkgPath)) {
    return {
      runtime: 'node',
      displayName: 'Node.js',
      icon: 'nodejs',
      port: 3000,
      nodeVersion: '22',
      hasBuild: false,
      buildCommand: null,
      startCommand: 'node index.js',
    };
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    throw new Error('package.json 파싱 실패: ' + e.message);
  }

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  const nodeVersion = parseNodeVersion(pkg.engines?.node);
  const hasLockFile = fs.existsSync(path.join(appDir, 'package-lock.json'))
    || fs.existsSync(path.join(appDir, 'npm-shrinkwrap.json'));

  for (const rule of RUNTIME_RULES) {
    if (!allDeps[rule.dep]) continue;

    // scripts.build 존재 여부로 실제 빌드 필요성 판단 (프레임워크 기본값보다 우선)
    const hasBuild = rule.hasBuild && !!pkg.scripts?.build;
    const buildCommand = hasBuild ? 'npm run build' : null;

    // scripts.start가 있으면 npm start, 없으면 프레임워크 기본 명령
    const startCommand = pkg.scripts?.start
      ? 'npm start'
      : (rule.defaultStartCmd || 'node index.js');

    return {
      runtime: rule.runtime,
      displayName: rule.displayName,
      icon: rule.icon,
      port: rule.port,
      nodeVersion,
      hasLockFile,
      hasBuild,
      buildCommand,
      startCommand,
    };
  }

  // 매칭 없음 → 기본 Node.js
  return {
    runtime: 'node',
    displayName: 'Node.js',
    icon: 'nodejs',
    port: 3000,
    nodeVersion,
    hasLockFile,
    hasBuild: !!(pkg.scripts?.build),
    buildCommand: pkg.scripts?.build ? 'npm run build' : null,
    startCommand: pkg.scripts?.start ? 'npm start' : 'node index.js',
  };
}

// --- CLI entry point ---

const appDir = process.argv[2];

if (!appDir) {
  process.stderr.write('Usage: detect-runtime.js <appDir>\n');
  process.exit(1);
}

try {
  const result = detect(path.resolve(appDir));
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (e) {
  process.stderr.write('런타임 감지 실패: ' + e.message + '\n');
  process.exit(1);
}
