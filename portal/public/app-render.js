// =============================================================================
// app-render.js - 앱 목록 · 사용자 목록 렌더링
// =============================================================================
// 역할:
//   state.apps, state.users 데이터를 DOM으로 변환한다.
//   app-utils.js(escapeHtml, statusClass 등)에 의존한다.
// =============================================================================

import { el, state } from "./app-state.js";
import {
  canManageApps,
  canManageUsers,
  escapeHtml,
  formatDate,
  formatJobAction,
  formatJobTarget,
  isLoggedIn,
  isPasswordLocked,
  runtimeBadgeHtml,
  statusClass,
} from "./app-utils.js";

function appSettingsButton(safeUser, safeApp, disabled = "") {
  return `<button class="action-btn app-manage-btn" data-action="manage" type="button" title="App settings" aria-label="App settings for ${safeUser} / ${safeApp}" ${disabled}>
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path fill="currentColor" d="M19.14 12.94a7.8 7.8 0 0 0 .05-.94 7.8 7.8 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.2 7.2 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.2 7.2 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.8 7.8 0 0 0-.05.94 7.8 7.8 0 0 0 .05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.04.7 1.62.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.24 1.12-.55 1.62-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58Z" />
    </svg>
  </button>`;
}

// ── 앱 카드 목록 렌더링 ───────────────────────────────────────────────────────

function renderApps(apps) {
  el.appCountChip.textContent = String(apps.length);

  if (!apps.length) {
    el.emptyState.style.display = "block";
    if (!isLoggedIn()) {
      el.emptyState.textContent = "Log in to view your apps.";
    } else if (isPasswordLocked()) {
      el.emptyState.textContent = "Change your password to view your apps.";
    } else {
      el.emptyState.textContent = "No apps yet. Create an app to get started.";
    }
    el.appsContainer.innerHTML = "";
    return;
  }

  const actionsDisabled = canManageApps() ? "" : "disabled";
  el.emptyState.style.display = "none";
  el.appsContainer.innerHTML = apps.map((appItem) => {
    const safeUser      = escapeHtml(appItem.userid);
    const safeApp       = escapeHtml(appItem.appname);
    const safeRepoUrl   = escapeHtml(appItem.repoUrl || "-");
    const safeBranch    = escapeHtml(appItem.branch || "main");
    const rawStatus     = appItem.status || "unknown";
    const safeStatus    = escapeHtml(rawStatus);
    const safeCreatedAt = escapeHtml(formatDate(appItem.createdAt));
    const badgeHtml     = runtimeBadgeHtml(appItem.detectedRuntime);

    // dev 모드에서는 http + Traefik 호스트 포트를 붙인다 (*.localhost 자동 해석).
    // prod 모드에서는 https (NPM이 443 처리).
    let domainHtml;
    if (appItem.domain) {
      const url = state.devMode && state.traefikPort
        ? `http://${appItem.domain}:${state.traefikPort}`
        : `https://${appItem.domain}`;
      domainHtml = `<a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(appItem.domain)}</a>`;
    } else {
      domainHtml = "-";
    }
    if (appItem.activeCustomDomains?.length) {
      const customLinks = appItem.activeCustomDomains
        .map(d => `<a href="https://${escapeHtml(d.domain)}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.domain)}</a>`)
        .join(", ");
      domainHtml += `, ${customLinks}`;
    }

    return `
      <article class="app-card" data-userid="${safeUser}" data-appname="${safeApp}">
        <div class="app-card-head">
          <div class="app-card-title-row">
            <button class="app-name-btn" data-action="manage" type="button" ${actionsDisabled}>${safeUser} / ${safeApp}</button>
            <span class="status-pill ${statusClass(rawStatus)}">${safeStatus}</span>
            ${appSettingsButton(safeUser, safeApp, actionsDisabled)}
          </div>
          <div class="app-card-badges">
            ${badgeHtml}
          </div>
        </div>
        <p class="app-domain">${domainHtml}</p>
        <p class="app-meta">repo: ${safeRepoUrl} | branch: ${safeBranch} | created: ${safeCreatedAt}</p>
        <div class="app-actions">
          <button class="action-btn" data-action="start"  type="button" ${actionsDisabled}>Start</button>
          <button class="action-btn" data-action="stop"   type="button" ${actionsDisabled}>Stop</button>
          <button class="action-btn" data-action="deploy" type="button" ${actionsDisabled}>Deploy</button>
          <button class="action-btn danger" data-action="delete" type="button" ${actionsDisabled}>Delete</button>
        </div>
      </article>
    `;
  }).join("");
}

// ── 전체 앱 목록 렌더링 (Admin 전용) ──────────────────────────────────────────

