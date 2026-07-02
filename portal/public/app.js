// =============================================================================
// app.js - 이벤트 바인딩 · 부트스트랩
// =============================================================================
// 역할:
//   모든 DOM 이벤트 리스너를 등록하고 앱을 시작한다.
//   비즈니스 로직은 각 모듈 파일로 위임되며, 이 파일은 '연결'만 담당한다.
//
//   로드 방식:
//     - index.html은 app.js(type="module")만 로드한다.
//     - app.js가 나머지 app-*.js를 import해 의존 관계를 구성한다.
// =============================================================================

// ── 모듈 연결 ─────────────────────────────────────────────────────────────────

import { DEFAULT_VIEW, el, state } from "./app-state.js";
import { parsePath, buildPath } from "./app-router.js";
import {
  canManageUsers,
  clearCreateFieldFeedback,
  isAdminUser,
  isPasswordLocked,
  normalizeErrorMessage,
  parsePositiveInt,
  redirectToAuth,
  setAddDomainError,
  setBanner,
  setCreateUserError,
  setDeleteUserError,
  setPromoteAdminError,
  setSettingsError,
  showToast,
  syncDomainPreview,
} from "./app-utils.js";
import {
  bindBackdropClose,
  closeAddDomainModal,
  closeCreateUserModal,
  closeDeleteUserModal,
  closeMobileMenu,
  closePromoteAdminModal,
  closeSettingsModal,
  closeJobListModal,
  closeJobLogModal,
  configureUiHandlers,
  navigateToApp,
  openAddDomainModal,
  openCreateUserModal,
  openDeleteUserModal,
  openPromoteAdminModal,
  openSettingsModal,
  openJobListModal,
  openJobLogModal,
  switchAdminTab,
  switchDetailTab,
  switchView,
  toggleMobileMenu,
  updateAuthUi,
} from "./app-ui.js";
import {
  clearExecTerminal,
  closeExecSocket,
  openExecSocket,
  resetExecForApp,
} from "./app-exec.js";
import {
  addCustomDomain,
  apiFetch,
  connectGithub,
  disconnectGithub,
  getActionTarget,
  handleCreate,
  handleRequestError,
  handleSettingsModalError,
  loadAndRecoverJobs,
  loadApps,
  loadAdminApps,
  loadDetailDomains,
  loadGithubStatus,
  loadPortalLogs,
  loadConfig,
  loadDetailEnv,
  loadDetailLogs,
  loadSession,
  loadUsers,
  performAction,
  refreshDashboardData,
  removeCustomDomain,
  retryJob,
  cancelJob,
  clearCompletedJobs,
  saveDetailEnv,
  startDetailLogsAutoRefresh,
  stopDetailLogsAutoRefresh,
  startAdminLogsAutoRefresh,
  stopAdminLogsAutoRefresh,
  stopAutoRefresh,
  verifyCustomDomain,
} from "./app-api.js";

// 로그 새로고침 버튼 UI 상태 동기화 (data-auto 속성 + 텍스트)
function syncLogRefreshBtn(btn, isAuto) {
  if (!btn) return;
  btn.dataset.auto = String(isAuto);
  btn.querySelector(".refresh-label").textContent = isAuto ? "Auto" : "새로고침";
}

configureUiHandlers({
  handleRequestError,
  loadDetailEnv,
  loadDetailLogs,
  loadDetailDomains,
  resetExecForApp,
  closeExecSocket,
  retryAllAlertJobs: async (alertJobs) => {
    for (const job of alertJobs) {
      await retryJob(job.id).catch(() => { });
    }
  },
});


el.appnameInput.addEventListener("input", () => {
  clearCreateFieldFeedback(el.appnameInput);
  syncDomainPreview();
});
el.repoUrlInput.addEventListener("input", () => clearCreateFieldFeedback(el.repoUrlInput));

el.githubConnectBtn?.addEventListener("click", connectGithub);
el.githubDisconnectBtn?.addEventListener("click", () =>
  disconnectGithub().catch((e) => setBanner(e.message, "error"))
);
// private repo 선택 시 해당 저장소의 기본 브랜치를 브랜치 입력칸에 자동 반영한다.
el.repoSelect?.addEventListener("change", () => {
  const opt = el.repoSelect.selectedOptions[0];
  if (opt?.dataset.branch) el.repoBranchInput.value = opt.dataset.branch;
});

