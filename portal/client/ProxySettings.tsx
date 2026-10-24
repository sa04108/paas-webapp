import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { api, errorMessage, json } from "./api";
import "./proxy.css";

type ProxyMode = "managed" | "external";
type CertificateAuthority = "letsencrypt" | "zerossl" | "custom";
const caServers = {
  letsencrypt: "https://acme-v02.api.letsencrypt.org/directory",
  zerossl: "https://acme.zerossl.com/v2/DV90",
};
type Settings = {
  mode: ProxyMode;
  image: string;
  container: string;
  network: string;
  entrypoint: string;
  certificateResolver: string;
  customCertificateResolver: string;
  certificateAuthority: CertificateAuthority;
  acmeServer: string;
  acmeEmail: string;
  acmeEab: boolean;
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
  dependency: { running: boolean | null; status: "ready" | "attention"; detail: string; checkedAt: string } | null;
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
    resolverDetails: {
      name: string;
      caServer: string | null;
      challenges: string[];
      dnsProvider: string | null;
      httpEntrypoint: string | null;
    }[];
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
  const [imageSource, setImageSource] = useState<{ image: string; container: string | null } | null>(null);
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
  const modeProfiles = useRef<Partial<Record<ProxyMode, Settings>>>({});
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
      modeProfiles.current = {};
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
    setImageSource(null);
    const timer = window.setTimeout(() => {
      setPreviewLoading(true);
      void api<{ guides: Guide[]; imageSource: { image: string; container: string | null } }>("/admin/proxy/preview", {
        ...json("POST", { settings }),
        headers: { "X-Paas-Admin": "proxy" },
        signal: controller.signal,
      })
        .then(({ guides, imageSource }) => {
          if (!controller.signal.aborted) {
            setPreviewGuides(guides);
            setImageSource(imageSource);
            if (settings.mode === "managed" && settings.image !== imageSource.image) {
              setSettings((current) => current ? { ...current, image: imageSource.image } : current);
            }
          }
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

  // 편집 중인 설정은 유지하고 실행 상태만 갱신한다.
  useEffect(() => {
    if (!data?.configured) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void api<ProxyData>("/admin/proxy", { signal: controller.signal })
        .then((latest) => {
          if (!controller.signal.aborted) setData((current) => current ? { ...current, dependency: latest.dependency } : current);
        }).catch(() => { /* 다음 조회에서 다시 확인한다. */ });
    }, 15000);
    return () => { window.clearInterval(timer); controller.abort(); };
  }, [data?.configured]);

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
    modeProfiles.current = {};
    checkController.current?.abort();
    checkController.current = null;
    setChecking(false);
    setData((current) =>
      current?.lastCheck ? { ...current, lastCheck: null } : current,
    );
    setError("");
    setMessage("");
  }

  function switchMode(mode: ProxyMode) {
    if (!settings || !data || mode === settings.mode) return;
    modeProfiles.current[settings.mode] = copySettings(settings);
    const previous = modeProfiles.current[mode];
    const container = mode === "external"
      ? discovery?.containers.find((item) => item.running)?.name || ""
      : data.defaults.container;
    update("mode", mode);
    setSettings(previous ? copySettings(previous) : { ...data.defaults, mode, container });
  }

  function changeAuthority(certificateAuthority: CertificateAuthority) {
    update("certificateAuthority", certificateAuthority);
    setSettings((current) => current ? {
      ...current,
      certificateAuthority,
      acmeServer: certificateAuthority === "custom" ? "" : caServers[certificateAuthority],
      acmeEab: certificateAuthority === "zerossl",
    } : current);
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
      (!dirty && data.configured && !data.loadError && settings.mode !== "external") ||
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
      if (result.loadError) return;
      setMessage(
        settings.mode === "managed" && !data.environment.devMode
          ? "Configuration saved and the dedicated Traefik Compose file generated. Follow the connection guide to start or update the proxy. Redeploy existing apps to update their proxy routes."
          : "Application network configured. New deployments keep web services separate from the portal and infrastructure. Redeploy existing apps to apply the network change.",
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

  function resolverDescription(name: string) {
    if (!name) return "No resolver selected. Configure another certificate source in Traefik.";
    const detail = selectedContainer?.resolverDetails?.find((item) => item.name === name.toLowerCase());
    if (!detail) return "Settings could not be verified. Refresh discovery and check that this resolver exists in Traefik.";
    const authority = detail.caServer === caServers.letsencrypt ? "Let’s Encrypt"
      : detail.caServer === caServers.zerossl ? "ZeroSSL"
        : detail.caServer || "CA unknown. Traefik defaults to Let’s Encrypt when no CA is configured.";
    return [authority, ...detail.challenges, detail.dnsProvider, detail.httpEntrypoint ? `HTTP entrypoint: ${detail.httpEntrypoint}` : null].filter(Boolean).join(" · ");
  }

  return (
    <section className="view-section proxy-settings" id="view-admin-proxy">
      <header className="view-header dashboard-heading">
        <div>
          <p className="eyebrow">ADMINISTRATION</p>
          <h2>Proxy setup</h2>
          <p className="view-subtitle">
            Connect application web services to a reverse proxy. The server manages the portal’s own address and HTTPS separately.
          </p>
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
                <p className="proxy-help">Choose who operates the Traefik proxy. Save and connect adds the separate application network while preserving the existing proxy configuration.</p>
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
                  onChange={() => switchMode("managed")}
                />
                <span><strong>Install a new Traefik</strong><small>Configure the certificate authority and validation methods for a new proxy.</small></span>
              </label>
              <label className={`proxy-mode-card${settings.mode === "external" ? " selected" : ""}`}>
                <input
                  type="radio"
                  name="proxy-mode"
                  value="external"
                  checked={settings.mode === "external"}
                  disabled={controlsDisabled}
                  onChange={() => switchMode("external")}
                />
                <span><strong>Use existing Traefik</strong><small>Use the entrypoint and certificate resolvers already defined in your proxy.</small></span>
              </label>
            </div>

            <div className="proxy-form-grid">
              <div className="proxy-field proxy-field-wide">
                <label htmlFor="proxy-network">Application-only network</label>
                <input id="proxy-network" type="text" list="proxy-network-options" value={settings.network} onChange={(event) => update("network", event.target.value)} disabled={controlsDisabled} autoComplete="off" />
                <datalist id="proxy-network-options">{discoveredNetworks.filter((name) => !selectedContainer?.networks.includes(name) || name === data.settings.network).map((name) => <option key={name} value={name} />)}</datalist>
                <small className="proxy-help">{settings.mode === "external"
                  ? "Use a separate network such as paas-app. Saving creates it if needed and connects Traefik. Web services stay off the infrastructure network; workers and databases remain private."
                  : "Use a separate network such as paas-app. Create it before starting the dedicated proxy; web services join it during deployment."}</small>
              </div>

              <div className="proxy-field proxy-field-wide">
                <label htmlFor="proxy-container">Traefik container</label>
                {settings.mode === "external" && discovery && !manualContainer ? (
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
                {settings.mode === "external" ? <div className="proxy-inline-actions">
                  <button type="button" className="ghost-btn" onClick={refreshDiscovery} disabled={discovering || controlsDisabled}>
                    {discovering ? "Discovering…" : "Refresh discovery"}
                  </button>
                  {settings.mode === "external" && discovery ? (
                    <button type="button" className="ghost-btn" onClick={() => setManualContainer((value) => !value)} disabled={controlsDisabled}>
                      {manualContainer ? "Choose discovered container" : "Enter name manually"}
                    </button>
                  ) : null}
                </div> : null}
                {discovery?.warnings.map((warning) => <small className="proxy-help" key={warning}>{warning}</small>)}
                {selectedContainer ? (
                  <small className="proxy-help">
                    {selectedContainer.running ? "Running" : "Not running"} · Networks: {selectedContainer.networks.join(", ") || "none detected"}
                  </small>
                ) : null}
              </div>

              {settings.mode === "managed" && imageSource ? <small className="proxy-help proxy-field-wide">
                Image: <code>{imageSource.image}</code> · {imageSource.container
                  ? `Detected from ${imageSource.container}`
                  : "No running Traefik found. Using the server default image."}
              </small> : selectedContainer ? <small className="proxy-help proxy-field-wide">Image: <code>{selectedContainer.image}</code> · The existing container image is preserved.</small> : null}

            </div>

            {settings.mode === "managed" && !data.environment.devMode ? (
              <div className="proxy-certificate-panel">
                <h4>Certificate issuance</h4>
                <p className="proxy-help">Choose a certificate authority. The new Traefik configuration will use this CA and the validation methods below.</p>
                <div className="proxy-form-grid">

                  <div className="proxy-field">
                    <label htmlFor="proxy-ca">Certificate authority</label>
                    <select id="proxy-ca" value={settings.certificateAuthority} disabled={controlsDisabled} onChange={(event) => changeAuthority(event.target.value as CertificateAuthority)}>
                      <option value="letsencrypt">Let’s Encrypt · Default</option>
                      <option value="zerossl">ZeroSSL · EAB required</option>
                      <option value="custom">Custom ACME CA</option>
                    </select>
                  </div>
                  <div className="proxy-field">
                    <label htmlFor="proxy-acme-email">ACME email</label>
                    <input id="proxy-acme-email" type="email" value={settings.acmeEmail} disabled={controlsDisabled} onChange={(event) => update("acmeEmail", event.target.value)} placeholder="admin@example.com" />
                    <small className="proxy-help">Leave blank to use ACME_EMAIL from the server’s .env file.</small>
                  </div>
                  <div className="proxy-field proxy-field-wide">
                    <label htmlFor="proxy-acme-server">ACME directory URL</label>
                    <input id="proxy-acme-server" type="url" value={settings.acmeServer} readOnly={settings.certificateAuthority !== "custom"} disabled={controlsDisabled} onChange={(event) => update("acmeServer", event.target.value)} placeholder="https://ca.example.com/acme/directory" />
                    <small className="proxy-help">Use the HTTPS ACME directory URL provided by your CA. It must support DNS-01, HTTP-01 and wildcard certificates.</small>
                  </div>
                  {settings.certificateAuthority === "custom" ? <label className="proxy-eab-toggle proxy-field-wide">
                    <input type="checkbox" checked={settings.acmeEab} disabled={controlsDisabled} onChange={(event) => update("acmeEab", event.target.checked)} />
                    This CA requires External Account Binding (EAB).
                  </label> : null}
                </div>
                {settings.acmeEab ? <p className="proxy-alert info">Set the EAB key ID and HMAC key in the server’s .env file using <code>ACME_EAB_KID</code> and <code>ACME_EAB_HMAC</code>.</p> : null}
                <div className="proxy-ca-facts">
                  <div><strong>Application domains</strong><small>DNS-01 · Cloudflare<br />Issues wildcard certificates for application domains.<br />Server environment variable: <code>CF_DNS_API_TOKEN</code></small></div>
                  <div><strong>Custom domains</strong><small>HTTP-01 · HTTP entrypoint <code>web</code><br />The domain must point to this server, and port 80 must be publicly accessible.</small></div>
                </div>
              </div>
            ) : settings.mode === "external" ? (
              <div className="proxy-certificate-panel">
                <h4>Existing certificate settings</h4>
                <p className="proxy-help">The existing Traefik manages the CA and validation methods. Use the identifiers below to select its certificate resolvers.</p>
                <div className="proxy-ca-facts">
                  <div><strong>Application domains</strong><small>{resolverDescription(settings.certificateResolver)}</small></div>
                  <div><strong>Custom domains</strong><small>{resolverDescription(settings.customCertificateResolver)}</small></div>
                </div>
                <p className="proxy-help">Only public settings detected in container arguments and environment variables are shown. Settings defined only in static files cannot be verified here.</p>
              </div>
            ) : <p className="proxy-help">Development mode uses HTTP and does not request ACME certificates.</p>}

            <fieldset className="proxy-identifiers" aria-describedby="proxy-identifiers-help">
              <legend>Identifiers</legend>
              <p className="proxy-help" id="proxy-identifiers-help">{settings.mode === "managed"
                ? "These names identify settings in the new Traefik configuration. The certificate issuance settings determine the CA and validation methods."
                : "Enter the names already defined in your Traefik configuration. They must match exactly."}</p>
              <div className="proxy-form-grid">

              <div className="proxy-field">
                <label htmlFor="proxy-entrypoint">Routing entrypoint</label>
                <input id="proxy-entrypoint" type="text" list="proxy-entrypoint-options" value={settings.entrypoint} disabled={controlsDisabled} onChange={(event) => update("entrypoint", event.target.value)} placeholder={data.environment.devMode ? "web" : "websecure"} />
                <datalist id="proxy-entrypoint-options">{selectedContainer?.entrypoints.map((value) => <option key={value} value={value} />)}</datalist>
                <small className="proxy-help">{settings.mode === "managed" && !data.environment.devMode
                  ? <>Names the HTTPS entrypoint on port 443. <code>web</code> is reserved for HTTP-01 on port 80.</>
                  : <>Used by application routes. Production commonly uses <code>websecure</code>; development uses HTTP <code>web</code>.</>}</small>
              </div>
              <div className="proxy-field">
                <label htmlFor="proxy-resolver">Application certificate resolver</label>
                <input id="proxy-resolver" type="text" list="proxy-resolver-options" value={settings.certificateResolver} disabled={controlsDisabled} onChange={(event) => update("certificateResolver", event.target.value)} placeholder="letsencrypt" />
                <datalist id="proxy-resolver-options">{selectedContainer?.resolvers.map((value) => <option key={value} value={value} />)}</datalist>
                <small className="proxy-help">{settings.mode === "managed" && !data.environment.devMode
                  ? "Names the DNS-01 certificate resolver for application domains."
                  : "Used for application hostnames, including the wildcard app certificate. Leave blank only when another certificate source is configured or in development."}</small>
              </div>
              <div className="proxy-field proxy-field-wide">
                <label htmlFor="proxy-custom-resolver">Custom-domain certificate resolver</label>
                <input id="proxy-custom-resolver" type="text" list="proxy-custom-resolver-options" value={settings.customCertificateResolver} disabled={controlsDisabled} onChange={(event) => update("customCertificateResolver", event.target.value)} placeholder="letsencrypt-http" />
                <datalist id="proxy-custom-resolver-options">{selectedContainer?.resolvers.map((value) => <option key={value} value={value} />)}</datalist>
                <small className="proxy-help">{settings.mode === "managed" && !data.environment.devMode
                  ? "Names the HTTP-01 certificate resolver for custom domains. Use a different name from the application resolver."
                  : "Used for customer-owned domains and their certificate challenge."}</small>
              </div>
              </div>
            </fieldset>

            {data.environment ? (
              <div className="proxy-environment">
                <h4>Platform environment</h4>
                <dl>
                  <div><dt>Base domain</dt><dd>{data.environment.domain}</dd></div>
                  <div><dt>Saved application network</dt><dd>{data.environment.network}</dd></div>
                  <div><dt>Portal container</dt><dd>{data.environment.portalContainer}</dd></div>
                  <div><dt>Portal internal port</dt><dd>{data.environment.portalPort}</dd></div>
                  <div><dt>Dynamic config directory</dt><dd>{data.environment.dynamicDirectory}</dd></div>
                </dl>
                <p className="proxy-help">The server operator configures the portal’s address, reverse proxy and HTTPS. This page manages application routing only.</p>
                <p className="proxy-help">The base domain and portal listener come from the server environment. The application network is selected above.</p>
                {discovery && discoveredNetworks.length > 0 && !discoveredNetworks.includes(data.environment.network) ? (
                  <p className="proxy-alert info" role="status">{settings.mode === "external" ? "This application network will be created when you save and connect." : "Create this application network before starting the dedicated proxy."}</p>
                ) : null}
              </div>
            ) : null}

            <div className="proxy-actions">
              <button type="button" className="ghost-btn" onClick={checkConnection} disabled={checking || saving || loading}>
                {checking ? "Checking…" : "Check connection"}
              </button>
              <button type="button" className="primary-btn" onClick={save} disabled={(!dirty && data.configured && !data.loadError && settings.mode !== "external") || saving || checking || loading}>
                {saving ? "Applying…" : settings.mode === "external" ? "Save and connect" : "Save configuration"}
              </button>
            </div>
            {dirty || !data.configured ? (
              <p className="proxy-alert info" role="note">Save these settings to use them for application deployments. A draft check does not change the running proxy or applications.</p>
            ) : null}
          </section>

          {data.dependency ? (
            <section className="panel detail-panel" aria-labelledby="proxy-status-heading">
              <h3 id="proxy-status-heading">Proxy status · {data.settings.container}</h3>
              <p>{data.dependency.running === true ? "Running" : data.dependency.running === false ? "Stopped" : "Status unavailable"} · {data.dependency.status === "ready" ? "Available" : "Needs attention"}</p>
              <p role="status">{data.dependency.detail}</p>
              <p className="proxy-help">Checked {new Date(data.dependency.checkedAt).toLocaleString("en-US")}</p>
            </section>
          ) : null}

          {data.lastCheck ? (
            <section className="panel detail-panel proxy-check-panel" aria-labelledby="proxy-check-heading">
              <div className="panel-head">
                <div><h3 id="proxy-check-heading">Connection check</h3><p className="proxy-help">Checked {new Date(data.lastCheck.checkedAt).toLocaleString("en-US")}</p></div>
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
              <p className="proxy-help">The portal adds and maintains only the application network connection. Existing proxy names, images, infrastructure networks and certificate settings are preserved. Check connection is read-only.</p>
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