function renderAdminApps(apps) {
  if (!apps.length) {
    el.adminEmptyState.style.display = "block";
    el.adminEmptyState.textContent = "No apps found.";
    el.adminAppsContainer.innerHTML = "";
    return;
  }

  el.adminEmptyState.style.display = "none";
  el.adminAppsContainer.innerHTML = apps.map((appItem) => {
    const safeUser      = escapeHtml(appItem.userid);
    const safeApp       = escapeHtml(appItem.appname);
    const safeRepoUrl   = escapeHtml(appItem.repoUrl || "-");
    const safeBranch    = escapeHtml(appItem.branch || "main");
    const rawStatus     = appItem.status || "unknown";
    const safeStatus    = escapeHtml(rawStatus);
    const safeCreatedAt = escapeHtml(formatDate(appItem.createdAt));
    const badgeHtml     = runtimeBadgeHtml(appItem.detectedRuntime);

    let domainHtml;
    if (appItem.domain) {
      const url = state.devMode && state.traefikPort
        ? `http://${appItem.domain}:${state.traefikPort}`
        : `https://${appItem.domain}`;
      domainHtml = `<a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(appItem.domain)}</a>`;
    } else {
      domainHtml = "-";
    }
    if (appItem.activeCustomDomains?.length) {
      const customLinks = appItem.activeCustomDomains
        .map(d => `<a href="https://${escapeHtml(d.domain)}" target="_blank" rel="noopener noreferrer">${escapeHtml(d.domain)}</a>`)
        .join(", ");
      domainHtml += `, ${customLinks}`;
    }

    return `
      <article class="app-card" data-userid="${safeUser}" data-appname="${safeApp}">
        <div class="app-card-head">
          <div class="app-card-title-row">
            <button class="app-name-btn" data-action="manage" type="button">${safeUser} / ${safeApp}</button>
            <span class="status-pill ${statusClass(rawStatus)}">${safeStatus}</span>
            ${appSettingsButton(safeUser, safeApp)}
          </div>
          <div class="app-card-badges">
            ${badgeHtml}
          </div>
        </div>
        <p class="app-domain">${domainHtml}</p>
        <p class="app-meta">repo: ${safeRepoUrl} | branch: ${safeBranch} | created: ${safeCreatedAt}</p>
        <div class="app-actions">
          <button class="action-btn" data-action="start"  type="button">Start</button>
          <button class="action-btn" data-action="stop"   type="button">Stop</button>
          <button class="action-btn" data-action="deploy" type="button">Deploy</button>
          <button class="action-btn danger" data-action="delete" type="button">Delete</button>
        </div>
      </article>
    `;
  }).join("");
}

// ── 사용자 테이블 렌더링 ──────────────────────────────────────────────────────

function renderUsers(users) {
  if (!canManageUsers()) {
    el.usersCount.textContent = "Users: 0";
    el.usersTableBody.innerHTML = "";
    el.usersEmptyState.hidden = false;
    el.openCreateUserBtn.disabled = true;
    if (!isLoggedIn()) {
      el.usersEmptyState.textContent = "Log in to view users.";
    } else if (isPasswordLocked()) {
      el.usersEmptyState.textContent = "Change your password to view users.";
    } else {
      el.usersEmptyState.textContent = "Only administrators can view users.";
    }
    return;
  }

  el.openCreateUserBtn.disabled = false;
  el.usersCount.textContent = `Users: ${users.length}`;

  if (!users.length) {
    el.usersTableBody.innerHTML = "";
    el.usersEmptyState.hidden = false;
    el.usersEmptyState.textContent = "No users registered.";
    return;
  }

  el.usersEmptyState.hidden = true;
  el.usersTableBody.innerHTML = users.map((item) => {
    const safeUsername    = escapeHtml(item.username || "-");
    const isAdmin         = item.isAdmin;
    const safeRole        = isAdmin ? "Admin" : "User";
    const safeCreatedAt   = escapeHtml(formatDate(item.createdAt));
    const safeLastAccessAt = escapeHtml(formatDate(item.lastAccessAt));

    // admin 계정은 삭제/승격 불가 — 보호됨 표시
    const actionCell = isAdmin
      ? `<span class="users-protected">Protected</span>`
      : `<div class="users-action-group">
           <button
             class="action-btn users-promote-btn"
             data-action="promote-user"
             data-id="${item.id}"
             data-username="${safeUsername}"
             type="button"
           >Promote to Admin</button>
           <button
             class="action-btn danger users-remove-btn"
             data-action="remove-user"
             data-id="${item.id}"
             data-username="${safeUsername}"
             type="button"
           >Remove</button>
         </div>`;

    return `
      <tr>
        <td>${safeUsername}</td>
        <td><span class="role-badge ${isAdmin ? "role-admin" : "role-user"}">${safeRole}</span></td>
        <td>${safeCreatedAt}</td>
        <td>${safeLastAccessAt}</td>
        <td>${actionCell}</td>
      </tr>
    `;
  }).join("");
}

