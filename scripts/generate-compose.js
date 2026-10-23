#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const proxyConfig = require("../portal/proxyConfig");
const { containerName: appContainerName, containedPath, memoryBytes, allocate, literal, IMAGE_TOKEN } = require("../portal/composeConfig");

// 검증된 서비스에 소유권·네트워크·자원 정책을 적용해 실행용 Compose를 생성한다.
function hostPath(file) {
  const root = path.resolve(process.env.PAAS_ROOT || path.resolve(__dirname, ".."));
  return process.env.PAAS_HOST_ROOT && (file === root || file.startsWith(`${root}/`)) ? path.join(process.env.PAAS_HOST_ROOT, path.relative(root, file)) : file;
}

function compile(userid, appname, info, loaded, revision) {
  const { definition, webService } = loaded;
  const memory = allocate(definition.services, "mem_limit", memoryBytes(process.env.DEFAULT_MEM_LIMIT || "256m"), memoryBytes);
  const parseCpu = (value) => { const cpu = Number(value); if (!Number.isFinite(cpu) || cpu < 0.01 || cpu > 1024) throw new Error("cpus must be at least 0.01"); return cpu; };
  const cpus = allocate(definition.services, "cpus", parseCpu(process.env.DEFAULT_CPU_LIMIT || "0.5"), parseCpu);
  const network = process.env.APP_NETWORK || "paas-app";
  const domainRoot = process.env.PAAS_DOMAIN || "my.domain.com";
  const domain = `${userid}-${appname}.apps.${domainRoot}`;
  const savedProxy = proxyConfig.read();
  if (savedProxy.loadError) throw new Error(savedProxy.loadError);
  const proxy = savedProxy.settings;
  const prefix = proxyConfig.namespace(domainRoot);
  const privateNetwork = `${info.project}-private`;
  const maxPids = Number(process.env.DEFAULT_PIDS_LIMIT || 128);
  const services = {}, manifest = [], builds = [], pulls = new Set();
  let sharedImage = null;
  for (const [name, input] of Object.entries(definition.services)) {
    const web = name === webService;
    const kind = input.restart === "no" ? "init" : "service";
    const containerName = appContainerName(userid, appname, name, web);
    const generatedImage = `paas-build-${info.project.slice(5)}-service-${name}:${revision}`;
    let image;
    if (input.build !== undefined) {
      const build = typeof input.build === "string" ? { context: input.build } : input.build;
      const context = containedPath(info.sourceDir, build.context || ".", `${name} build context`, true);
      const dockerfile = containedPath(context, build.dockerfile || "Dockerfile", `${name} Dockerfile`);
      builds.push({ image: generatedImage, context, dockerfile, args: build.args || {}, target: build.target });
      image = generatedImage;
    } else if (!input.image || input.image === IMAGE_TOKEN) {
      sharedImage ||= `paas-build-${info.project.slice(5)}-railpack:${revision}`;
      image = sharedImage;
    } else { image = input.image; pulls.add(image); }
    const pids = input.pids_limit === undefined ? maxPids : Number(input.pids_limit);
    if (!Number.isInteger(pids) || pids < 1 || pids > maxPids) throw new Error(`${name}.pids_limit must be 1–${maxPids}`);
    const labels = { "paas.type": "user-app", "paas.userid": userid, "paas.appname": appname, "paas.service": name, "paas.kind": kind, "paas.project": info.project, "paas.web": String(web), "paas.domain": domain, "paas.port": "5000", "traefik.enable": String(web) };
    const routerName = `${prefix}-${containerName}`;
    if (web) Object.assign(labels, {
      "traefik.docker.network": network,
      [`traefik.http.routers.${routerName}.rule`]: `Host(\`${domain}\`)`,
      [`traefik.http.routers.${routerName}.entrypoints`]: proxy.entrypoint,
      [`traefik.http.routers.${routerName}.service`]: routerName,
      [`traefik.http.routers.${routerName}.middlewares`]: `${routerName}-rewrite-host`,
      [`traefik.http.services.${routerName}.loadbalancer.server.port`]: "5000",
      [`traefik.http.middlewares.${routerName}-rewrite-host.headers.customrequestheaders.Host`]: "localhost",
    });
    if (web && process.env.RUN_MODE !== "development" && !domainRoot.endsWith("localhost")) {
      labels[`traefik.http.routers.${routerName}.tls`] = "true";
      if (proxy.certificateResolver) {
        labels[`traefik.http.routers.${routerName}.tls.certresolver`] = proxy.certificateResolver;
        labels[`traefik.http.routers.${routerName}.tls.domains[0].main`] = `apps.${domainRoot}`;
        labels[`traefik.http.routers.${routerName}.tls.domains[0].sans`] = `*.apps.${domainRoot}`;
      }
    }
    const service = { image, container_name: containerName, restart: input.restart || process.env.DEFAULT_RESTART_POLICY || "unless-stopped", mem_limit: memory[name], cpus: cpus[name], pids_limit: pids, init: true,
      security_opt: ["no-new-privileges:true"], cap_drop: ["NET_RAW", "MKNOD"], networks: web ? ["private", "proxy"] : ["private"], labels,
      logging: { driver: "json-file", options: { "max-size": "10m", "max-file": "3" } } };
    if (fs.existsSync(path.join(info.appDir, ".env.paas"))) service.env_file = [".env.paas"];
    service.environment = { ...Object.fromEntries(Object.entries(input.environment || {}).map(([key, value]) => [key, String(value)])), APP_ID: `${userid}-${appname}`, PAAS_SERVICE: name, ...(web ? { PORT: "5000", NODE_ENV: "production" } : {}) };
    for (const key of ["command", "entrypoint", "depends_on", "healthcheck", "working_dir", "user", "expose", "stop_grace_period", "read_only", "init"]) if (input[key] !== undefined) service[key] = input[key];
    const mounts = input.volumes || (web ? ["__app_data:/data"] : []);
    service.volumes = mounts.map((mount) => {
      const [volume, target, mode] = mount.split(":");
      const dataPath = path.join(info.appDir, process.env.APP_DATA_SUBDIR || "data", volume === "__app_data" ? "app" : volume);
      fs.mkdirSync(dataPath, { recursive: true });
      return { type: "bind", source: hostPath(dataPath), target, read_only: mode === "ro" };
    });
    services[name] = service;
    manifest.push({ name, kind, containerName, image, healthcheck: Boolean(input.healthcheck) });
  }
  return { compose: literal({ name: info.project, services, networks: { private: { name: privateNetwork, labels: { "paas.project": info.project } }, proxy: { external: true, name: network } } }), manifest, sharedImage, builds, pulls: [...pulls], webService };
}

module.exports = { compile };
