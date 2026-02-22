// =============================================================================
// app-api.js - API 통신 · 데이터 로딩 · 앱 액션
// =============================================================================
// 역할:
//   서버 API 호출과 데이터 로딩/자동갱신, 앱 액션(start/stop/deploy/delete)을 담당한다.
//   장시간 작업은 202 비동기 응답 + jobId 폴링 패턴으로 처리한다.
// =============================================================================

// ── 기본 API 통신 ─────────────────────────────────────────────────────────────

import { AUTO_REFRESH_MS, el, state } from "./app-state.js";
import { renderApps, renderUsers } from "./app-render.js";
import { navigateToApp, switchView, updateAuthUi, renderJobIndicator } from "./app-ui.js";
import {
  canManageApps,
  canManageUsers,
  normalizeErrorMessage,
  redirectToAuth,
  setBanner,
  setEnvError,
  setSettingsError,
  showToast,
  syncDomainPreview,
  validateCreateForm,
} from "./app-utils.js";

// 모든 API 호출의 기반 함수. 응답이 ok: false이거나 HTTP 오류면 예외를 던진다.
async function apiFetch(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    headers,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload.data;
}

// ── 데이터 로딩 ───────────────────────────────────────────────────────────────

async function loadConfig() {
  const data = await apiFetch("/config");
  state.domain      = data.domain  || "my.domain.com";
  state.devMode     = Boolean(data.devMode);
  state.traefikPort = data.traefikPort || null;
  el.domainChip.textContent = state.domain;
  el.limitChip.textContent  = `${data.limits.maxAppsPerUser}/${data.limits.maxTotalApps}`;
  el.devModeBadge.hidden = !state.devMode;
  syncDomainPreview();
}

async function loadSession() {
  try {
    const data = await apiFetch("/auth/me");
    state.user = data.user || null;
    updateAuthUi();
    syncDomainPreview();
    return true;
  } catch (error) {
    if (error.status === 401) {
      state.user = null;
      updateAuthUi();
      syncDomainPreview();
      return false;
    }
    throw error;
  }
}

async function loadApps() {
  if (!canManageApps()) {
    state.apps = [];
    renderApps([]);
    return;
  }
  const data = await apiFetch("/apps");
  state.apps = data.apps || [];
  renderApps(state.apps);
  if (data.hasLabelErrors) {
    setBanner("컨테이너 중 일부의 라벨이 누락되어 대시보드에서 제외되었습니다. 관리자에게 문의하세요.", "error");
  }
}

async function loadUsers() {
  if (!canManageUsers()) {
    state.users = [];
    renderUsers([]);
    return;
  }
  const data = await apiFetch("/users");
  state.users = data.users || [];
  renderUsers(state.users);
}

