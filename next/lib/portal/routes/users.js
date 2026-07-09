// =============================================================================
// routes/users.js - 사용자 관리 비즈니스 로직 핸들러 팩토리
// =============================================================================
// 역할:
//   사용자 관리(목록 조회/생성/삭제/role 변경) 로직을 프레임워크 독립적인
//   함수로 제공한다. authService 인스턴스를 의존성으로 주입받아 사용한다.
//   인증/권한 확인은 HTTP 어댑터(Next.js Route Handler)가 담당한다.
// =============================================================================
"use strict";

const { normalizeBoolean } = require("../utils");

/**
 * authService 인스턴스를 주입받아 /users 핸들러 묶음을 생성한다.
 * runtime.js에서 `createUsersHandlers(authService)` 형태로 호출한다.
 *
 * @param {object} authService - createAuthService()로 생성된 인증 서비스 인스턴스
 */
function createUsersHandlers(authService) {
  // admin 전용: 전체 사용자 목록 조회
  function listUsers() {
    const users = authService.listUsers();
    return { users, total: users.length };
  }

  // admin 전용: 새 사용자 생성
  function createUser({ body }) {
    const username = String(body?.username || "").trim();
    const password = String(body?.password || "");
    const isAdmin  = normalizeBoolean(body?.isAdmin, false);
    const user = authService.createUser({ username, password, isAdmin });
    return { user };
  }

  // admin 전용: 일반 사용자를 admin으로 승격
  function updateUserRole({ auth, params }) {
    const targetUserId = Number.parseInt(String(params?.id || ""), 10);
    const updatedUser = authService.updateUserRole({
      actorUserId: auth?.user?.id,
      targetUserId,
    });
    return { user: updatedUser };
  }

  // admin 전용: 사용자 제거 (현재 admin 비밀번호 확인 필요)
  function deleteUser({ auth, params, body }) {
    const targetUserId    = Number.parseInt(String(params?.id || ""), 10);
    const currentPassword = String(body?.currentPassword || "");
    const deletedUser = authService.deleteUser({
      actorUserId: auth?.user?.id,
      targetUserId,
      currentPassword,
    });
    return { user: deletedUser };
  }

  return { listUsers, createUser, updateUserRole, deleteUser };
}

module.exports = createUsersHandlers;
