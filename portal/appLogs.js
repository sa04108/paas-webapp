"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { StringDecoder } = require("node:string_decoder");
const { createHash } = require("node:crypto");
const Docker = require("dockerode");
const { AppError } = require("./utils");
const { projectName, containerName } = require("./composeConfig");

const socketPath = "/var/run/docker.sock";
const docker = new Docker({ socketPath, timeout: 10000 });
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LINE = 64 * 1024;
const MAX_REPLAY = 10000;
const compareEntries = (a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id);

function parseLogOptions(query) {
  const requested = Number.parseInt(query.lines, 10);
  const lines = Number.isFinite(requested) ? Math.max(1, Math.min(1000, requested)) : 120;
  const raw = query.services ?? query.service;
  if (raw !== undefined && (typeof raw !== "string" || raw.length > 4096)) throw new AppError(400, "Invalid services");
  const services = raw === undefined ? null : [...new Set(raw.split(",").filter(Boolean))];
  if (services?.some((name) => !/^[a-z][a-z0-9-]{0,39}$/.test(name))) throw new AppError(400, "Invalid service name");
  return { lines, services };
}

// 나노초를 버리지 않고 같은 UTC 형식으로 맞춰 문자열 비교로 정렬한다.
function timestampKey(value) {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) throw new Error("Invalid Docker log timestamp");
  return `${match[1]}.${(match[2] || "").padEnd(9, "0")}Z`;
}

function boundedEntries(entries, lines) {
  entries.sort(compareEntries);
  let bytes = 0;
  let start = entries.length;
  while (start > 0 && entries.length - start < lines) {
    const size = Buffer.byteLength(entries[start - 1].message) + 256;
    if (bytes + size > MAX_BYTES) break;
    bytes += size;
    start--;
  }
  return entries.slice(start);
}

// Docker의 stdout/stderr 프레임을 도착 순서대로 읽고 스트림별 불완전한 줄을 이어 붙인다.
async function readLogResponse(response, target, onEntry) {
  let pending = Buffer.alloc(0);
  const streams = new Map();
  const occurrences = new Map();
  function emit(line, stream) {
    const split = line.indexOf(" ");
    const time = timestampKey(line.slice(0, split));
    const message = line.slice(split + 1).replace(/\r$/, "");
    const key = createHash("sha256").update(`${time}\0${stream}\0${message}`).digest("hex");
    const occurrence = occurrences.get(key) || 0;
    occurrences.set(key, occurrence + 1);
    if (occurrences.size > MAX_REPLAY) occurrences.delete(occurrences.keys().next().value);
    onEntry({ id: `${target.id}:${key}:${occurrence}`, timestamp: time, service: target.service, stream, message });
  }
  function consume(stream, chunk, final = false) {
    let state = streams.get(stream);
    if (!state) { state = { decoder: new StringDecoder("utf8"), text: "", truncated: false }; streams.set(stream, state); }
    const text = state.decoder.write(chunk) + (final ? state.decoder.end() : "");
    for (const piece of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
      const end = piece.endsWith("\n");
      if (state.text.length < MAX_LINE) state.text += piece.slice(0, MAX_LINE - state.text.length);
      if (state.text.length >= MAX_LINE) state.truncated = true;
      if (end || final) {
        if (state.text) emit(state.text.replace(/\n$/, "") + (state.truncated ? " … [truncated]" : ""), stream);
        state.text = ""; state.truncated = false;
      }
    }
    if (final && state.text) { emit(state.text + (state.truncated ? " … [truncated]" : ""), stream); state.text = ""; }
  }
  for await (const chunk of response) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 8) {
      const size = pending.readUInt32BE(4);
      if (![1, 2].includes(pending[0]) || size > MAX_BYTES) throw new Error("Invalid Docker log frame");
      if (pending.length < size + 8) break;
      consume(pending[0] === 2 ? "stderr" : "stdout", pending.subarray(8, size + 8));
      pending = pending.subarray(size + 8);
    }
  }
  if (pending.length) throw new Error("Incomplete Docker log frame");
  for (const stream of streams.keys()) consume(stream, Buffer.alloc(0), true);
}

