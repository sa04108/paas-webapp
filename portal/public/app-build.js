// 앱 생성의 빌드 옵션과 Dockerfile 조회 상태를 관리한다.
import { el } from "./app-state.js";
import { canManageApps, getRepoSource } from "./app-utils.js";

const MAX_DOCKERFILE_BYTES = 65536;
let apiFetchRequest = null;
let requestId = 0;
let requestController = null;
let debounceTimer = null;
let lookupState = "idle";
let validFiles = new Set();
let submitting = false;

function getMode() {
  return el.buildModeRadios.find((radio) => radio.checked)?.value || "auto";
}

function customError() {
  const content = el.buildCustomContent.value;
  if (!content.trim()) return "Enter Dockerfile contents.";
  if (content.includes("\0")) return "Dockerfile contents must not contain NUL characters.";
  if (new TextEncoder().encode(content).byteLength > MAX_DOCKERFILE_BYTES) {
    return "Dockerfile must be 64 KiB or smaller.";
  }
  return "";
}

function syncBuildUi() {
  const mode = getMode();
  el.buildRepositoryPanel.hidden = mode !== "repository";
  el.buildCustomPanel.hidden = mode !== "custom";
  const error = mode === "custom" ? customError() : "";
  el.buildCustomError.textContent = error;
  el.buildCustomError.hidden = !error;
  const validRepository = lookupState === "ready" && validFiles.has(el.buildDockerfileSelect.value);
  el.createSubmitBtn.disabled = submitting || !canManageApps() || (mode === "repository"
    ? !validRepository
    : mode === "custom" && Boolean(error));
}

function invalidateLookup(message = "Choose a repository and branch to load root Dockerfiles.") {
  requestId += 1;
  requestController?.abort();
  requestController = null;
  window.clearTimeout(debounceTimer);
  lookupState = "idle";
  validFiles = new Set();
  el.buildDockerfileSelect.replaceChildren(new Option("Select a repository first", ""));
  el.buildDockerfileSelect.disabled = true;
  el.buildFilesStatus.textContent = message;
  syncBuildUi();
}

function lookupTarget() {
  const source = getRepoSource();
  const repoUrl = (source === "github" ? el.repoSelect.value : el.repoUrlInput.value).trim();
  const branch = el.repoBranchInput.value.trim() || "main";
  return { repoUrl, branch, usePrivate: source === "github" };
}

async function loadDockerfiles() {
  if (getMode() !== "repository") return;
  const target = lookupTarget();
  invalidateLookup(target.repoUrl ? "Loading root Dockerfiles…" : "Choose a repository and branch to load root Dockerfiles.");
  if (!target.repoUrl) return;

  const currentRequest = ++requestId;
  const controller = new AbortController();
  requestController = controller;
  lookupState = "loading";
  el.buildFilesStatus.textContent = "Loading root Dockerfiles…";
  el.buildDockerfileSelect.replaceChildren(new Option("Loading…", ""));
  syncBuildUi();

  try {
    const data = await apiFetchRequest("/apps/dockerfiles", {
      method: "POST",
      body: JSON.stringify(target),
      signal: controller.signal,
    });
    if (currentRequest !== requestId) return;
    const files = Array.isArray(data.files) ? data.files.filter((file) => typeof file === "string") : [];
    validFiles = new Set(files);
    el.buildDockerfileSelect.replaceChildren(new Option(files.length ? "Select a Dockerfile" : "No root Dockerfiles found", ""));
    files.forEach((file) => el.buildDockerfileSelect.add(new Option(file, file)));
    el.buildDockerfileSelect.disabled = files.length === 0;
    lookupState = "ready";
    el.buildFilesStatus.textContent = files.length ? `${files.length} root Dockerfile${files.length === 1 ? "" : "s"} found.` : "No root Dockerfiles found. Choose automatic detection or write a Dockerfile.";
  } catch (error) {
    if (currentRequest !== requestId || error.name === "AbortError") return;
    lookupState = "error";
    validFiles = new Set();
    el.buildDockerfileSelect.replaceChildren(new Option("Could not load Dockerfiles", ""));
    el.buildDockerfileSelect.disabled = true;
    el.buildFilesStatus.textContent = error.message || "Could not load Dockerfiles. Try again.";
  }
  syncBuildUi();
}

function scheduleLookup() {
  invalidateLookup("Loading root Dockerfiles…");
  if (getMode() !== "repository") return;
  const target = lookupTarget();
  if (!target.repoUrl) {
    el.buildFilesStatus.textContent = "Choose a repository and branch to load root Dockerfiles.";
    return;
  }
  debounceTimer = window.setTimeout(loadDockerfiles, 250);
}

function initBuildOptions(apiFetch) {
  apiFetchRequest = apiFetch;
  el.buildModeRadios.forEach((radio) => radio.addEventListener("change", () => {
    if (radio.checked && radio.value === "repository") loadDockerfiles();
    syncBuildUi();
  }));
  el.buildFilesRefresh.addEventListener("click", loadDockerfiles);
  el.buildDockerfileSelect.addEventListener("change", syncBuildUi);
  el.buildCustomContent.addEventListener("input", syncBuildUi);
  el.repoSourceRadios.forEach((radio) => radio.addEventListener("change", scheduleLookup));
  el.repoUrlInput.addEventListener("input", scheduleLookup);
  el.repoSelect.addEventListener("change", scheduleLookup);
  el.repoBranchInput.addEventListener("input", scheduleLookup);
  el.createForm.addEventListener("build-access-state-changed", syncBuildUi);
  el.repoSelect.addEventListener("repo-options-updated", scheduleLookup);
  syncBuildUi();
}

function setBuildSubmitting(value) {
  submitting = Boolean(value);
  syncBuildUi();
}

function getBuildPayload() {
  const mode = getMode();
  if (mode === "repository") {
    const dockerfile = el.buildDockerfileSelect.value;
    if (lookupState !== "ready" || !validFiles.has(dockerfile)) {
      throw new Error("Load and select a root Dockerfile before creating the app.");
    }
    return { mode, dockerfile };
  }
  if (mode === "custom") {
    const content = el.buildCustomContent.value;
    const error = customError();
    if (error) throw new Error(error);
    return { mode, content };
  }
  return { mode: "auto" };
}

function resetBuildOptions() {
  el.buildModeRadios.find((radio) => radio.value === "auto").checked = true;
  el.buildCustomContent.value = "";
  invalidateLookup();
  syncBuildUi();
}

export { getBuildPayload, initBuildOptions, invalidateLookup, resetBuildOptions, setBuildSubmitting };
