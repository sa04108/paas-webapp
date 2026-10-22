// 기존 앱의 빌드 설정을 불러오고 저장한다.
import { el, state } from "./app-state.js";

const MAX_CONFIG_BYTES = 65536;
let apiFetch = null;
let requestId = 0;
let requestController = null;
let loaded = false;
let saving = false;
let dockerfiles = new Set();
let redeployRequired = false;

function setRedeployWarning(value) {
  redeployRequired = Boolean(value);
  el.detailBuildRedeployWarning.hidden = !redeployRequired;
}

function syncRedeployWarningFromApps() {
  const key = selectedKey();
  const app = [...state.apps, ...state.adminApps].find((item) => `${item.userid}/${item.appname}` === key);
  if (app?.pendingConfigChanges) setRedeployWarning(app.pendingConfigChanges.build);
}

function selectedKey() {
  return state.selectedApp ? `${state.selectedApp.userid}/${state.selectedApp.appname}` : "";
}

function current(id, key) {
  return id === requestId && key === selectedKey();
}

function mode() {
  return el.detailBuildModeRadios.find((radio) => radio.checked)?.value || "auto";
}

function configError(value) {
  if (new TextEncoder().encode(value).byteLength > MAX_CONFIG_BYTES) return "Railpack configuration must be 64 KiB or smaller.";
  if (!value.trim()) return "";
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "Railpack configuration must be a JSON object.";
  } catch {
    return "Enter valid JSON for the Railpack configuration.";
  }
  return "";
}

function customError(value) {
  if (!value.trim()) return "Enter Dockerfile contents.";
  if (value.includes("\0")) return "Dockerfile contents must not contain NUL characters.";
  if (new TextEncoder().encode(value).byteLength > MAX_CONFIG_BYTES) return "Dockerfile must be 64 KiB or smaller.";
  return "";
}

function sync() {
  const selectedMode = mode();
  el.detailBuildRepositoryPanel.hidden = selectedMode !== "repository";
  el.detailBuildCustomPanel.hidden = selectedMode !== "custom";
  el.detailBuildRailpackPanel.hidden = selectedMode !== "railpack";
  const dockerfile = el.detailBuildDockerfile.value;
  const repositoryReady = dockerfiles.has(dockerfile);
  const dockerError = selectedMode === "custom" ? customError(el.detailBuildCustomContent.value) : "";
  const railpackValidationError = selectedMode === "railpack" ? configError(el.detailBuildRailpackConfig.value) : "";
  el.detailBuildCustomError.textContent = dockerError;
  el.detailBuildCustomError.hidden = !dockerError;
  el.detailBuildRailpackError.textContent = railpackValidationError;
  el.detailBuildRailpackError.hidden = !railpackValidationError;
  el.detailBuildSaveBtn.disabled = !loaded || saving || el.detailBuildOptions.disabled ||
    (selectedMode === "repository" && !repositoryReady) || Boolean(dockerError || railpackValidationError);
}

async function loadDetailBuild() {
  const key = selectedKey();
  if (!key || !apiFetch) return;
  const id = ++requestId;
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  loaded = false;
  saving = false;
  setRedeployWarning(false);
  dockerfiles = new Set();
  el.detailBuildModeRadios.forEach((radio) => { radio.checked = radio.value === "auto"; });
  el.detailBuildCustomContent.value = "";
  el.detailBuildRailpackConfig.value = "";
  el.detailBuildDockerfile.replaceChildren(new Option("Select a repository first", ""));
  el.detailBuildDockerfile.disabled = true;
  el.detailBuildSaveBtn.textContent = "Save build settings";
  el.detailBuildOptions.disabled = true;
  el.detailBuildSaveBtn.disabled = true;
  el.detailBuildError.hidden = true;
  el.detailBuildError.textContent = "";
  el.detailBuildStatus.textContent = "Loading build settings…";
  el.detailBuildFilesStatus.textContent = "";
  sync();
  try {
    const { userid, appname } = state.selectedApp;
    const data = await apiFetch(`/apps/${encodeURIComponent(userid)}/${encodeURIComponent(appname)}/build`, { signal: controller.signal });
    if (!current(id, key)) return;
    const build = data.build || { mode: "auto" };
    setRedeployWarning(data.pendingConfigChanges?.build);
    if (build.mode === "repository") {
      try {
        const fileData = await apiFetch(`/apps/${encodeURIComponent(userid)}/${encodeURIComponent(appname)}/dockerfiles`, { signal: controller.signal });
        if (!current(id, key)) return;
        const files = Array.isArray(fileData.files) ? fileData.files.filter((file) => typeof file === "string") : [];
        dockerfiles = new Set(files);
        el.detailBuildDockerfile.replaceChildren(new Option(files.length ? "Select a Dockerfile" : "No root Dockerfiles found", ""));
        files.forEach((file) => el.detailBuildDockerfile.add(new Option(file, file)));
        el.detailBuildDockerfile.value = dockerfiles.has(build.dockerfile) ? build.dockerfile : "";
        el.detailBuildDockerfile.disabled = !files.length;
        el.detailBuildFilesStatus.textContent = files.length ? `${files.length} root Dockerfile${files.length === 1 ? "" : "s"} found.` : "No root Dockerfiles found.";
      } catch (error) {
        if (!current(id, key) || error.name === "AbortError") return;
        el.detailBuildDockerfile.replaceChildren(new Option("Could not load Dockerfiles", ""));
        el.detailBuildDockerfile.disabled = true;
        el.detailBuildFilesStatus.textContent = error.message || "Could not load Dockerfiles. Try again.";
      }
    }
    if (!current(id, key)) return;
    el.detailBuildModeRadios.forEach((radio) => { radio.checked = radio.value === (build.mode || "auto"); });
    el.detailBuildCustomContent.value = build.content || "";
    el.detailBuildRailpackConfig.value = build.config || "";
    loaded = true;
    el.detailBuildOptions.disabled = false;
    el.detailBuildStatus.textContent = "Build settings loaded. Changes apply on the next redeployment.";
    sync();
  } catch (error) {
    if (!current(id, key) || error.name === "AbortError") return;
    el.detailBuildModeRadios.forEach((radio) => { radio.checked = radio.value === "auto"; });
    el.detailBuildCustomContent.value = "";
    el.detailBuildRailpackConfig.value = "";
    el.detailBuildDockerfile.replaceChildren(new Option("Could not load Dockerfiles", ""));
    el.detailBuildFilesStatus.textContent = "";
    el.detailBuildStatus.textContent = "Could not load build settings.";
    el.detailBuildError.textContent = error.message || "Could not load build settings. Try again.";
    el.detailBuildError.hidden = false;
    el.detailBuildOptions.disabled = true;
    loaded = false;
  }
}

