// =============================================================================
// server.mjs - PaaS 포털 커스텀 Next.js 서버
// =============================================================================
// 역할:
//   Next.js의 기본 `next start` 서버로는 WebSocket 업그레이드(exec 터미널 스트리밍)를
//   처리할 수 없으므로, 이를 위해 커스텀 HTTP 서버를 둔다.
//   - Next.js 요청 핸들링은 그대로 next()의 requestHandler에 위임한다.
//   - /api/apps/:userid/:appname/exec/ws 로 들어오는 업그레이드만 가로채 exec-ws
//     핸들러(dockerode TTY exec)로 연결하고, 그 외 업그레이드(HMR 등)는 Next.js
//     자체 업그레이드 핸들러로 넘긴다.
//   - 시작 시 getRuntime()을 호출해 SQLite/도메인/GitHub/Job 초기화를 선행한다.
// =============================================================================
import { createServer } from "node:http";
import { parse } from "node:url";
import next from "next";
import { WebSocketServer } from "ws";

// lib/portal/*.js는 CommonJS 모듈이다. Node ESM에서 module.exports 객체 전체가
// default export로 들어오므로 구조 분해로 꺼내 쓴다.
import runtimeModule from "./lib/portal/runtime.js";
import execWsModule from "./lib/portal/routes/exec-ws.js";
import appManagerModule from "./lib/portal/appManager.js";

const { getRuntime } = runtimeModule;
const { createExecWsHandler, parseExecWsUrl } = execWsModule;
const { findDockerApp, getDockerContainer } = appManagerModule;

const dev = process.env.NODE_ENV !== "production";
const app = next({ dev });

async function main() {
  await app.prepare();
  // getRequestHandler()/getUpgradeHandler()는 prepare() 완료 후에만 안전하게 호출 가능하다.
  const handleRequest = app.getRequestHandler();
  const handleNextUpgrade = app.getUpgradeHandler();
  const runtime = await getRuntime();

  const server = createServer((req, res) => {
    handleRequest(req, res, parse(req.url, true));
  });

  // ── WebSocket 서버 (exec 스트리밍) ─────────────────────────────────────────
  // noServer: true — 업그레이드를 아래에서 직접 라우팅한다.
  const wss = new WebSocketServer({ noServer: true });
  const handleExecWs = createExecWsHandler({
    resolveSessionAuth: (req) => runtime.authService.resolveSessionAuth(req),
    findDockerApp,
    getDockerContainer,
  });
  wss.on("connection", handleExecWs);

  server.on("upgrade", (req, socket, head) => {
    const params = parseExecWsUrl(req.url?.split("?")[0]);
    if (!params) {
      // exec-ws 경로가 아니면 Next.js(HMR 등)에게 그대로 위임한다.
      handleNextUpgrade(req, socket, head);
      return;
    }

    // 세션 검증 — cookie 기반이므로 req 객체만 있으면 충분하다.
    const auth = runtime.authService.resolveSessionAuth(req);
    if (!auth) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    // exec-ws.js가 재조회 없이 재사용할 수 있도록 req에 첨부한다.
    req._wsAuth = auth;

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  server.listen(runtime.config.PORTAL_PORT, () => {
    console.log(`[portal] listening on http://localhost:${runtime.config.PORTAL_PORT}`);
    console.log(`[portal] env: ${runtime.envFilePath}`);
    console.log(`[portal] apps dir: ${runtime.config.PAAS_APPS_DIR}`);
    console.log(`[portal] db: ${runtime.authService.getDbPath()}`);
  });
}

main().catch((error) => {
  console.error("[portal] failed to start:", error);
  process.exit(1);
});
