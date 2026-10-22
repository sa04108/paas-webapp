// Compose 런타임 설정을 생성 폼과 앱 설정 화면에서 관리한다.
import { el, state } from "./app-state.js";

const MAX_RUNTIME_BYTES = 65536;
let apiFetch = null;
let requestId = 0;
let loaded = false;
let saving = false;
let serverError = "";
let selectionAppKey = "";
let provisionalExecDefault = false;
let runtimeErrorAppKey = "";
let currentRuntime = { mode: "single" };
let currentAppInfo = null;
let currentAppInfoKey = "";
let runtimeRedeployRequired = false;

const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;

function selectedValue(radios, fallback) {
  return radios.find((radio) => radio.checked)?.value || fallback;
}

function createMode() { return selectedValue(el.createRuntimeModeRadios, "single"); }
function createSource() { return selectedValue(el.createComposeSourceRadios, "inline"); }
function detailMode() { return selectedValue(el.detailRuntimeModeRadios, "single"); }
function detailSource() { return selectedValue(el.detailRuntimeComposeSourceRadios, "inline"); }

function contentError(value) {
  if (!value.trim()) return "Enter Compose YAML content.";
  if (value.includes("\0")) return "Compose YAML must not contain NUL characters.";
  if (new TextEncoder().encode(value).byteLength > MAX_RUNTIME_BYTES) return "Compose YAML must be 64 KiB or smaller.";
  return "";
}

function serviceNameError(value) {
  return SERVICE_NAME_PATTERN.test(value.trim()) ? "" : "Use a service name starting with a lowercase letter, followed by up to 39 lowercase letters, digits, or hyphens.";
}

function rootFileError(value) {
  const file = value.trim();
  if (!file) return "Enter a root Compose file name.";
  if (file.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(file) || file === "." || file === "..") {
    return "Enter a root file name without a path.";
  }
  return "";
}

function createRuntimeError() {
  if (createMode() !== "compose") return "";
  const serviceError = serviceNameError(el.createWebService.value);
  if (serviceError) return serviceError;
  if (createSource() === "repository") return rootFileError(el.createComposeFile.value);
  return contentError(el.createComposeContent.value);
}

function syncCreate() {
  const compose = createMode() === "compose";
  el.createComposePanel.hidden = !compose;
  el.createComposeInlinePanel.hidden = !compose || createSource() !== "inline";
  el.createComposeRepositoryPanel.hidden = !compose || createSource() !== "repository";
  const error = compose ? createRuntimeError() : "";
  el.createRuntimeError.textContent = error;
  el.createRuntimeError.hidden = !error;
}

function getRuntimePayload() {
  if (createMode() !== "compose") return { mode: "single" };
  const webService = el.createWebService.value.trim();
  const webServiceError = serviceNameError(webService);
  if (webServiceError) throw new Error(webServiceError);
  if (createSource() === "repository") {
    const file = el.createComposeFile.value.trim();
    const fileError = rootFileError(file);
    if (fileError) throw new Error(fileError);
    return { mode: "compose", source: "repository", file, webService };
  }
  const content = el.createComposeContent.value;
  const error = contentError(content);
  if (error) throw new Error(error);
  return { mode: "compose", source: "inline", content, webService };
}

function selectedKey() {
  return state.selectedApp ? `${state.selectedApp.userid}/${state.selectedApp.appname}` : "";
}

function setRuntimeRedeployWarning(value) {
  runtimeRedeployRequired = Boolean(value);
  el.detailRuntimeRedeployWarning.hidden = !runtimeRedeployRequired;
}

function syncRuntimeWarningFromApps() {
  const key = selectedKey();
  const app = [...state.apps, ...state.adminApps].find((item) => `${item.userid}/${item.appname}` === key);
  if (app?.pendingConfigChanges) setRuntimeRedeployWarning(app.pendingConfigChanges.runtime);
}

function syncDetail() {
  const compose = detailMode() === "compose";
  el.detailRuntimeComposePanel.hidden = !compose;
  el.detailRuntimeInlinePanel.hidden = !compose || detailSource() !== "inline";
  el.detailRuntimeRepositoryPanel.hidden = !compose || detailSource() !== "repository";
  const error = compose
    ? serviceNameError(el.detailRuntimeWebService.value) ||
      (detailSource() === "repository" ? rootFileError(el.detailRuntimeFile.value) : contentError(el.detailRuntimeContent.value))
    : "";
  el.detailRuntimeError.textContent = error || serverError;
  el.detailRuntimeError.hidden = !error && !serverError;
  el.detailRuntimeSaveBtn.disabled = !loaded || saving || Boolean(error);
}

