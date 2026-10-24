"use strict";

const crypto = require("node:crypto");
const { AppError } = require("./utils");
const proxyConfig = require("./proxyConfig");

// Compose로 실행하지 않은 컨테이너도 비밀값을 저장하지 않고 재생성 여부를 비교한다.
function identity(info, network) {
  const configuration = { ...info.Config };
  if (configuration.Hostname === info.Id.slice(0, 12)) delete configuration.Hostname;
  const stable = (value) => Array.isArray(value) ? value.map(stable) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify(stable({ image: info.Image,
    configuration, host: info.HostConfig, mounts: [...(info.Mounts || [])].sort((a, b) => a.Destination.localeCompare(b.Destination)),
  }))).digest("hex");
  return { id: info.Id, name: String(info.Name).replace(/^\//, ""), network, fingerprint,
    project: info.Config?.Labels?.["com.docker.compose.project"] || "",
    service: info.Config?.Labels?.["com.docker.compose.service"] || "" };
}

function createProxyNetwork({ docker, isTraefik, domain }) {
  async function attach(settings, approved = null, reauthorize = false) {
    let running = null;
    try {
      const info = await docker.getContainer(!reauthorize && approved ? approved.name : settings.container).inspect();
      running = Boolean(info.State?.Running);
      if (!isTraefik(info)) throw new AppError(400, "Select an existing Traefik container.");
      if (!running) throw new AppError(409, "The selected proxy is stopped. Start it to restore application access.");
      const current = identity(info, settings.network);
      if (approved && !reauthorize && (approved.name !== current.name || approved.network !== current.network ||
        approved.project !== current.project || approved.service !== current.service ||
        (approved.id !== current.id && !(approved.project && approved.service) && approved.fingerprint !== current.fingerprint))) {
        throw new AppError(409, "The selected proxy changed. Select the intended proxy and save again.");
      }
      const mode = info.HostConfig?.NetworkMode;
      if (["host", "none"].includes(mode) || mode?.startsWith("container:")) {
        throw new AppError(409, "The selected proxy does not support an additional application network.");
      }
      const existing = info.NetworkSettings?.Networks || {};
      if (!existing[settings.network]) {
        const [major, minor] = String((await docker.version()).ApiVersion || "").split(".").map(Number);
        if (!(major > 1 || (major === 1 && minor >= 48))) {
          throw new AppError(409, "Docker Engine 28 or newer is required to add the application network while preserving the proxy's default gateway.");
        }
      }
      let network;
      try { network = await docker.getNetwork(settings.network).inspect(); }
      catch (error) {
        if (error.statusCode !== 404) throw error;
        try {
          await docker.createNetwork({ Name: settings.network, Driver: "bridge", CheckDuplicate: true,
            Labels: { "paas.type": "app-network", "paas.proxy.owner": proxyConfig.namespace(domain) } });
        } catch (creationError) { if (creationError.statusCode !== 409) throw creationError; }
        network = await docker.getNetwork(settings.network).inspect();
      }
      if (network.Name !== settings.network) throw new AppError(400, "Enter the application network name, not its Docker ID.");
      const owner = network.Labels?.["paas.proxy.owner"];
      if (network.Driver !== "bridge" || (owner && owner !== proxyConfig.namespace(domain))) {
        throw new AppError(409, "Choose a dedicated bridge network for this PaaS's application web services.");
      }
      // 이미 사용 중인 인프라 네트워크를 앱 네트워크로 잘못 선택하지 않게 한다.
      if (existing[settings.network] && !approved && owner !== proxyConfig.namespace(domain) &&
        [settings.network, network.Id].includes(info.HostConfig?.NetworkMode)) {
        throw new AppError(409, "Choose a separate application network, not the proxy's existing infrastructure network.");
      }
      const members = await docker.listContainers({ all: true, filters: { network: [network.Id] } });
      if (members.some((item) => item.Id !== info.Id && !(item.Labels?.["paas.type"] === "user-app" &&
        item.Labels?.["paas.web"] === "true" && item.Labels?.["paas.domain"]?.endsWith(`.apps.${domain}`)))) {
        throw new AppError(409, "The application network contains unrelated services. Choose a separate network for application web services.");
      }
      if (existing[settings.network]?.NetworkID !== network.Id) {
        const priority = Math.min(0, ...Object.values(existing).map((endpoint) => endpoint.GwPriority || 0)) - 1;
        if (priority < -2147483648) throw new AppError(409, "The proxy's gateway priority cannot be preserved automatically.");
        try {
          await docker.getNetwork(network.Id).connect({ Container: info.Id, EndpointConfig: { GwPriority: priority } });
        } catch {
          // 연결 요청이 시간 초과되었거나 겹쳐도 실제 연결이 완료됐으면 유지한다.
          const after = await docker.getContainer(info.Id).inspect();
          if (after.NetworkSettings?.Networks?.[settings.network]?.NetworkID !== network.Id) {
            throw new AppError(503, "Could not connect the application network. Check Docker and save again.");
          }
        }
      }
      const after = await docker.getContainer(info.Id).inspect();
      running = Boolean(after.State?.Running);
      if (!running || after.NetworkSettings?.Networks?.[settings.network]?.NetworkID !== network.Id) {
        throw new AppError(409, "The proxy changed during connection. Refresh discovery and save again.");
      }
      return { info: after, binding: current };
    } catch (error) {
      const failure = error instanceof AppError ? error : new AppError(503, "Could not inspect or connect the application network. Check Docker and retry.");
      failure.proxyRunning = running;
      throw failure;
    }
  }
  return { attach };
}

module.exports = { createProxyNetwork };
