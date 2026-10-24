"use strict";

const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const Docker = require("dockerode");
const { config, IS_DEV } = require("./config");
const proxyConfig = require("./proxyConfig");
const proxyCompose = require("./proxyCompose");
const { AppError } = require("./utils");

const docker = new Docker({ timeout: 8000 });
const execFileAsync = promisify(execFile);
const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const networkName = () => process.env.APP_NETWORK || "paas-app";
const dynamicDirectory = () => path.join(path.dirname(config.PORTAL_DB_PATH), "traefik-dynamic");
const staticBoolean = (value, fallback) => value === undefined ? fallback :
  ["true", "t", "1"].includes(String(value).toLowerCase()) ? true :
  ["false", "f", "0"].includes(String(value).toLowerCase()) ? false : null;

function hostPath(file) {
  const root = path.resolve(process.env.PAAS_ROOT || path.join(__dirname, ".."));
  const dir = path.resolve(file);
  if (process.env.PAAS_HOST_ROOT && (dir === root || dir.startsWith(root + path.sep))) {
    return path.join(process.env.PAAS_HOST_ROOT, path.relative(root, dir));
  }
  return dir;
}

function hostDirectory() { return hostPath(dynamicDirectory()); }

const publicOption = /^(entrypoints\.[^.]+\.address|certificatesresolvers\.[^.]+\.acme\.(caserver|dnschallenge(?:\.provider)?|httpchallenge(?:\.entrypoint)?|tlschallenge)|providers\.(docker(\.constraints|\.exposedbydefault)?|file\.(directory|watch)))$/;

