// =============================================================================
// routes/domains.js - 커스텀 도메인 비즈니스 로직 핸들러
// =============================================================================
// 역할:
//   커스텀 도메인 CRUD 및 DNS 검증 로직을 프레임워크 독립적인 함수로 제공한다.
//   도메인 비즈니스 로직 자체는 domainManager에 위임한다.
// =============================================================================
"use strict";

const { ROLE_ADMIN } = require("../authService");
const { AppError } = require("../utils");
const {
  validateAppParams,
  ensureAppExists,
  findDockerApp,
} = require("../appManager");

/**
 * @param {object} domainManager - createDomainManager() 인스턴스
 */
function createDomainsHandlers(domainManager) {
  // URL 파라미터(userid, appname) 검증 + 권한 확인
  async function resolveAppContext(auth, params) {
    const userid  = String(params?.userid  || "").trim();
    const appname = String(params?.appname || "").trim();
    validateAppParams(userid, appname);

    const user = auth?.user;
    if (user?.role !== ROLE_ADMIN && user?.username !== userid) {
      throw new AppError(403, "Forbidden");
    }

    await ensureAppExists(userid, appname);
    return { userid, appname };
  }

  function parseDomainId(params) {
    const id = Number.parseInt(params?.id, 10);
    if (!Number.isInteger(id) || id <= 0) throw new AppError(400, "유효하지 않은 도메인 ID입니다.");
    return id;
  }

  // 커스텀 도메인 목록 조회
  async function listDomains({ auth, params }) {
    const { userid, appname } = await resolveAppContext(auth, params);
    return { domains: domainManager.listDomains(userid, appname) };
  }

  // 커스텀 도메인 추가
  async function addDomain({ auth, params, body }) {
    const { userid, appname } = await resolveAppContext(auth, params);

    const domain = String(body?.domain || "").trim().toLowerCase();
    if (!domain) throw new AppError(400, "domain은 필수 입력값입니다.");

    // 현재 실행 중인 컨테이너에서 포트 정보 조회
    const dockerApp = await findDockerApp(userid, appname);
    const port = Number(dockerApp?.port) || 5000;

    const created = domainManager.addDomain(userid, appname, domain, port);
    return { domain: created };
  }

  // 커스텀 도메인 제거
  async function removeDomain({ auth, params }) {
    const { userid, appname } = await resolveAppContext(auth, params);
    const id = parseDomainId(params);

    domainManager.removeDomain(id, userid, appname);
    return { deleted: true };
  }

  // DNS 검증
  async function verifyDomain({ auth, params }) {
    const { userid, appname } = await resolveAppContext(auth, params);
    const id = parseDomainId(params);

    const updated = await domainManager.verifyDomain(id, userid, appname);
    return { domain: updated };
  }

  return { listDomains, addDomain, removeDomain, verifyDomain };
}

module.exports = createDomainsHandlers;
