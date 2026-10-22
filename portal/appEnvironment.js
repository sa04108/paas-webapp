"use strict";

const dotenv = require("dotenv");
const { AppError } = require("./utils");

const MAX_ENV_BYTES = 64 * 1024;

// 생성 입력은 한 줄에 하나의 할당만 허용하고, 호스트 변수 치환 없이 Compose에 전달한다.
function normalizeCreateEnv(content) {
  if (content === undefined) return undefined;
  if (typeof content !== "string") {
    throw new AppError(400, "env must be a KEY=VALUE string");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_ENV_BYTES) {
    throw new AppError(400, "env must not exceed 64 KiB");
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) {
    throw new AppError(400, "env contains unsupported control characters");
  }

  const entries = new Map();
  content.split(/\r\n|\n|\r/).forEach((line, index) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return;
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) throw new AppError(400, `env line ${index + 1} must use KEY=VALUE`);
    const key = match[1];
    // 사용자 키가 __proto__여도 파서 객체의 프로토타입에 영향을 주지 않는다.
    entries.set(key, dotenv.parse(`VALUE=${line.slice(match[0].length)}`).VALUE ?? "");
  });

  // 이중 인용부호와 $$ 이스케이프는 Compose 2.17에서도 리터럴 값을 보존한다.
  return Array.from(entries, ([key, value]) =>
    `${key}=${JSON.stringify(value).replace(/\$/g, () => "$$")}`
  ).join("\n");
}

module.exports = { normalizeCreateEnv };
