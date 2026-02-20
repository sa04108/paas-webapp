#!/usr/bin/env node
'use strict';

/**
 * detect-runtime.js <appDir>
 *
 * 주어진 디렉토리의 package.json을 분석하여 런타임 정보를 stdout에 JSON으로 출력한다.
 * create.sh / deploy.sh에서 호출된다.
 *
 * 반환 JSON:
 *   runtime, displayName, icon   - 주요 런타임 (Dockerfile 생성 기준)
 *   nodeVersion, hasLockFile
 *   hasBuild, buildCommand, startCommand
 *   dependencies                 - 감지된 모든 의존성 목록 (App 카드 표시용)
 *                                  Node.js 는 항상 첫 번째로 포함된다.
 *
 * 내부 포트(컨테이너 포트)는 항상 5000으로 고정되며,
 * 이 파일에서는 포트를 결정하지 않는다.
 */

const fs = require('fs');
const path = require('path');

// 우선순위 순서로 정의. isFramework=true인 항목 중 첫 번째가 주요 런타임이 된다.
// isFramework=false 항목은 표시 전용(Dockerfile 생성에 영향 없음).
const RUNTIME_RULES = [
  // --- 프레임워크 (주요 런타임 후보, 우선순위 순) ---
  {
    dep: 'next',
    runtime: 'nextjs',
    displayName: 'Next.js',
    icon: 'nextjs',
    isFramework: true,
    hasBuild: true,
    defaultStartCmd: 'next start',
  },
  {
    dep: '@nestjs/core',
    runtime: 'nestjs',
    displayName: 'NestJS',
    icon: 'nestjs',
    isFramework: true,
    hasBuild: true,
    defaultStartCmd: 'node dist/main',
  },
  {
    dep: 'nuxt',
    runtime: 'nuxt',
    displayName: 'Nuxt.js',
    icon: 'nuxt',
    isFramework: true,
    hasBuild: true,
    defaultStartCmd: 'node .output/server/index.mjs',
  },
  {
    dep: 'vite',
    runtime: 'vite',
    displayName: 'Vite',
    icon: 'vite',
    isFramework: true,
    hasBuild: true,
    defaultStartCmd: 'vite preview',
  },
  {
    dep: 'express',
    runtime: 'express',
    displayName: 'Express',
    icon: 'express',
    isFramework: true,
    hasBuild: false,
    defaultStartCmd: null,
  },
  {
    dep: 'fastify',
    runtime: 'fastify',
    displayName: 'Fastify',
    icon: 'fastify',
    isFramework: true,
    hasBuild: false,
    defaultStartCmd: null,
  },
  {
    dep: 'koa',
    runtime: 'koa',
    displayName: 'Koa',
    icon: 'koa',
    isFramework: true,
    hasBuild: false,
    defaultStartCmd: null,
  },
  // --- 라이브러리 / 도구 (표시 전용) ---
  {
    dep: 'react',
    runtime: 'react',
    displayName: 'React',
    icon: 'react',
    isFramework: false,
  },
  {
    dep: 'vue',
    runtime: 'vue',
    displayName: 'Vue',
    icon: 'vue',
    isFramework: false,
  },
  {
    dep: 'tailwindcss',
    runtime: 'tailwind',
    displayName: 'Tailwind CSS',
    icon: 'tailwind',
    isFramework: false,
  },
  {
    dep: 'typescript',
    runtime: 'typescript',
    displayName: 'TypeScript',
    icon: 'typescript',
    isFramework: false,
  },
  {
    dep: 'prisma',
    runtime: 'prisma',
    displayName: 'Prisma',
    icon: 'prisma',
    isFramework: false,
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
      nodeVersion: '22',
      hasBuild: false,
      buildCommand: null,
      startCommand: 'node index.js',
      dependencies: [{ name: 'nodejs', displayName: 'Node.js', icon: 'nodejs' }],
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

  // 매칭된 모든 규칙 수집 (순서 유지)
  const matchedRules = RUNTIME_RULES.filter(rule => !!allDeps[rule.dep]);

  // 의존성 목록: Node.js 항상 첫 번째, 이후 매칭된 순서대로
  const dependencies = [
    { name: 'nodejs', displayName: 'Node.js', icon: 'nodejs' },
    ...matchedRules.map(r => ({ name: r.runtime, displayName: r.displayName, icon: r.icon })),
  ];

  // 주요 런타임: 첫 번째 프레임워크 규칙
  const primaryRule = matchedRules.find(r => r.isFramework);

  if (primaryRule) {
    // scripts.build 존재 여부로 실제 빌드 필요성 판단 (프레임워크 기본값보다 우선)
    const hasBuild = primaryRule.hasBuild && !!pkg.scripts?.build;
    const buildCommand = hasBuild ? 'npm run build' : null;

    // scripts.start가 있으면 npm start, 없으면 프레임워크 기본 명령
    const startCommand = pkg.scripts?.start
      ? 'npm start'
      : (primaryRule.defaultStartCmd || 'node index.js');

    return {
      runtime: primaryRule.runtime,
      displayName: primaryRule.displayName,
      icon: primaryRule.icon,
      nodeVersion,
      hasLockFile,
      hasBuild,
      buildCommand,
      startCommand,
      dependencies,
    };
  }

  // 매칭 없음 → 기본 Node.js
  return {
    runtime: 'node',
    displayName: 'Node.js',
    icon: 'nodejs',
    nodeVersion,
    hasLockFile,
    hasBuild: !!(pkg.scripts?.build),
    buildCommand: pkg.scripts?.build ? 'npm run build' : null,
    startCommand: pkg.scripts?.start ? 'npm start' : 'node index.js',
    dependencies,
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
