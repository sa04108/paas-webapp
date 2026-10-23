import { el, state } from "./app-state.js";

const output = el.detailLogsOutput;
const title = el.detailLogsTitle;
const controls = document.getElementById("detail-log-services");
const liveToggle = el.detailRefreshLogsBtn;
const timestampToggle = document.getElementById("detail-log-timestamps");
let stream = null;
let entries = [];
let services = [];
let selected = new Set();
let warnings = [];
let active = false;
let liveMode = true;
let showTimestamps = false;
let requestKey = "";
let activeAppKey = "";
const selectionByApp = new Map();
const selectionAllByApp = new Map();
let servicesKnown = false;
let selectionAll = true;
let generation = 0;
let refreshController = null;
let probeController = null;

function lineCount() {
  const n = Number.parseInt(el.detailLogLinesInput.value, 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(1000, n)) : 120;
}

function syncLiveToggle() {
  liveToggle.dataset.auto = String(liveMode);
  liveToggle.setAttribute("aria-pressed", String(liveMode));
  liveToggle.title = liveMode ? "Pause automatic log streaming" : "Resume automatic log streaming";
  liveToggle.querySelector(".refresh-label").textContent = liveMode ? "Auto" : "Refresh";
}

function showLogError(error) {
  if (error.name === "AbortError" || !active) return;
  cancelRequests();
  liveMode = false;
  syncLiveToggle();
  title.textContent = error.message;
  if (!entries.length) output.textContent = `Unable to load logs: ${error.message}`;
}

function nearBottom() { return output.scrollHeight - output.scrollTop - output.clientHeight < 48; }
function stopStream() { if (stream) stream.close(); stream = null; requestKey = ""; }
function cancelRequests() {
  generation += 1;
  if (refreshController) refreshController.abort();
  refreshController = null;
  if (probeController) probeController.abort();
  probeController = null;
  stopStream();
  return generation;
}

function render() {
  const follow = nearBottom();
  const previousTop = output.scrollTop;
  const frag = document.createDocumentFragment();
  const sorted = entries.filter((entry) => selected.has(entry.service))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-lineCount());
  for (const entry of sorted) {
    const row = document.createElement("div");
    if (showTimestamps) {
      const time = document.createElement("span");
      time.className = "log-timestamp";
      time.textContent = `${entry.timestamp} `;
      row.append(time);
    }
    const service = document.createElement("span");
    service.className = "log-service-prefix";
    service.textContent = `[${entry.service}] `;
    row.append(service, document.createTextNode(entry.message));
    frag.append(row);
  }
  output.replaceChildren(frag);
  if (!sorted.length) output.textContent = selected.size ? "No logs available for the selected services." : "Choose services to view logs.";
  output.scrollTop = follow ? output.scrollHeight : previousTop;
}

function renderServices(nextServices = null) {
  if (Array.isArray(nextServices)) {
    const before = new Set(selected);
    const hadAll = selectionAll;
    services = nextServices;
    selected = hadAll ? new Set(services) : new Set(services.filter((s) => before.has(s)));
    if (activeAppKey) {
      selectionByApp.set(activeAppKey, new Set(selected));
      selectionAllByApp.set(activeAppKey, hadAll);
    }
  }
  controls.replaceChildren();
  for (const service of services) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "service-toggle";
    button.textContent = service;
    button.setAttribute("aria-pressed", String(selected.has(service)));
    button.addEventListener("click", () => {
      if (selected.has(service)) selected.delete(service); else selected.add(service);
      selectionAll = services.length > 0 && selected.size === services.length;
      if (activeAppKey) {
        selectionByApp.set(activeAppKey, new Set(selected));
        selectionAllByApp.set(activeAppKey, selectionAll);
      }
      renderServices();
      render();
      reloadSelection();
    });
    controls.append(button);
  }
}

function queryUrl(streaming = false) {
  const { userid, appname } = state.selectedApp || {};
  const params = new URLSearchParams({ lines: String(lineCount()) });
  if (servicesKnown) params.set("services", [...selected].join(","));
  return `/api/apps/${encodeURIComponent(userid)}/${encodeURIComponent(appname)}/logs${streaming ? "/stream" : ""}?${params}`;
}

function applyPayload(data, replace) {
  if (Array.isArray(data.services)) { servicesKnown = true; renderServices(data.services); }
  if (Array.isArray(data.warnings)) warnings = data.warnings;
  if (Array.isArray(data.entries)) {
    if (replace) entries = data.entries;
    else {
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      for (const entry of data.entries) byId.set(entry.id, entry);
      entries = [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-lineCount());
    }
  }
  entries = entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-lineCount());
  let bufferSize = entries.reduce((total, entry) => total + entry.message.length + entry.timestamp.length + entry.service.length, 0);
  while (entries.length && bufferSize > 2 * 1024 * 1024) {
    const removed = entries.shift();
    bufferSize -= removed.message.length + removed.timestamp.length + removed.service.length;
  }
  title.textContent = warnings.length ? warnings.join(" · ") : selected.size === 0
    ? "Choose services to view logs."
    : `${state.selectedApp.userid}/${state.selectedApp.appname} · ${entries.length} entries`;
  render();
}

