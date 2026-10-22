#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { loadDefinition, projectName, normalizeRuntime, INSPECT_FORMAT } = require("../../portal/composeConfig");
const { compile } = require("../generate-compose");

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

function atomicWrite(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function locations(userid, appname) {
  if (!/^[a-z0-9]{3,20}$/.test(userid) || !/^[a-z0-9][a-z0-9-]{2,29}$/.test(appname)) throw new Error("Invalid app identity");
  const root = process.env.PAAS_ROOT || path.resolve(__dirname, "../..");
  const appDir = path.join(process.env.PAAS_APPS_DIR || path.join(root, "apps"), userid, appname);
  return { appDir, sourceDir: path.join(appDir, process.env.APP_SOURCE_SUBDIR || "app"), composeFile: path.join(appDir, process.env.APP_COMPOSE_FILE || "docker-compose.yml"), stateFile: path.join(appDir, ".paas-project.json"), metaFile: path.join(appDir, ".paas-meta.json"), project: projectName(userid, appname), root };
}

function run(command, args, { capture = false, cwd, timeout = 600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "", stderr = "";
    if (capture) {
      child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 16 * 1024 * 1024) child.kill("SIGKILL"); });
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} ${args[0] || ""} failed (${code ?? "timeout"})${capture ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

const compose = (info, file, args, options = {}) => run("docker", ["compose", "--env-file", "/dev/null", "-p", info.project, "-f", file, ...args], { cwd: info.appDir, ...options });

function syncCompose(info) {
  const state = readJson(info.stateFile);
  if (state?.compose) {
    if (state.project !== info.project) throw new Error("App project identity does not match");
    atomicWrite(info.composeFile, state.compose);
  }
}

async function deploy(userid, appname, runtimePath) {
  const info = locations(userid, appname);
  const metadata = readJson(info.metaFile);
  if (!metadata) throw new Error("App repository metadata is missing");
  const runtime = normalizeRuntime(runtimePath ? readJson(runtimePath) : metadata.runtime);
  // 실패해도 설정을 보존해 재시도와 삭제가 같은 앱을 식별할 수 있게 한다.
  atomicWrite(info.metaFile, { ...metadata, runtime });
  const loaded = loadDefinition(runtime, info.sourceDir);
  const revision = crypto.randomUUID();
  const compiled = compile(userid, appname, info, loaded, revision);
  const candidate = `${info.composeFile}.candidate.json`;
  const previous = readJson(info.stateFile);
  atomicWrite(candidate, compiled.compose);
  try {
    await compose(info, candidate, ["config", "--quiet"]);
    if (compiled.sharedImage) {
      await run("bash", ["-ec", 'source "$1"; build_app_image "$2" "$3" "$4"', "build", path.join(__dirname, "build.sh"), info.sourceDir, compiled.sharedImage, info.metaFile]);
      const entrypoint = JSON.parse(await run("docker", ["image", "inspect", "--format", "{{json .Config.Entrypoint}}", compiled.sharedImage], { capture: true }));
      // Railpack의 bash -c 래퍼가 워커의 argv를 삼키지 않도록 명시적인 명령은 교체한다.
      if (Array.isArray(entrypoint) && entrypoint.length === 2 && ["/bin/bash", "bash"].includes(entrypoint[0]) && entrypoint[1] === "-c") {
        for (const service of Object.values(compiled.compose.services)) {
          if (service.image === compiled.sharedImage && service.command !== undefined && service.entrypoint === undefined) service.entrypoint = [];
        }
        atomicWrite(candidate, compiled.compose);
      }
    }
    for (const build of compiled.builds) {
      const args = ["build", "--label", `paas.project=${info.project}`, "-t", build.image, "-f", build.dockerfile];
      if (build.target) args.push("--target", build.target);
      for (const [key, value] of Object.entries(build.args)) args.push("--build-arg", `${key}=${value}`);
      await run("docker", [...args, build.context]);
    }
    for (const image of compiled.pulls) await run("docker", ["pull", image]);
    syncCompose(info);
    if (fs.existsSync(info.composeFile)) await compose(info, info.composeFile, ["down", "--remove-orphans", "--volumes"]);
    // 실행 정의와 서비스 목록을 한 파일로 교체하고 Compose 파일은 여기서 복원한다.
    atomicWrite(info.stateFile, { project: info.project, revision, webService: compiled.webService, services: compiled.manifest, compose: compiled.compose, phase: "starting", runtime });
    syncCompose(info);
    await compose(info, info.composeFile, ["up", "-d", "--no-build", "--remove-orphans", "--force-recreate"]);
    await wait(userid, appname);
    const state = readJson(info.stateFile);
    atomicWrite(info.stateFile, { ...state, phase: "active" });
  } catch (error) {
    const state = readJson(info.stateFile);
    if (state?.revision === revision) atomicWrite(info.stateFile, { ...state, phase: "failed", error: error.message });
    else if (previous) atomicWrite(info.stateFile, { ...previous, lastDeployError: error.message });
    throw error;
  } finally { fs.rmSync(candidate, { force: true }); }
}

async function projectContainers(info) {
  const ids = await run("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${info.project}`], { capture: true, timeout: 30000 });
  if (!ids) return [];
  const output = await run("docker", ["inspect", "--format", INSPECT_FORMAT, ...ids.split(/\s+/)], { capture: true, timeout: 30000 });
  return output.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function serviceState(service, container) {
  if (!container) return "not-found";
  const state = container.State;
  if (service.kind === "init" && state.Status === "exited" && state.ExitCode === 0) return "completed";
  if (service.kind === "init" && state.Status === "running") return "starting";
  if (state.Status === "running") return state.Health?.Status === "unhealthy" ? "unhealthy" : state.Health?.Status === "starting" ? "starting" : "running";
  return state.Status === "exited" || state.Status === "dead" ? "stopped" : state.Status;
}

async function wait(userid, appname) {
  const info = locations(userid, appname);
  const manifest = readJson(info.stateFile);
  if (!manifest) throw new Error("App project state is missing");
  const deadline = Date.now() + Number(process.env.APP_HEALTH_TIMEOUT_SECS || process.env.DEPLOY_TIMEOUT_SECS || 120) * 1000;
  while (Date.now() < deadline) {
    const containers = await projectContainers(info);
    const states = manifest.services.map((service) => ({ service, container: containers.find((item) => item.Name === `/${service.containerName}` && item.Config.Labels["paas.project"] === info.project) }));
    if (states.every(({ service, container }) => ["running", "completed"].includes(serviceState(service, container)))) return;
    const failed = states.find(({ service, container }) => container && (container.State.Health?.Status === "unhealthy" || (container.State.Status === "exited" && (service.kind !== "init" || container.State.ExitCode !== 0)) || container.State.Status === "dead"));
    if (failed) throw new Error(`Service ${failed.service.name} failed (exit ${failed.container.State.ExitCode})`);
    await delay(1000);
  }
  throw new Error("App services did not become ready before the deadline");
}

async function down(userid, appname) {
  const info = locations(userid, appname);
  if (fs.existsSync(info.stateFile)) atomicWrite(info.stateFile, { ...readJson(info.stateFile), phase: "deleting" });
  try {
    // 데몬 오류를 성공으로 바꾸지 않고 실제 잔류 리소스까지 확인한다.
    syncCompose(info);
    if (fs.existsSync(info.composeFile)) await compose(info, info.composeFile, ["down", "--remove-orphans", "--volumes"]);
    for (const container of await projectContainers(info)) await run("docker", ["rm", "-fv", container.Id]);
    const networks = await run("docker", ["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${info.project}`], { capture: true });
    if (networks) await run("docker", ["network", "rm", ...networks.split(/\s+/)]);
    if ((await projectContainers(info)).length) throw new Error("App containers still exist");
    const remaining = await run("docker", ["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${info.project}`], { capture: true });
    if (remaining) throw new Error("App networks still exist");
    const images = await run("docker", ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"], { capture: true });
    const owned = [...new Set(images.split("\n").filter((tag) => tag.startsWith(`paas-build-${info.project.slice(5)}-`)))];
    for (const image of owned) await run("docker", ["image", "rm", image]);
  } catch (error) {
    if (fs.existsSync(info.stateFile)) atomicWrite(info.stateFile, { ...readJson(info.stateFile), phase: "delete-failed", error: error.message });
    throw error;
  }
}

module.exports = { locations, atomicWrite, readJson, syncCompose, compile, deploy, down, wait, serviceState, projectContainers };

if (require.main === module) {
  const [command, userid, appname, runtimePath] = process.argv.slice(2);
  const action = command === "deploy" ? deploy(userid, appname, runtimePath) : command === "down" ? down(userid, appname) : command === "wait" ? wait(userid, appname) : Promise.reject(new Error("Usage: compose-project.js deploy|down|wait <userid> <appname> [runtime.json]"));
  action.catch((error) => { console.error(`[project] ${error.message}`); process.exitCode = 1; });
}
