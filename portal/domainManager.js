// =============================================================================
// domainManager.js - 커스텀 도메인 관리
// =============================================================================
// 역할:
//   사용자 커스텀 도메인의 CRUD, DNS 검증, Traefik 파일 프로바이더 YAML 생성을 담당한다.
//   - 도메인 추가 시 고유 CNAME 타겟 발급
//   - dns.promises.resolveCname 으로 소유권 검증
//   - 검증된 도메인만 portal-data/traefik-dynamic/custom-domains.yml 에 반영
//   - 파일은 원자적으로(tmp → rename) 덮어써 Traefik 핫 리로드를 안전하게 트리거
// =============================================================================
"use strict";

const path = require("node:path");
const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const dns = require("node:dns").promises;
const YAML = require("yaml");
const proxyConfig = require("./proxyConfig");

const { AppError } = require("./utils");
const { config, IS_DEV } = require("./config");
const { containerName: appContainerName } = require("./composeConfig");

// FQDN 기본 검증 정규식
const FQDN_REGEX =
  /^([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

const DYNAMIC_CONFIG_DIR = path.join(
  path.dirname(config.PORTAL_DB_PATH), // portal-data/
  "traefik-dynamic",
);
const DYNAMIC_CONFIG_FILE = path.join(DYNAMIC_CONFIG_DIR, "custom-domains.yml");

function nowIso() {
  return new Date().toISOString();
}

function generateCnameTarget(appname) {
  const hash = crypto.randomBytes(4).toString("hex"); // 8자 hex
  return `${appname}-${hash}.${config.PAAS_DOMAIN}`;
}

// ── Traefik YAML 생성 ─────────────────────────────────────────────────────────

let rebuildQueue = Promise.resolve();
function rebuildTraefikConfig(statements) {
  // 저장과 도메인 갱신이 겹쳐도 이전 스냅샷이 최신 파일을 덮어쓰지 않게 직렬화한다.
  const operation = rebuildQueue.catch(() => {}).then(() => writeTraefikConfig(statements));
  rebuildQueue = operation;
  return operation;
}

async function writeTraefikConfig(statements) {
  await fs.mkdir(DYNAMIC_CONFIG_DIR, { recursive: true });

  const activeDomains = statements.listAllActiveCustomDomains.all();
  const saved = proxyConfig.read();
  if (saved.loadError) throw new Error(saved.loadError);
  const settings = saved.settings;
  const prefix = proxyConfig.namespace(config.PAAS_DOMAIN);
  const portalKey = `${prefix}-portal`;
  const tls = (resolver) => IS_DEV ? {} : { tls: resolver ? { certResolver: resolver } : {} };
  const routers = {
    [portalKey]: {
      rule: `Host(\`portal.${config.PAAS_DOMAIN}\`)`, entryPoints: [settings.entrypoint],
      service: portalKey, ...tls(settings.certificateResolver),
    },
  };
  const services = {
    [portalKey]: { loadBalancer: { servers: [{ url: `http://${process.env.PORTAL_CONTAINER_NAME || "paas-portal"}:${config.PORTAL_PORT}` }] } },
  };
  const middlewares = {};
  for (const row of activeDomains) {
    const containerName = appContainerName(row.userid, row.appname, "", true);
    const key = `${prefix}-custom-${row.id}`;
    routers[key] = {
      rule: `Host(\`${row.domain}\`)`, entryPoints: [settings.entrypoint],
      service: `${key}-svc`, middlewares: [`${key}-rewrite-host`],
      ...tls(settings.customCertificateResolver),
    };
    services[`${key}-svc`] = { loadBalancer: { servers: [{ url: `http://${containerName}:${row.port}` }] } };
    middlewares[`${key}-rewrite-host`] = { headers: { customRequestHeaders: { Host: "localhost" } } };
  }
  const yaml = "# 포털이 관리하는 파일입니다. 직접 수정하지 마세요.\n" + YAML.stringify({
    http: { routers, services, ...(Object.keys(middlewares).length ? { middlewares } : {}) },
  });

  // 원자적 쓰기: tmp 파일에 먼저 쓴 뒤 rename
  const tmpPath = `${DYNAMIC_CONFIG_FILE}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmpPath, yaml, { encoding: "utf8", flag: "wx" });
    await fs.rename(tmpPath, DYNAMIC_CONFIG_FILE);
  } finally { await fs.rm(tmpPath, { force: true }); }
}

// ── 팩토리 ───────────────────────────────────────────────────────────────────

function createDomainManager({ statements }) {
  async function init() {
    await fs.mkdir(DYNAMIC_CONFIG_DIR, { recursive: true });
    // 시작 시 현재 active 도메인으로 YAML 재빌드 (재시작 후 상태 복구)
    // 손상된 설정은 기존 라우팅을 유지하고 관리자 화면에서 복구하도록 한다.
    if (proxyConfig.read().loadError) console.error("[domainManager] Saved proxy settings require repair; keeping existing routes.");
    else await rebuildTraefikConfig(statements);

    // ── 자동 도메인 검증 ────────────────────────────────────────────────────
    // pending/error 도메인: 5분마다 재검증 (DNS TTL 60~300s 고려)
    // active 도메인: 2시간마다 재검증 (CNAME 삭제·만료 감지)

    let pendingVerifyRunning = false;
    async function autoVerifyPending() {
      if (pendingVerifyRunning) return;
      pendingVerifyRunning = true;
      try {
        const domains = statements.selectAllNonActiveDomains.all();
        for (const row of domains) {
          try {
            await verifyDomain(row.id, row.userid, row.appname);
          } catch (err) {
            console.error(`[domainManager] auto-verify error (id=${row.id} ${row.domain}):`, err.message);
          }
        }
      } finally {
        pendingVerifyRunning = false;
      }
    }

    let activeReverifyRunning = false;
    async function autoReverifyActive() {
      if (activeReverifyRunning) return;
      activeReverifyRunning = true;
      try {
        const domains = statements.listAllActiveCustomDomains.all();
        for (const row of domains) {
          try {
            await verifyDomain(row.id, row.userid, row.appname);
          } catch (err) {
            console.error(`[domainManager] auto-reverify error (id=${row.id} ${row.domain}):`, err.message);
          }
        }
      } finally {
        activeReverifyRunning = false;
      }
    }

    setInterval(autoVerifyPending,   5 * 60 * 1000).unref();
    setInterval(autoReverifyActive, 2 * 60 * 60 * 1000).unref();
  }

  function listDomains(userid, appname) {
    return statements.selectCustomDomainsByApp.all(userid, appname);
  }

  function listActiveDomains(userid, appname) {
    return statements.selectActiveCustomDomainsByApp.all(userid, appname);
  }

  function addDomain(userid, appname, domain, port) {
    // FQDN 검증
    if (!FQDN_REGEX.test(domain)) {
      throw new AppError(400, "Invalid domain format.");
    }

    // 플랫폼 도메인 등록 차단
    // if (domain.includes(`${config.PAAS_DOMAIN}`)) {
    //   throw new AppError(400, "플랫폼 기본 도메인은 등록할 수 없습니다.");
    // }
    // 내 도메인으로 테스트하고 싶어서 임시로 풀어둠

    // 전역 중복 확인
    const existing = statements.selectCustomDomainByDomain.get(domain);
    if (existing) {
      if (existing.userid === userid && existing.appname === appname) {
        throw new AppError(409, "This domain is already registered to this app.");
      }
      throw new AppError(409, "This domain is already registered to another app.");
    }

    const cnameTarget = generateCnameTarget(appname);
    const now = nowIso();
    statements.insertCustomDomain.run(
      userid,
      appname,
      domain,
      cnameTarget,
      port ?? 5000,
      now,
      now,
    );

    return statements.selectCustomDomainByDomain.get(domain);
  }

  function removeDomain(id, userid, appname) {
    const row = statements.selectCustomDomainById.get(id);
    if (!row || row.userid !== userid || row.appname !== appname) {
      throw new AppError(404, "Domain not found.");
    }
    statements.deleteCustomDomainById.run(id);

    // fire-and-forget — 실패해도 도메인 삭제 자체는 성공으로 처리
    rebuildTraefikConfig(statements).catch((err) =>
      console.error("[domainManager] rebuildTraefikConfig failed:", err),
    );
  }

  async function verifyDomain(id, userid, appname) {
    const row = statements.selectCustomDomainById.get(id);
    if (!row || row.userid !== userid || row.appname !== appname) {
      throw new AppError(404, "Domain not found.");
    }

    const now = nowIso();
    let resolved = null;

    try {
      const results = await dns.resolveCname(row.domain);
      resolved = results[0] ?? null;
    } catch {
      // ENOTFOUND, ENODATA 등 — DNS 미설정 상태로 간주
    }

    // 일부 리졸버가 trailing dot 포함 반환
    const normalised = resolved ? resolved.replace(/\.$/, "") : null;
    const isVerified = normalised === row.cnameTarget;

    statements.updateCustomDomainStatus.run(
      isVerified ? "active" : "error",
      isVerified ? now : null,
      now,
      id,
    );

    const updated = statements.selectCustomDomainById.get(id);

    // active→error 전환 시에도 Traefik 설정을 재빌드해야 해당 도메인 라우팅이 제거된다.
    if (isVerified || row.status === "active") {
      await rebuildTraefikConfig(statements);
    }

    return updated;
  }

  // 재배포 완료 후 포트가 변경된 경우 갱신
  async function refreshAppPort(userid, appname, port) {
    statements.updateCustomDomainPort.run(port, nowIso(), userid, appname);
    await rebuildTraefikConfig(statements);
  }

  // 앱 삭제 시 해당 앱의 모든 커스텀 도메인 정리
  function removeAppDomains(userid, appname) {
    statements.deleteCustomDomainsByApp.run(userid, appname);
    rebuildTraefikConfig(statements).catch((err) =>
      console.error(
        "[domainManager] rebuildTraefikConfig failed after removeAppDomains:",
        err,
      ),
    );
  }

  return {
    init,
    refreshProxyRoutes: () => rebuildTraefikConfig(statements),
    listDomains,
    listActiveDomains,
    addDomain,
    removeDomain,
    verifyDomain,
    refreshAppPort,
    removeAppDomains,
  };
}

module.exports = { createDomainManager };
