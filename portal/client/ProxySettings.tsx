import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api, errorMessage, json } from "./api";
import "./proxy.css";

type ProxyMode = "managed" | "external";
type Settings = {
  mode: ProxyMode;
  container: string;
  entrypoint: string;
  certificateResolver: string;
  customCertificateResolver: string;
};
type Check = {
  status: "ready" | "attention";
  checkedAt: string;
  checks: {
    id: string;
    title: string;
    status: "ok" | "warning" | "error";
    detail: string;
  }[];
};
type Guide = { title: string; description: string; code: string };
type ProxyData = {
  configured: boolean;
  settings: Settings;
  defaults: Settings;
  revision: number;
  environment: {
    domain: string;
    network: string;
    portalPort: number;
    portalContainer: string;
    dynamicDirectory: string;
    devMode: boolean;
  };
  lastCheck: Check | null;
  loadError?: string;
  guides: Guide[];
};
type Discovery = {
  containers: {
    id: string;
    name: string;
    image: string;
    running: boolean;
    networks: string[];
    entrypoints: string[];
    resolvers: string[];
  }[];
  networks: string[];
  warnings: string[];
};

const copySettings = (value: Settings): Settings => ({ ...value });
const statusLabel = (status: Check["checks"][number]["status"]) =>
  status === "ok" ? "Ready" : status === "warning" ? "Attention" : "Failed";