// Docker inspect 전체나 환경변수는 응답에 넣지 않고 공개 설정만 추출한다.
function inspectOptions(info) {
  const options = {};
  const args = [...(info.Config?.Entrypoint || []), ...(info.Config?.Cmd || [])];
  for (let i = 0; i < args.length; i++) {
    const match = String(args[i]).match(/^--([^=]+)(?:=(.*))?$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    if (!publicOption.test(key)) continue;
    options[key] = match[2] ?? (args[i + 1] && !String(args[i + 1]).startsWith("--") ? String(args[++i]) : "true");
  }
  for (const entry of info.Config?.Env || []) {
    const equal = entry.indexOf("=");
    if (equal < 0) continue;
    const key = entry.slice(0, equal);
    let target;
    if (key === "TRAEFIK_PROVIDERS_DOCKER") target = "providers.docker";
    if (key === "TRAEFIK_PROVIDERS_DOCKER_CONSTRAINTS") target = "providers.docker.constraints";
    if (key === "TRAEFIK_PROVIDERS_FILE_DIRECTORY") target = "providers.file.directory";
    if (key === "TRAEFIK_PROVIDERS_FILE_WATCH") target = "providers.file.watch";
    const address = key.match(/^TRAEFIK_ENTRYPOINTS_([A-Z0-9]+)_ADDRESS$/);
    if (address) target = `entrypoints.${address[1].toLowerCase()}.address`;
    const resolver = key.match(/^TRAEFIK_CERTIFICATESRESOLVERS_(.+)_ACME_(CASERVER|DNSCHALLENGE_PROVIDER|HTTPCHALLENGE_ENTRYPOINT|DNSCHALLENGE|HTTPCHALLENGE|TLSCHALLENGE)$/);
    if (resolver) target = `certificatesresolvers.${resolver[1].toLowerCase()}.acme.${resolver[2].toLowerCase().replace(/_/g, ".")}`;
    if (target && !Object.hasOwn(options, target)) options[target] = entry.slice(equal + 1);
  }
  return options;
}

function resolverDetails(options, name) {
  const value = (suffix) => options[`certificatesresolvers.${name}.acme.${suffix}`];
  let caServer = null;
  try { if (value("caserver")) caServer = proxyConfig.validateAcmeServer(value("caserver")); } catch { /* 인증정보가 포함된 주소는 브라우저에 전달하지 않는다. */ }
  const challenges = [];
  if (value("dnschallenge.provider") || staticBoolean(value("dnschallenge"), false)) challenges.push("DNS-01");
  if (value("httpchallenge.entrypoint") || staticBoolean(value("httpchallenge"), false)) challenges.push("HTTP-01");
  if (staticBoolean(value("tlschallenge"), false)) challenges.push("TLS-ALPN-01");
  return { name, caServer, challenges, dnsProvider: value("dnschallenge.provider") || null, httpEntrypoint: value("httpchallenge.entrypoint") || null };
}

function isTraefik(info) {
  return /(?:^|\/)traefik(?::|@|$)/i.test(info.Config?.Image || info.Image || "") ||
    /(?:^|\/)traefik$/i.test(info.Path || "") ||
    (info.Config?.Entrypoint || []).some((part) => /(?:^|\/)traefik$/i.test(part));
}

function summarize(info) {
  const options = inspectOptions(info);
  const resolvers = [...new Set(Object.keys(options).map((key) => key.match(/^certificatesresolvers\.([^.]+)\./)?.[1]).filter(Boolean))];
  return {
    id: info.Id, name: String(info.Name || "").replace(/^\//, ""), image: info.Config?.Image || "",
    running: Boolean(info.State?.Running), networks: Object.keys(info.NetworkSettings?.Networks || {}),
    entrypoints: [...new Set(Object.keys(options).map((key) => key.match(/^entrypoints\.([^.]+)\./)?.[1]).filter(Boolean))],
    resolvers,
    resolverDetails: resolvers.map((name) => resolverDetails(options, name)),
  };
}

function inspectFailure(error) {
  return error.statusCode === 404 ? "The selected container was not found. Refresh discovery or start the proxy." :
    "Docker could not inspect the proxy. Check Docker availability and the portal socket mount.";
}

// 프록시 네트워크의 IP에만 접속하고 공개 Host/SNI로 실제 라우팅과 인증서를 검사한다.
function probe(address, port, hostname) {
  return new Promise((resolve) => {
    let timer;
    const finish = (result) => { clearTimeout(timer); resolve(result); };
    const transport = IS_DEV ? http : https;
    const request = transport.get({ hostname: address, port, path: "/health", servername: hostname,
      headers: { Host: hostname, "User-Agent": "PaaS-Proxy-Check" }, timeout: 4000,
    }, (response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 16384) request.destroy(new Error("Response is too large"));
      });
      response.on("end", () => {
        let valid = false;
        try { valid = JSON.parse(body)?.data?.service === "portal"; } catch { /* 다른 서비스의 응답은 성공으로 처리하지 않는다. */ }
        finish(response.statusCode === 200 && valid ? null : "The proxy did not return a portal health response. Check the file provider, hostname and upstream network.");
      });
      response.on("error", () => finish("The proxy closed the health response before it completed."));
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => finish(IS_DEV ? "Could not reach the portal through the proxy." : "HTTPS routing failed. Check the certificate, entrypoint and network; certificate verification remains enabled."));
    timer = setTimeout(() => request.destroy(new Error("timeout")), 4000);
  });
}

