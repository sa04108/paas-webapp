// =============================================================================
// app-state.js - 전역 상수 · 상태 · DOM 참조
// =============================================================================
// 역할:
//   app.js 전체에서 공유되는 상수, 상태 객체, DOM 요소 참조를 선언한다.
//   다른 모든 스크립트보다 먼저 로드되어야 한다.
//
// ── 스크립트 로드 순서 (index.html 기준) ─────────────────────────────────────
//  1. app-state.js   ← 이 파일. 전역 상수·상태·el. 다른 모든 스크립트의 기반.
//  2. app-utils.js   ← 순수 헬퍼. app-state의 상수·state·el에 의존.
//  3. app-render.js  ← DOM 생성. app-utils(escapeHtml, statusClass 등)에 의존.
//  4. app-ui.js      ← 뷰/모달. app-render, app-utils에 의존.
//                       navigateToApp은 app-exec(execCwd 등)·app-api를 런타임 참조.
//  5. app-exec.js    ← Exec 터미널. app-api(apiFetch)를 런타임 참조.
//  6. app-api.js     ← API 통신. app-render·app-ui·app-exec를 런타임 참조.
//  7. app.js         ← 이벤트 바인딩 + 부트스트랩. 모든 스크립트가 로드된 뒤 실행.
//
// "런타임 참조"란 함수 본문 안에서만 호출되므로 선언 시점엔 미정의여도 무방함을 의미한다.
// 파싱 시점에 즉시 실행되는 최상위 구문(예: IIFE 내부 직접 호출)은 이 규칙의 예외다.
// =============================================================================

// ── 자동 갱신 주기 · 뷰 상수 ────────────────────────────────────────────────

const AUTO_REFRESH_MS = 30000;
const UI_STATE_STORAGE_KEY = "portal.uiState";
const AVAILABLE_VIEWS        = ["dashboard", "create", "app-detail", "users"];
const AVAILABLE_DETAIL_TABS  = ["logs", "exec", "settings"];
const DEFAULT_VIEW       = "dashboard";
const DEFAULT_DETAIL_TAB = "logs";

// 앱 생성 폼 필드 오류 표시용 CSS 클래스
const CREATE_FIELD_INVALID_CLASS     = "field-invalid";
const CREATE_FIELD_SHAKE_CLASS       = "field-shake";
const CREATE_FIELD_SEQUENCE_GAP_MS   = 120;  // 필드 간 shake 시작 딜레이 (ms)
const CREATE_FIELD_SHAKE_DURATION_MS = 320;  // shake 애니메이션 지속 시간 (ms)

// ── 앱 런타임 상태 ────────────────────────────────────────────────────────────

const state = {
  domain:  "my.domain.com",
  devMode: false,
  apps:    [],
  users:   [],
  pendingDeleteUser:  null,  // 삭제 확인 모달에 표시할 대상 사용자
  pendingPromoteUser: null,  // Admin 승격 확인 모달에 표시할 대상 사용자
  user:    null,             // 현재 로그인된 사용자 객체 (null = 비로그인)
  refreshTimer:    null,     // setInterval 핸들 (자동 갱신)
  activeView:      DEFAULT_VIEW,
  activeDetailTab: DEFAULT_DETAIL_TAB,
  selectedApp:     null,     // 앱 관리 화면에서 선택된 앱 { userid, appname }
};

// ── DOM 요소 참조 캐시 ────────────────────────────────────────────────────────
// DOMContentLoaded 이후 스크립트가 실행되므로 여기서 바로 참조해도 안전하다.

