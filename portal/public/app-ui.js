// =============================================================================
// app-ui.js - 뷰 전환 · 모달 관리 · 인증 UI
// =============================================================================
// 역할:
//   뷰 전환(switchView), 서브탭 전환(switchDetailTab), 모달 열기/닫기,
//   인증 상태 반영(updateAuthUi), 앱 관리 화면 진입(navigateToApp)을 담당한다.
//   app-render.js와 app-utils.js에 의존한다.
//   navigateToApp은 app-exec.js(execCwd, updateExecPrompt, initExecCwd)와
//   app-api.js(loadDetailLogs, loadDetailEnv)를 런타임에 참조하므로
//   이 파일보다 뒤에 로드되는 스크립트의 함수를 호출할 수 있다.
//   (모든 스크립트 로드가 완료된 후에만 실제로 호출되기 때문이다.)
// =============================================================================

// ── 뷰 전환 ──────────────────────────────────────────────────────────────────

function switchView(viewName, { persist = true } = {}) {
  const nextView = AVAILABLE_VIEWS.includes(viewName) ? viewName : DEFAULT_VIEW;
  state.activeView = nextView;

  el.viewDashboard.hidden = nextView !== "dashboard";
  el.viewCreate.hidden    = nextView !== "create";
  el.viewAppDetail.hidden = nextView !== "app-detail";
  el.viewUsers.hidden     = nextView !== "users";

  el.gnbItems.forEach((item) => {
    // app-detail은 별도 GNB 항목이 없으므로 dashboard를 active로 표시한다.
    const viewKey = nextView === "app-detail" ? "dashboard" : nextView;
    item.classList.toggle("active", item.dataset.view === viewKey);
  });

  if (persist) persistUiState();
  closeMobileMenu();
}

function closeMobileMenu() {
  el.gnbNav.classList.remove("open");
  el.gnbOverlay.classList.remove("open");
}

function toggleMobileMenu() {
  el.gnbNav.classList.toggle("open");
  el.gnbOverlay.classList.toggle("open");
}

// ── 앱 관리 서브탭 ────────────────────────────────────────────────────────────

function switchDetailTab(tabName) {
  const nextTab = AVAILABLE_DETAIL_TABS.includes(tabName) ? tabName : DEFAULT_DETAIL_TAB;
  state.activeDetailTab = nextTab;

  el.detailTabBtns.forEach((btn) => {
    const isActive = btn.dataset.detailTab === nextTab;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  });

  el.detailPanelLogs.hidden     = nextTab !== "logs";
  el.detailPanelExec.hidden     = nextTab !== "exec";
  el.detailPanelSettings.hidden = nextTab !== "settings";
}

// 앱 관리 화면으로 진입한다.
// exec cwd를 초기화하고, 로그를 자동 로드하며 env 데이터를 백그라운드로 미리 로드한다.
// (loadDetailLogs, loadDetailEnv, initExecCwd는 app-api.js / app-exec.js에 정의되어 있으며,
//  이 함수는 항상 이벤트 핸들러에서만 호출되므로 실행 시점엔 이미 정의가 완료된다.)
async function navigateToApp(userid, appname) {
  state.selectedApp = { userid, appname };
  execCwd = "";
  updateExecPrompt();
  el.appDetailAppname.textContent = `${userid} / ${appname}`;
  switchDetailTab(DEFAULT_DETAIL_TAB);
  switchView("app-detail");
  try {
    await loadDetailLogs();
  } catch (error) {
    await handleRequestError(error);
  }
  loadDetailEnv().catch(() => {});
}

// ── 모달 유틸 ─────────────────────────────────────────────────────────────────

// 모달 열린 상태를 body 클래스에 반영하여 배경 스크롤을 방지한다.
function syncModalOpenState() {
  const hasOpenModal =
    !el.settingsModal.hidden   ||
    !el.createUserModal.hidden ||
    !el.deleteUserModal.hidden ||
    !el.promoteAdminModal.hidden;
  document.body.classList.toggle("modal-open", hasOpenModal);
}

// 모달 배경(backdrop) 클릭으로 닫기 기능을 바인딩한다.
// mousedown에서 대상을 기록하고 click에서 확인하는 두 단계 방식을 사용한다.
// 이는 모달 내부에서 드래그 후 배경에서 버튼을 놓는 의도치 않은 닫힘을 방지한다.
function bindBackdropClose(modalElement, stateKey, onClose) {
  modalElement.addEventListener("mousedown", (event) => {
    modalBackdropState[stateKey] = event.target === modalElement;
  });
  modalElement.addEventListener("click", (event) => {
    if (event.target === modalElement && modalBackdropState[stateKey]) onClose();
    modalBackdropState[stateKey] = false;
  });
}

