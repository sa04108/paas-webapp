// =============================================================================
// routes/users.js - /users 라우트 핸들러 팩토리
// =============================================================================
// 역할:
//   사용자 관리(목록 조회/생성/삭제/role 변경) HTTP 엔드포인트를 제공한다.
//   authService 인스턴스를 의존성으로 주입받아 사용한다.
//   인증/권한 미들웨어는 server.js에서 이 라우터 앞에 적용된다.
// =============================================================================
"use strict";

const express = require("express");
const { normalizeBoolean, sendOk } = require("../utils");

/**
 * authService 인스턴스를 주입받아 /users 라우터를 생성한다.
 * server.js에서 `app.use("/users", ..., createUsersRouter(authService))` 형태로 호출한다.
 *
 * @param {object} authService - createAuthService()로 생성된 인증 서비스 인스턴스
 * @returns {express.Router}
 */
function createUsersRouter(authService) {
  const router = express.Router();

  // GET /users — admin 전용: 전체 사용자 목록 조회
  router.get("/", (_req, res, next) => {
    try {
      const users = authService.listUsers();
      return sendOk(res, { users, total: users.length });
    } catch (error) {
      return next(error);
    }
  });

  // POST /users — admin 전용: 새 사용자 생성
  router.post("/", (req, res, next) => {
    try {
      const username = String(req.body?.username || "").trim();
      const password = String(req.body?.password || "");
      const isAdmin  = normalizeBoolean(req.body?.isAdmin, false);
      const user = authService.createUser({ username, password, isAdmin });
      return sendOk(res, { user }, 201);
    } catch (error) {
      return next(error);
    }
  });

  // PATCH /users/:id/role — admin 전용: 일반 사용자를 admin으로 승격
  router.patch("/:id/role", (req, res, next) => {
    try {
      const targetUserId = Number.parseInt(String(req.params.id || ""), 10);
      const updatedUser = authService.updateUserRole({
        actorUserId: req.auth?.user?.id,
        targetUserId,
      });
      return sendOk(res, { user: updatedUser });
    } catch (error) {
      return next(error);
    }
  });

  // DELETE /users/:id — admin 전용: 사용자 제거 (현재 admin 비밀번호 확인 필요)
  router.delete("/:id", (req, res, next) => {
    try {
      const targetUserId     = Number.parseInt(String(req.params.id || ""), 10);
      const currentPassword  = String(req.body?.currentPassword || "");
      const deletedUser = authService.deleteUser({
        actorUserId: req.auth?.user?.id,
        targetUserId,
        currentPassword,
      });
      return sendOk(res, { user: deletedUser });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = createUsersRouter;
