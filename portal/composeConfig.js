"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const YAML = require("yaml");

const MAX_COMPOSE_BYTES = 65536;
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const IMAGE_TOKEN = "${PAAS_APP_IMAGE}";
// 이미지의 임의 레이블·환경변수는 읽지 않아 테넌트 메타데이터가 전역 조회를 고갈시키지 못하게 한다.
const INSPECT_FORMAT = '{"Id":{{json .Id}},"Name":{{json .Name}},"State":{"Status":{{json .State.Status}},"Running":{{json .State.Running}},"ExitCode":{{json .State.ExitCode}},"Health":{"Status":{{with (index .State "Health")}}{{json .Status}}{{else}}null{{end}}}},"Config":{"Labels":{"paas.project":{{json (index .Config.Labels "paas.project")}},"com.docker.compose.project":{{json (index .Config.Labels "com.docker.compose.project")}},"paas.service":{{json (index .Config.Labels "paas.service")}}}}}';
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message) => { throw new Error(message); };

function keys(value, allowed, context) {
  if (!object(value)) fail(`${context} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${context}.${key} is not supported`);
}

function text(value, context, max = 8192) {
  if (typeof value !== "string" || value.includes("\0") || value.length > max) fail(`${context} must be text without NUL characters (max ${max})`);
  return value;
}

function normalizeRuntime(input) {
  if (input === undefined || input?.mode === "single") return { mode: "single" };
  if (!object(input) || input.mode !== "compose") fail("runtime.mode must be single or compose");
  const webService = input.webService || "app";
  if (!SERVICE_NAME.test(webService)) fail("Choose a valid web service name");
  if (input.source === "repository") {
    const file = input.file || "compose.yaml";
    if (typeof file !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}\.ya?ml$/.test(file)) fail("Choose a root-level Compose YAML filename");
    return { mode: "compose", source: "repository", file, webService };
  }
  if (input.source !== "inline") fail("runtime.source must be inline or repository");
  const content = text(input.content, "Compose YAML", MAX_COMPOSE_BYTES);
  if (!content.trim() || Buffer.byteLength(content) > MAX_COMPOSE_BYTES) fail("Compose YAML must be nonempty and at most 64 KiB");
  validateDefinition(parseCompose(content), webService);
  return { mode: "compose", source: "inline", content, webService };
}

function parseCompose(content) {
  if (Buffer.byteLength(content) > MAX_COMPOSE_BYTES) fail("Compose YAML must be at most 64 KiB");
  try {
    const document = YAML.parseDocument(content, { uniqueKeys: true, version: "1.2" });
    if (document.errors.length) fail("Invalid Compose YAML");
    return document.toJS({ maxAliasCount: 20 });
  } catch { fail("Invalid Compose YAML or excessive aliases"); }
}