// ── 설정 모달 (비밀번호 변경) ─────────────────────────────────────────────────

function openSettingsModal() {
  if (!isLoggedIn()) return;
  modalBackdropState.settings = false;
  setSettingsError("");
  el.settingsModal.hidden = false;
  syncModalOpenState();
  el.currentPasswordInput.focus();
}

function closeSettingsModal() {
  modalBackdropState.settings = false;
  el.settingsModal.hidden = true;
  syncModalOpenState();
  setSettingsError("");
  el.passwordForm.reset();
}

// ── 사용자 생성 모달 ──────────────────────────────────────────────────────────

function openCreateUserModal() {
  if (!canManageUsers()) return;
  modalBackdropState.createUser = false;
  setCreateUserError("");
  el.createUserModal.hidden = false;
  syncModalOpenState();
  el.createUsernameInput.focus();
}

function closeCreateUserModal({ resetForm = false } = {}) {
  modalBackdropState.createUser = false;
  el.createUserModal.hidden = true;
  setCreateUserError("");
  if (resetForm) {
    el.createUserForm.reset();
    el.createUserRoleInput.value = "user";
  }
  syncModalOpenState();
}

// ── 사용자 삭제 모달 ──────────────────────────────────────────────────────────

function openDeleteUserModal(targetUser) {
  if (!canManageUsers()) return;
  state.pendingDeleteUser = targetUser || null;
  if (!state.pendingDeleteUser) return;
  modalBackdropState.deleteUser = false;
  setDeleteUserError("");
  el.deleteUserPasswordInput.value = "";
  el.deleteUserTarget.textContent = `'${state.pendingDeleteUser.username}' 사용자를 제거합니다.`;
  el.deleteUserModal.hidden = false;
  syncModalOpenState();
  el.deleteUserPasswordInput.focus();
}

function closeDeleteUserModal({ resetForm = false } = {}) {
  modalBackdropState.deleteUser = false;
  el.deleteUserModal.hidden = true;
  setDeleteUserError("");
  if (resetForm) {
    state.pendingDeleteUser = null;
    el.deleteUserPasswordInput.value = "";
    el.deleteUserTarget.textContent = "삭제할 사용자를 확인하세요.";
  }
  syncModalOpenState();
}

// ── Admin 승격 모달 ───────────────────────────────────────────────────────────

function openPromoteAdminModal(targetUser) {
  if (!canManageUsers()) return;
  state.pendingPromoteUser = targetUser || null;
  if (!state.pendingPromoteUser) return;
  modalBackdropState.promoteAdmin = false;
  setPromoteAdminError("");
  el.promoteAdminTarget.textContent =
    `'${state.pendingPromoteUser.username}' 사용자를 Admin으로 승격합니다.`;
  el.promoteAdminModal.hidden = false;
  syncModalOpenState();
  el.submitPromoteAdminBtn.focus();
}

function closePromoteAdminModal() {
  modalBackdropState.promoteAdmin = false;
  el.promoteAdminModal.hidden = true;
  state.pendingPromoteUser = null;
  setPromoteAdminError("");
  syncModalOpenState();
}

// ── 인증 UI 동기화 ────────────────────────────────────────────────────────────

// 로그인 상태·역할·비밀번호 잠금 여부에 따라 전체 UI를 동기화한다.
// (stopAutoRefresh는 app-api.js에 정의되어 있으며, 런타임에만 호출된다.)
function updateAuthUi() {
  if (!isLoggedIn()) {
    el.authState.textContent = "인증 필요";
    el.logoutBtn.hidden  = true;
    el.settingsBtn.hidden = true;
    el.gnbUsersBtn.hidden = true;
    state.users = [];
    renderUsers([]);
    if (state.activeView === "users" && DEFAULT_VIEW !== "users") {
      switchView(DEFAULT_VIEW);
    }
    applyAccessState();
    closeSettingsModal();
    closeCreateUserModal({ resetForm: true });
    closeDeleteUserModal({ resetForm: true });
    closePromoteAdminModal();
    return;
  }

  const suffix = isPasswordLocked() ? " | 비밀번호 변경 필요" : "";
  el.authState.textContent = `${state.user.username} (${state.user.role})${suffix}`;
  el.logoutBtn.hidden  = false;
  el.settingsBtn.hidden = false;
  el.gnbUsersBtn.hidden = !canManageUsers();

  if (el.gnbUsersBtn.hidden && state.activeView === "users") {
    switchView(DEFAULT_VIEW);
  }
  if (!canManageUsers()) {
    closeCreateUserModal({ resetForm: true });
    closeDeleteUserModal({ resetForm: true });
    closePromoteAdminModal();
  }
  applyAccessState();
}
