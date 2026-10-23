import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { api, errorMessage } from "./api";
import {
  appPath,
  isActiveJob,
  type AppInfo,
  type Job,
  type Notice,
  type PortalConfig,
  type User,
} from "./types";
import { Icon, ErrorText } from "./ui";
import { Jobs } from "./jobs";
import { PasswordSettings, UsersPage, PortalLogs } from "./account";
import { AppCard } from "./AppCards";
import { AppLogs } from "./AppLogs";
import { AppSettings } from "./AppSettings";
import { CreateApp } from "./CreateApp";
import { Domains } from "./Domains";
import { ProxySettings } from "./ProxySettings";

const AppExec = lazy(() =>
  import("./AppExec").then((module) => ({ default: module.AppExec })),
);

// 수동 갱신과 주기 갱신이 겹쳐도 마지막 요청만 상태를 변경한다.
function useResource<T>(
  path: string,
  initial: T,
  interval: number,
  enabled = true,
) {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (!enabled) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await api<T>(path, { signal: controller.signal });
      if (!controller.signal.aborted) {
        setData(result);
        setError("");
        setLoading(false);
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(errorMessage(e));
        setLoading(false);
      }
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [path, enabled]);
  useEffect(() => {
    setLoading(true);
    setError("");
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden && !request.current) void refresh();
    }, interval);
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      request.current?.abort();
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh, interval]);
  return { data, loading, error, refresh };
}
function useTheme() {
  const [theme, setTheme] = useState(
    document.documentElement.dataset.theme === "dark" ? "dark" : "light",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("paas-theme", theme);
    } catch {
      /* 저장소가 제한되어도 현재 테마를 유지한다. */
    }
  }, [theme]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === "paas-theme" || event.key === null)
        setTheme(event.newValue === "dark" ? "dark" : "light");
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  return {
    theme,
    toggle: () => setTheme((value) => (value === "light" ? "dark" : "light")),
  };
}

