"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const YAML = require("yaml");
const proxyConfig = require("./proxyConfig");

const composePath = () => path.join(path.dirname(proxyConfig.settingsPath()), "proxy-compose.yml");
// Compose 보간 문법으로 사용자 입력이 다시 해석되지 않게 한다.
const literal = (value) => value.replace(/\$/g, () => "$$");

function generate(input) {
  const settings = proxyConfig.normalize(input);
  if (settings.mode !== "managed") throw new Error("Compose generation is only available for a new Traefik.");
  for (const key of ["entrypoint", "certificateResolver", "customCertificateResolver"]) {
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,62}$/.test(settings[key])) throw new Error("New Traefik identifiers must start with a letter and use only letters, numbers, underscores or hyphens (up to 63 characters).");
  }
  if (settings.entrypoint.toLowerCase() === "web") throw new Error("The web entrypoint is reserved for HTTP-01 on port 80. Choose a different HTTPS entrypoint name.");
  if (settings.certificateResolver.toLowerCase() === settings.customCertificateResolver.toLowerCase()) throw new Error("Use different names for the DNS-01 and HTTP-01 certificate resolvers.");
  const template = YAML.parse(fs.readFileSync(path.join(__dirname, "..", "docker-compose.proxy.yml"), "utf8"));
  const service = template.services.traefik;
  service.image = settings.image;
  service.container_name = settings.container;
  template.networks["paas-app"].name = literal(settings.network);
  service.command = service.command.map((arg) => arg.startsWith("--providers.docker.network=") ? `--providers.docker.network=${settings.network}` : arg);
  const root = path.resolve(process.env.PAAS_ROOT || path.join(__dirname, ".."));
  const dynamicDirectory = path.join(path.dirname(proxyConfig.settingsPath()), "traefik-dynamic");
  const relative = path.relative(root, dynamicDirectory);
  const hostDirectory = process.env.PAAS_HOST_ROOT && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? path.join(process.env.PAAS_HOST_ROOT, relative) : dynamicDirectory;
  service.volumes = service.volumes.map((volume) => typeof volume === "string" && volume.endsWith(":/traefik-dynamic:ro")
    ? { type: "bind", source: literal(hostDirectory), target: "/traefik-dynamic", read_only: true } : volume);
  // 기본 템플릿의 네트워크·인증서 저장소·와일드카드 TLS 정책은 그대로 유지한다.
  service.command = service.command.map((arg) => arg
    .replace(/entrypoints\.websecure\./g, `entrypoints.${settings.entrypoint}.`)
    .replace(/entrypoint\.to=websecure$/, `entrypoint.to=${settings.entrypoint}`)
    .replace(/certresolver=letsencrypt$/, `certresolver=${settings.certificateResolver}`)
    .replace(/certificatesresolvers\.(letsencrypt-http|letsencrypt)\./g, (_match, name) => `certificatesresolvers.${name === "letsencrypt" ? settings.certificateResolver : settings.customCertificateResolver}.`)
    .replace(/acme\.email=\$\{ACME_EMAIL\}$/, () => `acme.email=${settings.acmeEmail ? literal(settings.acmeEmail) : "${ACME_EMAIL:?Set ACME_EMAIL in .env}"}`));
  for (const resolver of [settings.certificateResolver, settings.customCertificateResolver]) {
    service.command.push(`--certificatesresolvers.${resolver}.acme.caserver=${literal(settings.acmeServer)}`);
    if (settings.acmeEab) {
      // Traefik의 정적 설정 방식을 섞지 않고 Compose가 실행 시 비밀값을 보간한다.
      service.command.push(`--certificatesresolvers.${resolver}.acme.eab.kid=\${ACME_EAB_KID:?Set ACME_EAB_KID in .env}`);
      service.command.push(`--certificatesresolvers.${resolver}.acme.eab.hmacencoded=\${ACME_EAB_HMAC:?Set ACME_EAB_HMAC in .env}`);
    }
  }
  return "# 관리자 프록시 설정에서 생성한 파일입니다. 변경은 설정 화면에서 저장하세요.\n" + YAML.stringify(template);
}

function write(content) {
  const file = composePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

module.exports = { generate, write, composePath };
