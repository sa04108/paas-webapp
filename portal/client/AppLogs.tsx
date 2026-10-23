import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import { appPath, type LogEntry, type Service } from "./types";
import { ErrorText } from "./ui";

type StreamPayload = {
  type?: string;
  entries?: LogEntry[];
  services?: string[];
  warnings?: string[];
  message?: string;
};

type LogsData = {
  entries: LogEntry[];
  services: string[];
  warnings?: string[];
};

const preferencesByApp = new Map<
  string,
  { lines: number; live: boolean; timestamps: boolean }
>();
const selectionByApp = new Map<string, Set<string>>();
const selectionAllByApp = new Map<string, boolean>();

function boundedLineCount(value: string) {
  const count = Number.parseInt(value, 10);
  return Number.isFinite(count) ? Math.max(1, Math.min(1000, count)) : 120;
}

function boundEntries(input: LogEntry[], lines: number) {
  const byId = new Map<string, LogEntry>();
  for (const entry of input) byId.set(entry.id, entry);
  const sorted = [...byId.values()]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-lines);
  let size = sorted.reduce(
    (total, entry) =>
      total +
      entry.message.length +
      entry.timestamp.length +
      entry.service.length,
    0,
  );
  while (sorted.length && size > 2 * 1024 * 1024) {
    const removed = sorted.shift()!;
    size -=
      removed.message.length +
      removed.timestamp.length +
      removed.service.length;
  }
  return sorted;
}

function serviceNames(services: Service[] | undefined) {
  return (services || []).map((service) => service.name).filter(Boolean);
}