// follow=false도 스트림으로 읽어 Docker 응답 전체가 메모리에 쌓이지 않게 한다.
function logResponse(target, options, signal) {
  return new Promise((resolve, reject) => {
    // Engine API는 CLI와 달리 since/until에 Unix 초와 소수부를 받는다.
    options = { ...options };
    for (const field of ["since", "until"]) if (options[field]) {
      const value = options[field];
      options[field] = `${Date.parse(`${value.slice(0, 19)}Z`) / 1000}.${value.slice(20, 29)}`;
    }
    const query = new URLSearchParams({ stdout: "true", stderr: "true", timestamps: "true", ...options });
    const request = http.get({ socketPath, path: `/containers/${target.id}/logs?${query}`, signal }, (response) => {
      clearTimeout(timer);
      if (response.statusCode !== 200) {
        response.destroy();
        reject(new Error(`Docker logs unavailable (HTTP ${response.statusCode})`));
      } else resolve(response);
    });
    const timer = setTimeout(() => request.destroy(new Error("Docker log connection timed out")), 10000);
    request.on("error", reject);
    request.on("close", () => clearTimeout(timer));
  });
}

class AppLogSession {
  constructor(context, options, signal) {
    Object.assign(this, context, options);
    this.signal = signal;
    this.targets = new Map();
    this.closed = false;
    this.pending = [];
    this.pendingBytes = 0;
    this.initialized = false;
    signal.addEventListener("abort", () => this.close(), { once: true });
  }

