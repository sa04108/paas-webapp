import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, errorMessage, json } from "./api";
import type { Job, Notice } from "./types";
import { Icon, Modal } from "./ui";

const active = (job: Job) =>
  job.status === "pending" || job.status === "running";
const label: Record<string, string> = {
  pending: "Pending",
  running: "Running",
  done: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
  warn: "Completed with warnings",
};
const action = (job: Job) =>
  ({
    create: "Create App",
    deploy: "Redeploy",
    start: "Start",
    stop: "Stop",
    delete: "Delete App",
    "env-restart": "Restart with Updated Environment Variables",
  })[job.type] ||
  job.type ||
  "Job";
const target = (job: Job) =>
  job.meta?.userid && job.meta?.appname
    ? `${job.meta.userid}/${job.meta.appname}`
    : job.meta?.appname || "-";
const LOG_LIMIT = 2500;
function terminalLog(job: Job) {
  const tail = (job.logs || []).slice(-LOG_LIMIT).join("\n");
  const output = job.output || "";
  const error = job.error || "";
  const result = [output, error ? `[Error]\n${error}` : ""]
    .filter(Boolean)
    .join("\n\n");
  if (!result) return tail;
  if (!tail || output.startsWith(tail) || error.startsWith(tail)) return result;
  if (tail.startsWith(output) && !error) return tail;
  return `${tail}${tail ? "\n\n" : ""}${result}`;
}

