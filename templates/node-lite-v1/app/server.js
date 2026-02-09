// =============================================================================
// server.js - Node Lite v1 템플릿 앱 (사용자 앱의 시작점)
// =============================================================================
// 역할:
//   PaaS에서 제공하는 Node.js 실행 환경의 기본 템플릿이다.
//   사용자가 앱을 생성하면 이 파일이 복사되며,
//   사용자는 이 코드를 자유롭게 수정하여 자신만의 로직을 구현한다.
//
//   기본 제공 엔드포인트:
//   - GET  /            : 헬스체크 및 엔드포인트 안내
//   - GET  /app/info    : 앱 메타데이터 (appId, node 버전, 현재 시각)
//   - POST /app/execute : JSON payload를 받아 처리하는 예시
//
//   환경변수:
//   - PORT     : 컨테이너 내부 포트 (기본 3000)
//   - APP_ID   : 앱 식별자 ({userid}-{appname})
//   - DATA_DIR : 영속 데이터 디렉토리 (/data)
// =============================================================================
"use strict";

const http = require("node:http");
const { randomUUID } = require("node:crypto");

const PORT = Number.parseInt(process.env.PORT || "3000", 10) || 3000;
const APP_ID = process.env.APP_ID || "node-lite-app";

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return null;
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

const server = http.createServer(async (req, res) => {
  const method = String(req.method || "GET").toUpperCase();
  const path = String(req.url || "/");

  if (method === "GET" && path === "/") {
    return sendJson(res, 200, {
      ok: true,
      appId: APP_ID,
      message: "Node app is ready",
      endpoints: {
        info: "GET /app/info",
        execute: "POST /app/execute"
      }
    });
  }

  if (method === "GET" && path === "/app/info") {
    return sendJson(res, 200, {
      ok: true,
      appId: APP_ID,
      node: process.version,
      now: new Date().toISOString()
    });
  }

  if (method === "POST" && path === "/app/execute") {
    const payload = await readJsonBody(req);
    return sendJson(res, 200, {
      ok: true,
      appId: APP_ID,
      executionId: randomUUID(),
      received: payload,
      now: new Date().toISOString()
    });
  }

  return sendJson(res, 404, {
    ok: false,
    error: "Not found"
  });
});

server.listen(PORT, () => {
  console.log(`[app] ${APP_ID} listening on ${PORT}`);
});
