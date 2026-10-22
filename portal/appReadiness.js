"use strict";

const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const Database = require("better-sqlite3");
const { config, IS_DEV } = require("./config");
const { AppError } = require("./utils");

const probes = new Map();
let db;
let checkServices = async () => true;

function setServiceChecker(checker) { checkServices = checker; }

function init(dbPath) {
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_readiness (
      userid TEXT NOT NULL,
      appname TEXT NOT NULL,
      generation TEXT NOT NULL,
      phase TEXT NOT NULL,
      last_status INTEGER,
      checked_at INTEGER,
      error TEXT,
      PRIMARY KEY (userid, appname)
    );
    UPDATE app_readiness SET phase = 'failed', error = 'Interrupted by a portal restart'
    WHERE phase IN ('deploying', 'checking');
  `);
}

function keyFor(userid, appname) {
  return [userid.toLowerCase(), appname.toLowerCase()];
}

function read(userid, appname) {
  return db?.prepare("SELECT * FROM app_readiness WHERE userid = ? AND appname = ?")
    .get(...keyFor(userid, appname));
}

// 공개 URL만 검사하며 앱 입력이나 컨테이너 레이블을 목적지로 사용하지 않는다.
function healthUrl(userid, appname) {
  const domain = `${userid}-${appname}.apps.${config.PAAS_DOMAIN}`;
  return IS_DEV ? `http://${domain}:${config.TRAEFIK_HOST_PORT}/` : `https://${domain}/`;
}

function begin(userid, appname, generation) {
  db.prepare(`
    INSERT INTO app_readiness (userid, appname, generation, phase)
    VALUES (?, ?, ?, 'deploying')
    ON CONFLICT(userid, appname) DO UPDATE SET generation = excluded.generation,
      phase = 'deploying', last_status = NULL, checked_at = NULL, error = NULL
  `).run(...keyFor(userid, appname), generation);
}

function fail(userid, appname, generation) {
  db.prepare(`
    UPDATE app_readiness SET phase = 'failed' WHERE userid = ? AND appname = ?
      AND generation = ? AND phase != 'ready'
  `).run(...keyFor(userid, appname), generation);
}

function remove(userid, appname) {
  db.prepare("DELETE FROM app_readiness WHERE userid = ? AND appname = ?")
    .run(...keyFor(userid, appname));
}

async function requestStatus(url, timeoutMs) {
  // curl은 기존 프록시·CA 설정을 따르며, 리다이렉트와 응답 본문은 소비하지 않는다.
  const args = ["--disable", "--silent", "--show-error", "--output", "/dev/null", "--dump-header", "-",
    "--suppress-connect-headers", "--no-buffer",
    "--max-time", String(timeoutMs / 1000), "--header", "Cache-Control: no-cache",
    "--user-agent", "PaaS-Readiness/1.0"];
  const target = new URL(url);
  if (IS_DEV && config.APP_HEALTH_DEV_ORIGIN) {
    // 개발용 Docker 네트워크에서도 외부 URL의 Host 헤더로 Traefik 라우팅을 검증한다.
    let origin;
    try { origin = new URL(config.APP_HEALTH_DEV_ORIGIN); }
    catch { return { status: null, error: "Invalid APP_HEALTH_DEV_ORIGIN" }; }
    if (origin.protocol !== "http:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
      return { status: null, error: "Invalid APP_HEALTH_DEV_ORIGIN" };
    }
    args.push("--connect-to", `${target.hostname}:${target.port}:${origin.hostname}:${origin.port || 80}`);
  }
  if (IS_DEV && (target.hostname === "localhost" || target.hostname.endsWith(".localhost"))) {
    args.push("--noproxy", target.hostname);
  }
  return new Promise((resolve) => {
    const child = spawn("curl", [...args, url], { stdio: ["ignore", "pipe", "ignore"] });
    let settled = false;
    let headers = "";
    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      resolve({ status, error });
    };
    const timer = setTimeout(() => finish(null, "Request timed out"), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      headers += chunk;
      if (headers.length > 65536) return finish(null, "Response headers too large");
      let end;
      // 응답 본문이나 열린 스트림을 기다리지 않고 최종 응답 헤더만 확인한다.
      while ((end = headers.indexOf("\r\n\r\n")) >= 0) {
        const status = Number(headers.slice(0, end).match(/^HTTP\/[\d.]+\s+(\d{3})\b/)?.[1]);
        headers = headers.slice(end + 4);
        if (status >= 200 || status === 101) return finish(status, null);
      }
    });
    child.on("error", (error) => finish(null, error.code === "ENOENT" ? "curl is not installed" : "Could not start health request"));
    child.on("close", (code) => finish(null, `Connection error (${code ?? "closed"})`));
  });
}