  async discover() {
    let metadata, manifest;
    try {
      metadata = JSON.parse(await fs.readFile(path.join(this.appDir, ".paas-meta.json"), "utf8"));
      try { manifest = JSON.parse(await fs.readFile(path.join(this.appDir, ".paas-project.json"), "utf8")); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    } catch (error) {
      if (error.code === "ENOENT") throw new AppError(404, "App was deleted");
      throw error;
    }
    if (this.instanceId !== undefined && this.instanceId !== metadata.instanceId) throw new AppError(410, "App was replaced; reopen its logs");
    this.instanceId = metadata.instanceId;
    const project = projectName(this.userid, this.appname);
    if (manifest && (manifest.project !== project || manifest.instanceId !== metadata.instanceId)) throw new AppError(409, "App deployment changed; reopen its logs");
    if (manifest?.phase === "deleting") throw new AppError(410, "App is being deleted");
    const services = manifest?.services || [];
    const names = services.map((service) => service.name);
    if (!this.initialized && this.services?.some((name) => !names.includes(name))) throw new AppError(404, "Service not found for this app");
    const containers = await docker.listContainers({ all: true, filters: JSON.stringify({ label: [`paas.project=${project}`, `com.docker.compose.project=${project}`, "paas.type=user-app"] }) });
    await this.assertInstance();
    const targets = [];
    for (const service of services) {
      if (this.services && !this.services.includes(service.name)) continue;
      const name = containerName(this.userid, this.appname, service.name, service.name === manifest.webService);
      if (service.containerName !== name) throw new AppError(409, "Invalid app service manifest");
      const container = containers.find((item) => item.Names.includes(`/${name}`) && item.Labels["paas.project"] === project && item.Labels["com.docker.compose.project"] === project && item.Labels["paas.service"] === service.name);
      if (container) targets.push({ id: container.Id, service: service.name, running: container.State === "running" || container.State === "restarting" });
    }
    return { names, targets };
  }

  async assertInstance() {
    let metadata;
    try { metadata = JSON.parse(await fs.readFile(path.join(this.appDir, ".paas-meta.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") throw new AppError(404, "App was deleted"); throw error; }
    if (metadata.instanceId !== this.instanceId) throw new AppError(410, "App was replaced; reopen its logs");
  }

  async history(target, boundary) {
    let entries = [], bytes = 0;
    const signal = AbortSignal.any([this.signal, AbortSignal.timeout(10000)]);
    const response = await logResponse(target, { follow: "false", tail: String(this.lines), until: boundary }, signal);
    await readLogResponse(response, target, (entry) => {
      entries.push(entry); bytes += Buffer.byteLength(entry.message) + 256;
      while (entries.length > this.lines || bytes > MAX_BYTES) bytes -= Buffer.byteLength(entries.shift().message) + 256;
    });
    return entries;
  }

  async snapshot() {
    const { names, targets } = await this.discover();
    this.names = names;
    const boundary = timestampKey(new Date().toISOString());
    const warnings = [];
    const results = await Promise.all(targets.map(async (target) => {
      const current = { ...target, boundary, cursor: boundary, seen: new Map(), active: false };
      this.targets.set(target.id, current);
      try { return await this.history(target, boundary); }
      catch (error) { if (!this.signal.aborted) warnings.push(`${target.service}: ${error.message}`); return []; }
    }));
    await this.assertInstance();
    this.initialized = true;
    return { entries: boundedEntries(results.flat(), this.lines), services: names, lines: this.lines, warnings };
  }

  flush() {
    if (!this.pending.length || this.closed) return;
    const entries = this.pending.sort(compareEntries);
    this.pending = []; this.pendingBytes = 0;
    this.send({ type: "entries", entries });
  }

  enqueue(entry) {
    if (this.closed) return;
    this.pending.push(entry); this.pendingBytes += Buffer.byteLength(entry.message) + 256;
    if (this.pending.length >= 1000 || this.pendingBytes >= MAX_BYTES) this.flush();
  }

  async follow(target) {
    if (target.active || this.closed) return;
    target.active = true;
    const controller = new AbortController();
    target.controller = controller;
    const signal = AbortSignal.any([this.signal, controller.signal]);
    // 마지막 시각 직전도 다시 읽는다. 두 출력 스트림의 도착 순서는 기록 시각과 다를 수 있다.
    let cursor = timestampKey(new Date(Date.parse(target.cursor) - 1000).toISOString());
    if (cursor < target.boundary) cursor = target.boundary;
    try {
      const response = await logResponse(target, { follow: "true", tail: "all", since: cursor }, signal);
      await readLogResponse(response, target, (entry) => {
        if (entry.timestamp < target.boundary || target.seen.has(entry.id)) return;
        target.seen.set(entry.id, entry.timestamp);
        if (target.seen.size > MAX_REPLAY) target.seen.delete(target.seen.keys().next().value);
        if (entry.timestamp > target.cursor) target.cursor = entry.timestamp;
        this.enqueue(entry);
      });
      target.warned = false;
    } catch (error) {
      if (!signal.aborted && !target.warned) { target.warned = true; this.send({ type: "warning", message: `${target.service}: ${error.message}; retrying` }); }
    } finally { target.active = false; }
  }

  async refresh() {
    if (this.closed || this.refreshing) return;
    this.refreshing = true;
    try {
      const { names, targets } = await this.discover();
      if (this.closed) return;
      if (JSON.stringify(names) !== JSON.stringify(this.names)) { this.names = names; this.send({ type: "services", services: names }); }
      const ids = new Set(targets.map((target) => target.id));
      for (const [id, target] of this.targets) if (!ids.has(id)) { target.controller?.abort(); this.targets.delete(id); }
      await Promise.all(targets.map(async (target) => {
        let current = this.targets.get(target.id);
        if (!current) {
          const boundary = timestampKey(new Date().toISOString());
          current = { ...target, boundary, cursor: boundary, seen: new Map(), active: false };
          this.targets.set(target.id, current);
          try { for (const entry of await this.history(target, boundary)) this.enqueue(entry); }
          catch (error) { if (!this.closed) this.send({ type: "warning", message: `${target.service}: ${error.message}` }); }
        }
        current.running = target.running;
        void this.follow(current);
      }));
    } catch (error) {
      if (this.closed) return;
      if (error instanceof AppError) { this.send({ type: "end", message: error.message }); this.close(); }
      else this.send({ type: "warning", message: "Cannot refresh app containers; retrying" });
    } finally { this.refreshing = false; }
  }

  start(send, onClose) {
    this.send = send;
    this.onClose = onClose;
    if (this.closed) return;
    for (const target of this.targets.values()) void this.follow(target);
    this.flushTimer = setInterval(() => this.flush(), 250);
    this.refreshTimer = setInterval(() => void this.refresh(), 2000);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.flushTimer); clearInterval(this.refreshTimer);
    for (const target of this.targets.values()) target.controller?.abort();
    this.targets.clear(); this.pending = [];
    this.onClose?.();
  }
}

module.exports = { AppLogSession, parseLogOptions };
