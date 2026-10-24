"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const CA_SERVERS = Object.freeze({
  letsencrypt: "https://acme-v02.api.letsencrypt.org/directory",
  zerossl: "https://acme.zerossl.com/v2/DV90",
});

function certificateDefaults() {
  return { certificateAuthority: "letsencrypt", acmeServer: CA_SERVERS.letsencrypt, acmeEmail: process.env.ACME_EMAIL || "", acmeEab: false };
}

// 포털과 배포 생성기가 같은 설정을 읽되 비밀값이나 Docker 접근을 공유하지 않는다.
function settingsPath() {
  const root = process.env.PAAS_ROOT || path.resolve(__dirname, "..");
  const db = process.env.PORTAL_DB_PATH || path.join(root, "portal-data", "portal.sqlite3");
  return path.join(path.dirname(db), "proxy-settings.json");
}

function defaults() {
  const dev = process.env.RUN_MODE === "development";
  return {
    mode: "managed", container: "paas-proxy", entrypoint: dev ? "web" : "websecure",
    image: process.env.TRAEFIK_IMAGE || "traefik:latest",
    certificateResolver: dev ? "" : "letsencrypt",
    customCertificateResolver: dev ? "" : "letsencrypt-http",
    ...certificateDefaults(),
  };
}

function normalize(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Proxy settings are required.");
  if (!["managed", "external"].includes(input.mode)) throw new Error("Choose a proxy connection mode.");
  const result = { mode: input.mode };
  // 기존 프로필은 이전 템플릿의 이미지 버전을 유지한다.
  result.image = input.image === undefined ? "traefik:v3.6" : input.image;
  if (typeof result.image !== "string" || result.image.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*(?:@sha256:[a-f0-9]{64})?$/.test(result.image)) {
    throw new Error("The detected Traefik image reference is invalid.");
  }
  for (const key of ["container", "entrypoint", "certificateResolver", "customCertificateResolver"]) {
    if (typeof input[key] !== "string") throw new Error(`${key} must be a string.`);
    const value = input[key].trim();
    const optional = key.endsWith("Resolver");
    if ((!value && !optional) || (value && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value))) {
      throw new Error(`${key} must contain only letters, numbers, dots, underscores or hyphens.`);
    }
    result[key] = value;
  }
  const certificate = { ...certificateDefaults(), ...input };
  if (!["letsencrypt", "zerossl", "custom"].includes(certificate.certificateAuthority)) throw new Error("Choose a supported certificate authority.");
  result.certificateAuthority = certificate.certificateAuthority;
  result.acmeServer = CA_SERVERS[result.certificateAuthority] || validateAcmeServer(certificate.acmeServer);
  if (typeof certificate.acmeEmail !== "string" || certificate.acmeEmail.length > 254 || /[\r\n\x00]/.test(certificate.acmeEmail)) throw new Error("Enter a valid ACME email address.");
  result.acmeEmail = certificate.acmeEmail.trim();
  if (result.acmeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.acmeEmail)) throw new Error("Enter a valid ACME email address.");
  if (typeof certificate.acmeEab !== "boolean") throw new Error("EAB must be enabled or disabled.");
  result.acmeEab = result.certificateAuthority === "zerossl" || certificate.acmeEab;
  return result;
}

function validateAcmeServer(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a valid HTTPS ACME directory URL."); }
  if (typeof value !== "string" || value.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.search || url.hash || /[\s\x00-\x1f]/.test(value)) {
    throw new Error("Use an HTTPS ACME directory URL without credentials, query parameters or fragments.");
  }
  return url.href;
}

function read() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    if (data.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 1) throw new Error("Invalid saved proxy settings.");
    return { configured: true, settings: normalize(data.settings), revision: data.revision };
  } catch (error) {
    return { configured: false, settings: defaults(), revision: 0,
      ...(error.code === "ENOENT" ? {} : { loadError: "Saved proxy settings could not be read. Review and save the configuration again." }) };
  }
}

function write(settings, revision) {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, revision, settings }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

function namespace(domain = process.env.PAAS_DOMAIN || "my.domain.com") {
  return `paas-${crypto.createHash("sha256").update(domain).digest("hex").slice(0, 12)}`;
}

module.exports = { defaults, normalize, read, write, settingsPath, namespace, CA_SERVERS, validateAcmeServer };