// ── 작업 목록 테이블 렌더링 ──────────────────────────────────────────────────────

function renderJobList(jobs) {
  const activeStatuses = new Set(["pending", "running", "done", "interrupted", "failed", "warn"]);
  const activeJobs = jobs.filter((j) => activeStatuses.has(j.status));

  const table = document.getElementById("job-list-table");
  if (!activeJobs.length) {
    el.jobListTbody.innerHTML = "";
    el.jobListEmpty.hidden = false;
    table.hidden = true;
    return;
  }

  el.jobListEmpty.hidden = true;
  table.hidden = false;

  el.jobListTbody.innerHTML = activeJobs.map((job) => {
    const jobName = escapeHtml(formatJobAction(job));
    const appPart = escapeHtml(formatJobTarget(job) || "-");
    const rawStatus = job.status;
    const safeStatus = escapeHtml(rawStatus);
    const isActive = rawStatus === "pending" || rawStatus === "running";
    const logButton = `
      <button class="ghost-btn job-log-btn" data-action="view-job-log" data-id="${escapeHtml(job.id)}" type="button">
        ${isActive ? "Live logs" : "View logs"}
      </button>`;

    let actions = `<span class="ink-subtle">-</span>`;
    const closeBtnHtml = `
      <button class="ghost-btn danger-ghost-btn job-action-btn job-remove-btn" data-action="cancel-job" data-id="${job.id}" type="button" aria-label="Remove job from list" title="Remove from list">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    `;

    if (rawStatus === "interrupted" || rawStatus === "failed") {
      actions = `
        <div class="job-action-group">
          <button class="action-btn job-action-btn" data-action="retry-job" data-id="${job.id}" type="button">Retry</button>
          ${closeBtnHtml}
        </div>
      `;
    } else if (rawStatus === "done" || rawStatus === "warn") {
      actions = `
        <div class="job-action-group">
          ${closeBtnHtml}
        </div>
      `;
    }

    return `
      <tr>
        <td>${jobName}</td>
        <td>${appPart}</td>
        <td><span class="status-pill ${statusClass(rawStatus)}">${safeStatus}</span></td>
        <td>${logButton}</td>
        <td>${actions}</td>
      </tr>
    `;
  }).join("");
}

// ── 커스텀 도메인 테이블 렌더링 ──────────────────────────────────────────────

function renderDomains(domains) {
  if (!domains.length) {
    el.domainsTableWrap.hidden = true;
    el.domainsEmptyState.hidden = false;
    return;
  }

  el.domainsEmptyState.hidden = true;
  el.domainsTableWrap.hidden = false;

  el.domainsTableBody.innerHTML = domains.map((d) => {
    const safeDomain = escapeHtml(d.domain);
    const safeCname  = escapeHtml(d.cnameTarget || "");
    const status     = d.status || "pending";

    const badgeClass =
      status === "active"  ? "domain-status-active"  :
      status === "error"   ? "domain-status-error"   :
                             "domain-status-pending";

    const statusLabel =
      status === "active"  ? "Active"  :
      status === "error"   ? "Error"   :
                             "Pending";

    return `
      <tr>
        <td><span class="domain-type-badge">CNAME</span></td>
        <td><a href="https://${safeDomain}" target="_blank" rel="noopener noreferrer" class="domain-name">${safeDomain}</a></td>
        <td>
          <div class="domain-cname-cell">
            <code class="domain-cname-target">${safeCname}</code>
            <button class="ghost-btn domains-copy-btn" data-action="copy-cname"
              data-cname="${safeCname}" type="button" title="Copy"><svg xmlns="http://www.w3.org/2000/svg" height="16" viewBox="0 0 24 24" width="16" aria-hidden="true"><path d="M0 0h24v24H0z" fill="none"/><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg></button>
          </div>
        </td>
        <td><span class="domain-status-badge ${badgeClass}">${statusLabel}</span></td>
        <td>
          <div class="users-action-group">
            <button class="ghost-btn" data-action="verify-domain"
              data-id="${d.id}" type="button">Verify</button>
            <button class="ghost-btn danger-ghost-btn" data-action="remove-domain"
              data-id="${d.id}" type="button">Remove</button>
          </div>
        </td>
      </tr>
    `;
  }).join("");
}

export {
  renderApps,
  renderAdminApps,
  renderDomains,
  renderUsers,
  renderJobList,
};