export function AppLogs({
  userid,
  appname,
  services: appServices,
}: {
  userid: string;
  appname: string;
  services?: Service[];
}) {
  const appKey = `${userid}/${appname}`;
  const path = appPath(userid, appname);
  const preference = preferencesByApp.get(appKey);
  const [lineInput, setLineInput] = useState(String(preference?.lines ?? 120));
  const [lines, setLines] = useState(preference?.lines ?? 120);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [services, setServices] = useState<string[]>(() =>
    serviceNames(appServices),
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(selectionByApp.get(appKey) || serviceNames(appServices)),
  );
  const [selectionAll, setSelectionAll] = useState(
    () => selectionAllByApp.get(appKey) ?? true,
  );
  const [servicesKnown, setServicesKnown] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [liveMode, setLiveMode] = useState(preference?.live ?? true);
  const [showTimestamps, setShowTimestamps] = useState(
    preference?.timestamps ?? false,
  );
  const [connection, setConnection] = useState("");
  const [refreshId, setRefreshId] = useState(0);
  const outputRef = useRef<HTMLPreElement>(null);
  const followOutput = useRef(true);
  const previousLiveMode = useRef(liveMode);
  const selectedKey = useMemo(() => [...selected].sort().join(","), [selected]);
  const serviceListKey = useMemo(() => JSON.stringify(services), [services]);

  useEffect(() => {
    preferencesByApp.set(appKey, {
      lines,
      live: liveMode,
      timestamps: showTimestamps,
    });
  }, [appKey, lines, liveMode, showTimestamps]);

  useEffect(() => {
    selectionByApp.set(appKey, new Set(selected));
    selectionAllByApp.set(appKey, selectionAll);
  }, [appKey, selected, selectionAll]);

  useEffect(() => {
    const wasLiveMode = previousLiveMode.current;
    previousLiveMode.current = liveMode;
    if (!liveMode && wasLiveMode) return;
    const controller = new AbortController();
    let stream: EventSource | null = null;
    let disposed = false;
    let probeController: AbortController | null = null;
    const query = new URLSearchParams({ lines: String(lines) });
    if (servicesKnown) query.set("services", selectedKey);
    const logsPath = `${path}/logs?${query.toString()}`;

    const applyServices = (nextServices: string[]) => {
      setServices(nextServices);
      setServicesKnown(true);
      setSelected((current) => {
        const next = selectionAll
          ? new Set(nextServices)
          : new Set(nextServices.filter((name) => current.has(name)));
        return next.size === current.size &&
          [...next].every((name) => current.has(name))
          ? current
          : next;
      });
    };

    const applyPayload = (data: StreamPayload, replace: boolean) => {
      if (Array.isArray(data.services)) applyServices(data.services);
      if (Array.isArray(data.warnings)) setWarnings(data.warnings);
      if (Array.isArray(data.entries)) {
        setEntries((current) =>
          boundEntries(
            replace ? data.entries! : [...current, ...data.entries!],
            lines,
          ),
        );
      }
    };

    const fail = (reason: unknown) => {
      if (disposed || controller.signal.aborted) return;
      setError(errorMessage(reason));
      setLoading(false);
      setLiveMode(false);
      setConnection("");
    };

    async function loadSnapshot() {
      setError("");
      setConnection("");
      try {
        const data = await api<LogsData>(logsPath, {
          signal: controller.signal,
        });
        if (disposed) return;
        if (!Array.isArray(data?.entries) || !Array.isArray(data?.services)) {
          throw new Error(
            "The portal backend needs to be updated. Restart the portal and reload this page.",
          );
        }
        if (!servicesKnown) {
          if (Array.isArray(data.warnings)) setWarnings(data.warnings);
          setServices(data.services);
          setServicesKnown(true);
          setSelected((current) =>
            selectionAll
              ? new Set(data.services)
              : new Set(data.services.filter((name) => current.has(name))),
          );
          return;
        }
        applyPayload(data, true);
        setLoading(false);
        if (!liveMode) return;
        const streamQuery = new URLSearchParams({ lines: String(lines) });
        streamQuery.set("services", selectedKey);
        const streamUrl = `/api${path}/logs/stream?${streamQuery.toString()}`;
        stream = new EventSource(streamUrl, { withCredentials: true });
        const currentStream = stream;
        stream.onopen = () => {
          if (disposed || stream !== currentStream) return;
          setConnection("connected");
        };
        stream.onmessage = (event) => {
          if (disposed || stream !== currentStream) return;
          try {
            const payload = JSON.parse(event.data) as StreamPayload;
            if (payload.type === "snapshot") applyPayload(payload, true);
            else if (payload.type === "entries") applyPayload(payload, false);
            else if (payload.type === "services")
              applyServices(payload.services || []);
            else if (payload.type === "warning" && payload.message)
              setWarnings((current) =>
                [...current, payload.message!].slice(-20),
              );
            else if (payload.type === "end") {
              setConnection(payload.message || "Log stream ended");
              setLiveMode(false);
            }
          } catch {
            /* 잘못된 이벤트 하나는 스트림을 중단하지 않는다. */
          }
        };
        stream.onerror = async () => {
          if (disposed || stream !== currentStream) return;
          setConnection("Reconnecting to live logs…");
          probeController?.abort();
          probeController = new AbortController();
          const timeout = window.setTimeout(
            () => probeController?.abort(),
            2500,
          );
          try {
            const response = await fetch(`/api${logsPath}`, {
              credentials: "same-origin",
              cache: "no-store",
              signal: probeController.signal,
            });
            if (disposed || stream !== currentStream) return;
            if (response.status === 401 || response.status === 403) {
              setError("Log access expired. Please sign in again.");
              setLiveMode(false);
              setConnection("");
            } else if (response.status === 404 || response.status === 410) {
              setError("Log stream has ended.");
              setLiveMode(false);
              setConnection("");
            }
          } catch {
            /* EventSource가 연결을 다시 시도한다. */
          } finally {
            window.clearTimeout(timeout);
            probeController?.abort();
            probeController = null;
          }
        };
      } catch (reason) {
        if (!controller.signal.aborted) fail(reason);
      }
    }

    void loadSnapshot();
    return () => {
      disposed = true;
      controller.abort();
      probeController?.abort();
      stream?.close();
    };
  }, [
    appKey,
    path,
    lines,
    selectedKey,
    serviceListKey,
    servicesKnown,
    selectionAll,
    liveMode,
    refreshId,
  ]);

  const visibleEntries = entries
    .filter((entry) => selected.has(entry.service))
    .slice(-lines);
  useLayoutEffect(() => {
    const output = outputRef.current;
    if (output && followOutput.current) output.scrollTop = output.scrollHeight;
  }, [visibleEntries, showTimestamps]);
  const title = warnings.length
    ? warnings.join(" · ")
    : selected.size === 0
      ? "Choose services to view logs."
      : `${userid}/${appname} · ${entries.length} entries`;

  function toggleService(service: string) {
    const next = new Set(selected);
    if (next.has(service)) next.delete(service);
    else next.add(service);
    setSelectionAll(services.length > 0 && next.size === services.length);
    setSelected(next);
  }

  function changeLines(value: string) {
    setLineInput(value);
  }

  function commitLines() {
    const next = boundedLineCount(lineInput);
    setLines(next);
    setLineInput(String(next));
  }

  function toggleLive() {
    if (liveMode) {
      setLiveMode(false);
      setConnection("");
      setLoading(false);
    } else {
      setLiveMode(true);
      setRefreshId((value) => value + 1);
      setLoading(true);
      setError("");
    }
  }

  return (
    <section
      id="detail-panel-logs"
      className="panel detail-panel"
      role="tabpanel"
      aria-labelledby="detail-tab-btn-logs"
    >
      <div className="panel-head logs-head">
        <h3>Logs</h3>
        <div className="logs-controls">
          <label className="timestamp-toggle">
            <input
              id="detail-log-timestamps"
              type="checkbox"
              checked={showTimestamps}
              onChange={(event) => setShowTimestamps(event.target.checked)}
            />{" "}
            Timestamps
          </label>
          <input
            id="detail-log-lines-input"
            type="number"
            className="log-lines-input"
            min="1"
            max="1000"
            value={lineInput}
            onChange={(event) => changeLines(event.target.value)}
            onBlur={commitLines}
            onKeyDown={(event) => {
              if (event.key === "Enter") commitLines();
            }}
            aria-label="Number of log lines"
            title="Number of log lines"
          />
          <button
            id="detail-refresh-logs-btn"
            className="ghost-btn logs-refresh-btn"
            type="button"
            data-auto={String(liveMode)}
            aria-pressed={liveMode}
            title={
              liveMode
                ? "Pause automatic log streaming"
                : "Resume automatic log streaming"
            }
            onClick={toggleLive}
          >
            <span className="refresh-icon">↻</span>
            <span className="refresh-label">
              {liveMode ? "Auto" : "Refresh"}
            </span>
          </button>
        </div>
      </div>
      <div
        id="detail-log-services"
        className="log-service-toggles"
        role="group"
        aria-label="Log services"
      >
        {services.map((service) => (
          <button
            key={service}
            type="button"
            className="service-toggle"
            aria-pressed={selected.has(service)}
            onClick={() => toggleService(service)}
          >
            {service}
          </button>
        ))}
      </div>
      <p
        id="detail-logs-title"
        className="detail-logs-title"
        data-connection={connection}
      >
        {title}
        {connection ? ` · ${connection}` : ""}
      </p>
      {error && (
        <ErrorText
          message={`Unable to load logs: ${error}`}
          id="detail-logs-error"
        />
      )}
      <pre
        ref={outputRef}
        onScroll={(event) => {
          const output = event.currentTarget;
          followOutput.current =
            output.scrollHeight - output.scrollTop - output.clientHeight < 48;
        }}
        id="detail-logs-output"
        className="logs-output"
        aria-live="polite"
      >
        {loading && !error
          ? "Loading logs…"
          : error
            ? ""
            : visibleEntries.length
              ? visibleEntries.map((entry) => (
                  <div key={entry.id}>
                    {showTimestamps && (
                      <span className="log-timestamp">{entry.timestamp} </span>
                    )}
                    <span className="log-service-prefix">
                      [{entry.service}]{" "}
                    </span>
                    {entry.message}
                  </div>
                ))
              : selected.size
                ? "No logs available for the selected services."
                : "Choose services to view logs."}
      </pre>
    </section>
  );
}
