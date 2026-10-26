// =============================================================================
// routes/github.js - GitHub App 연동 라우트
// =============================================================================
// 역할:
//   - GET  /github/status     : 현재 사용자의 연결 상태
//   - GET  /github/connect    : GitHub 사용자 인증 시작
//   - GET  /github/callback   : OAuth 콜백 검증 후 기존 설치 조회
//   - GET  /github/install    : 설치가 없는 사용자를 설치 화면으로 안내
//   - POST /github/complete-connection : 설치 재조회 또는 계정 선택 완료
//   - GET  /github/repos      : 설치된 repo 목록
//   - POST /github/disconnect : 연결 해제
//   /github/connect, /github/callback 은 브라우저 최상위 네비게이션(리다이렉트)이다.
// =============================================================================
"use strict";

const express = require("express");
const { AppError, sendOk } = require("../utils");
const CONNECTION_COOKIE = "github_connection";

function connectionToken(req) {
  const cookie = String(req.headers.cookie || "").split(";")
    .find((part) => part.trim().startsWith(`${CONNECTION_COOKIE}=`));
  if (!cookie) return "";
  try {
    return decodeURIComponent(cookie.trim().slice(CONNECTION_COOKIE.length + 1));
  } catch {
    return "";
  }
}

function cookieOptions(req) {
  return { httpOnly: true, secure: req.secure, sameSite: "lax", path: "/api/github" };
}

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
      return sendOk(res, githubService.getConnectionStatus(req.auth.user.id, connectionToken(req)));
    } catch (error) {
      return next(error);
    }
  });

  // GET /github/connect → 302 to GitHub
  router.get("/connect", (req, res, next) => {
    try {
      const { url, token } = githubService.beginConnection(req.auth.user.id);
      res.cookie(CONNECTION_COOKIE, token, { ...cookieOptions(req), maxAge: 10 * 60_000 });
      return res.redirect(url);
    } catch (error) {
      return next(error);
    }
  });

  // 일반 OAuth 콜백에는 installation_id가 없어도 설치 목록에서 연결 대상을 찾는다.
  router.get("/callback", async (req, res, next) => {
    try {
      if (req.query.error) throw new AppError(400, "GitHub authorization was not completed. Try Connect GitHub again.");
      const code = String(req.query.code || "");
      const state = String(req.query.state || "");
      const installationId = String(req.query.installation_id || "").trim();
      const token = connectionToken(req);
      // 설치 중 OAuth 콜백이 state를 생략하면 기존에 인증한 토큰으로 원래 화면에서 재조회한다.
      if (!state && githubService.getConnectionStatus(req.auth.user.id, token).pending?.kind === "install") {
        return res.redirect("/create?github=install");
      }
      if (!code || !state) throw new AppError(400, "GitHub authorization code or state is missing. Try Connect GitHub again.");
      const result = await githubService.completeAuthorization({
        userId: req.auth.user.id, token, code, state, installationId,
      });
      if (!result.pending) {
        res.clearCookie(CONNECTION_COOKIE, cookieOptions(req));
        return res.redirect("/create?github=connected");
      }
      res.cookie(CONNECTION_COOKIE, token, { ...cookieOptions(req), maxAge: 10 * 60_000 });
      if (result.pending.kind === "install") {
        return res.redirect(githubService.buildInstallUrl(req.auth.user.id, token));
      }
      return res.redirect("/create?github=select");
    } catch (error) {
      return next(error);
    }
  });

  router.get("/install", (req, res, next) => {
    try {
      return res.redirect(githubService.buildInstallUrl(req.auth.user.id, connectionToken(req)));
    } catch (error) {
      return next(error);
    }
  });

  router.post("/complete-connection", async (req, res, next) => {
    try {
      // 쿠키를 이용한 완료 요청은 현재 포털에서만 허용한다.
      const origin = req.get("Origin");
      const expected = new URL(`${req.protocol}://${req.get("host")}`).origin;
      if (origin !== expected) throw new AppError(403, "GitHub connection must be completed from this portal.");
      const result = await githubService.completeConnection({
        userId: req.auth.user.id,
        token: connectionToken(req),
        installationId: String(req.body?.installationId || "").trim(),
      });
      if (!result.pending) res.clearCookie(CONNECTION_COOKIE, cookieOptions(req));
      return sendOk(res, result);
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
      res.clearCookie(CONNECTION_COOKIE, cookieOptions(req));
      return sendOk(res, { disconnected: true });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = createGithubRouter;