el.createForm.addEventListener("submit", async (event) => {
  try {
    await handleCreate(event);
  } catch (error) {
    await handleRequestError(error);
  }
});

// ── GNB ───────────────────────────────────────────────────────────────────────

el.gnbItems.forEach((item) => {
  item.addEventListener("click", () => switchView(item.dataset.view));
});

if (el.gnbBrand) {
  el.gnbBrand.addEventListener("click", (event) => {
    // 수정자 키 또는 보조 버튼 클릭은 기본 동작(링크 이동)으로 처리한다.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    switchView(DEFAULT_VIEW);
  });
}

el.mobileMenuBtn.addEventListener("click", toggleMobileMenu);
el.gnbOverlay.addEventListener("click", closeMobileMenu);

// ── 앱 관리 서브 GNB ─────────────────────────────────────────────────────────

el.appDetailBackBtn.addEventListener("click", () => {
  closeExecSocket();
  switchView("dashboard");
});

el.detailTabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.detailTab;
    switchDetailTab(tab);
    if (tab === "logs" && state.selectedApp) loadDetailLogs().catch(handleRequestError);
    if (tab === "exec" && state.selectedApp) { openExecSocket(); }
    if (tab === "settings" && state.selectedApp) loadDetailEnv().catch(handleRequestError);
    if (tab === "domains" && state.selectedApp) loadDetailDomains().catch(handleRequestError);
    // exec 외 탭으로 전환 시 소켓 해제
    if (tab !== "exec") closeExecSocket();
  });
});

// ── 커스텀 도메인 ─────────────────────────────────────────────────────────────

el.detailAddDomainBtn.addEventListener("click", openAddDomainModal);

el.closeAddDomainBtn.addEventListener("click", (e) => {
  e.preventDefault();
  closeAddDomainModal();
});
el.cancelAddDomainBtn.addEventListener("click", (e) => {
  e.preventDefault();
  closeAddDomainModal();
});
bindBackdropClose(el.addDomainModal, "addDomain", closeAddDomainModal);

el.addDomainForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAddDomainError("");
  const domain = el.addDomainInput.value.trim().toLowerCase();
  if (!domain) {
    setAddDomainError("도메인을 입력하세요.");
    return;
  }
  el.submitAddDomainBtn.disabled = true;
  el.submitAddDomainBtn.textContent = "추가 중...";
  try {
    await addCustomDomain(domain);
    closeAddDomainModal();
    await loadDetailDomains();
    showToast(`도메인 추가 완료: ${domain}`, "success");
  } catch (error) {
    setAddDomainError(normalizeErrorMessage(error, "도메인 추가 중 오류가 발생했습니다."));
  } finally {
    el.submitAddDomainBtn.disabled = false;
    el.submitAddDomainBtn.textContent = "추가";
  }
});


el.detailPanelDomains.addEventListener("click", async (event) => {
  const verifyBtn = event.target.closest("button[data-action='verify-domain']");
  if (verifyBtn) {
    const id = Number.parseInt(verifyBtn.dataset.id, 10);
    if (!id) return;
    verifyBtn.disabled = true;
    try {
      const updated = await verifyCustomDomain(id);
      await loadDetailDomains();
      const msg = updated?.status === "active"
        ? `인증 완료: ${updated.domain}`
        : "CNAME이 아직 설정되지 않았습니다. DNS 전파 후 다시 시도하세요.";
      showToast(msg, updated?.status === "active" ? "success" : "error");
    } catch (error) {
      await handleRequestError(error);
    } finally {
      verifyBtn.disabled = false;
    }
    return;
  }

  const copyCnameBtn = event.target.closest("button[data-action='copy-cname']");
  if (copyCnameBtn) {
    const cname = copyCnameBtn.dataset.cname;
    if (!cname) return;
    navigator.clipboard.writeText(cname).then(() => {
      showToast("CNAME 타겟 복사 완료", "success");
    }).catch(() => { });
    return;
  }

  const removeBtn = event.target.closest("button[data-action='remove-domain']");
  if (removeBtn) {
    const id = Number.parseInt(removeBtn.dataset.id, 10);
    if (!id) return;
    if (!window.confirm("이 도메인을 제거하시겠습니까?")) return;
    try {
      await removeCustomDomain(id);
      await loadDetailDomains();
      showToast("도메인이 제거되었습니다.", "success");
    } catch (error) {
      await handleRequestError(error);
    }
  }
});