export function Portal({
  user,
  config,
  onUser,
  onLogout,
}: {
  user: User;
  config: PortalConfig;
  onUser: (user: User) => void;
  onLogout: () => Promise<void>;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [mobile, setMobile] = useState(false);
  const [settings, setSettings] = useState(user.mustChangePassword);
  const [notice, setNotice] = useState<{
    message: string;
    kind: string;
  } | null>(null);
  const notify: Notice = useCallback(
    (message, kind = "info") => setNotice({ message, kind }),
    [],
  );
  const { theme, toggle } = useTheme();
  const allowed = !user.mustChangePassword;
  const proxySetupRedirected = useRef(false);
  useEffect(() => {
    if (user.role !== "admin" || !allowed || proxySetupRedirected.current)
      return;
    const controller = new AbortController();
    api<{ configured: boolean }>("/admin/proxy", { signal: controller.signal })
      .then(({ configured }) => {
        if (controller.signal.aborted) return;
        proxySetupRedirected.current = true;
        if (!configured) navigate("/admin/proxy", { replace: true });
      })
      .catch(() => {
        // 설정 상태 조회가 실패해도 기존 관리 화면을 사용할 수 있게 둔다.
      });
    return () => controller.abort();
  }, [allowed, navigate, user.role]);
  const apps = useResource<{ apps: AppInfo[]; hasLabelErrors?: boolean }>(
    "/apps",
    { apps: [] },
    5000,
    allowed,
  );
  const [jobs, setJobs] = useState<Job[]>([]);
  const jobResource = useResource<{ jobs: Job[] }>(
    "/jobs",
    { jobs: [] },
    jobs.some(isActiveJob) ? 1500 : 5000,
    allowed,
  );
  const previousJobs = useRef<Job[]>([]);
  useEffect(() => {
    setJobs(jobResource.data.jobs);
    if (
      previousJobs.current.some(
        (old) =>
          isActiveJob(old) &&
          !jobResource.data.jobs.some(
            (job) => job.id === old.id && isActiveJob(job),
          ),
      )
    )
      void apps.refresh();
    previousJobs.current = jobResource.data.jobs;
  }, [jobResource.data, apps.refresh]);
  useEffect(() => {
    setMobile(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!mobile) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobile(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [mobile]);
  const onJob = useCallback(async () => {
    await Promise.all([jobResource.refresh(), apps.refresh()]);
  }, [jobResource.refresh, apps.refresh]);
  const links = [
    ["/dashboard", "Dashboard"],
    ["/create", "Create App"],
    ...(user.role === "admin" && allowed
      ? [
          ["/admin", "Admin Dashboard"],
          ["/admin/proxy", "Proxy Setup"],
          ["/users", "User Management"],
        ]
      : []),
  ];
  return (
    <>
      <header id="gnb" className="gnb" aria-label="Main navigation">
        <div className="gnb-left">
          <Link
            className="gnb-brand"
            to="/dashboard"
            aria-label="Hyunbbai Portal"
          >
            <span className="gnb-logo" aria-hidden="true">
              P
            </span>
            <span className="gnb-brand-text">
              <span className="eyebrow">Hyunbbai</span>
              <strong>Portal</strong>
            </span>
          </Link>
          <nav
            id="main-navigation"
            className={`gnb-nav${mobile ? " open" : ""}`}
          >
            {links.map(([path, label]) => (
              <NavLink
                key={path}
                className={({ isActive }) =>
                  `gnb-item${isActive || (path === "/dashboard" && location.pathname.startsWith("/apps/")) ? " active" : ""}`
                }
                to={path}
                end
              >
                <span>{label}</span>
              </NavLink>
            ))}
          </nav>
          <button
            id="mobile-menu-btn"
            className="icon-btn gnb-hamburger"
            type="button"
            aria-label="Menu"
            aria-expanded={mobile}
            aria-controls="main-navigation"
            onClick={() => setMobile((value) => !value)}
          >
            <Icon name="menu" />
          </button>
        </div>
        <div className="gnb-right">
          {config.devMode && (
            <span id="dev-mode-badge" className="dev-mode-badge">
              DEV
            </span>
          )}
          <p id="auth-state" className="auth-state">
            {user.username} ({user.role})
          </p>
          {allowed && (
            <Jobs jobs={jobs} refresh={jobResource.refresh} notify={notify} />
          )}
          <button
            id="settings-btn"
            className="icon-btn"
            type="button"
            aria-label="Settings"
            onClick={() => setSettings(true)}
          >
            <Icon name="settings" />
          </button>
          <button
            id="theme-toggle-btn"
            className="icon-btn"
            type="button"
            aria-label="Dark theme"
            aria-pressed={theme === "dark"}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            onClick={toggle}
          >
            <Icon name={theme === "dark" ? "sun" : "moon"} />
          </button>
          <button
            id="logout-btn"
            className="ghost-btn gnb-logout-btn"
            type="button"
            aria-label="Log out"
            onClick={() =>
              onLogout().catch((e) => notify(errorMessage(e), "error"))
            }
          >
            <span className="gnb-logout-label">Log Out</span>
            <svg
              className="gnb-logout-icon"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M10 17v3H4V4h6v3h2V2H2v20h10v-5h-2zm6.59-10.59L15.17 7.83 18.34 11H8v2h10.34l-3.17 3.17 1.42 1.42L22.17 12l-5.58-5.59Z" />
            </svg>
          </button>
        </div>
      </header>
      <div
        id="gnb-mobile-overlay"
        className={`gnb-mobile-overlay${mobile ? " open" : ""}`}
        onClick={() => setMobile(false)}
      />
      <div className="app-layout">
        <main className="main-content">
          {notice && (
            <p
              id="status-banner"
              className={`status-banner ${notice.kind}`}
              role="status"
            >
              {notice.message}
            </p>
          )}
          <ErrorText message={apps.error || jobResource.error} />
          {apps.data.hasLabelErrors && (
            <p className="status-banner error">
              Some containers have invalid labels. Check portal logs.
            </p>
          )}
          {!allowed ? (
            <p className="status-banner info">
              Change your password in Settings to manage apps.
            </p>
          ) : (
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route
                path="/index.html"
                element={<Navigate to="/dashboard" replace />}
              />
              <Route
                path="/dashboard"
                element={
                  <section id="view-dashboard" className="view-section">
                    <header className="view-header dashboard-heading">
                      <div>
                        <h2>Dashboard</h2>
                        <p className="view-subtitle">
                          Manage your applications and deployments.
                        </p>
                      </div>
                      <Link
                        className="primary-btn dashboard-create-btn"
                        to="/create"
                      >
                        <span aria-hidden="true">+</span> New App
                      </Link>
                    </header>
                    <div className="dashboard-stats">
                      <div className="chip">
                        <span className="chip-label">DOMAIN</span>
                        <strong id="domain-chip">{config.appsDomain}</strong>
                      </div>
                      <div className="chip">
                        <span className="chip-label">Limit</span>
                        <strong id="limit-chip">
                          {config.limits.maxAppsPerUser}/
                          {config.limits.maxTotalApps}
                        </strong>
                      </div>
                      <div className="chip">
                        <span className="chip-label">Apps</span>
                        <strong id="app-count-chip">
                          {apps.data.apps.length}
                        </strong>
                      </div>
                    </div>
                    <section className="panel app-panel">
                      <div className="panel-head">
                        <h3>Deployed Apps</h3>
                        <button
                          id="refresh-btn"
                          type="button"
                          className="ghost-btn"
                          onClick={apps.refresh}
                        >
                          Refresh
                        </button>
                      </div>
                      {apps.loading ? (
                        <p>Loading apps…</p>
                      ) : (
                        !apps.data.apps.length && (
                          <p id="empty-state" className="empty-state">
                            No apps yet. Create an app to get started.
                          </p>
                        )
                      )}
                      <div id="apps-container" className="apps-container">
                        {apps.data.apps.map((app) => (
                          <AppCard
                            key={`${app.userid}/${app.appname}`}
                            app={app}
                            config={config}
                            notify={notify}
                            onJob={onJob}
                          />
                        ))}
                      </div>
                    </section>
                  </section>
                }
              />
              <Route
                path="/create"
                element={
                  <CreateApp
                    user={user}
                    config={config}
                    notify={notify}
                    onJob={onJob}
                  />
                }
              />
              <Route
                path="/apps/:userid/:appname"
                element={
                  <DetailRoute config={config} notify={notify} onJob={onJob} />
                }
              />
              <Route
                path="/users"
                element={
                  user.role === "admin" ? (
                    <UsersPage notify={notify} />
                  ) : (
                    <Navigate to="/dashboard" replace />
                  )
                }
              />
              <Route
                path="/admin"
                element={
                  user.role === "admin" ? (
                    <AdminPage config={config} notify={notify} onJob={onJob} />
                  ) : (
                    <Navigate to="/dashboard" replace />
                  )
                }
              />
              <Route
                path="/admin/proxy"
                element={
                  user.role === "admin" ? (
                    <ProxySettings />
                  ) : (
                    <Navigate to="/dashboard" replace />
                  )
                }
              />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          )}
          <div id="job-indicator-slot" />
        </main>
      </div>
      {settings && (
        <PasswordSettings
          user={user}
          onClose={() => setSettings(false)}
          onUpdated={(updated) => {
            onUser(updated);
            notify("Password changed.", "success");
          }}
        />
      )}
    </>
  );
}
function DetailRoute(props: {
  config: PortalConfig;
  notify: Notice;
  onJob: () => Promise<void>;
}) {
  const { userid = "", appname = "" } = useParams();
  return (
    <AppDetail
      key={`${userid}/${appname}`}
      userid={userid}
      appname={appname}
      {...props}
    />
  );
}
function AppDetail({
  userid,
  appname,
  config,
  notify,
  onJob,
}: {
  userid: string;
  appname: string;
  config: PortalConfig;
  notify: Notice;
  onJob: () => Promise<void>;
}) {
  const [tab, setTab] = useState("logs");
  const [settingsVisited, setSettingsVisited] = useState(false);
  const [keepData, setKeepData] = useState(false);
  const app = useResource<{ app: AppInfo | null }>(
    appPath(userid, appname),
    { app: null },
    5000,
  );
  return (
    <section id="view-app-detail" className="view-section">
      <nav className="app-detail-gnb" aria-label="App navigation">
        <div className="app-detail-gnb-left">
          <Link id="app-detail-back-btn" className="ghost-btn" to="/dashboard">
            ← Dashboard
          </Link>
          <span id="app-detail-appname" className="app-detail-appname">
            {userid} / {appname}
          </span>
        </div>
        <div className="app-detail-tabs" role="tablist" aria-label="App tabs">
          {["logs", "exec", "domains", "settings"].map((name) => (
            <button
              key={name}
              id={`detail-tab-btn-${name}`}
              className={`detail-tab-btn${tab === name ? " active" : ""}`}
              data-detail-tab={name}
              role="tab"
              aria-selected={tab === name}
              aria-controls={`detail-panel-${name}`}
              type="button"
              onClick={() => {
                setTab(name);
                if (name === "settings") setSettingsVisited(true);
              }}
            >
              {name[0].toUpperCase() + name.slice(1)}
            </button>
          ))}
        </div>
      </nav>
      <ErrorText message={app.error} />
      {app.error && (
        <button type="button" className="ghost-btn" onClick={app.refresh}>
          Retry
        </button>
      )}
      {app.loading ? (
        <p>Loading app…</p>
      ) : (
        app.data.app && (
          <>
            {tab === "logs" && (
              <AppLogs
                userid={userid}
                appname={appname}
                services={app.data.app.services}
              />
            )}
            {tab === "exec" && (
              <Suspense fallback={<p>Loading terminal…</p>}>
                <AppExec
                  userid={userid}
                  appname={appname}
                  services={app.data.app.services}
                  primaryService={app.data.app.primaryService}
                />
              </Suspense>
            )}
            {tab === "domains" && (
              <Domains userid={userid} appname={appname} notify={notify} />
            )}
            {settingsVisited && (
              <div hidden={tab !== "settings"}>
                <AppSettings
                  app={app.data.app}
                  notify={notify}
                  onChanged={app.refresh}
                  onJob={onJob}
                  keepData={keepData}
                  setKeepData={setKeepData}
                />
                <AppCard
                  app={app.data.app}
                  config={config}
                  notify={notify}
                  onJob={onJob}
                  keepData={keepData}
                />
              </div>
            )}
          </>
        )
      )}
    </section>
  );
}
function AdminPage({
  config,
  notify,
  onJob,
}: {
  config: PortalConfig;
  notify: Notice;
  onJob: () => Promise<void>;
}) {
  const [tab, setTab] = useState("apps");
  const apps = useResource<{ apps: AppInfo[] }>(
    "/apps?all=true",
    { apps: [] },
    5000,
    tab === "apps",
  );
  return (
    <section id="view-admin-dashboard" className="view-section">
      <nav className="app-detail-gnb" aria-label="Admin dashboard navigation">
        <strong>Admin Dashboard</strong>
        <div className="app-detail-tabs" role="tablist">
          {["apps", "logs"].map((name) => (
            <button
              key={name}
              className={`detail-tab-btn${tab === name ? " active" : ""}`}
              data-admin-tab={name}
              role="tab"
              aria-selected={tab === name}
              type="button"
              onClick={() => setTab(name)}
            >
              {name === "apps" ? "Apps" : "Logs"}
            </button>
          ))}
        </div>
      </nav>
      {tab === "logs" ? (
        <PortalLogs />
      ) : (
        <section id="admin-panel-apps" className="panel detail-panel">
          <div className="panel-head">
            <h3>All Apps</h3>
            <button
              id="admin-refresh-apps-btn"
              className="ghost-btn"
              type="button"
              onClick={apps.refresh}
            >
              Refresh
            </button>
          </div>
          <ErrorText message={apps.error} />
          {apps.loading ? (
            <p>Loading apps…</p>
          ) : (
            !apps.data.apps.length && (
              <p className="empty-state">No apps found.</p>
            )
          )}
          <div id="admin-apps-container" className="apps-container">
            {apps.data.apps.map((app) => (
              <AppCard
                key={`${app.userid}/${app.appname}`}
                app={app}
                config={config}
                notify={notify}
                onJob={onJob}
              />
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