function applyRuntime(runtime = { mode: "single" }) {
  const value = runtime && runtime.mode === "compose" ? runtime : { mode: "single" };
  el.detailRuntimeModeRadios.forEach((radio) => { radio.checked = radio.value === value.mode; });
  el.detailRuntimeComposeSourceRadios.forEach((radio) => { radio.checked = radio.value === (value.source || "inline"); });
  el.detailRuntimeContent.value = value.content || "";
  el.detailRuntimeFile.value = value.file || "compose.yaml";
  el.detailRuntimeWebService.value = value.webService || "app";
  syncDetail();
}

function findListedApp(key) {
  return [...state.apps, ...state.adminApps].find((candidate) => `${candidate.userid}/${candidate.appname}` === key) || null;
}

function setServiceOptions(runtime = null, appInfo = null) {
  const oldExecSelection = el.detailExecService.value;
  const app = state.selectedApp;
  const appKey = selectedKey();
  const switchedApp = appKey !== selectionAppKey;
  if (switchedApp) {
    selectionAppKey = appKey;
    provisionalExecDefault = true;
    currentRuntime = { mode: "single" };
    currentAppInfo = null;
    currentAppInfoKey = appKey;
  }
  if (runtime) currentRuntime = runtime;
  if (appInfo?.userid === app?.userid && appInfo?.appname === app?.appname) {
    currentAppInfo = appInfo;
    currentAppInfoKey = appKey;
  }
  const listedApp = findListedApp(appKey);
  if (listedApp) {
    currentAppInfo = listedApp;
    currentAppInfoKey = appKey;
  }
  const activeRuntime = currentRuntime;
  const item = currentAppInfoKey === appKey ? currentAppInfo : null;
  const services = Array.isArray(item?.services) ? item.services : [];
  const names = services.map((service) => service?.name).filter((name) => typeof name === "string" && name);
  const webService = item?.primaryService || activeRuntime?.webService || "app";
  if (!names.includes(webService)) names.unshift(webService);
  const previousLogSelection = switchedApp ? "" : el.detailLogService.value;
  el.detailLogService.replaceChildren(new Option("All services", ""));
  names.forEach((name) => el.detailLogService.add(new Option(name, name)));
  el.detailLogService.value = names.includes(previousLogSelection) ? previousLogSelection : "";
  el.detailExecService.replaceChildren();
  names.forEach((name) => el.detailExecService.add(new Option(name, name)));
  const preserveExecSelection = !switchedApp && !provisionalExecDefault && names.includes(oldExecSelection);
  el.detailExecService.value = preserveExecSelection ? oldExecSelection : (names.includes(webService) ? webService : (names[0] || "app"));
  if (activeRuntime?.webService) provisionalExecDefault = false;
  if (el.detailExecService.value !== oldExecSelection) {
    document.dispatchEvent(new CustomEvent("app-service-options-updated"));
  }
}

async function loadDetailRuntime() {
  const key = selectedKey();
  if (!key || !apiFetch) return;
  if (runtimeErrorAppKey !== key) {
    serverError = "";
    runtimeErrorAppKey = key;
  }
  const id = ++requestId;
  loaded = false;
  saving = false;
  setRuntimeRedeployWarning(false);
  el.detailRuntimeOptions.disabled = true;
  el.detailRuntimeStatus.textContent = "Loading runtime settings…";
  setServiceOptions();
  applyRuntime();
  try {
    const { userid, appname } = state.selectedApp;
    const appPath = `/apps/${encodeURIComponent(userid)}/${encodeURIComponent(appname)}`;
    const appRequest = currentAppInfoKey === key && currentAppInfo
      ? Promise.resolve(null)
      : apiFetch(appPath).catch(() => null);
    const [data, appData] = await Promise.all([
      apiFetch(`${appPath}/runtime`),
      appRequest,
    ]);
    if (id !== requestId || key !== selectedKey()) return;
    applyRuntime(data.runtime);
    setRuntimeRedeployWarning(data.pendingConfigChanges?.runtime);
    setServiceOptions(data.runtime || { mode: "single" }, appData?.app || null);
    loaded = true;
    el.detailRuntimeOptions.disabled = false;
    el.detailRuntimeStatus.textContent = "Runtime settings loaded. Changes apply on the next deployment.";
    syncDetail();
  } catch (error) {
    if (id !== requestId || key !== selectedKey()) return;
    el.detailRuntimeStatus.textContent = "Could not load runtime settings.";
    serverError = error.message || "Could not load runtime settings. Try again.";
    syncDetail();
  }
}