// ── 로그 ─────────────────────────────────────────────────────────────────

// 클릭: Auto On → 타이머 Off / Auto Off → 1회 로드 + 타이머 On
el.detailRefreshLogsBtn.addEventListener("click", async () => {
  if (state.detailLogsTimer) {
    stopDetailLogsAutoRefresh();
    syncLogRefreshBtn(el.detailRefreshLogsBtn, false);
  } else {
    await loadDetailLogs().catch(handleRequestError);
    startDetailLogsAutoRefresh();
    syncLogRefreshBtn(el.detailRefreshLogsBtn, true);
  }
});

// ── Exec ──────────────────────────────────────────────────────────────────────

el.detailExecClearBtn.addEventListener("click", () => {
  clearExecTerminal();
});

// ── Settings (env) ────────────────────────────────────────────────────────────

el.detailEnvSaveBtn.addEventListener("click", async () => {
  try {
    await saveDetailEnv();
  } catch (error) {
    await handleRequestError(error);
  }
});

// ── 설정 모달 (비밀번호 변경) ─────────────────────────────────────────────────

el.settingsBtn.addEventListener("click", openSettingsModal);

el.closeSettingsBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeSettingsModal();
});

bindBackdropClose(el.settingsModal, "settings", closeSettingsModal);

el.passwordForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setSettingsError("");
  try {
    const currentPassword = el.currentPasswordInput.value;
    const newPassword = el.newPasswordInput.value;
    const newPasswordConfirm = el.newPasswordConfirmInput.value;
    if (newPassword !== newPasswordConfirm) {
      setSettingsError("새 비밀번호와 비밀번호 확인이 일치하지 않습니다.");
      el.newPasswordConfirmInput.focus();
      return;
    }
    const data = await apiFetch("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    state.user = data.user || null;
    el.currentPasswordInput.value = "";
    el.newPasswordInput.value = "";
    el.newPasswordConfirmInput.value = "";
    updateAuthUi();
    closeSettingsModal();
    await refreshDashboardData();
    showToast("비밀번호 변경이 완료되었습니다.", "success");
    setBanner("", "none");
  } catch (error) {
    await handleSettingsModalError(error);
  }
});

// ── 로그아웃 ──────────────────────────────────────────────────────────────────

el.logoutBtn.addEventListener("click", async () => {
  try {
    await apiFetch("/auth/logout", { method: "POST" });
  } catch {
    // 전송 오류는 무시하고 리다이렉트로 진행한다.
  }
  stopAutoRefresh();
  redirectToAuth();
});

// ── 대시보드 ──────────────────────────────────────────────────────────────────

el.refreshBtn.addEventListener("click", async () => {
  try {
    await loadApps();
    await loadUsers();
    setBanner("데이터 갱신 완료", "success");
  } catch (error) {
    await handleRequestError(error);
  }
});

// 앱 카드 클릭 — 이벤트 위임 방식으로 [data-action] 버튼을 처리한다.
el.appsContainer.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const target = getActionTarget(button);
  if (!target) return;
  try {
    await performAction(target);
  } catch (error) {
    await handleRequestError(error);
  }
});

// ── Admin 대시보드 ────────────────────────────────────────────────────────────

// Admin 서브탭 전환
el.adminTabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    switchAdminTab(btn.dataset.adminTab);
  });
});

if (el.adminRefreshAppsBtn) {
  el.adminRefreshAppsBtn.addEventListener("click", async () => {
    try {
      await loadAdminApps();
      setBanner("전체 앱 목록 갱신 완료", "success");
    } catch (error) {
      await handleRequestError(error);
    }
  });
}

if (el.adminRefreshPortalLogsBtn) {
  el.adminRefreshPortalLogsBtn.addEventListener("click", async () => {
    if (state.adminLogsTimer) {
      stopAdminLogsAutoRefresh();
      syncLogRefreshBtn(el.adminRefreshPortalLogsBtn, false);
    } else {
      await loadPortalLogs().catch(handleRequestError);
      startAdminLogsAutoRefresh();
      syncLogRefreshBtn(el.adminRefreshPortalLogsBtn, true);
    }
  });
}

