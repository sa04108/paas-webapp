"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_DOCKERFILE_BYTES = 64 * 1024;

// 저장소 루트의 파일명만 허용하며 경로와 제어 문자는 받지 않는다.
function isDockerfileName(name) {
  return typeof name === "string" && /Dockerfile/.test(name) &&
    !/[\\/\x00-\x1f\x7f]/.test(name) && Buffer.byteLength(name, "utf8") <= 255;
}

function normalizeBuildConfig(input) {
  if (input === undefined) return { mode: "auto" };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("build must be an object");
  }
  if (input.mode === "auto") return { mode: "auto" };
  if (input.mode === "repository") {
    if (!isDockerfileName(input.dockerfile)) {
      throw new Error("Select a root-level filename containing Dockerfile");
    }
    return { mode: "repository", dockerfile: input.dockerfile };
  }
  if (input.mode === "custom") {
    if (typeof input.content !== "string" || !input.content.trim() || input.content.includes("\0")) {
      throw new Error("Custom Dockerfile content is required and must not contain NUL characters");
    }
    if (Buffer.byteLength(input.content, "utf8") > MAX_DOCKERFILE_BYTES) {
      throw new Error("Custom Dockerfile must be at most 64 KiB");
    }
    return { mode: "custom", content: input.content };
  }
  throw new Error("build.mode must be auto, repository, or custom");
}

function parseJson(text) {
  let input;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error("Invalid build configuration JSON");
  }
  return input;
}

// 소스 저장소 밖에서 원자적으로 저장해 git pull과 빌드 컨텍스트에서 분리한다.
function atomicWrite(filePath, content) {
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function saveAppMetadata(metadataPath, metadata, input) {
  const build = normalizeBuildConfig(input);
  atomicWrite(metadataPath, `${JSON.stringify({ ...metadata, build }, null, 2)}\n`);
}

// 명시적으로 고른 파일이 없어졌거나 루트 밖을 가리키면 자동 탐지로 대체하지 않는다.
function resolveDockerfile(sourceDir, configPath) {
  let build;
  try {
    const input = parseJson(fs.readFileSync(configPath, "utf8"));
    build = normalizeBuildConfig(path.basename(configPath) === ".paas-meta.json" ? input.build : input);
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
  if (build.mode === "auto") return "";
  if (build.mode === "repository") {
    const sourceRoot = fs.realpathSync(sourceDir);
    const selectedPath = path.join(sourceRoot, build.dockerfile);
    let realPath;
    try {
      realPath = fs.realpathSync(selectedPath);
      if (path.dirname(realPath) === sourceRoot && fs.statSync(realPath).isFile()) {
        return selectedPath;
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    throw new Error(`Selected Dockerfile is not a regular root-level file: ${build.dockerfile}`);
  }
  const customPath = path.resolve(path.dirname(configPath), "Dockerfile.custom");
  atomicWrite(customPath, build.content);
  return customPath;
}

module.exports = { MAX_DOCKERFILE_BYTES, isDockerfileName, normalizeBuildConfig, saveAppMetadata, resolveDockerfile };

if (require.main === module) {
  try {
    const [command, firstPath, secondPath] = process.argv.slice(2);
    if (command === "save-metadata" && firstPath) {
      const build = secondPath ? parseJson(fs.readFileSync(secondPath, "utf8")) : undefined;
      const { runtime, displayName, icon, dependencies } = JSON.parse(process.env.RUNTIME_JSON);
      saveAppMetadata(firstPath, {
        repoUrl: process.env.REPO_URL,
        branch: process.env.BRANCH,
        installationId: process.env.INSTALLATION_ID || null,
        createdAt: new Date().toISOString(),
        detectedRuntime: { name: runtime, displayName, icon, dependencies },
      }, build);
    } else if (command === "resolve" && firstPath && secondPath) {
      process.stdout.write(resolveDockerfile(firstPath, secondPath));
    } else {
      throw new Error("Usage: build-config.js save-metadata <metadata-path> [input-path] | resolve <source-dir> <config-path>");
    }
  } catch (error) {
    console.error(`[build] ${error.message}`);
    process.exitCode = 1;
  }
}
