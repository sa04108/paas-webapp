"use strict";

const { createHash } = require("node:crypto");
const { normalizeBuildConfig } = require("./build-config");
const { normalizeRuntime } = require("../../portal/composeConfig");

// 마지막 배포 설정은 해시로 보존하고 변경 여부만 응답한다.
function configSnapshot(metadata) {
  const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    build: hash(normalizeBuildConfig(metadata.build)),
    runtime: hash(normalizeRuntime(metadata.runtime)),
  };
}

// 이전 배포 기록이 없는 앱은 첫 변경 직전의 설정을 비교 기준으로 보존한다.
function withDeploymentBaseline(metadata) {
  return metadata.deployedConfig ? metadata : { ...metadata, deployedConfig: configSnapshot(metadata) };
}

function deploymentStatus(metadata) {
  const deployed = metadata?.deployedConfig;
  const current = deployed ? configSnapshot(metadata) : null;
  const pendingConfigChanges = {
    build: Boolean(deployed && deployed.build !== current.build),
    runtime: Boolean(deployed && deployed.runtime !== current.runtime),
  };
  return { redeployRequired: pendingConfigChanges.build || pendingConfigChanges.runtime, pendingConfigChanges };
}

module.exports = { configSnapshot, withDeploymentBaseline, deploymentStatus };
