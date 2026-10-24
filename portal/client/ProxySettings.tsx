import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
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

  function selectContainer(value: string) {
    update("container", value);
    const candidate = discovery?.containers.find((item) => item.name === value || item.id === value);
    if (!candidate || settings?.mode !== "external") return;
    const networks = candidate.networks.filter((name) => !["bridge", "host", "none", "paas-buildkit-net"].includes(name)) || [];
    setSettings((current) => current ? { ...current, network: networks.includes(current.network) ? current.network : networks.length === 1 ? networks[0] : "" } : current);
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
      if (result.loadError) return;
      setMessage(
        settings.mode === "managed" && !data.environment.devMode
          ? "Configuration saved and the dedicated Traefik Compose file generated. Follow the connection guide to start or update the proxy. Redeploy existing apps to update their proxy routes."
          : "Configuration saved. New deployments connect web services to the selected proxy network. Redeploy existing apps to apply changes; workers and databases stay on their private networks.",
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
    if (!name) return "Resolver 미지정 · 인증서는 Traefik의 다른 인증서 소스로 제공해야 합니다.";
    const detail = selectedContainer?.resolverDetails?.find((item) => item.name === name.toLowerCase());
    if (!detail) return "설정을 확인할 수 없습니다. Refresh discovery를 실행하고 기존 Traefik에 정의된 이름인지 확인하세요.";
    const authority = detail.caServer === caServers.letsencrypt ? "Let’s Encrypt"
      : detail.caServer === caServers.zerossl ? "ZeroSSL"
        : detail.caServer || "CA 확인 불가 · 미지정 시 기본 CA는 Let’s Encrypt";
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
                  onChange={() => switchMode("managed")}
                />
                <span><strong>Install a new Traefik</strong><small>새 프록시의 CA와 인증서 발급 방식을 설정합니다.</small></span>
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
                <span><strong>Use existing Traefik</strong><small>기존 프록시에 정의된 entrypoint와 resolver를 연결합니다.</small></span>
              </label>
            </div>

            <div className="proxy-form-grid">
              <div className="proxy-field proxy-field-wide">
                <label htmlFor="proxy-network">Application connection network</label>
                <input id="proxy-network" type="text" list="proxy-network-options" value={settings.network} onChange={(event) => update("network", event.target.value)} disabled={controlsDisabled} autoComplete="off" />
                <datalist id="proxy-network-options">{(selectedContainer?.networks || discoveredNetworks).map((name) => <option key={name} value={name} />)}</datalist>
                <small className="proxy-help">Choose a network already used by the proxy. Only application web services join it; the portal, workers and databases remain separate.</small>
              </div>

              <div className="proxy-field proxy-field-wide">
                <label htmlFor="proxy-container">Traefik container</label>
                {settings.mode === "external" && discovery && !manualContainer ? (
                  <select
                    id="proxy-container"
                    value={settings.container}
                    disabled={controlsDisabled}
                    onChange={(event) => selectContainer(event.target.value)}
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
                    onChange={(event) => selectContainer(event.target.value)}
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
                이미지: <code>{imageSource.image}</code> · {imageSource.container
                  ? `${imageSource.container} 컨테이너에서 자동 반영`
                  : "실행 중인 Traefik이 없어 서버 기본 이미지 사용"}
              </small> : selectedContainer ? <small className="proxy-help proxy-field-wide">이미지: <code>{selectedContainer.image}</code> · 기존 컨테이너의 이미지는 변경하지 않습니다.</small> : null}

            </div>

            {settings.mode === "managed" && !data.environment.devMode ? (
              <div className="proxy-certificate-panel">
                <h4>인증서 발급</h4>
                <p className="proxy-help">사용할 CA를 선택하세요. 선택한 CA와 검증 방식이 새 Traefik 구성에 반영됩니다.</p>
                <div className="proxy-form-grid">

                  <div className="proxy-field">
                    <label htmlFor="proxy-ca">Certificate authority</label>
                    <select id="proxy-ca" value={settings.certificateAuthority} disabled={controlsDisabled} onChange={(event) => changeAuthority(event.target.value as CertificateAuthority)}>
                      <option value="letsencrypt">Let’s Encrypt · 기본값</option>
                      <option value="zerossl">ZeroSSL · EAB 필요</option>
                      <option value="custom">사용자 지정 ACME CA</option>
                    </select>
                  </div>
                  <div className="proxy-field">
                    <label htmlFor="proxy-acme-email">ACME email</label>
                    <input id="proxy-acme-email" type="email" value={settings.acmeEmail} disabled={controlsDisabled} onChange={(event) => update("acmeEmail", event.target.value)} placeholder="admin@example.com" />
                    <small className="proxy-help">비워 두면 서버 .env의 ACME_EMAIL을 사용합니다.</small>
                  </div>
                  <div className="proxy-field proxy-field-wide">
                    <label htmlFor="proxy-acme-server">ACME directory URL</label>
                    <input id="proxy-acme-server" type="url" value={settings.acmeServer} readOnly={settings.certificateAuthority !== "custom"} disabled={controlsDisabled} onChange={(event) => update("acmeServer", event.target.value)} placeholder="https://ca.example.com/acme/directory" />
                    <small className="proxy-help">CA에서 제공하는 HTTPS ACME directory URL입니다. 해당 CA가 DNS-01·HTTP-01과 와일드카드 인증서를 지원해야 합니다.</small>
                  </div>
                  {settings.certificateAuthority === "custom" ? <label className="proxy-eab-toggle proxy-field-wide">
                    <input type="checkbox" checked={settings.acmeEab} disabled={controlsDisabled} onChange={(event) => update("acmeEab", event.target.checked)} />
                    이 CA는 EAB 계정 인증이 필요합니다.
                  </label> : null}
                </div>
                {settings.acmeEab ? <p className="proxy-alert info">EAB Key ID와 HMAC 키는 서버 .env의 <code>ACME_EAB_KID</code>, <code>ACME_EAB_HMAC</code>으로 제공합니다.</p> : null}
                <div className="proxy-ca-facts">
                  <div><strong>플랫폼·포털 도메인</strong><small>DNS-01 · Cloudflare<br />플랫폼 앱의 와일드카드 인증서를 발급합니다.<br />서버 환경변수: <code>CF_DNS_API_TOKEN</code></small></div>
                  <div><strong>사용자 커스텀 도메인</strong><small>HTTP-01 · HTTP entrypoint <code>web</code><br />도메인이 이 서버를 가리키고 외부에서 80번 포트에 접근할 수 있어야 합니다.</small></div>
                </div>
              </div>
            ) : settings.mode === "external" ? (
              <div className="proxy-certificate-panel">
                <h4>기존 인증서 설정</h4>
                <p className="proxy-help">CA와 검증 방식은 기존 Traefik에서 관리합니다. 아래 식별자로 참조할 resolver를 선택하세요.</p>
                <div className="proxy-ca-facts">
                  <div><strong>플랫폼·포털 도메인</strong><small>{resolverDescription(settings.certificateResolver)}</small></div>
                  <div><strong>사용자 커스텀 도메인</strong><small>{resolverDescription(settings.customCertificateResolver)}</small></div>
                </div>
                <p className="proxy-help">컨테이너 실행 인자와 환경변수에서 확인한 공개 설정만 표시합니다. 정적 파일 등에만 정의된 설정은 확인할 수 없습니다.</p>
              </div>
            ) : <p className="proxy-help">개발 모드에서는 HTTP를 사용하며 ACME 인증서를 발급하지 않습니다.</p>}

            <fieldset className="proxy-identifiers" aria-describedby="proxy-identifiers-help">
              <legend>식별자</legend>
              <p className="proxy-help" id="proxy-identifiers-help">{settings.mode === "managed"
                ? "새 Traefik 구성에 정의할 이름입니다. 이름은 설정을 식별하며, CA와 검증 방식은 인증서 발급 설정으로 결정됩니다."
                : "기존 Traefik 설정에 정의된 이름을 입력하세요. 이 이름으로 해당 설정을 참조하므로 기존 이름과 일치해야 합니다."}</p>
              <div className="proxy-form-grid">

              <div className="proxy-field">
                <label htmlFor="proxy-entrypoint">Routing entrypoint</label>
                <input id="proxy-entrypoint" type="text" list="proxy-entrypoint-options" value={settings.entrypoint} disabled={controlsDisabled} onChange={(event) => update("entrypoint", event.target.value)} placeholder={data.environment.devMode ? "web" : "websecure"} />
                <datalist id="proxy-entrypoint-options">{selectedContainer?.entrypoints.map((value) => <option key={value} value={value} />)}</datalist>
                <small className="proxy-help">{settings.mode === "managed" && !data.environment.devMode
                  ? <>HTTPS 443번 포트의 이름입니다. <code>web</code>은 HTTP-01용 80번 포트에 사용합니다.</>
                  : <>Used by application routes. Production commonly uses <code>websecure</code>; development uses HTTP <code>web</code>.</>}</small>
              </div>
              <div className="proxy-field">
                <label htmlFor="proxy-resolver">Application certificate resolver</label>
                <input id="proxy-resolver" type="text" list="proxy-resolver-options" value={settings.certificateResolver} disabled={controlsDisabled} onChange={(event) => update("certificateResolver", event.target.value)} placeholder="letsencrypt" />
                <datalist id="proxy-resolver-options">{selectedContainer?.resolvers.map((value) => <option key={value} value={value} />)}</datalist>
                <small className="proxy-help">{settings.mode === "managed" && !data.environment.devMode
                  ? "사용자 앱의 DNS-01 인증서 발급 설정 이름입니다."
                  : "Used for application hostnames, including the wildcard app certificate. Leave blank only when another certificate source is configured or in development."}</small>
              </div>
              <div className="proxy-field proxy-field-wide">
                <label htmlFor="proxy-custom-resolver">Custom-domain certificate resolver</label>
                <input id="proxy-custom-resolver" type="text" list="proxy-custom-resolver-options" value={settings.customCertificateResolver} disabled={controlsDisabled} onChange={(event) => update("customCertificateResolver", event.target.value)} placeholder="letsencrypt-http" />
                <datalist id="proxy-custom-resolver-options">{selectedContainer?.resolvers.map((value) => <option key={value} value={value} />)}</datalist>
                <small className="proxy-help">{settings.mode === "managed" && !data.environment.devMode
                  ? "사용자 커스텀 도메인의 HTTP-01 인증서 발급 설정 이름입니다. 플랫폼용 resolver와 다른 이름을 사용하세요."
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
              <p className="proxy-alert info" role="note">Save these settings to use them for application deployments. A draft check does not change the running proxy or applications.</p>
            ) : null}
          </section>

          {data.dependency ? (
            <section className="panel detail-panel" aria-labelledby="proxy-status-heading">
              <h3 id="proxy-status-heading">Proxy status · {data.settings.container}</h3>
              <p>{data.dependency.running === true ? "Running" : data.dependency.running === false ? "Stopped" : "Status unavailable"} · {data.dependency.status === "ready" ? "Available" : "Needs attention"}</p>
              <p role="status">{data.dependency.detail}</p>
              <p className="proxy-help">Checked {new Date(data.dependency.checkedAt).toLocaleString()}</p>
            </section>
          ) : null}

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