function validateDefinition(definition, webService) {
  keys(definition, ["services", "volumes"], "Compose");
  keys(definition.services, Object.keys(definition.services || {}), "services");
  const names = Object.keys(definition.services);
  const max = Number(process.env.MAX_SERVICES_PER_APP || 8);
  if (!names.length || names.length > max || !names.includes(webService)) fail(`Compose needs the web service '${webService}' and at most ${max} services`);
  const volumes = definition.volumes || {};
  keys(volumes, Object.keys(volumes), "volumes");
  for (const [name, value] of Object.entries(volumes)) {
    if (!SERVICE_NAME.test(name) || (value !== null && (!object(value) || Object.keys(value).length))) fail("Volumes must be named app data volumes with empty options");
  }
  for (const [name, service] of Object.entries(definition.services)) {
    if (!SERVICE_NAME.test(name)) fail(`Invalid service name: ${name}`);
    keys(service, ["image", "build", "command", "entrypoint", "environment", "depends_on", "healthcheck", "working_dir", "user", "restart", "volumes", "expose", "stop_grace_period", "init", "mem_limit", "cpus", "pids_limit", "read_only"], name);
    for (const key of ["command", "entrypoint"]) if (service[key] !== undefined) {
      if (Array.isArray(service[key])) service[key].forEach((arg) => text(arg, `${name}.${key}`));
      else text(service[key], `${name}.${key}`);
    }
    if (service.image !== undefined) {
      text(service.image, `${name}.image`, 512);
      if (service.image !== IMAGE_TOKEN && (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(service.image) || service.image.includes("paas-build-"))) fail(`${name}.image must be a registry image or ${IMAGE_TOKEN}`);
      if (service.build !== undefined) fail(`${name}: choose image or build, not both`);
    }
    if (service.build !== undefined) {
      const build = typeof service.build === "string" ? { context: service.build } : service.build;
      keys(build, ["context", "dockerfile", "args", "target"], `${name}.build`);
      for (const field of ["context", "dockerfile"]) if (build[field] !== undefined) relativePath(build[field], `${name}.build.${field}`);
      if (build.args !== undefined) validateEnvironment(build.args, `${name}.build.args`);
      if (build.target !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(build.target)) fail(`${name}.build.target is invalid`);
    }
    if (service.environment !== undefined) validateEnvironment(service.environment, `${name}.environment`);
    if (service.restart !== undefined && !["no", "always", "unless-stopped", "on-failure"].includes(service.restart)) fail(`${name}.restart is invalid`);
    for (const key of ["working_dir", "user", "stop_grace_period"]) if (service[key] !== undefined) text(service[key], `${name}.${key}`, 255);
    if (service.working_dir && !service.working_dir.startsWith("/")) fail(`${name}.working_dir must be absolute`);
    if (service.stop_grace_period !== undefined) {
      const duration = service.stop_grace_period.match(/^(\d+)(ms|s|m)$/);
      const ms = duration ? Number(duration[1]) * ({ ms: 1, s: 1000, m: 60000 }[duration[2]]) : 0;
      if (ms < 1 || ms > 60000) fail(`${name}.stop_grace_period must be between 1ms and 60s`);
    }
    for (const key of ["init", "read_only"]) if (service[key] !== undefined && typeof service[key] !== "boolean") fail(`${name}.${key} must be boolean`);
    if (service.expose !== undefined && (!Array.isArray(service.expose) || service.expose.some((port) => !/^\d+(?:\/(?:tcp|udp))?$/.test(String(port)) || Number.parseInt(port, 10) > 65535 || Number.parseInt(port, 10) < 1))) fail(`${name}.expose must contain valid container ports`);
    if (service.volumes !== undefined) {
      if (!Array.isArray(service.volumes)) fail(`${name}.volumes must be a list of named data mounts`);
      for (const mount of service.volumes) {
        const parts = typeof mount === "string" ? mount.split(":") : [];
        if (parts.length < 2 || parts.length > 3 || !Object.hasOwn(volumes, parts[0]) || !/^\/(?!$)/.test(parts[1]) || parts[1].split("/").includes("..") || (parts[2] && !["ro", "rw"].includes(parts[2]))) fail(`${name}: only declared named data volumes are supported`);
      }
    }
    if (service.healthcheck !== undefined) {
      keys(service.healthcheck, ["test", "interval", "timeout", "start_period", "retries"], `${name}.healthcheck`);
      const check = service.healthcheck;
      if (!Array.isArray(check.test) || !["CMD", "CMD-SHELL"].includes(check.test[0]) || check.test.length < 2) fail(`${name}.healthcheck.test must use CMD or CMD-SHELL`);
      check.test.forEach((arg) => text(arg, "healthcheck.test"));
      for (const key of ["interval", "timeout", "start_period"]) if (check[key] !== undefined && (typeof check[key] !== "string" || !/^\d+(?:ms|s|m|h)$/.test(check[key]))) fail(`${name}.healthcheck.${key} must be a duration`);
      if (check.retries !== undefined && (!Number.isInteger(check.retries) || check.retries < 1 || check.retries > 100)) fail("healthcheck.retries must be 1–100");
    }
    dependencies(service).forEach(([dependency, condition]) => {
      if (!names.includes(dependency) || dependency === name) fail(`${name}: unknown or self dependency ${dependency}`);
      if (condition === "service_completed_successfully" && definition.services[dependency].restart !== "no") fail(`${dependency}: completed dependencies require restart: 'no'`);
      if (condition === "service_healthy" && !definition.services[dependency].healthcheck) fail(`${dependency}: healthy dependencies require a healthcheck`);
    });
  }
  if (definition.services[webService].restart === "no") fail("The web service cannot be an initialization job");
  const visit = (name, chain = []) => {
    if (chain.includes(name)) fail("Compose dependencies contain a cycle");
    for (const [dependency] of dependencies(definition.services[name])) visit(dependency, [...chain, name]);
  };
  names.forEach((name) => visit(name));
  return definition;
}

