import { Link, useNavigate, useLocation } from "react-router-dom";
import { api, errorMessage, json } from "./api";
import { appPath, type AppInfo, type PortalConfig, type Notice } from "./types";
import { formatDate, Icon } from "./ui";
import { useRequestScope } from "./hooks";
import { useState } from "react";

export function AppCard({
  app,
  config,
  notify,
  onJob,
  keepData = false,
}: {
  app: AppInfo;
  config: PortalConfig;
  notify: Notice;
  onJob: () => Promise<void>;
  keepData?: boolean;
}) {
  const scope = useRequestScope();
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const path = appPath(app.userid, app.appname);
  const dependencies = app.detectedRuntime?.dependencies?.length
    ? app.detectedRuntime.dependencies
    : app.detectedRuntime?.name
      ? [app.detectedRuntime]
      : [];
  async function action(kind: string) {
    const signal = scope.current.signal;
    if (
      kind === "delete" &&
      !window.confirm(
        `Delete ${app.userid}/${app.appname}?${keepData ? " The data folder will be kept." : " App data will be removed."}`,
      )
    )
      return;
    setBusy(true);
    try {
      await api(kind === "delete" ? path : `${path}/${kind}`, {
        ...json(
          kind === "delete" ? "DELETE" : "POST",
          kind === "delete" ? { keepData } : undefined,
        ),
        signal,
      });
      if (signal.aborted) return;
      notify(
        `${kind === "delete" ? "Deletion" : kind[0].toUpperCase() + kind.slice(1)} started. Check Jobs for progress.`,
        "success",
      );
      if (kind === "delete" && location.pathname === path)
        navigate("/dashboard");
      await onJob();
    } catch (e) {
      if (!signal.aborted) notify(errorMessage(e), "error");
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  return (
    <article
      className="app-card"
      data-userid={app.userid}
      data-appname={app.appname}
    >
      <div className="app-card-head">
        <div className="app-card-title-row">
          <Link className="app-name-btn" data-action="manage" to={path}>
            {app.userid} / {app.appname}
          </Link>
          <span className={`status-pill status-${app.status}`}>
            {app.status}
          </span>
          <Link
            className="action-btn app-manage-btn"
            data-action="manage"
            to={path}
            title="App settings"
            aria-label={`App settings for ${app.userid} / ${app.appname}`}
          >
            <Icon name="settings" />
          </Link>
        </div>
        <div className="app-card-badges">
          {dependencies.map((dep, index) => (
            <span
              key={`${dep.name}-${index}`}
              className={`runtime-badge ${dep.icon || dep.name || ""}`}
            >
              {dep.displayName || dep.name}
            </span>
          ))}
        </div>
      </div>
      <p className="app-domain">
        {app.domain ? (
          <a
            href={
              config.devMode && config.traefikPort
                ? `http://${app.domain}:${config.traefikPort}`
                : `https://${app.domain}`
            }
            target="_blank"
            rel="noreferrer"
          >
            {app.domain}
          </a>
        ) : (
          "-"
        )}
        {app.activeCustomDomains?.map((domain) => (
          <span key={domain.domain}>
            ,{" "}
            <a
              href={`https://${domain.domain}`}
              target="_blank"
              rel="noreferrer"
            >
              {domain.domain}
            </a>
          </span>
        ))}
      </p>
      <p className="app-meta">
        repo: {app.repoUrl || "-"} | branch: {app.branch || "main"} | created:{" "}
        {formatDate(app.createdAt)}
      </p>
      {app.redeployRequired && (
        <p className="config-redeploy-warning" role="status">
          Configuration changes are saved. Redeploy this app to apply them.
        </p>
      )}
      {!!app.services?.length && (
        <ul className="app-service-list" aria-label="Service status">
          {app.services.map((service) => (
            <li key={service.name}>
              <span className="app-service-name">
                {service.name}
                {service.kind === "init" ? " · init" : ""}
              </span>
              <span className={`status-pill status-${service.status}`}>
                {service.status}
              </span>
              {service.health && service.health !== "healthy" && (
                <span className="app-service-meta">
                  health: {service.health}
                </span>
              )}
              {service.exitCode != null &&
                service.exitCode !== 0 &&
                service.status !== "running" && (
                  <span className="app-service-meta">
                    exit {service.exitCode}
                  </span>
                )}
            </li>
          ))}
        </ul>
      )}
      <div className="app-actions">
        {["start", "stop", "deploy", "delete"].map((kind) => (
          <button
            key={kind}
            className={`action-btn${kind === "delete" ? " danger" : ""}`}
            data-action={kind}
            type="button"
            disabled={busy}
            onClick={() => action(kind)}
          >
            {kind[0].toUpperCase() + kind.slice(1)}
          </button>
        ))}
      </div>
    </article>
  );
}