async function refreshDashboardData() {
  await loadApps();
  await loadUsers();
  if (canManageApps()) {
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
}

// ── 자동 갱신 ─────────────────────────────────────────────────────────────────

function stopAutoRefresh() {
  if (state.refreshTimer) {
    clearInterval(state.refreshTimer);
    state.refreshTimer = null;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!canManageApps()) return;
  state.refreshTimer = setInterval(async () => {
    try {
      await loadApps();
      await loadUsers();
    } catch (error) {
      await handleRequestError(error);
    }
  }, AUTO_REFRESH_MS);
}

// ── Job 폴링 ─────────────────────────────────────────────────────────────────
//
// 새로고침 이후에도 진행중 job 상태를 복원하는 핵심 메커니즘.
// 부트스트랩 시 /jobs를 조회하여 active job을 감지하고 자동으로 폴링을 시작한다.

const JOB_POLL_INTERVAL_MS = 1500;
const TERMINAL_STATUSES = new Set(["done", "failed", "interrupted"]);

/**
 * job 상태를 주기적으로 조회하고 완료/실패 시 UI를 업데이트한다.
 * 페이지 새로고침 후에도 동일 jobId로 재연결되면 상태 복원이 이루어진다.
 *
 * @param {string}   jobId
 * @param {object}   callbacks
 * @param {Function} callbacks.onDone   - status='done' 시 호출 (job 객체 전달)
 * @param {Function} callbacks.onFail   - status='failed'|'interrupted' 시 호출
 */
function pollJob(jobId, callbacks = {}) {
  if (state.jobPollers.has(jobId)) return; // 이미 폴링 중

  const intervalId = setInterval(async () => {
    try {
      const data = await apiFetch(`/jobs/${jobId}`);
      const job = data.job;

      // state.jobs 업데이트
      const idx = state.jobs.findIndex((j) => j.id === jobId);
      if (idx >= 0) state.jobs[idx] = job;
      else state.jobs.unshift(job);

      renderJobIndicator(state.jobs);

      if (TERMINAL_STATUSES.has(job.status)) {
        clearInterval(intervalId);
        state.jobPollers.delete(jobId);

        if (job.status === "done") {
          callbacks.onDone?.(job);
        } else {
          callbacks.onFail?.(job);
        }
        // 앱 목록 갱신 (job 완료 후 상태 반영)
        await loadApps().catch(() => {});
      }
    } catch (error) {
      if (error.status === 401) {
        clearInterval(intervalId);
        state.jobPollers.delete(jobId);
      }
      // 그 외 네트워크 오류는 다음 interval에서 재시도
    }
  }, JOB_POLL_INTERVAL_MS);

  state.jobPollers.set(jobId, intervalId);
}

/**
 * 서버의 /jobs 엔드포인트를 조회하여 진행중인 job을 복원한다.
 * 부트스트랩(페이지 로드/새로고침) 시 호출한다.
 */
async function loadAndRecoverJobs() {
  if (!canManageApps()) return;
  try {
    const data = await apiFetch("/jobs");
    state.jobs = data.jobs || [];
    renderJobIndicator(state.jobs);

    // active 상태인 job에 대해 폴링 재개
    for (const job of state.jobs) {
      if (!TERMINAL_STATUSES.has(job.status)) {
        pollJob(job.id, {
          onDone: (j) => _onJobDone(j),
          onFail: (j) => _onJobFail(j),
        });
      }
    }
  } catch {
    // /jobs 자체 오류는 무시 (앱 기능에 영향 없음)
  }
}

function _onJobDone(job) {
  const label = _jobLabel(job);
  showToast(`✅ 완료: ${label}`, "success");
}

function _onJobFail(job) {
  const label = _jobLabel(job);
  const reason = job.status === "interrupted"
    ? "서버 재시작으로 인해 중단됨 — 재시도 가능"
    : (job.error || "알 수 없는 오류");
  showToast(`❌ 실패: ${label} — ${reason}`, "error", 8000);
}

function _jobLabel(job) {
  const { type, meta } = job;
  const appPart = meta?.appname ? `${meta.userid}/${meta.appname}` : "";
  const typeMap = {
    create: "앱 생성",
    deploy: "재배포",
    delete: "앱 삭제",
    start:  "시작",
    stop:   "중지",
    "env-restart": "환경변수 재시작",
  };
  return appPart ? `${typeMap[type] || type} (${appPart})` : (typeMap[type] || type);
}

/**
 * 202 응답으로 jobId를 받아 즉시 폴링을 시작하는 헬퍼.
 */
function startJobPolling(jobId, appLabel, actionLabel) {
  showToast(`${actionLabel} 시작: ${appLabel} — 진행 중...`, "info", 3000);

  // state.jobs에 낙관적으로 pending job 추가
  state.jobs.unshift({
    id: jobId, status: "pending",
    type: "unknown", userid: state.user?.username,
    meta: {}, createdAt: Date.now(),
  });
  renderJobIndicator(state.jobs);

  pollJob(jobId, {
    onDone: (job) => {
      const label = appLabel || _jobLabel(job);
      showToast(`✅ ${actionLabel} 완료: ${label}`, "success");
    },
    onFail: (job) => {
      const label = appLabel || _jobLabel(job);
      const reason = job.status === "interrupted"
        ? "서버 재시작으로 중단됨"
        : (job.error || "오류 발생");
      showToast(`❌ ${actionLabel} 실패: ${label} — ${reason}`, "error", 8000);
    },
  });
}

/**
 * interrupted/failed job을 서버에 재시도 요청한다.
 */
async function retryJob(jobId) {
  const data = await apiFetch(`/jobs/${jobId}/retry`, { method: "POST" });
  const job = state.jobs.find((j) => j.id === jobId);
  const label = job ? _jobLabel(job) : jobId;

  pollJob(jobId, {
    onDone: (j) => showToast(`✅ 재시도 완료: ${_jobLabel(j)}`, "success"),
    onFail: (j) => showToast(`❌ 재시도 실패: ${_jobLabel(j)} — ${j.error || "오류"}`, "error", 8000),
  });
  showToast(`재시도 요청됨: ${label}`, "info");
  return data;
}

/**
 * interrupted/failed job을 서버에 취소(복구) 요청한다.
 */
async function cancelJob(jobId) {
  const data = await apiFetch(`/jobs/${jobId}/cancel`, { method: "POST" });
  const job = state.jobs.find((j) => j.id === jobId);
  const label = job ? _jobLabel(job) : jobId;
  showToast(`✅ 작업 취소 완료: ${label}`, "success");

  // 상태 배열에서 직접 제거
  state.jobs = state.jobs.filter((j) => j.id !== jobId);
  renderJobIndicator(state.jobs);
  await loadApps().catch(() => {});
  return data;
}

// ── 공통 에러 처리 ────────────────────────────────────────────────────────────

async function handleRequestError(error) {
  if (error?.status === 401) {
    state.user  = null;
    state.apps  = [];
    state.users = [];
    renderApps([]);
    renderUsers([]);
    updateAuthUi();
    stopAutoRefresh();
    setBanner("세션이 만료되었습니다. 로그인 페이지로 이동합니다.", "error");
    redirectToAuth();
    return;
  }
  setBanner(normalizeErrorMessage(error), "error");
}

async function handleSettingsModalError(error) {
  const message = normalizeErrorMessage(error, "설정 변경 중 오류가 발생했습니다.");
  const isCurrentPasswordMismatch =
    error?.status === 401 && /^current password is incorrect$/i.test(message);
  if (error?.status === 401 && !isCurrentPasswordMismatch) {
    await handleRequestError(error);
    return;
  }
  setSettingsError(message);
}

// ── 앱 카드 액션 ─────────────────────────────────────────────────────────────

function getActionTarget(button) {
  const appCard = button.closest(".app-card");
  if (!appCard) return null;
  return {
    userid:  appCard.dataset.userid,
    appname: appCard.dataset.appname,
    action:  button.dataset.action,
  };
}

async function performAction(target) {
  if (!canManageApps()) {
    throw new Error("앱 관리를 위해 로그인 상태와 비밀번호 변경 상태를 확인하세요.");
  }

  const { userid, appname, action } = target;
  const appLabel = `${userid}/${appname}`;

  if (action === "manage") {
    await navigateToApp(userid, appname);
    return;
  }

  if (action === "delete") {
    const keepData    = el.keepDataInput?.checked ?? false;
    const shouldDelete = window.confirm(`${appLabel} 앱을 삭제합니다.`);
    if (!shouldDelete) return;

    const data = await apiFetch(`/apps/${userid}/${appname}`, {
      method: "DELETE",
      body: JSON.stringify({ keepData }),
    });
    startJobPolling(data.jobId, appLabel, "삭제");

    if (state.selectedApp?.userid === userid && state.selectedApp?.appname === appname) {
      state.selectedApp = null;
      switchView("dashboard");
    }
    return;
  }

  const validActions = ["start", "stop", "deploy"];
  if (!validActions.includes(action)) return;

  const actionLabels = { start: "시작", stop: "중지", deploy: "재배포" };
  const data = await apiFetch(`/apps/${userid}/${appname}/${action}`, { method: "POST" });
  startJobPolling(data.jobId, appLabel, actionLabels[action] || action);
}

// ── 앱 관리 > Logs ────────────────────────────────────────────────────────────

async function loadDetailLogs() {
  if (!state.selectedApp) return;
  const { userid, appname } = state.selectedApp;
  const rawLines = Number.parseInt(el.detailLogLinesInput.value, 10);
  const lines    = Number.isFinite(rawLines) ? Math.max(1, Math.min(1000, rawLines)) : 120;
  el.detailLogsTitle.textContent = `${userid}/${appname} 로그 조회 중...`;
  const data = await apiFetch(`/apps/${userid}/${appname}/logs?lines=${lines}`);
  el.detailLogsTitle.textContent = `${userid}/${appname} (${lines} lines)`;
  el.detailLogsOutput.textContent = data.logs || "(empty)";
}

// ── 앱 관리 > Settings (env vars) ────────────────────────────────────────────

async function loadDetailEnv() {
  if (!state.selectedApp) return;
  const { userid, appname } = state.selectedApp;
  const data = await apiFetch(`/apps/${userid}/${appname}/env`);
  el.detailEnvTextarea.value = data.env || "";
}

async function saveDetailEnv() {
  if (!state.selectedApp) return;
  setEnvError("");
  const { userid, appname } = state.selectedApp;
  const envContent = el.detailEnvTextarea.value;
  el.detailEnvSaveBtn.disabled = true;
  el.detailEnvSaveBtn.textContent = "저장 중...";
  try {
    const result = await apiFetch(`/apps/${userid}/${appname}/env`, {
      method: "PUT",
      body: JSON.stringify({ env: envContent }),
    });
    if (result.jobId) {
      startJobPolling(result.jobId, `${userid}/${appname}`, "환경변수 재시작");
    }
    showToast(`환경변수 저장 완료: ${userid}/${appname}`, "success");
  } catch (error) {
    setEnvError(normalizeErrorMessage(error, "환경변수 저장 중 오류가 발생했습니다."));
  } finally {
    el.detailEnvSaveBtn.disabled = false;
    el.detailEnvSaveBtn.textContent = "저장 및 재시작";
  }
}

// ── 앱 생성 ───────────────────────────────────────────────────────────────────

async function handleCreate(event) {
  event.preventDefault();
  if (!canManageApps()) {
    throw new Error("로그인 후 비밀번호 변경을 완료해야 앱을 관리할 수 있습니다.");
  }

  const repoUrl = el.repoUrlInput.value.trim();
  const branch  = el.repoBranchInput.value.trim() || "main";
  const body    = {
    appname: el.appnameInput.value.trim(),
    repoUrl,
    branch,
  };

  if (!validateCreateForm()) {
    throw new Error("appname, repo URL을 입력하세요.");
  }

  const submitBtn = el.createSubmitBtn;
  submitBtn.disabled = true;
  submitBtn.textContent = "요청 중...";
  try {
    const data = await apiFetch("/apps", { method: "POST", body: JSON.stringify(body) });
    startJobPolling(data.jobId, `${body.appname}`, "앱 생성");
    el.createForm.reset();
    el.repoBranchInput.value = "main";
    syncDomainPreview();
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = "Create App";
  }
}

export {
  apiFetch,
  getActionTarget,
  handleCreate,
  handleRequestError,
  handleSettingsModalError,
  loadApps,
  loadAndRecoverJobs,
  loadConfig,
  loadDetailEnv,
  loadDetailLogs,
  loadSession,
  loadUsers,
  performAction,
  pollJob,
  refreshDashboardData,
  retryJob,
  cancelJob,
  saveDetailEnv,
  startAutoRefresh,
  startJobPolling,
  stopAutoRefresh,
};