function dependencies(service) {
  const value = service.depends_on;
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    if (value.some((name) => typeof name !== "string")) fail("depends_on must contain service names");
    return value.map((name) => [name, "service_started"]);
  }
  if (!object(value)) fail("depends_on must be a list or object");
  return Object.entries(value).map(([name, settings]) => {
    keys(settings, ["condition"], `depends_on.${name}`);
    const condition = settings.condition || "service_started";
    if (!["service_started", "service_healthy", "service_completed_successfully"].includes(condition)) fail("Invalid dependency condition");
    return [name, condition];
  });
}

function validateEnvironment(environment, context) {
  if (!object(environment)) fail(`${context} must be a mapping with explicit values`);
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || !["string", "number", "boolean"].includes(typeof value)) fail(`${context} must contain explicit KEY: value entries`);
    text(String(value), context);
  }
}

function relativePath(value, context) {
  text(value, context, 1024);
  if (!value || path.isAbsolute(value) || value.includes("\\") || /^[a-z]+:/i.test(value) || value.split("/").includes("..")) fail(`${context} must stay inside the repository`);
  return value;
}

function containedPath(root, relative, context, directory = false) {
  relativePath(relative, context);
  const realRoot = fs.realpathSync(root);
  const real = fs.realpathSync(path.resolve(realRoot, relative));
  if ((real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) || (directory ? !fs.statSync(real).isDirectory() : !fs.statSync(real).isFile())) fail(`${context} must be a regular repository ${directory ? "directory" : "file"}`);
  return real;
}

function loadDefinition(input, sourceDir) {
  const runtime = normalizeRuntime(input);
  if (runtime.mode === "single") return { runtime, definition: { services: { app: {} } }, webService: "app" };
  let content = runtime.content;
  if (runtime.source === "repository") {
    const file = containedPath(sourceDir, runtime.file, "Compose file");
    if (fs.statSync(file).size > MAX_COMPOSE_BYTES) fail("Compose YAML must be at most 64 KiB");
    content = fs.readFileSync(file, "utf8");
  }
  return { runtime, definition: validateDefinition(parseCompose(content), runtime.webService), webService: runtime.webService };
}

function projectName(userid, appname) {
  return `paas-${crypto.createHash("sha256").update(`${userid.toLowerCase()}/${appname.toLowerCase()}`).digest("hex").slice(0, 24)}`;
}

function containerName(userid, appname, service, web = false) {
  return `${projectName(userid, appname)}-${web ? "web" : `service-${service}`}`;
}

function memoryBytes(value) {
  const match = String(value).match(/^(\d+(?:\.\d+)?)([bkmg])?b?$/i);
  if (!match) fail("Memory limits must use bytes, k, m, or g");
  const bytes = Math.floor(Number(match[1]) * (1024 ** ({ b: 0, k: 1, m: 2, g: 3 }[(match[2] || "b").toLowerCase()])));
  if (!Number.isSafeInteger(bytes) || bytes < 1024 * 1024) fail("Memory limits must be at least 1 MiB");
  return bytes;
}

function allocate(services, field, budget, parse) {
  let used = 0;
  const missing = [];
  const result = {};
  for (const [name, service] of Object.entries(services)) {
    if (service[field] === undefined) missing.push(name);
    else { result[name] = parse(service[field]); used += result[name]; }
  }
  if (used > budget + 0.000001) fail(`Combined ${field} exceeds the app budget`);
  const share = field === "mem_limit" ? Math.floor((budget - used) / missing.length) : Math.floor((budget - used) / missing.length * 1000) / 1000;
  if (missing.length && share < (field === "mem_limit" ? 1048576 : 0.01)) fail(`Not enough ${field} budget for every service`);
  missing.forEach((name) => { result[name] = share; });
  return result;
}

// 사용자 문자열은 Compose의 호스트 환경변수 치환을 거치지 않고 그대로 전달한다.
function literal(value) {
  if (typeof value === "string") return value.replace(/\$/g, "$$$$");
  if (Array.isArray(value)) return value.map(literal);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, literal(item)]));
  return value;
}

module.exports = { MAX_COMPOSE_BYTES, IMAGE_TOKEN, INSPECT_FORMAT, normalizeRuntime, parseCompose, validateDefinition, dependencies, containedPath, loadDefinition, projectName, containerName, memoryBytes, allocate, literal };