export function Jobs({
  jobs,
  refresh,
  notify,
}: {
  jobs: Job[];
  refresh: () => Promise<void>;
  notify: Notice;
}) {
  const [listOpen, setListOpen] = useState(false);
  const [selected, setSelected] = useState<Job | null>(null);
  const [log, setLog] = useState("");
  const [logStatus, setLogStatus] = useState("");
  const [copyReady, setCopyReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const contentRef = useRef<HTMLPreElement>(null);
  const sorted = useMemo(
    () =>
      [...jobs].filter((j) =>
        [
          "pending",
          "running",
          "done",
          "warn",
          "failed",
          "interrupted",
        ].includes(j.status),
      ),
    [jobs],
  );
  const activeJobs = jobs.filter(active);
  const alertJobs = jobs.filter(
    (j) => j.status === "failed" || j.status === "interrupted",
  );
  const openJob = (job: Job) => {
    setSelected(job);
    setLog((job.logs || []).join("\n"));
    setLogStatus("Loading job logs...");
    setCopyReady(false);
  };
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    let source: EventSource | null = null;
    let lines: string[] = [];
    let currentId = selected.id;
    const setText = (text: string, placeholder = "No logs recorded.") => {
      const el = contentRef.current;
      const follow =
        !el || el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      setLog(text || placeholder);
      setCopyReady(Boolean(text));
      if (el && follow)
        requestAnimationFrame(() => {
          if (contentRef.current)
            contentRef.current.scrollTop = contentRef.current.scrollHeight;
        });
    };
    const fetchJob = async () => {
      const { job } = await api<{ job: Job }>(
        `/jobs/${encodeURIComponent(currentId)}`,
        { signal: controller.signal },
      );
      return job;
    };
    const connect = () => {
      source = new EventSource(
        `/api/jobs/${encodeURIComponent(currentId)}/stream`,
      );
      const currentSource = source;
      currentSource.onopen = () => {
        if (!controller.signal.aborted && source === currentSource) {
          lines = [];
          setText("", "Waiting for logs...");
          setLogStatus("Live — receiving job logs");
        }
      };
      currentSource.onmessage = async (event) => {
        if (controller.signal.aborted || source !== currentSource) return;
        let message: { type?: string; line?: string; status?: string };
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "log") {
          lines.push(String(message.line));
          if (lines.length > LOG_LIMIT) lines = lines.slice(-LOG_LIMIT);
          setText(lines.join("\n"), "Waiting for logs...");
        }
        if (
          message.type === "status" &&
          message.status &&
          !["pending", "running"].includes(message.status)
        ) {
          currentSource.close();
          source = null;
          try {
            const job = await fetchJob();
            if (!controller.signal.aborted) {
              setSelected(job);
              setText(terminalLog(job));
              setLogStatus(label[job.status] || job.status);
            }
          } catch (error) {
            if (!controller.signal.aborted) setLogStatus(errorMessage(error));
          }
        }
      };
      currentSource.onerror = async () => {
        if (controller.signal.aborted || source !== currentSource) return;
        setLogStatus(
          currentSource.readyState === EventSource.CLOSED
            ? "Connection closed. Reopen logs to reconnect."
            : "Connection lost. Reconnecting...",
        );
        try {
          const job = await fetchJob();
          if (controller.signal.aborted || source !== currentSource) return;
          if (!active(job)) {
            currentSource.close();
            source = null;
            setSelected(job);
            setText(terminalLog(job));
            setLogStatus(label[job.status] || job.status);
          }
        } catch (error) {
          const status = (error as { status?: number }).status;
          if ([401, 403, 404].includes(status || 0)) {
            currentSource.close();
            source = null;
            setLogStatus(
              "Logs unavailable. Check your session and reopen logs.",
            );
          }
        }
      };
    };
    (async () => {
      try {
        const job = await fetchJob();
        if (controller.signal.aborted) return;
        setSelected(job);
        const text = active(job)
          ? (job.logs || []).slice(-LOG_LIMIT).join("\n")
          : terminalLog(job);
        setText(
          text,
          active(job) ? "Waiting for logs..." : "No logs recorded.",
        );
        setLogStatus(label[job.status] || job.status);
        if (active(job)) connect();
      } catch (error) {
        if (!controller.signal.aborted)
          setLogStatus(`Could not load job details: ${errorMessage(error)}`);
      }
    })();
    return () => {
      controller.abort();
      source?.close();
    };
  }, [selected?.id]);
  async function runAction(job: Job, kind: "retry" | "cancel") {
    setBusy(true);
    try {
      await api(
        kind === "retry"
          ? `/jobs/${encodeURIComponent(job.id)}/retry`
          : `/jobs/${encodeURIComponent(job.id)}/cancel`,
        json("POST"),
      );
      notify(
        kind === "retry"
          ? `Retry started: ${target(job)}`
          : `Job removed: ${target(job)}`,
        "success",
      );
      await refresh();
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  }
  async function clearCompleted() {
    if (!window.confirm("Clear all completed jobs?")) return;
    setBusy(true);
    try {
      await api("/jobs", json("DELETE"));
      notify("Completed job history cleared.", "success");
      await refresh();
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  }
  async function retryAll() {
    for (const job of alertJobs) await runAction(job, "retry");
  }
  const slot = document.getElementById("job-indicator-slot");
  return (
    <>
      <button
        id="job-list-btn"
        className="icon-btn"
        type="button"
        aria-label="Jobs"
        title="Jobs"
        onClick={() => setListOpen(true)}
      >
        <Icon name="jobs" />
      </button>
      {slot &&
        (activeJobs.length > 0 || alertJobs.length > 0) &&
        createPortal(
          <div className="bottom-right-stack">
            <div
              id="job-indicator"
              className="job-indicator"
              aria-live="polite"
            >
              {activeJobs.length > 0 && (
                <span>
                  <span className="job-spinner" aria-hidden="true">
                    ⏳
                  </span>{" "}
                  Jobs in progress: {activeJobs.length}
                </span>
              )}
              {alertJobs.length > 0 && (
                <span className="job-alert">
                  ⚠️ Interrupted / failed jobs: {alertJobs.length} —{" "}
                  <button
                    className="job-retry-all-btn"
                    type="button"
                    disabled={busy}
                    onClick={() => void retryAll()}
                  >
                    Retry
                  </button>
                </span>
              )}
              <button
                className="job-view-list-btn ghost-btn"
                type="button"
                onClick={() => setListOpen(true)}
              >
                View list
              </button>
            </div>
          </div>,
          slot,
        )}
      {listOpen && (
        <Modal
          title="Jobs"
          onClose={() => setListOpen(false)}
          className="job-list-modal-card"
          id="job-list-modal"
        >
          <div className="job-modal-actions">
            <button
              id="clear-completed-jobs-btn"
              className="ghost-btn danger-ghost-btn job-clear-btn"
              type="button"
              onClick={clearCompleted}
              disabled={busy}
            >
              Clear all completed jobs
            </button>
          </div>
          <p className="modal-description">
            View all jobs, including those in progress and completed. Only the
            10 most recent completed jobs are retained.
          </p>
          {!sorted.length ? (
            <p id="job-list-empty" className="empty-state">
              No jobs at the moment.
            </p>
          ) : (
            <div className="users-table-wrap">
              <table className="users-table" id="job-list-table">
                <thead>
                  <tr>
                    <th>Job</th>
                    <th>App</th>
                    <th>Status</th>
                    <th>Logs</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody id="job-list-tbody">
                  {sorted.map((job) => (
                    <tr key={job.id}>
                      <td>{action(job)}</td>
                      <td>{target(job)}</td>
                      <td>
                        <span className={`status-pill status-${job.status}`}>
                          {label[job.status] || job.status}
                        </span>
                      </td>
                      <td>
                        <button
                          className="ghost-btn job-log-btn"
                          data-action="view-job-log"
                          data-id={job.id}
                          type="button"
                          aria-label={
                            active(job) ? "View live job logs" : "View job logs"
                          }
                          title={active(job) ? "Live logs" : "View logs"}
                          onClick={() => openJob(job)}
                        >
                          <Icon name="logs" />
                        </button>
                      </td>
                      <td>
                        {job.status === "failed" ||
                        job.status === "interrupted" ? (
                          <div className="job-action-group">
                            <button
                              className="action-btn job-action-btn"
                              data-action="retry-job"
                              type="button"
                              disabled={busy}
                              onClick={() => void runAction(job, "retry")}
                            >
                              Retry
                            </button>
                            <button
                              className="ghost-btn danger-ghost-btn job-action-btn job-remove-btn"
                              data-action="cancel-job"
                              type="button"
                              disabled={busy}
                              aria-label="Remove job from list"
                              title="Remove from list"
                              onClick={() => void runAction(job, "cancel")}
                            >
                              <Icon name="close" />
                            </button>
                          </div>
                        ) : ["done", "warn"].includes(job.status) ? (
                          <div className="job-action-group">
                            <button
                              className="ghost-btn danger-ghost-btn job-action-btn job-remove-btn"
                              type="button"
                              disabled={busy}
                              aria-label="Remove job from list"
                              title="Remove from list"
                              onClick={() => void runAction(job, "cancel")}
                            >
                              <Icon name="close" />
                            </button>
                          </div>
                        ) : (
                          <span className="ink-subtle">-</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
      {selected && (
        <Modal
          title="Job Log Details"
          onClose={() => setSelected(null)}
          className="job-log-modal-card"
          id="job-log-modal"
        >
          <div className="job-modal-actions">
            <button
              id="copy-job-log-btn"
              className="ghost-btn job-copy-btn"
              type="button"
              disabled={!copyReady}
              onClick={() =>
                navigator.clipboard
                  .writeText(log)
                  .then(() => notify("Job logs copied.", "success"))
                  .catch(() =>
                    notify("Failed to copy to the clipboard.", "error"),
                  )
              }
            >
              <Icon name="copy" /> Copy
            </button>
          </div>
          <p
            id="job-log-status"
            className="modal-description"
            role="status"
            aria-live="polite"
          >
            {logStatus}
          </p>
          <pre
            id="job-log-content"
            ref={contentRef}
            className="logs-output"
            tabIndex={0}
            aria-label="Job log output"
          >
            {log ||
              (active(selected) ? "Waiting for logs..." : "No logs recorded.")}
          </pre>
        </Modal>
      )}
    </>
  );
}