async function refresh() {
  if (!state.selectedApp) return;
  const key = `${state.selectedApp.userid}/${state.selectedApp.appname}`;
  const currentGeneration = cancelRequests();
  const controller = new AbortController();
  refreshController = controller;
  const query = queryUrl();
  const response = await fetch(query, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
  const payload = await response.json().catch(() => ({}));
  if (currentGeneration !== generation || controller.signal.aborted || !active || !state.selectedApp || `${state.selectedApp.userid}/${state.selectedApp.appname}` !== key || query !== queryUrl()) return;
  if (!response.ok || payload.ok === false) throw Object.assign(new Error(payload.error || "Failed to load logs"), { status: response.status });
  if (!Array.isArray(payload.data?.entries) || !Array.isArray(payload.data?.services)) {
    throw new Error("The portal backend needs to be updated. Restart the portal and reload this page.");
  }
  refreshController = null;
  if (!servicesKnown && !selectionAll && selected.size > 0 && Array.isArray(payload.data?.services)) {
    if (Array.isArray(payload.data.warnings)) warnings = payload.data.warnings;
    servicesKnown = true;
    renderServices(payload.data.services);
    render();
    return refresh();
  }
  applyPayload(payload.data, true);
  return true;
}

function reloadSelection() {
  if (!active) return;
  if (liveMode) connect(true);
  else refresh().catch(showLogError);
}

function connect(force = false) {
  if (!active || !liveMode || !state.selectedApp) return;
  const nextKey = `${state.selectedApp.userid}/${state.selectedApp.appname}|${lineCount()}|${[...selected].sort().join(",")}`;
  if (!force && stream && requestKey === nextKey) return;
  cancelRequests();
  requestKey = nextKey;
  const currentGeneration = generation;
  stream = new EventSource(queryUrl(true), { withCredentials: true });
  const thisStream = stream;
  syncLiveToggle();
  stream.onopen = () => {
    if (currentGeneration === generation && thisStream === stream) {
      title.dataset.connection = "connected";
      title.textContent = warnings.length ? warnings.join(" · ") : `${state.selectedApp.userid}/${state.selectedApp.appname} · ${entries.length} entries`;
    }
  };
  stream.onmessage = (event) => {
    if (currentGeneration !== generation || thisStream !== stream || !active) return;
    try {
      const data = JSON.parse(event.data);
      if (data.type === "snapshot") applyPayload(data, true);
      else if (data.type === "entries") applyPayload(data, false);
      else if (data.type === "services") { servicesKnown = true; renderServices(data.services || []); render(); connect(true); }
      else if (data.type === "warning") { warnings.push(data.message); warnings = warnings.slice(-20); title.textContent = warnings.join(" · "); }
      else if (data.type === "end") { title.textContent = data.message || "Log stream ended"; cancelRequests(); liveMode = false; syncLiveToggle(); }
    } catch { /* 잘못된 이벤트 하나는 스트림을 중단하지 않는다. */ }
  };
  stream.onerror = async () => {
    if (currentGeneration !== generation || thisStream !== stream || !active) return;
    title.dataset.connection = "reconnecting";
    title.textContent = "Reconnecting to live logs…";
    const controller = new AbortController();
    probeController = controller;
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const probeUrl = queryUrl(false);
      const response = await fetch(probeUrl, { credentials: "same-origin", cache: "no-store", signal: controller.signal });
      if (currentGeneration !== generation || thisStream !== stream || !active) return;
      if (response.status === 401 || response.status === 403) { cancelRequests(); liveMode = false; syncLiveToggle(); title.textContent = "Log access expired. Please sign in again."; }
      else if (response.status === 404 || response.status === 410) { cancelRequests(); liveMode = false; syncLiveToggle(); title.textContent = "Log stream has ended."; }
    } catch { /* EventSource가 연결을 다시 시도한다. */ }
    finally {
      clearTimeout(timeout);
      controller.abort();
      if (probeController === controller) probeController = null;
    }
  };
}

function setActive(next) {
  const shouldRun = Boolean(next && state.activeView === "app-detail" && state.activeDetailTab === "logs" && state.selectedApp);
  const key = shouldRun ? `${state.selectedApp.userid}/${state.selectedApp.appname}` : "";
  if (active === shouldRun && activeAppKey === key) return;
  active = shouldRun;
  if (!active) { cancelRequests(); return; }
  const previousKey = activeAppKey;
  cancelRequests();
  if (!active) { activeAppKey = ""; return; }
  const changedApp = previousKey !== key;
  if (changedApp) {
    servicesKnown = false;
    services = [];
    selected = new Set(selectionByApp.get(key) || []);
    selectionAll = selectionAllByApp.get(key) ?? true;
    entries = [];
    warnings = [];
    activeAppKey = key;
    renderServices();
  }
  if (!entries.length) output.textContent = "Loading logs…";
  refresh().then((updated) => { if (updated && active && liveMode) connect(true); }).catch(showLogError);
}

liveToggle.addEventListener("click", () => {
  liveMode = !liveMode;
  syncLiveToggle();
  if (!liveMode) cancelRequests();
  else refresh().then((updated) => { if (updated && active && liveMode) connect(true); })
    .catch(showLogError);
});
el.detailLogLinesInput.addEventListener("change", () => { render(); reloadSelection(); });
timestampToggle.addEventListener("change", () => { showTimestamps = timestampToggle.checked; render(); });
document.addEventListener("app-logs-visibility", (event) => setActive(event.detail));
window.addEventListener("pagehide", cancelRequests);
syncLiveToggle();
export { setActive as setLogsActive };
