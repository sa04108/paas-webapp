"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const jobsRouter = require("../routes/jobs");
const jobStore = require("../jobStore");

function authFromHeader(req, res, next) {
  const identity = req.get("x-test-user");
  if (!identity) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const [username, role = "user"] = identity.split(":");
  req.auth = { user: { username, role } };
  next();
}

function createSseEventReader(reader, decoder) {
  let buffered = "";
  return async function readSseEvent() {
    while (true) {
      const separator = buffered.indexOf("\n\n");
      if (separator !== -1) {
        const raw = buffered.slice(0, separator);
        buffered = buffered.slice(separator + 2);
        const data = raw.split(/\r?\n/).find((line) => line.startsWith("data: "));
        if (data) return JSON.parse(data.slice(6));
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("SSE stream ended before expected event");
      buffered += decoder.decode(value, { stream: true });
    }
  };
}

test("jobs SSE replays backlog, streams appended logs, and enforces job access", { timeout: 10000 }, async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paas-job-stream-"));
  jobStore.init(path.join(tempDir, "jobs.sqlite3"));

  const app = express();
  app.use("/api/jobs", authFromHeader, jobsRouter);
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.message });
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/jobs`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const jobId = jobStore.createJob("deploy", { appname: "sample" }, "alice");
  jobStore.appendLog(jobId, "backlog one");
  jobStore.appendLog(jobId, "backlog two");
  jobStore.startJob(jobId);

  const ownerHeaders = { "x-test-user": "alice" };
  const liveResponse = await fetch(`${baseUrl}/${jobId}/stream`, { headers: ownerHeaders });
  assert.equal(liveResponse.status, 200);
  assert.match(liveResponse.headers.get("content-type"), /text\/event-stream/);
  const reader = liveResponse.body.getReader();
  const decoder = new TextDecoder();
  const nextEvent = createSseEventReader(reader, decoder);
  async function nextEventWithTimeout() {
    let timer;
    try {
      return await Promise.race([
        nextEvent(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Timed out waiting for SSE event")), 3000);
          timer.unref?.();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  assert.deepEqual(await nextEventWithTimeout(), { type: "log", line: "backlog one" });
  assert.deepEqual(await nextEventWithTimeout(), { type: "log", line: "backlog two" });

  jobStore.appendLog(jobId, "live line");
  assert.deepEqual(await nextEventWithTimeout(), { type: "log", line: "live line" });
  jobStore.finishJob(jobId, "complete");
  assert.deepEqual(await nextEventWithTimeout(), { type: "status", status: "done" });
  assert.equal((await reader.read()).done, true);

  const lateResponse = await fetch(`${baseUrl}/${jobId}/stream`, { headers: ownerHeaders });
  assert.equal(lateResponse.status, 200);
  const lateBody = await lateResponse.text();
  assert.deepEqual(
    [...lateBody.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1])),
    [
      { type: "log", line: "backlog one" },
      { type: "log", line: "backlog two" },
      { type: "log", line: "live line" },
      { type: "status", status: "done" },
    ]
  );

  const forbidden = await fetch(`${baseUrl}/${jobId}/stream`, { headers: { "x-test-user": "bob" } });
  assert.equal(forbidden.status, 403);
  const admin = await fetch(`${baseUrl}/${jobId}/stream`, { headers: { "x-test-user": "admin:admin" } });
  assert.equal(admin.status, 200);
  assert.match(await admin.text(), /"status":"done"/);
});
