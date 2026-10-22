"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

async function setup(fetchJob) {
  const { createJobLogViewer } = await import("../public/app-job-log.js");
  const content = { textContent: "", scrollTop: 0, scrollHeight: 100, clientHeight: 100 };
  const status = { textContent: "" };
  const copyButton = { disabled: false };
  const sources = [];
  const viewer = createJobLogViewer({
    content, status, copyButton, fetchJob,
    createEventSource(url) {
      const source = {
        url, closed: false, readyState: 0,
        close() { this.closed = true; },
        send(message) { return this.onmessage({ data: JSON.stringify(message) }); },
      };
      sources.push(source);
      return source;
    },
  });
  return { viewer, content, status, copyButton, sources };
}

test("진행 중 로그를 즉시 표시하고 최종 오류까지 조회한 뒤 연결을 닫는다", async () => {
  let job = { id: "job-1", status: "running", logs: ["cached"] };
  const { viewer, content, status, sources, copyButton } = await setup(async () => job);
  await viewer.open(job);
  assert.equal(sources[0].url, "/api/jobs/job-1/stream");
  sources[0].onopen();
  assert.equal(copyButton.disabled, true);
  await sources[0].send({ type: "log", line: "<script>log</script>" });
  assert.equal(content.textContent, "<script>log</script>");
  assert.equal(copyButton.disabled, false);
  await sources[0].send({ type: "log", line: "next line" });
  assert.equal(content.textContent, "<script>log</script>\nnext line");
  job = { ...job, status: "failed", error: "<script>log</script>\nnext line\n\n[Error]\nbuild failed" };
  await sources[0].send({ type: "status", status: "failed" });
  assert.equal(sources[0].closed, true);
  assert.equal(status.textContent, "Failed");
  assert.equal(content.textContent, job.error);
});

test("재접속의 전체 로그 리플레이는 이전 로그와 중복되지 않는다", async () => {
  const job = { id: "job-1", status: "pending" };
  const { viewer, content, status, sources } = await setup(async () => job);
  await viewer.open(job);
  const source = sources[0];
  source.onopen();
  await source.send({ type: "log", line: "one" });
  await source.onerror();
  assert.match(status.textContent, /Reconnecting/);
  source.onopen();
  await source.send({ type: "log", line: "one" });
  await source.send({ type: "log", line: "two" });
  assert.equal(content.textContent, "one\ntwo");
  viewer.close();
  assert.equal(source.closed, true);
});

test("서버 재시작 후의 완료 작업도 영속화된 결과를 표시하며 SSE를 열지 않는다", async () => {
  const job = { id: "job-1", status: "done", logs: [], output: "stored logs\n[Result]\nfinished" };
  const { viewer, content, status, sources } = await setup(async () => job);
  await viewer.open(job);
  assert.equal(content.textContent, job.output);
  assert.equal(status.textContent, "Completed");
  assert.equal(sources.length, 0);
});

test("닫기와 작업 전환 후 늦게 도착한 응답 및 로그는 무시한다", async () => {
  let resolveFirst;
  const firstJob = new Promise((resolve) => { resolveFirst = resolve; });
  const secondJob = { id: "second", status: "running" };
  const { viewer, content, sources } = await setup((id) => id === "first" ? firstJob : secondJob);
  const firstOpen = viewer.open({ id: "first", status: "pending" });
  await viewer.open(secondJob);
  resolveFirst({ id: "first", status: "done", output: "stale" });
  await firstOpen;
  assert.equal(sources.length, 1);
  const source = sources[0];
  source.onopen();
  await source.send({ type: "log", line: "current" });
  viewer.close();
  await source.send({ type: "log", line: "stale" });
  assert.equal(source.closed, true);
  assert.equal(content.textContent, "current");
});

test("로그를 위로 스크롤하면 위치를 보존하며 맨 아래에서는 새 로그를 따라간다", async () => {
  const job = { id: "job-1", status: "running" };
  const { viewer, content, sources } = await setup(async () => job);
  await viewer.open(job);
  const source = sources[0];
  source.onopen();
  content.scrollHeight = 1000;
  content.scrollTop = 200;
  await source.send({ type: "log", line: "one" });
  assert.equal(content.scrollTop, 200);
  content.scrollTop = 900;
  await source.send({ type: "log", line: "two" });
  assert.equal(content.scrollTop, 1000);
});

test("연결 단절 중 완료된 작업은 최종 결과를 표시하고 재연결을 중지한다", async () => {
  let job = { id: "job-1", status: "running" };
  const { viewer, content, status, sources } = await setup(async () => job);
  await viewer.open(job);
  job = { ...job, status: "done", output: "finished while disconnected" };
  await sources[0].onerror();
  assert.equal(content.textContent, job.output);
  assert.equal(status.textContent, "Completed");
  assert.equal(sources[0].closed, true);
});

test("세션 만료는 재접속을 중단하고 오류를 표시한다", async () => {
  let expired = false;
  const job = { id: "job-1", status: "running" };
  const { viewer, status, sources } = await setup(async () => {
    if (expired) throw Object.assign(new Error("Unauthorized"), { status: 401 });
    return job;
  });
  await viewer.open(job);
  expired = true;
  await sources[0].onerror();
  assert.equal(sources[0].closed, true);
  assert.match(status.textContent, /Check your session/);
});
