"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");

// 서버와 프런트엔드 감시를 같은 수명으로 관리한다. 최초 검사는 predev가 수행한다.
const children = new Set();
let stopping = false;
let shutdownTimer;

function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill("SIGTERM");
  shutdownTimer = setTimeout(() => {
    for (const child of children) child.kill("SIGKILL");
  }, 5000);
  shutdownTimer.unref();
}

function start(args) {
  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    stdio: "inherit",
  });
  children.add(child);
  child.once("error", (error) => {
    console.error(`[dev] ${error.message}`);
    stop(1);
  });
  child.once("close", (code) => {
    children.delete(child);
    if (!stopping) stop(code || 1);
    if (!children.size) clearTimeout(shutdownTimer);
  });
}

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));

start([path.join(__dirname, "node_modules/vite/bin/vite.js"), "build", "--watch"]);
start(["--watch", "server.js"]);