if (el.adminAppsContainer) {
  el.adminAppsContainer.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const target = getActionTarget(button);
    if (!target) return;
    try {
      await performAction(target);
    } catch (error) {
      await handleRequestError(error);
    }
  });
}

// ── 사용자 생성 모달 ──────────────────────────────────────────────────────────

el.openCreateUserBtn.addEventListener("click", openCreateUserModal);

el.closeCreateUserBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeCreateUserModal({ resetForm: true });
});
el.cancelCreateUserBtn.addEventListener("click", (event) => {
  event.preventDefault();
  closeCreateUserModal({ resetForm: true });
});
bindBackdropClose(el.createUserModal, "createUser", () => closeCreateUserModal({ resetForm: true }));

el.createUserForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setCreateUserError("");
  if (!canManageUsers()) {
    setCreateUserError("관리자 계정에서만 사용자 추가가 가능합니다.");
    return;
  }
  const username = el.createUsernameInput.value.trim();
  const password = el.createPasswordInput.value;
  const passwordConfirm = el.createPasswordConfirmInput.value;
  const roleValue = el.createUserRoleInput.value;
  if (!username || !password || !passwordConfirm) {
    setCreateUserError("username, password, password confirm을 입력하세요.");
    return;
  }
  if (password !== passwordConfirm) {
    setCreateUserError("password와 password confirm이 일치하지 않습니다.");
    return;
  }
  if (password.length < 8) {
    setCreateUserError("password는 8자 이상이어야 합니다.");
    return;
  }
  try {
    const isAdmin = roleValue === "admin";
    const data = await apiFetch("/users", {
      method: "POST",
      body: JSON.stringify({ username, password, isAdmin }),
    });
    closeCreateUserModal({ resetForm: true });
    await loadUsers();
    showToast(`사용자 생성 완료: ${data.user.username}`, "success");
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      await handleRequestError(error);
      return;
    }
    setCreateUserError(normalizeErrorMessage(error, "사용자 생성 중 오류가 발생했습니다."));
  }
});

// ── 사용자 삭제 모달 ──────────────────────────────────────────────────────────

el.closeDeleteUserBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeDeleteUserModal({ resetForm: true });
});
el.cancelDeleteUserBtn.addEventListener("click", (event) => {
  event.preventDefault();
  closeDeleteUserModal({ resetForm: true });
});
bindBackdropClose(el.deleteUserModal, "deleteUser", () => closeDeleteUserModal({ resetForm: true }));

el.deleteUserForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setDeleteUserError("");
  if (!canManageUsers()) {
    setDeleteUserError("관리자 계정에서만 사용자 제거가 가능합니다.");
    return;
  }
  if (!state.pendingDeleteUser?.id) {
    setDeleteUserError("제거할 사용자를 다시 선택하세요.");
    return;
  }
  const currentPassword = el.deleteUserPasswordInput.value;
  if (!currentPassword) {
    setDeleteUserError("현재 admin 비밀번호를 입력하세요.");
    return;
  }
  try {
    const targetUser = state.pendingDeleteUser;
    await apiFetch(`/users/${targetUser.id}`, {
      method: "DELETE",
      body: JSON.stringify({ currentPassword }),
    });
    closeDeleteUserModal({ resetForm: true });
    await loadUsers();
    showToast(`사용자 제거 완료: ${targetUser.username}`, "success");
  } catch (error) {
    const message = normalizeErrorMessage(error, "사용자 제거 중 오류가 발생했습니다.");
    const isCurrentPasswordMismatch =
      error?.status === 401 && /^current password is incorrect$/i.test(message);
    if (error?.status === 401 && !isCurrentPasswordMismatch) {
      await handleRequestError(error);
      return;
    }
    setDeleteUserError(message);
  }
});

// ── Admin 승격 모달 ───────────────────────────────────────────────────────────

el.closePromoteAdminBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closePromoteAdminModal();
});
el.cancelPromoteAdminBtn.addEventListener("click", (event) => {
  event.preventDefault();
  closePromoteAdminModal();
});
bindBackdropClose(el.promoteAdminModal, "promoteAdmin", closePromoteAdminModal);