// 같은 세대의 검사를 공유하고, 이전 배포의 늦은 응답이 새 배포를 덮어쓰지 않게 한다.
async function probe(userid, appname, generation, timeoutMs) {
  const key = keyFor(userid, appname).join("/");
  const active = probes.get(key);
  if (active?.generation === generation) return active.promise;
  const promise = requestStatus(healthUrl(userid, appname), timeoutMs).then(async (result) => {
    const ready = result.status === 200 && await checkServices(userid, appname);
    result = { ...result, ready, error: result.status === 200 && !ready ? "Required app services are not ready" : result.error };
    db.prepare(`
      UPDATE app_readiness SET phase = CASE WHEN ? = 200 THEN 'ready' ELSE phase END,
        last_status = ?, checked_at = ?, error = ?
      WHERE userid = ? AND appname = ? AND generation = ? AND phase IN ('checking', 'failed')
    `).run(ready ? 200 : 0, result.status, Date.now(), result.error, ...keyFor(userid, appname), generation);
    return result;
  });
  probes.set(key, { generation, promise });
  try {
    return await promise;
  } finally {
    if (probes.get(key)?.promise === promise) probes.delete(key);
  }
}

async function waitUntilReady(userid, appname, generation, onLog) {
  db.prepare(`UPDATE app_readiness SET phase = 'checking'
    WHERE userid = ? AND appname = ? AND generation = ?`)
    .run(...keyFor(userid, appname), generation);
  const url = healthUrl(userid, appname);
  const deadline = Date.now() + config.APP_HEALTH_TIMEOUT_SECS * 1000;
  onLog(`[health] Waiting for HTTP 200 at ${url}`);
  let previousResult;
  while (Date.now() < deadline) {
    const current = read(userid, appname);
    if (current?.generation !== generation) throw new AppError(409, "Health check superseded by another deployment");
    if (current.phase === "ready") return;
    const result = await probe(userid, appname, generation,
      Math.min(config.APP_HEALTH_REQUEST_TIMEOUT_MS, Math.max(1, deadline - Date.now())));
    if (result.ready) {
      if (read(userid, appname)?.generation !== generation) {
        throw new AppError(409, "Health check superseded by another deployment");
      }
      onLog(`[health] Ready: HTTP 200 at ${url}`);
      return;
    }
    const description = result.error || (result.status ? `HTTP ${result.status}` : "No response");
    if (description !== previousResult) onLog(`[health] Not ready: ${description}`);
    previousResult = description;
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(config.APP_HEALTH_INTERVAL_MS, remaining));
  }
  fail(userid, appname, generation);
  throw new AppError(504, `Health check timed out after ${config.APP_HEALTH_TIMEOUT_SECS}s: expected HTTP 200 and ready services at ${url}`);
}

function apply(userid, appname, containerStatus) {
  const row = read(userid, appname);
  if (!row) return { status: containerStatus, health: null };
  // 지연 기동은 목록 조회 시 재검사하되, 성공한 앱을 상시 모니터링하지는 않는다.
  if (containerStatus === "running" && row.phase === "failed" &&
      Date.now() - (row.checked_at || 0) >= config.APP_HEALTH_INTERVAL_MS) {
    probe(userid, appname, row.generation, config.APP_HEALTH_REQUEST_TIMEOUT_MS)
      .catch(() => console.error("[health] Could not update app readiness"));
  }
  const readinessStatus = row.phase === "ready" ? "running" : row.phase === "failed" ? "unhealthy" : "starting";
  return {
    status: containerStatus === "running" ? readinessStatus : containerStatus,
    health: { status: readinessStatus, url: healthUrl(userid, appname), lastStatus: row.last_status,
      checkedAt: row.checked_at ? new Date(row.checked_at).toISOString() : null, error: row.error },
  };
}

module.exports = { init, begin, fail, remove, waitUntilReady, apply, setServiceChecker };
