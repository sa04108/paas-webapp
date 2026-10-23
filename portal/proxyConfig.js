"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

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
    certificateResolver: dev ? "" : "letsencrypt",
    customCertificateResolver: dev ? "" : "letsencrypt-http",
  };
}

function normalize(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Proxy settings are required.");
  if (!["managed", "external"].includes(input.mode)) throw new Error("Choose a proxy connection mode.");
  const result = { mode: input.mode };
  for (const key of ["container", "entrypoint", "certificateResolver", "customCertificateResolver"]) {
    if (typeof input[key] !== "string") throw new Error(`${key} must be a string.`);
    const value = input[key].trim();
    const optional = key.endsWith("Resolver");
    if ((!value && !optional) || (value && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value))) {
      throw new Error(`${key} must contain only letters, numbers, dots, underscores or hyphens.`);
    }
    result[key] = value;
  }
  return result;
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

module.exports = { defaults, normalize, read, write, settingsPath, namespace };