el.submitPromoteAdminBtn.addEventListener("click", async () => {
  setPromoteAdminError("");
  if (!canManageUsers()) {
    setPromoteAdminError("관리자 계정에서만 권한을 변경할 수 있습니다.");
    return;
  }
  if (!state.pendingPromoteUser?.id) {
    setPromoteAdminError("대상 사용자를 다시 선택하세요.");
    return;
  }
  el.submitPromoteAdminBtn.disabled = true;
  try {
    const targetUser = state.pendingPromoteUser;
    const data = await apiFetch(`/users/${targetUser.id}/role`, { method: "PATCH" });
    closePromoteAdminModal();
    await loadUsers();
    showToast(`${data.user.username} 사용자가 Admin으로 승격되었습니다.`, "success");
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) {
      await handleRequestError(error);
      return;
    }
    setPromoteAdminError(normalizeErrorMessage(error, "권한 변경 중 오류가 발생했습니다."));
  } finally {
    el.submitPromoteAdminBtn.disabled = false;
  }
});

// ── 사용자 테이블 클릭 (이벤트 위임) ─────────────────────────────────────────

el.usersTableBody.addEventListener("click", (event) => {
  if (!canManageUsers()) return;

  const removeBtn = event.target.closest("button[data-action='remove-user']");
  if (removeBtn) {
    const id = parsePositiveInt(removeBtn.dataset.id);
    if (!id) return;
    const username = String(removeBtn.dataset.username || "").trim() || `user-${id}`;
    openDeleteUserModal({ id, username });
    return;
  }

  const promoteBtn = event.target.closest("button[data-action='promote-user']");
  if (promoteBtn) {
    const id = parsePositiveInt(promoteBtn.dataset.id);
    if (!id) return;
    const username = String(promoteBtn.dataset.username || "").trim() || `user-${id}`;
    openPromoteAdminModal({ id, username });
  }
});

// ── 직업 목록 모달 ────────────────────────────────────────────────────────────

el.jobListBtn.addEventListener("click", openJobListModal);

el.closeJobListBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeJobListModal();
});
bindBackdropClose(el.jobListModal, "jobList", closeJobListModal);

el.jobListTbody.addEventListener("click", async (event) => {
  const retryBtn = event.target.closest("button[data-action='retry-job']");
  if (retryBtn) {
    const id = retryBtn.dataset.id;
    if (id) await retryJob(id).catch(handleRequestError);
    return;
  }

  const cancelBtn = event.target.closest("button[data-action='cancel-job']");
  if (cancelBtn) {
    const id = cancelBtn.dataset.id;
    if (id) await cancelJob(id).catch(handleRequestError);
    return;
  }

  const viewLogBtn = event.target.closest("button[data-action='view-job-log']");
  if (viewLogBtn) {
    const id = viewLogBtn.dataset.id;
    if (id) {
      const job = state.jobs.find((j) => j.id === id);
      if (job) {
        openJobLogModal(job.error || job.output || "내용 없음");
      }
    }
  }
});

el.clearCompletedJobsBtn.addEventListener("click", async () => {
  if (!window.confirm("모든 완료된 작업 내역을 지우시겠습니까?")) return;
  try {
    await clearCompletedJobs();
  } catch (error) {
    await handleRequestError(error);
  }
});

el.closeJobLogBtn.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  closeJobLogModal();
});
bindBackdropClose(el.jobLogModal, "jobLog", closeJobLogModal);

el.copyJobLogBtn.addEventListener("click", async () => {
  const text = el.jobLogContent.textContent;
  if (!text || text === "내용 없음") return;
  try {
    await navigator.clipboard.writeText(text);
    showToast("로그 내용이 클립보드에 복사되었습니다.", "success");
  } catch (error) {
    showToast("클립보드 복사에 실패했습니다.", "error");
  }
});

// ── ESC 키 모달 닫기 ──────────────────────────────────────────────────────────

// 열린 모달 중 우선순위(promoteAdmin > deleteUser > createUser > settings) 순서로 닫는다.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" && event.key !== "Esc") return;
  if (!el.promoteAdminModal.hidden) { closePromoteAdminModal(); return; }
  if (!el.addDomainModal.hidden) { closeAddDomainModal(); return; }
  if (!el.deleteUserModal.hidden) { closeDeleteUserModal({ resetForm: true }); return; }
  if (!el.createUserModal.hidden) { closeCreateUserModal({ resetForm: true }); return; }
  if (!el.settingsModal.hidden) { closeSettingsModal(); return; }
  if (!el.jobListModal.hidden) { closeJobListModal(); }
});

