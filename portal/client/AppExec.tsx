import { useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { appPath, type Service } from "./types";
import { ErrorText } from "./ui";

const execSelectionByApp = new Map<string, string>();

export function AppExec({
  userid,
  appname,
  services = [],
  primaryService,
}: {
  userid: string;
  appname: string;
  services?: Service[];
  primaryService?: string;
}) {
  const appKey = `${userid}/${appname}`;
  const path = appPath(userid, appname);
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [service, setService] = useState(
    () =>
      execSelectionByApp.get(appKey) ||
      primaryService ||
      services[0]?.name ||
      "app",
  );
  const [status, setStatus] = useState("Connecting…");
  const [error, setError] = useState("");
  const serviceNames = useMemo(() => {
    const names = services.map((item) => item.name).filter(Boolean);
    const preferred = primaryService || "app";
    if (!names.includes(preferred)) names.unshift(preferred);
    return names.length ? names : ["app"];
  }, [services, primaryService]);

  useEffect(() => {
    const remembered = execSelectionByApp.get(appKey);
    setService(
      remembered && serviceNames.includes(remembered)
        ? remembered
        : primaryService && serviceNames.includes(primaryService)
          ? primaryService
          : serviceNames[0] || "app",
    );
  }, [appKey, primaryService, serviceNames]);

  useEffect(() => {
    execSelectionByApp.set(appKey, service);
  }, [appKey, service]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
      theme: {
        background: "#0a0a0a",
        foreground: "#ededed",
        cursor: "#ededed",
      },
      scrollback: 5000,
    });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(mount);
    fit.fit();

    const sendResize = () => {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: "resize",
            cols: terminal.cols,
            rows: terminal.rows,
          }),
        );
      }
    };

    terminal.onData((data) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(data);
    });
    resizeObserver = new ResizeObserver(() => {
      if (disposed) return;
      fit.fit();
      sendResize();
    });
    resizeObserver.observe(mount);

    const params = new URLSearchParams({
      cols: String(terminal.cols || 80),
      rows: String(terminal.rows || 24),
      service,
    });
    const url = new URL(
      `/api${path}/exec/ws?${params.toString()}`,
      window.location.href,
    );
    url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    setStatus("Connecting…");
    setError("");
    try {
      socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      socket.onopen = () => {
        if (disposed) return;
        fit.fit();
        sendResize();
        terminal.focus();
        setStatus("Connected");
      };
      socket.onmessage = (event) => {
        if (disposed) return;
        if (typeof event.data === "string") terminal.write(event.data);
        else if (event.data instanceof ArrayBuffer)
          terminal.write(new Uint8Array(event.data));
        else if (event.data instanceof Blob)
          void event.data.arrayBuffer().then((buffer) => {
            if (!disposed) terminal.write(new Uint8Array(buffer));
          });
      };
      socket.onerror = () => {
        if (!disposed) {
          setError("Unable to connect to the exec terminal.");
          setStatus("Connection error");
        }
      };
      socket.onclose = (event) => {
        if (!disposed) {
          setStatus("Disconnected");
          if (event.code !== 1000)
            setError("The exec connection closed unexpectedly.");
        }
      };
    } catch {
      setError("Unable to open the exec connection.");
      setStatus("Connection error");
    }

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      resizeObserver = null;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        )
          socket.close();
        socket = null;
      }
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
    };
  }, [appKey, path, service]);

  function clearTerminal() {
    terminalRef.current?.clear();
  }

  return (
    <section
      id="detail-panel-exec"
      className="panel detail-panel"
      role="tabpanel"
      aria-labelledby="detail-tab-btn-exec"
    >
      <div className="panel-head">
        <h3>Exec</h3>
        <div className="logs-controls">
          <label
            className="service-selector-label"
            htmlFor="detail-exec-service"
          >
            Service
          </label>
          <select
            id="detail-exec-service"
            className="service-selector"
            aria-label="Exec service"
            value={service}
            onChange={(event) => setService(event.target.value)}
          >
            {serviceNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <button
            id="detail-exec-clear-btn"
            className="ghost-btn"
            type="button"
            onClick={clearTerminal}
          >
            Clear
          </button>
        </div>
      </div>
      <p className="detail-logs-title" role="status" aria-live="polite">
        {status}
      </p>
      {error && <ErrorText message={error} id="detail-exec-error" />}
      <div className="exec-terminal-container">
        <div
          ref={mountRef}
          id="detail-exec-terminal"
          className="exec-terminal-mount"
        />
      </div>
    </section>
  );
}