async function saveDetailRuntime() {
  if (!loaded || saving || !state.selectedApp) return;
  const key = selectedKey();
  const id = requestId;
  const mode = detailMode();
  let runtime = { mode: "single" };
  if (mode === "compose") {
    const webService = el.detailRuntimeWebService.value.trim();
    const webServiceError = serviceNameError(webService);
    if (webServiceError) return;
    if (detailSource() === "repository") {
      const file = el.detailRuntimeFile.value.trim();
      if (rootFileError(file)) return;
      runtime = { mode, source: "repository", file, webService };
    } else {
      const content = el.detailRuntimeContent.value;
      const error = contentError(content);
      if (error) return;
      runtime = { mode, source: "inline", content, webService };
    }
  }
  const { userid, appname } = state.selectedApp;
  saving = true;
  el.detailRuntimeOptions.disabled = true;
  el.detailRuntimeStatus.textContent = "Saving…";
  syncDetail();
  try {
    const result = await apiFetch(`/apps/${encodeURIComponent(userid)}/${encodeURIComponent(appname)}/runtime`, {
      method: "PUT", body: JSON.stringify({ runtime }),
    });
    if (id !== requestId || key !== selectedKey()) return;
    setRuntimeRedeployWarning(result.pendingConfigChanges?.runtime);
    document.dispatchEvent(new CustomEvent("app-config-updated", { detail: {
      userid, appname, redeployRequired: result.redeployRequired,
      pendingConfigChanges: result.pendingConfigChanges,
    } }));
    serverError = "";
    setServiceOptions(runtime);
    el.detailRuntimeStatus.textContent = "Runtime settings saved. Changes apply on the next deployment.";
  } catch (error) {
    if (id !== requestId || key !== selectedKey()) return;
    serverError = error.message || "Could not save runtime settings.";
  } finally {
    if (id === requestId && key === selectedKey()) {
      saving = false;
      el.detailRuntimeOptions.disabled = false;
      syncDetail();
    }
  }
}

function initRuntime(fetcher) {
  apiFetch = fetcher;
  el.createRuntimeModeRadios.forEach((radio) => radio.addEventListener("change", syncCreate));
  el.createComposeSourceRadios.forEach((radio) => radio.addEventListener("change", syncCreate));
  el.createComposeContent.addEventListener("input", syncCreate);
  el.createComposeFile.addEventListener("input", syncCreate);
  el.createWebService.addEventListener("input", syncCreate);
  const onDetailEdit = () => { serverError = ""; syncDetail(); };
  el.detailRuntimeModeRadios.forEach((radio) => radio.addEventListener("change", onDetailEdit));
  el.detailRuntimeComposeSourceRadios.forEach((radio) => radio.addEventListener("change", onDetailEdit));
  el.detailRuntimeContent.addEventListener("input", onDetailEdit);
  el.detailRuntimeFile.addEventListener("input", onDetailEdit);
  el.detailRuntimeWebService.addEventListener("input", onDetailEdit);
  el.detailExecService.addEventListener("change", () => { provisionalExecDefault = false; });
  document.addEventListener("app-list-updated", () => {
    if (state.selectedApp) {
      setServiceOptions();
      syncRuntimeWarningFromApps();
    }
  });
  el.detailRuntimeSaveBtn.addEventListener("click", saveDetailRuntime);
  syncCreate();
}

function resetCreateRuntime() {
  el.createRuntimeModeRadios.forEach((radio) => { radio.checked = radio.value === "single"; });
  el.createComposeSourceRadios.forEach((radio) => { radio.checked = radio.value === "inline"; });
  el.createComposeContent.value = "";
  el.createComposeFile.value = "compose.yaml";
  el.createWebService.value = "app";
  syncCreate();
}

export { initRuntime, getRuntimePayload, loadDetailRuntime, resetCreateRuntime };
