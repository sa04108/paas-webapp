// =============================================================================
// routes/github.js - GitHub App 연동 비즈니스 로직 핸들러
// =============================================================================
// 역할:
//   - status     : 현재 사용자의 연결 상태
//   - connectUrl : GitHub App 설치 페이지 URL 발급 (state 포함)
//   - callback   : 설치 후 OAuth 콜백 (code+state+installation_id 수신·검증·저장)
//   - repos      : 설치된 repo 목록
//   - disconnect : 연결 해제
//   connectUrl/callback은 브라우저 최상위 네비게이션(리다이렉트)에 쓰인다.
// =============================================================================
"use strict";

const { AppError } = require("../utils");

/**
 * @param {object} githubService - createGithubService() 인스턴스
 */
function createGithubHandlers(githubService) {
  function status({ auth }) {
    if (!githubService.isConfigured()) {
      return { configured: false, connected: false };
    }
    const installationId = githubService.getInstallationId(auth.user.id);
    return { configured: true, connected: Boolean(installationId) };
  }

  // GitHub 설치 페이지로 이동할 URL을 반환한다 (호출부에서 302 리다이렉트 처리)
  function connectUrl({ auth }) {
    return githubService.buildInstallUrl(auth.user.id);
  }

  // GitHub Callback (code+installation_id+state) → 리다이렉트 대상 경로 반환
  async function callback({ auth, query }) {
    const code = String(query?.code || "");
    const state = String(query?.state || "");
    const installationId = String(query?.installation_id || "").trim();
    if (!code || !installationId) throw new AppError(400, "code 또는 installation_id가 없습니다.");

    const result = await githubService.completeInstall({ code, state, installationId });
    if (!result) throw new AppError(400, "유효하지 않은 설치 요청입니다. (state/소유 검증 실패)");

    // 설치한 본인과 로그인 세션이 일치하는지 확인 (state의 uid == 현재 세션 user)
    if (result.userId !== auth.user.id) {
      throw new AppError(403, "설치 요청과 로그인 사용자가 일치하지 않습니다.");
    }

    return "/create?github=connected";
  }

  async function repos({ auth }) {
    return githubService.listReposForUser(auth.user.id);
  }

  function disconnect({ auth }) {
    githubService.disconnect(auth.user.id);
    return { disconnected: true };
  }

  return { status, connectUrl, callback, repos, disconnect };
}

module.exports = createGithubHandlers;
