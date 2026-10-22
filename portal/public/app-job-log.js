// 작업 로그 창의 SSE 연결과 표시를 관리한다. DOM과 통신은 호출자가 주입한다.
const ACTIVE_STATUSES = new Set(["pending", "running"]);
const STATUS_LABELS = {
  pending: "Pending", running: "Running", done: "Completed",
  failed: "Failed", interrupted: "Interrupted", warn: "Completed with warnings",
};

export function createJobLogViewer({ content, status, copyButton, fetchJob,
  createEventSource = (url) => new EventSource(url) }) {
  let session = null;

  function close() {
    session?.source?.close();
    session = null;
  }

  function render(text, placeholder = "No logs recorded.") {
    // 맨 아래를 보고 있을 때만 새 로그를 따라가며, 위로 스크롤한 위치는 보존한다.
    const follow = content.scrollHeight - content.scrollTop - content.clientHeight < 40;
    content.textContent = text || placeholder;
    copyButton.disabled = !text;
    if (follow) content.scrollTop = content.scrollHeight;
  }

  function showJob(job) {
    const active = ACTIVE_STATUSES.has(job.status);
    render(active ? (job.logs || []).join("\n") :
      (job.error || job.output || (job.logs || []).join("\n")),
    active ? "Waiting for logs..." : "No logs recorded.");
    status.textContent = STATUS_LABELS[job.status] || job.status;
  }

  function connect(current) {
    const source = createEventSource(`/api/jobs/${encodeURIComponent(current.id)}/stream`);
    current.source = source;
    let lines = [];
    source.onopen = () => {
      if (session !== current || current.source !== source) return;
      // 서버가 재접속마다 전체 버퍼를 보내므로 기존 표시를 교체하여 중복을 막는다.
      lines = [];
      render("", "Waiting for logs...");
      status.textContent = "Live — receiving job logs";
    };
    source.onmessage = async (event) => {
      if (session !== current || current.source !== source) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "log") {
        lines.push(String(message.line));
        render(lines.join("\n"), "Waiting for logs...");
      } else if (message.type === "status" && !ACTIVE_STATUSES.has(message.status)) {
        source.close();
        current.source = null;
        status.textContent = STATUS_LABELS[message.status] || message.status;
        // 최종 결과/오류는 로그 이벤트와 별도로 저장되므로 완료 후 다시 조회한다.
        await refresh(current);
      }
    };
    source.onerror = async () => {
      if (session !== current || current.source !== source) return;
      status.textContent = source.readyState === 2
        ? "Connection closed. Reopen logs to reconnect."
        : "Connection lost. Reconnecting...";
      try {
        const job = await fetchJob(current.id);
        if (session !== current || current.source !== source) return;
        // 연결이 끊긴 사이 완료되거나 서버가 재시작된 경우 재접속 루프를 끝낸다.
        if (!ACTIVE_STATUSES.has(job.status)) {
          source.close();
          current.source = null;
          showJob(job);
        }
      } catch (error) {
        if (session !== current || current.source !== source) return;
        if ([401, 403, 404].includes(error.status)) {
          source.close();
          current.source = null;
          status.textContent = "Logs unavailable. Check your session and reopen logs.";
        }
      }
    };
  }

  async function refresh(current) {
    try {
      const job = await fetchJob(current.id);
      if (session !== current) return;
      showJob(job);
      if (ACTIVE_STATUSES.has(job.status)) connect(current);
    } catch {
      if (session === current) {
        status.textContent = "Could not load job details. Reopen logs to retry.";
      }
    }
  }

  function open(job) {
    close();
    const current = { id: job.id, source: null };
    session = current;
    showJob(job);
    content.scrollTop = content.scrollHeight;
    status.textContent = "Loading job logs...";
    return refresh(current);
  }

  return { open, close };
}