function createProxySetup({ refreshRoutes }) {
  let lastCheck = null;
  let saving = false;
  let applyError = null;

  async function managedImage(settings) {
    if (settings.mode !== "managed" || IS_DEV) return { image: settings.image, container: null };
    try {
      let selected;
      try { selected = await docker.getContainer(settings.container).inspect(); }
      catch (error) { if (error.statusCode !== 404) throw error; }
      if (selected?.State?.Running && isTraefik(selected)) return { image: selected.Config.Image, container: String(selected.Name).replace(/^\//, "") };
      const running = await docker.listContainers();
      const candidates = running.filter((item) => /traefik/i.test(item.Image || "") || item.Names?.some((name) => /traefik|paas-proxy/i.test(name)));
      const inspected = await Promise.all(candidates.map((item) => docker.getContainer(item.Id).inspect()));
      const proxies = inspected.filter((info) => info.State?.Running && isTraefik(info));
      if (proxies.length > 1) throw new AppError(400, "Several Traefik containers are running. Enter the intended Traefik container name so its image can be used.");
      if (proxies.length === 1) return { image: proxies[0].Config.Image, container: String(proxies[0].Name).replace(/^\//, "") };
      return { image: process.env.TRAEFIK_IMAGE || "traefik:latest", container: null };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, "Could not inspect the running Traefik image. Check Docker availability and the portal socket mount.");
    }
  }

  function guides(settings) {
    const source = hostDirectory();
    const configuredAdminPort = Number(process.env.PORTAL_ADMIN_PORT || 3000);
    const adminPort = Number.isInteger(configuredAdminPort) && configuredAdminPort > 0 && configuredAdminPort < 65536 ? configuredAdminPort : 3000;
    let generated;
    if (settings.mode === "managed" && !IS_DEV) {
      try { generated = proxyCompose.generate(settings); }
      catch (error) { generated = `# ${error.message}`; }
    }
    const compose = `docker compose --env-file .env --project-directory . -f ${shellQuote(hostPath(proxyCompose.composePath()))}`;
    return [
      { title: "Open local administration", description: "Run the Compose command on the server. Run SSH on your computer, then open http://localhost:13000. Keep the SSH connection open.",
        code: `docker compose --env-file .env -f docker-compose.yml -f docker-compose.admin.yml up -d\n# On your computer:\nssh -N -L 13000:127.0.0.1:${adminPort} user@server` },
      ...(settings.mode === "managed" ? IS_DEV ? [{ title: "Start the development proxy", description: "Development uses the HTTP proxy from the development Compose override; ACME certificates are not requested.", code: "docker compose --env-file .env -f docker-compose.yml -f docker-compose.dev.yml up -d" }] : [
        { title: "Review the generated Traefik configuration", description: "Saving creates this dedicated Compose file with your selected CA, certificate settings and identifiers. Renaming identifiers updates both their definitions and references. DNS and EAB credentials remain in server environment variables. This preview does not start a proxy.", code: generated },
        { title: "Start a dedicated Traefik", description: `Save the settings first, then run these commands from the repository root on the server. Configure CF_DNS_API_TOKEN${settings.acmeEmail ? "" : " and ACME_EMAIL"}${settings.acmeEab ? ", ACME_EAB_KID and ACME_EAB_HMAC" : ""} in .env. Only start this proxy if host ports 80 and 443 are available. Recreating an existing dedicated proxy applies the new CA and identifiers; it does not replace certificates that are already valid.`,
          code: `${compose} up -d\n${compose} logs --tail=100 traefik` },
      ] : [
        { title: "Connect the existing proxy network", description: "Add the same external network to the existing proxy's own Compose file for persistence. This command connects the current container only.",
          code: `docker network connect ${shellQuote(networkName())} ${shellQuote(settings.container)}` },
        { title: "Watch PaaS routing files", description: "Mount the whole PaaS directory exactly at the file-provider directory, not a subdirectory or a single file. Traefik 3.6 does not watch nested directories. Before changing an existing mount, its owner must back up and consolidate existing routing files in this shared directory; do not hide or overwrite them. PaaS owns custom-domains.yml, so resolve any filename conflict first. Recreating a shared proxy affects its other services.",
          code: `# Existing Traefik service, after preserving its current route files\nvolumes:\n  - type: bind\n    source: ${JSON.stringify(source)}\n    target: /etc/traefik/dynamic\n    read_only: true\n# Merge these flags with the existing command; do not replace it.\n# --providers.file.directory=/etc/traefik/dynamic\n# --providers.file.watch=true\n# --providers.docker=true\n# --providers.docker.exposedbydefault=false` },
      ]),
      { title: "Configure DNS and certificates", description: `Point the portal and wildcard app records to the edge server. Default domains need a wildcard certificate from DNS-01, or a certificate already installed in Traefik. ${settings.mode === "managed" ? "The generated configuration uses Cloudflare DNS-01 for platform domains and HTTP-01 on web for custom domains. The CA must support both challenges and wildcard certificates." : "Resolver names must already exist in Traefik's static configuration; the portal does not change its CA, challenges or credentials."}`,
        code: `portal.${config.PAAS_DOMAIN}       A / CNAME → edge server\n*.apps.${config.PAAS_DOMAIN}       A / CNAME → edge server\n\n# Check the public route from a machine outside the server:\ncurl --fail https://portal.${config.PAAS_DOMAIN}/health` },
      { title: "Changing deployment-wide values", description: "Domain, application network and portal listener come from the server environment. Update .env and recreate the affected services to change them. Existing apps need redeployment when their route settings change.",
        code: `PAAS_DOMAIN=${config.PAAS_DOMAIN}\nAPP_NETWORK=${networkName()}\nPORTAL_PORT=${config.PORTAL_PORT}\n\ndocker compose --env-file .env -f docker-compose.yml -f docker-compose.admin.yml up -d --no-deps --force-recreate portal` },
    ];
  }

  function generatedProblem(saved) {
    if (!saved.configured || saved.settings.mode !== "managed" || IS_DEV) return null;
    try {
      if (fs.readFileSync(proxyCompose.composePath(), "utf8") === proxyCompose.generate(saved.settings)) return null;
    } catch { /* 누락되거나 오래된 생성 파일은 설정 화면에서 다시 저장할 수 있게 한다. */ }
    return "The generated Traefik Compose file is missing or outdated. Save the settings again before starting the proxy.";
  }

  function status() {
    const saved = proxyConfig.read();
    const problem = applyError || generatedProblem(saved);
    return { ...saved, ...(problem ? { loadError: problem } : {}), defaults: proxyConfig.defaults(), lastCheck,
      environment: { domain: config.PAAS_DOMAIN, network: networkName(), portalPort: config.PORTAL_PORT,
        portalContainer: process.env.PORTAL_CONTAINER_NAME || "paas-portal", dynamicDirectory: hostDirectory(), devMode: IS_DEV },
      guides: guides(saved.settings) };
  }

  async function preview(input) {
    let settings;
    try { settings = proxyConfig.normalize(input); }
    catch (error) { throw new AppError(400, error.message); }
    const imageSource = await managedImage(settings);
    settings = { ...settings, image: imageSource.image };
    return { guides: guides(settings), imageSource };
  }

  async function discovery() {
    try {
      const [containers, networks] = await Promise.all([docker.listContainers({ all: true }), docker.listNetworks()]);
      const candidates = containers.filter((item) => /traefik/i.test(item.Image || "") || item.Names?.some((name) => /traefik|paas-proxy/i.test(name))).slice(0, 20);
      const results = await Promise.allSettled(candidates.map((item) => docker.getContainer(item.Id).inspect()));
      return { containers: results.filter((item) => item.status === "fulfilled" && isTraefik(item.value)).map((item) => summarize(item.value)),
        networks: networks.map((item) => item.Name).filter((name) => !["host", "none", "bridge"].includes(name)).sort(),
        warnings: results.some((item) => item.status === "rejected") ? ["Some containers changed during discovery. Refresh to try again."] : [] };
    } catch { throw new AppError(503, "Docker discovery failed. Check the Docker socket mount and daemon availability."); }
  }

  async function check(input) {
    const saved = proxyConfig.read();
    let settings;
    try { settings = proxyConfig.normalize(input || saved.settings); }
    catch (error) { throw new AppError(400, error.message); }
    const checks = [];
    const add = (id, title, state, detail) => checks.push({ id, title, status: state, detail });
    const problem = generatedProblem(saved);
    if (problem) add("generated", "Generated configuration", "warning", problem);
    const draft = !saved.configured || Boolean(applyError) || JSON.stringify(settings) !== JSON.stringify(saved.settings);
    if (draft) add("draft", "Unsaved settings", "warning", "Save these settings before checking portal routing. Container checks below use the draft; routing still uses the saved settings.");
    const finish = () => {
      const current = proxyConfig.read();
      const invalidated = saving || Boolean(applyError || current.loadError) || saved.revision !== current.revision ||
        JSON.stringify(saved.settings) !== JSON.stringify(current.settings);
      if (!draft && invalidated) add("changed", "Configuration changed", "warning", "The configuration changed or could not be applied during this check. Reload the settings and check again.");
      const result = { status: checks.every((item) => item.status === "ok") ? "ready" : "attention", checkedAt: new Date().toISOString(), checks };
      // 입력한 초안의 검사 결과를 저장된 설정의 정상 상태로 오인하지 않게 한다.
      if (!draft && !invalidated) lastCheck = result;
      return result;
    };
    let info;
    try { info = await docker.getContainer(settings.container).inspect(); }
    catch (error) { add("container", "Traefik container", "error", inspectFailure(error)); return finish(); }
    if (!isTraefik(info)) { add("container", "Traefik container", "error", "The selected container is not recognized as Traefik. Nginx Proxy Manager is not a compatible routing provider."); return finish(); }
    add("container", "Traefik container", info.State?.Running ? "ok" : "error", info.State?.Running ? "The selected Traefik container is running." : "Start the selected Traefik container.");
    const network = info.NetworkSettings?.Networks?.[networkName()];
    add("network", "Application network", network ? "ok" : "error", network ? `Connected to ${networkName()}.` : `Connect the proxy to ${networkName()} and keep that network in its Compose configuration.`);
    const options = inspectOptions(info);
    const entrypoint = options[`entrypoints.${settings.entrypoint.toLowerCase()}.address`];
    add("entrypoint", "Entrypoint", entrypoint ? "ok" : "warning", entrypoint ? `${settings.entrypoint} listens on ${entrypoint}.` : "Entrypoint could not be confirmed from container flags or environment. Check the proxy's static configuration file.");
    const constraints = options["providers.docker.constraints"];
    const knownConstraints = !constraints || ["Label(`paas.type`, `user-app`)", "Label(`paas.type`, `user-app`) || Label(`paas.type`, `core`)"].includes(constraints);
    const dockerEnabled = staticBoolean(options["providers.docker"], false);
    add("docker", "Application discovery", dockerEnabled && knownConstraints ? "ok" : "warning", !dockerEnabled ? "Enable the Docker provider and allow PaaS web-service labels. Static-file settings cannot be inspected here." : knownConstraints ? "Docker provider enabled and its constraints allow PaaS web services." : "Docker provider has custom constraints. Confirm that they allow containers labeled paas.type=user-app; this check cannot evaluate those constraints.");
    const watched = options["providers.file.directory"];
    const source = path.resolve(hostDirectory());
    const mounted = info.Mounts?.some((mount) => {
      if (mount.Type !== "bind") return false;
      const relative = path.relative(mount.Source, source);
      if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
      const target = path.posix.join(mount.Destination, relative);
      return watched && path.posix.normalize(target) === path.posix.normalize(watched);
    });
    const watching = staticBoolean(options["providers.file.watch"], true);
    add("files", "Routing directory", mounted && watching ? "ok" : "warning", mounted ? !watching ? "The routing directory is mounted, but file watching is disabled or unknown. Enable providers.file.watch." : "The PaaS directory matches the watched file-provider directory." : "Mount the whole PaaS routing directory at the watched directory. Nested directories and single-file mounts do not reliably follow updates; preserve the proxy's other route files first.");
    if (!IS_DEV) {
      for (const [field, title, suffix] of [["certificateResolver", "Default-domain certificates", "dnschallenge.provider"], ["customCertificateResolver", "Custom-domain certificates", "httpchallenge.entrypoint"]]) {
        const name = settings[field];
        const known = name && options[`certificatesresolvers.${name.toLowerCase()}.acme.${suffix}`];
        add(field, title, known ? "ok" : "warning", known ? `Resolver ${name} has the expected challenge configured.` : name ? `Confirm resolver ${name} in the existing proxy configuration. DNS-01 is required for wildcard certificates.` : "No resolver selected. Provide and maintain the required certificates in Traefik separately.");
        if (settings.mode === "managed") {
          const actual = resolverDetails(options, name.toLowerCase()).caServer;
          add(`${field}-ca`, `${title} CA`, actual === settings.acmeServer ? "ok" : "warning", actual === settings.acmeServer
            ? "The running resolver uses the selected ACME CA. Existing certificates remain valid until renewal."
            : "The selected ACME CA could not be confirmed on the running proxy. Start or update it using the generated Compose file.");
        }
      }
    }
    const address = network?.IPAddress;
    const port = Number(entrypoint?.match(/:(\d+)(?:\/tcp)?$/)?.[1]);
    if (draft) add("route", "Portal routing", "warning", "Save the draft first, then check the applied routing.");
    else if (info.State?.Running && net.isIP(address || "") && port > 0 && port < 65536) {
      const failure = await probe(address, port, `portal.${config.PAAS_DOMAIN}`);
      add("route", IS_DEV ? "Portal routing" : "Portal routing and HTTPS", failure ? "error" : "ok", failure || "Traefik returned the portal health response through the configured hostname.");
    } else add("route", "Portal routing", "warning", "Routing could not be tested until the container, network and entrypoint are available.");
    if (!IS_DEV && !draft) {
      let valid = false;
      try {
        const { stdout } = await execFileAsync("curl", ["--disable", "--silent", "--show-error", "--fail", "--max-time", "5",
          "--proto", "=https", "--write-out", "\n%{http_code}", `https://portal.${config.PAAS_DOMAIN}/health`], { timeout: 6000, maxBuffer: 16384 });
        const boundary = stdout.lastIndexOf("\n");
        valid = stdout.slice(boundary + 1) === "200" && JSON.parse(stdout.slice(0, boundary))?.data?.service === "portal";
      } catch { /* 실제 공개 주소의 실패를 숨기거나 TLS 검증을 우회하지 않는다. */ }
      add("public", "Public portal URL", valid ? "ok" : "warning", valid ? "The public HTTPS portal URL returned its health response from this server. Also verify access from your browser." :
        `Could not verify https://portal.${config.PAAS_DOMAIN}/health from this server. Check DNS, certificates and firewall or hairpin routing; verify from an external browser too.`);
    }
    return finish();
  }

  async function save(input, revision) {
    if (saving) throw new AppError(409, "Another proxy update is in progress. Try again.");
    let settings;
    try { settings = proxyConfig.normalize(input); }
    catch (error) { throw new AppError(400, error.message); }
    const imageSource = await managedImage(settings);
    settings = { ...settings, image: imageSource.image };
    let generated;
    try { if (settings.mode === "managed" && !IS_DEV) generated = proxyCompose.generate(settings); }
    catch (error) { throw new AppError(400, error.message); }
    const previous = proxyConfig.read();
    if (revision !== previous.revision) throw new AppError(409, "Proxy settings changed in another session. Reload this page before saving.");
    saving = true;
    try {
      proxyConfig.write(settings, previous.revision + 1);
      if (generated) proxyCompose.write(generated);
      lastCheck = null;
      await refreshRoutes();
      applyError = null;
      return status();
    } catch {
      // 저장은 유지하고 재시도 가능한 오류를 알린다. 외부 프록시는 수정하지 않는다.
      applyError = "Proxy settings could not be fully applied. Reload this page and retry saving; check the routing and generated Compose directory permissions.";
      throw new AppError(503, applyError);
    } finally { saving = false; }
  }

  return { status, discovery, check, save, preview };
}

module.exports = { createProxySetup };