// ── URL 라우팅 ────────────────────────────────────────────────────────────────

// 현재 URL(pathname)을 뷰 상태에 적용한다. 부트스트랩과 popstate에서 호출된다.
// URL이 뷰의 canonical 경로와 다르면(루트 / , 알 수 없는 경로, 권한 fallback 등)
// replaceState로 정규화한다 — 히스토리에 잘못된 항목을 남기지 않기 위함이다.
async function applyRouteFromUrl() {
  const route = parsePath(window.location.pathname);

  // 알 수 없는 경로 → dashboard
  if (!route) {
    switchView(DEFAULT_VIEW, { updateUrl: false });
    window.history.replaceState(null, "", buildPath(DEFAULT_VIEW));
    return;
  }

  if (route.view === "app-detail") {
    const { userid, appname } = route.params;
    // 본인 앱 목록에 없으면 진입하지 않는다. (admin은 타 사용자 앱 접근이
    // 가능하므로 목록 검사를 생략하고 서버 응답에 맡긴다)
    const known = state.apps.some((a) => a.userid === userid && a.appname === appname);
    if (!known && !isAdminUser()) {
      showToast(`앱을 찾을 수 없습니다: ${userid}/${appname}`, "error");
      switchView(DEFAULT_VIEW, { updateUrl: false });
      window.history.replaceState(null, "", buildPath(DEFAULT_VIEW));
      return;
    }
    await navigateToApp(userid, appname, { updateUrl: false });
    return;
  }

  // 앱 상세를 벗어나는 라우팅이면 exec 소켓을 정리한다.
  closeExecSocket();

  // admin 전용 뷰 권한 확인
  if ((route.view === "users" || route.view === "admin-dashboard") && !canManageUsers()) {
    switchView(DEFAULT_VIEW, { updateUrl: false });
    window.history.replaceState(null, "", buildPath(DEFAULT_VIEW));
    return;
  }

  switchView(route.view, { updateUrl: false });
  // 루트("/")로 진입한 경우 canonical 경로로 정규화
  const canonical = buildPath(route.view);
  if (window.location.pathname !== canonical) {
    window.history.replaceState(null, "", canonical);
  }
}

// 뒤로/앞으로가기: URL → 뷰 동기화
window.addEventListener("popstate", () => {
  applyRouteFromUrl().catch(handleRequestError);
});

// ── 부트스트랩 ────────────────────────────────────────────────────────────────

async function bootstrap() {
  switchView(DEFAULT_VIEW, { updateUrl: false });
  updateAuthUi();
  await loadConfig();
  syncDomainPreview();

  const loggedIn = await loadSession();
  if (!loggedIn) {
    redirectToAuth();
    return;
  }
  updateAuthUi();

  await refreshDashboardData();
  await loadGithubStatus();

  // URL이 가리키는 뷰로 진입 (새로고침/딥링크/북마크 복원)
  await applyRouteFromUrl();

  // /create?github=connected 복귀 시 배너 안내
  if (new URLSearchParams(window.location.search).get("github") === "connected") {
    setBanner("GitHub 연결이 완료되었습니다.", "success");
    // 쿼리스트링을 히스토리에서 제거하여 새로고침 시 중복 표시 방지
    window.history.replaceState(null, "", window.location.pathname);
  }

  // 로그 자동 갱신 타이머는 항상 켜진 상태로 유지한다.
  // 타이머 내부에서 activeView를 체크하므로 원치 않는 빗치는 발생하지 않는다.
  startDetailLogsAutoRefresh();
  startAdminLogsAutoRefresh();
  syncLogRefreshBtn(el.detailRefreshLogsBtn, true);
  syncLogRefreshBtn(el.adminRefreshPortalLogsBtn, true);

  // 새로고침/재방문 시 진행중 job 복원
  await loadAndRecoverJobs();

  if (isPasswordLocked()) {
    setBanner("초기 비밀번호를 우상단 설정에서 변경하세요.", "error");
    return;
  }
  setBanner("로그인 상태가 확인되었습니다.", "success");
}

// 페이지 언로드 시 소켓 정리
window.addEventListener("beforeunload", () => closeExecSocket());

bootstrap().catch((error) => {
  handleRequestError(error);
});