export function ProxySettings() {
  const location = useLocation();
  const [data, setData] = useState<ProxyData | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [previewGuides, setPreviewGuides] = useState<Guide[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [manualContainer, setManualContainer] = useState(false);
  const dirty = Boolean(
    data && settings && JSON.stringify(data.settings) !== JSON.stringify(settings),
  );
  const dirtyRef = useRef(dirty);
  const discoveryController = useRef<AbortController | null>(null);
  const checkController = useRef<AbortController | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const saveController = useRef<AbortController | null>(null);
  const previewController = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  dirtyRef.current = dirty;

  const load = useCallback(async () => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    setLoading(true);
    setError("");
    try {
      const result = await api<ProxyData>("/admin/proxy", {
        signal: controller.signal,
      });
      if (controller.signal.aborted || !mounted.current) return;
      setData(result);
      setSettings(copySettings(result.settings));
      setMessage("");
    } catch (e) {
      if (!controller.signal.aborted && mounted.current) setError(errorMessage(e));
    } finally {
      if (!controller.signal.aborted && mounted.current) setLoading(false);
      if (loadController.current === controller) loadController.current = null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      loadController.current?.abort();
      discoveryController.current?.abort();
      checkController.current?.abort();
      saveController.current?.abort();
      previewController.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    if (!settings || !data || !mounted.current) return;
    previewController.current?.abort();
    const controller = new AbortController();
    previewController.current = controller;
    setPreviewGuides(null);
    setPreviewError("");
    const timer = window.setTimeout(() => {
      setPreviewLoading(true);
      void api<{ guides: Guide[] }>("/admin/proxy/preview", {
        ...json("POST", { settings }),
        headers: { "X-Paas-Admin": "proxy" },
        signal: controller.signal,
      })
        .then(({ guides }) => {
          if (!controller.signal.aborted) setPreviewGuides(guides);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setPreviewError(errorMessage(e));
        })
        .finally(() => {
          if (!controller.signal.aborted) setPreviewLoading(false);
          if (previewController.current === controller)
            previewController.current = null;
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      if (previewController.current === controller)
        previewController.current = null;
    };
  }, [data?.revision, settings]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const guardLinks = (event: MouseEvent) => {
      if (!dirtyRef.current || event.defaultPrevented || event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank") return;
      const href = anchor.href;
      if (!href || new URL(href).origin !== window.location.origin) return;
      if (!window.confirm("You have unsaved proxy settings. Leave this page?")) {
        event.preventDefault();
        event.stopPropagation();
      } else {
        dirtyRef.current = false;
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", guardLinks, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", guardLinks, true);
    };
  }, [location.pathname]);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((current) => (current ? { ...current, [key]: value } : current));
    checkController.current?.abort();
    checkController.current = null;
    setChecking(false);
    setData((current) =>
      current?.lastCheck ? { ...current, lastCheck: null } : current,
    );
    setError("");
    setMessage("");
  }

  function restoreDefaults() {
    if (!data) return;
    setSettings(copySettings(data.defaults));
    checkController.current?.abort();
    checkController.current = null;
    setChecking(false);
    setData((current) =>
      current?.lastCheck ? { ...current, lastCheck: null } : current,
    );
    setError("");
    setMessage("");
  }

  async function reloadConfiguration() {
    if (
      dirty &&
      !window.confirm("Discard unsaved proxy settings and reload the saved configuration?")
    )
      return;
    dirtyRef.current = false;
    setMessage("");
    await load();
  }

  async function refreshDiscovery() {
    discoveryController.current?.abort();
    const controller = new AbortController();
    discoveryController.current = controller;
    setDiscovering(true);
    setError("");
    try {
      const result = await api<Discovery>("/admin/proxy/discovery", {
        signal: controller.signal,
      });
      if (!controller.signal.aborted) setDiscovery(result);
    } catch (e) {
      if (!controller.signal.aborted) setError(errorMessage(e));
    } finally {
      if (!controller.signal.aborted) setDiscovering(false);
      if (discoveryController.current === controller)
        discoveryController.current = null;
    }
  }

  async function save() {
    if (
      !settings ||
      !data ||
      (!dirty && data.configured && !data.loadError) ||
      saving ||
      checking
    )
      return;
    const controller = new AbortController();
    saveController.current?.abort();
    saveController.current = controller;
    setSaving(true);
    setError("");
    setMessage("");
    try {
      const result = await api<ProxyData>("/admin/proxy", {
        ...json("PUT", { settings, revision: data.revision }),
        headers: { "X-Paas-Admin": "proxy" },
        signal: controller.signal,
      });
      if (controller.signal.aborted || !mounted.current) return;
      dirtyRef.current = false;
      setData(result);
      setSettings(copySettings(result.settings));
      setMessage(
        "Configuration saved. Portal and custom-domain routes update now; redeploy existing apps to update their proxy routes.",
      );
    } catch (e) {
      if (!controller.signal.aborted && mounted.current)
        setError(errorMessage(e));
    } finally {
      if (!controller.signal.aborted && mounted.current) setSaving(false);
      if (saveController.current === controller) saveController.current = null;
    }
  }

  async function checkConnection() {
    if (!settings || checking || saving) return;
    checkController.current?.abort();
    const controller = new AbortController();
    checkController.current = controller;
    setChecking(true);
    setError("");
    setMessage("");
    try {
      const result = await api<Check>(
        "/admin/proxy/check",
        {
          ...json("POST", { settings }),
          headers: { "X-Paas-Admin": "proxy" },
          signal: controller.signal,
        },
      );
      if (!controller.signal.aborted)
        setData((current) => (current ? { ...current, lastCheck: result } : current));
    } catch (e) {
      if (!controller.signal.aborted) setError(errorMessage(e));
    } finally {
      if (!controller.signal.aborted) setChecking(false);
      if (checkController.current === controller) checkController.current = null;
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      if (mounted.current) setMessage("Guide copied to clipboard.");
    } catch {
      if (mounted.current)
        setError("Clipboard access is unavailable. Select and copy the guide text.");
    }
  }

  const selectedContainer = discovery?.containers.find(
    (item) => item.name === settings?.container || item.id === settings?.container,
  );
  const discoveredNetworks = discovery?.networks ?? [];
  const controlsDisabled = loading || saving || checking;
  const guides = previewGuides ?? (dirty ? [] : data?.guides ?? []);

  return (
    <section className="view-section proxy-settings" id="view-admin-proxy">
      <header className="view-header dashboard-heading">
        <div>
          <p className="eyebrow">ADMINISTRATION</p>
          <h2>Proxy setup</h2>
          <p className="view-subtitle">
            Connect the portal to the reverse proxy that routes applications.
          </p>
        </div>
        <div className="proxy-header-actions">
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void reloadConfiguration()}
            disabled={loading || saving || checking}
          >
            Reload configuration
          </button>
          <Link className="ghost-btn" to="/admin">Admin Dashboard</Link>
        </div>
      </header>

      {loading ? <p role="status">Loading proxy configuration…</p> : null}
      {error ? <p className="proxy-alert status-banner error" role="alert">{error}</p> : null}
      {previewError ? <p className="proxy-alert status-banner error" role="alert">Guide preview: {previewError}</p> : null}
      {message ? <p className="proxy-alert status-banner success" role="status">{message}</p> : null}

      {data?.loadError ? (
        <p className="proxy-alert status-banner error" role="alert">{data.loadError}</p>
      ) : null}

      {data && settings ? (
        <>
          {!data.configured ? (
            <p className="proxy-alert info" role="status">
              Proxy integration is not configured. Complete setup to enable application routing.
            </p>
          ) : data.lastCheck?.status === "attention" ? (
            <p className="proxy-alert info" role="status">
              The last connection check found items that need attention. Existing portal management remains available while you repair the connection.
            </p>
          ) : null}

          <section className="panel detail-panel">
            <div className="panel-head">
              <div>
                <h3>Connection mode</h3>
                <p className="proxy-help">Choose who operates the Traefik proxy. Saving a profile does not start or restart it.</p>
              </div>
              <button type="button" className="ghost-btn" onClick={restoreDefaults} disabled={controlsDisabled}>
                Restore defaults
              </button>
            </div>
            <div className="proxy-mode-grid" role="radiogroup" aria-label="Proxy connection mode">
              <label className={`proxy-mode-card${settings.mode === "managed" ? " selected" : ""}`}>
                <input
                  type="radio"
                  name="proxy-mode"
                  value="managed"
                  checked={settings.mode === "managed"}
                  disabled={controlsDisabled}
                  onChange={() => update("mode", "managed")}
                />
                <span><strong>Install a new Traefik</strong><small>Run the supplied standalone Traefik Compose stack.</small></span>
              </label>
              <label className={`proxy-mode-card${settings.mode === "external" ? " selected" : ""}`}>
                <input
                  type="radio"
                  name="proxy-mode"
                  value="external"
                  checked={settings.mode === "external"}
                  disabled={controlsDisabled}
                  onChange={() => update("mode", "external")}
                />
                <span><strong>Use existing Traefik</strong><small>Connect to a Traefik already running on the Docker host.</small></span>
              </label>
            </div>

            <div className="proxy-form-grid">
              <div className="proxy-field proxy-field-wide">
                <label htmlFor="proxy-container">Traefik container</label>
                {discovery && !manualContainer ? (
                  <select
                    id="proxy-container"
                    value={settings.container}
                    disabled={controlsDisabled}
                    onChange={(event) => update("container", event.target.value)}
                  >
                    <option value="">Choose a discovered container</option>
                    {discovery.containers.map((container) => (
                      <option
                        key={container.id}
                        value={settings.container === container.id ? container.id : container.name}
                      >
                        {container.name}{container.running ? "" : " (stopped)"} · {container.image}
                      </option>
                    ))}
                    {settings.container && !discovery.containers.some((container) => container.name === settings.container || container.id === settings.container) ? (
                      <option value={settings.container}>{settings.container} (current selection)</option>
                    ) : null}
                  </select>
                ) : (
                  <input
                    id="proxy-container"
                    type="text"
                    value={settings.container}
                    disabled={controlsDisabled}
                    onChange={(event) => update("container", event.target.value)}
                    placeholder="traefik"
                    autoComplete="off"
                  />
                )}
                <div className="proxy-inline-actions">
                  <button type="button" className="ghost-btn" onClick={refreshDiscovery} disabled={discovering || controlsDisabled}>
                    {discovering ? "Discovering…" : "Refresh discovery"}
                  </button>
                  {discovery ? (
                    <button type="button" className="ghost-btn" onClick={() => setManualContainer((value) => !value)} disabled={controlsDisabled}>
                      {manualContainer ? "Choose discovered container" : "Enter name manually"}
                    </button>
                  ) : null}
                </div>
                {discovery?.warnings.map((warning) => <small className="proxy-help" key={warning}>{warning}</small>)}
                {selectedContainer ? (
                  <small className="proxy-help">
                    {selectedContainer.running ? "Running" : "Not running"} · Networks: {selectedContainer.networks.join(", ") || "none detected"}
                  </small>
                ) : null}
              </div>

              <div className="proxy-field">
                <label htmlFor="proxy-entrypoint">Routing entrypoint</label>
                <input id="proxy-entrypoint" type="text" list="proxy-entrypoint-options" value={settings.entrypoint} disabled={controlsDisabled} onChange={(event) => update("entrypoint", event.target.value)} placeholder={data.environment.devMode ? "web" : "websecure"} />
                <datalist id="proxy-entrypoint-options">{selectedContainer?.entrypoints.map((value) => <option key={value} value={value} />)}</datalist>
                <small className="proxy-help">Used by application and portal routes. Production commonly uses <code>websecure</code>; development uses HTTP <code>web</code>.</small>
              </div>
              <div className="proxy-field">
                <label htmlFor="proxy-resolver">Platform and portal certificate resolver</label>
                <input id="proxy-resolver" type="text" list="proxy-resolver-options" value={settings.certificateResolver} disabled={controlsDisabled} onChange={(event) => update("certificateResolver", event.target.value)} placeholder="letsencrypt" />
                <datalist id="proxy-resolver-options">{selectedContainer?.resolvers.map((value) => <option key={value} value={value} />)}</datalist>
                <small className="proxy-help">Used for the portal and platform app hostnames, including the wildcard app certificate. Production commonly uses DNS-01. Leave blank only when another certificate source is configured or in development.</small>
              </div>
              <div className="proxy-field proxy-field-wide">
                <label htmlFor="proxy-custom-resolver">Custom-domain certificate resolver</label>
                <input id="proxy-custom-resolver" type="text" list="proxy-custom-resolver-options" value={settings.customCertificateResolver} disabled={controlsDisabled} onChange={(event) => update("customCertificateResolver", event.target.value)} placeholder="letsencrypt-http" />
                <datalist id="proxy-custom-resolver-options">{selectedContainer?.resolvers.map((value) => <option key={value} value={value} />)}</datalist>
                <small className="proxy-help">Used for customer-owned domains and their certificate challenge.</small>
              </div>
            </div>

            {data.environment ? (
              <div className="proxy-environment">
                <h4>Platform environment</h4>
                <dl>
                  <div><dt>Base domain</dt><dd>{data.environment.domain}</dd></div>
                  <div><dt>Shared network</dt><dd>{data.environment.network}</dd></div>
                  <div><dt>Portal container</dt><dd>{data.environment.portalContainer}</dd></div>
                  <div><dt>Portal internal port</dt><dd>{data.environment.portalPort}</dd></div>
                  <div><dt>Dynamic config directory</dt><dd>{data.environment.dynamicDirectory}</dd></div>
                </dl>
                <p className="proxy-help">The portal host is <code>portal.{data.environment.domain}</code>; the base domain above is not redirected to the portal.</p>
                <p className="proxy-help">These values come from the current environment. Change them there, then recreate the portal container.</p>
                {discovery && discoveredNetworks.length > 0 && !discoveredNetworks.includes(data.environment.network) ? (
                  <p className="proxy-alert info" role="status">The required network was not found during discovery. Create or configure it before connecting this proxy.</p>
                ) : null}
              </div>
            ) : null}

            <div className="proxy-actions">
              <button type="button" className="ghost-btn" onClick={checkConnection} disabled={checking || saving || loading}>
                {checking ? "Checking…" : "Check connection"}
              </button>
              <button type="button" className="primary-btn" onClick={save} disabled={(!dirty && data.configured && !data.loadError) || saving || checking || loading}>
                {saving ? "Saving…" : "Save configuration"}
              </button>
            </div>
            {dirty || !data.configured ? (
              <p className="proxy-alert info" role="note">A check with draft settings checks the selected container and configuration, but skips route checks. Save these settings to apply and validate routing.</p>
            ) : null}
          </section>

          {data.lastCheck ? (
            <section className="panel detail-panel proxy-check-panel" aria-labelledby="proxy-check-heading">
              <div className="panel-head">
                <div><h3 id="proxy-check-heading">Connection check</h3><p className="proxy-help">Checked {new Date(data.lastCheck.checkedAt).toLocaleString()}</p></div>
                <span className={`proxy-status status-pill ${data.lastCheck.status === "ready" ? "status-done" : "status-warn"}`}>{data.lastCheck.status === "ready" ? "Ready" : "Needs attention"}</span>
              </div>
              <ul className="proxy-check-list">
                {data.lastCheck.checks.map((item) => (
                  <li key={item.id}>
                    <span className={`proxy-check-mark ${item.status} ${item.status === "ok" ? "status-done" : item.status === "warning" ? "status-warn" : "status-failed"}`} aria-label={statusLabel(item.status)}>{item.status === "ok" ? "✓" : item.status === "warning" ? "!" : "×"}</span>
                    <span><strong>{item.title}</strong><small>{item.detail}</small></span>
                    <span className="proxy-check-result">{statusLabel(item.status)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {previewLoading ? <p role="status">Updating setup guide…</p> : null}
          {guides.length ? (
            <section className="panel detail-panel">
              <div className="panel-head"><div><h3>Connection guide</h3><p className="proxy-help">Follow the steps for the selected proxy mode.</p></div></div>
              <div className="proxy-guides">
                {guides.map((guide) => (
                  <details key={guide.title}>
                    <summary>{guide.title}</summary>
                    <p>{guide.description}</p>
                    <pre><code>{guide.code}</code></pre>
                    <button type="button" className="ghost-btn" onClick={() => void copy(guide.code)}>Copy instructions</button>
                  </details>
                ))}
              </div>
              <p className="proxy-help">External proxies are never changed or restarted by this portal. Check connection only reads the selected integration.</p>
            </section>
          ) : null}
        </>
      ) : !loading ? (
        <section className="panel detail-panel">
          <p role="status">Proxy configuration is unavailable.</p>
          <button className="ghost-btn" type="button" onClick={() => void load()}>Retry</button>
        </section>
      ) : null}
    </section>
  );
}
