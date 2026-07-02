// =============================================================================
// routes/github.js - GitHub App 연동 라우트
// =============================================================================
// 역할:
//   - GET  /github/status     : 현재 사용자의 연결 상태
//   - GET  /github/connect    : GitHub App 설치 페이지로 리다이렉트 (state 발급)
//   - GET  /github/callback   : 설치 후 OAuth 콜백 (code+state+installation_id 수신·검증·저장)
//   - GET  /github/repos      : 설치된 repo 목록
//   - POST /github/disconnect : 연결 해제
//   /github/connect, /github/callback 은 브라우저 최상위 네비게이션(리다이렉트)이다.
// =============================================================================
"use strict";

const express = require("express");
const { AppError, sendOk } = require("../utils");

/**
 * @param {object} githubService - createGithubService() 인스턴스
 * @returns {express.Router}
 */
function createGithubRouter(githubService) {
  const router = express.Router();

  // GET /github/status
  router.get("/status", (req, res, next) => {
    try {
      if (!githubService.isConfigured()) {
        return sendOk(res, { configured: false, connected: false });
      }
      const installationId = githubService.getInstallationId(req.auth.user.id);
      return sendOk(res, { configured: true, connected: Boolean(installationId) });
    } catch (error) {
      return next(error);
    }
  });

  // GET /github/connect → 302 to GitHub
  router.get("/connect", (req, res, next) => {
    try {
      const url = githubService.buildInstallUrl(req.auth.user.id);
      return res.redirect(url);
    } catch (error) {
      return next(error);
    }
  });

  // GET /github/callback?code=...&installation_id=...&state=...
  // (App 설정에서 "OAuth during installation"을 켜면 설치 후 이 Callback URL로 온다)
  router.get("/callback", async (req, res, next) => {
    try {
      const code = String(req.query.code || "");
      const state = String(req.query.state || "");
      const installationId = String(req.query.installation_id || "").trim();
      if (!code || !installationId) throw new AppError(400, "code 또는 installation_id가 없습니다.");

      const result = await githubService.completeInstall({ code, state, installationId });
      if (!result) throw new AppError(400, "유효하지 않은 설치 요청입니다. (state/소유 검증 실패)");

      // 설치한 본인과 로그인 세션이 일치하는지 확인 (state의 uid == 현재 세션 user)
      if (result.userId !== req.auth.user.id) {
        throw new AppError(403, "설치 요청과 로그인 사용자가 일치하지 않습니다.");
      }

      // 대시보드로 복귀 (앱 생성 화면)
      return res.redirect("/?github=connected#create");
    } catch (error) {
      return next(error);
    }
  });

  // GET /github/repos
  router.get("/repos", async (req, res, next) => {
    try {
      const result = await githubService.listReposForUser(req.auth.user.id);
      return sendOk(res, result);
    } catch (error) {
      return next(error);
    }
  });

  // POST /github/disconnect
  router.post("/disconnect", (req, res, next) => {
    try {
      githubService.disconnect(req.auth.user.id);
      return sendOk(res, { disconnected: true });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = createGithubRouter;