async function loadDockerfiles() {
  const key = selectedKey();
  if (!key || !loaded || mode() !== "repository") return;
  const id = ++requestId;
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  const oldSelection = el.detailBuildDockerfile.value;
  loaded = false;
  el.detailBuildDockerfile.disabled = true;
  el.detailBuildFilesStatus.textContent = "Loading root Dockerfiles…";
  sync();
  try {
    const { userid, appname } = state.selectedApp;
    const data = await apiFetch(`/apps/${encodeURIComponent(userid)}/${encodeURIComponent(appname)}/dockerfiles`, { signal: controller.signal });
    if (!current(id, key)) return;
    const files = Array.isArray(data.files) ? data.files.filter((file) => typeof file === "string") : [];
    dockerfiles = new Set(files);
    el.detailBuildDockerfile.replaceChildren(new Option(files.length ? "Select a Dockerfile" : "No root Dockerfiles found", ""));
    files.forEach((file) => el.detailBuildDockerfile.add(new Option(file, file)));
    el.detailBuildDockerfile.value = dockerfiles.has(oldSelection) ? oldSelection : "";
    el.detailBuildDockerfile.disabled = !files.length;
    el.detailBuildFilesStatus.textContent = files.length ? `${files.length} root Dockerfile${files.length === 1 ? "" : "s"} found.` : "No root Dockerfiles found.";
    loaded = true;
    sync();
  } catch (error) {
    if (!current(id, key) || error.name === "AbortError") return;
    loaded = true;
    el.detailBuildFilesStatus.textContent = error.message || "Could not load Dockerfiles. Try again.";
    sync();
  }
}

async function saveDetailBuild() {
  const key = selectedKey();
  if (!key || !loaded || saving) return;
  const id = requestId;
  const selectedMode = mode();
  const build = selectedMode === "repository"
    ? { mode: selectedMode, dockerfile: el.detailBuildDockerfile.value }
    : selectedMode === "custom"
      ? { mode: selectedMode, content: el.detailBuildCustomContent.value }
      : selectedMode === "railpack"
        ? { mode: selectedMode, config: el.detailBuildRailpackConfig.value }
        : { mode: "auto" };
  if (selectedMode === "repository" && !dockerfiles.has(build.dockerfile)) return;
  if (selectedMode === "custom" && customError(build.content)) return;
  if (selectedMode === "railpack" && configError(build.config)) return;
  const { userid, appname } = state.selectedApp;
  saving = true;
  el.detailBuildOptions.disabled = true;
  el.detailBuildError.hidden = true;
  el.detailBuildSaveBtn.textContent = "Saving…";
  sync();
  try {
    const result = await apiFetch(`/apps/${encodeURIComponent(userid)}/${encodeURIComponent(appname)}/build`, {
      method: "PUT",
      body: JSON.stringify({ build }),
    });
    if (!current(id, key)) return;
    setRedeployWarning(result.pendingConfigChanges?.build);
    document.dispatchEvent(new CustomEvent("app-config-updated", { detail: {
      userid, appname, redeployRequired: result.redeployRequired,
      pendingConfigChanges: result.pendingConfigChanges,
    } }));
    el.detailBuildStatus.textContent = "Build settings saved. Changes apply on the next redeployment.";
  } catch (error) {
    if (!current(id, key)) return;
    el.detailBuildError.textContent = error.message || "Could not save build settings.";
    el.detailBuildError.hidden = false;
  } finally {
    if (current(id, key)) {
      saving = false;
      el.detailBuildOptions.disabled = false;
      el.detailBuildSaveBtn.textContent = "Save build settings";
      sync();
    }
  }
}

function initBuildSettings(fetcher) {
  apiFetch = fetcher;
  el.detailBuildModeRadios.forEach((radio) => radio.addEventListener("change", () => {
    sync();
    if (radio.checked && radio.value === "repository") loadDockerfiles();
  }));
  el.detailBuildCustomContent.addEventListener("input", sync);
  el.detailBuildRailpackConfig.addEventListener("input", sync);
  el.detailBuildDockerfile.addEventListener("change", sync);
  el.detailBuildFilesRefresh.addEventListener("click", loadDockerfiles);
  el.detailBuildSaveBtn.addEventListener("click", saveDetailBuild);
  document.addEventListener("app-list-updated", syncRedeployWarningFromApps);
}

export { initBuildSettings, loadDetailBuild };