const el = {
  // GNB
  devModeBadge:  document.getElementById("dev-mode-badge"),
  gnbBrand:      document.querySelector(".gnb-brand"),
  gnbNav:        document.querySelector(".gnb-nav"),
  gnbOverlay:    document.getElementById("gnb-mobile-overlay"),
  gnbItems:      Array.from(document.querySelectorAll(".gnb-item")),
  gnbUsersBtn:   document.getElementById("gnb-users-btn"),
  mobileMenuBtn: document.getElementById("mobile-menu-btn"),

  // 뷰 패널
  viewDashboard: document.getElementById("view-dashboard"),
  viewCreate:    document.getElementById("view-create"),
  viewAppDetail: document.getElementById("view-app-detail"),
  viewUsers:     document.getElementById("view-users"),

  // 공통 UI
  statusBanner: document.getElementById("status-banner"),
  authState:    document.getElementById("auth-state"),
  logoutBtn:    document.getElementById("logout-btn"),

  // 설정 모달 (비밀번호 변경)
  settingsBtn:              document.getElementById("settings-btn"),
  settingsModal:            document.getElementById("settings-modal"),
  settingsError:            document.getElementById("settings-error"),
  closeSettingsBtn:         document.getElementById("close-settings-btn"),
  passwordForm:             document.getElementById("password-form"),
  currentPasswordInput:     document.getElementById("current-password-input"),
  newPasswordInput:         document.getElementById("new-password-input"),
  newPasswordConfirmInput:  document.getElementById("new-password-confirm-input"),

  // 앱 생성 폼
  createForm:       document.getElementById("create-form"),
  appnameInput:     document.getElementById("appname-input"),
  repoUrlInput:     document.getElementById("repo-url-input"),
  repoBranchInput:  document.getElementById("repo-branch-input"),
  domainPreview:    document.getElementById("domain-preview"),
  domainChip:       document.getElementById("domain-chip"),
  limitChip:        document.getElementById("limit-chip"),
  appCountChip:     document.getElementById("app-count-chip"),
  refreshBtn:       document.getElementById("refresh-btn"),
  emptyState:       document.getElementById("empty-state"),
  appsContainer:    document.getElementById("apps-container"),

  // 앱 관리 서브 GNB
  appDetailBackBtn:  document.getElementById("app-detail-back-btn"),
  appDetailAppname:  document.getElementById("app-detail-appname"),
  detailTabBtns:     Array.from(document.querySelectorAll(".detail-tab-btn")),

  // 앱 관리 패널
  detailPanelLogs:     document.getElementById("detail-panel-logs"),
  detailPanelExec:     document.getElementById("detail-panel-exec"),
  detailPanelSettings: document.getElementById("detail-panel-settings"),

  // Logs 탭
  detailLogLinesInput:    document.getElementById("detail-log-lines-input"),
  detailRefreshLogsBtn:   document.getElementById("detail-refresh-logs-btn"),
  detailLogsTitle:        document.getElementById("detail-logs-title"),
  detailLogsOutput:       document.getElementById("detail-logs-output"),

  // Exec 탭
  detailExecClearBtn:    document.getElementById("detail-exec-clear-btn"),
  detailExecOutput:      document.getElementById("detail-exec-output"),
  detailExecInput:       document.getElementById("detail-exec-input"),
  detailExecRunBtn:      document.getElementById("detail-exec-run-btn"),
  detailExecPromptCwd:   document.getElementById("detail-exec-prompt-cwd"),

  // Settings 탭 (환경변수)
  detailEnvTextarea:  document.getElementById("detail-env-textarea"),
  detailEnvError:     document.getElementById("detail-env-error"),
  detailEnvSaveBtn:   document.getElementById("detail-env-save-btn"),
  keepDataInput:      document.getElementById("keep-data-input"),

  // 사용자 관리 뷰
  usersCount:               document.getElementById("users-count"),
  usersEmptyState:          document.getElementById("users-empty-state"),
  usersTableBody:           document.getElementById("users-table-body"),
  openCreateUserBtn:        document.getElementById("open-create-user-btn"),
  createUserModal:          document.getElementById("create-user-modal"),
  closeCreateUserBtn:       document.getElementById("close-create-user-btn"),
  cancelCreateUserBtn:      document.getElementById("cancel-create-user-btn"),
  createUserForm:           document.getElementById("create-user-form"),
  createUserError:          document.getElementById("create-user-error"),
  createUsernameInput:      document.getElementById("create-username-input"),
  createPasswordInput:      document.getElementById("create-password-input"),
  createPasswordConfirmInput: document.getElementById("create-password-confirm-input"),
  createUserRoleInput:      document.getElementById("create-user-role-input"),

  // 사용자 삭제 모달
  deleteUserModal:          document.getElementById("delete-user-modal"),
  closeDeleteUserBtn:       document.getElementById("close-delete-user-btn"),
  cancelDeleteUserBtn:      document.getElementById("cancel-delete-user-btn"),
  deleteUserForm:           document.getElementById("delete-user-form"),
  deleteUserTarget:         document.getElementById("delete-user-target"),
  deleteUserError:          document.getElementById("delete-user-error"),
  deleteUserPasswordInput:  document.getElementById("delete-user-password-input"),

  // Admin 승격 모달
  promoteAdminModal:      document.getElementById("promote-admin-modal"),
  closePromoteAdminBtn:   document.getElementById("close-promote-admin-btn"),
  cancelPromoteAdminBtn:  document.getElementById("cancel-promote-admin-btn"),
  submitPromoteAdminBtn:  document.getElementById("submit-promote-admin-btn"),
  promoteAdminTarget:     document.getElementById("promote-admin-target"),
  promoteAdminError:      document.getElementById("promote-admin-error"),
};

// 각 모달의 백드롭 클릭 시작 여부를 추적한다.
// mousedown 이벤트에서 기록하고 click 이벤트에서 확인하여,
// 모달 내부에서 드래그 후 백드롭에서 버튼을 놓는 오동작을 방지한다.
const modalBackdropState = {
  settings:    false,
  createUser:  false,
  deleteUser:  false,
  promoteAdmin: false,
};

// 앱 생성 폼의 shake 애니메이션 타이머 ID 목록 (clearCreateValidationTimers로 일괄 취소)
const createValidationTimers = [];
