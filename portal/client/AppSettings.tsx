import { useCallback, useEffect, useState } from "react";
import { api, errorMessage, json } from "./api";
import {
  appPath,
  type AppInfo,
  type BuildConfig,
  type RuntimeConfig,
  type Notice,
} from "./types";
import {
  BuildFields,
  RuntimeFields,
  buildPayload,
  runtimePayload,
} from "./configuration";
import { ErrorText } from "./ui";

type Pending = {
  pendingConfigChanges?: { build: boolean; runtime: boolean };
  redeployRequired?: boolean;
};
function useSetting<T>(path: string, field: string, initial: T) {
  const [value, setValue] = useState<T>(initial);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState<Pending>({});
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setError("");
    api<Record<string, T> & Pending>(path, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setValue(data[field]);
        setStatus(data);
        setLoaded(true);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    return () => controller.abort();
  }, [path, field, reload]);
  return {
    value,
    setValue,
    loaded,
    busy,
    setBusy,
    error,
    setError,
    status,
    setStatus,
    retry: () => setReload((n) => n + 1),
  };
}
export function AppSettings({
  app,
  notify,
  onChanged,
  onJob,
  keepData,
  setKeepData,
}: {
  app: AppInfo;
  notify: Notice;
  onChanged: () => Promise<void>;
  onJob: () => Promise<void>;
  keepData: boolean;
  setKeepData: (value: boolean) => void;
}) {
  const path = appPath(app.userid, app.appname);
  const env = useSetting(`${path}/env`, "env", "");
  const build = useSetting<BuildConfig>(`${path}/build`, "build", {
    mode: "auto",
  });
  const runtime = useSetting<RuntimeConfig>(`${path}/runtime`, "runtime", {
    mode: "single",
  });
  const loadFiles = useCallback(
    async (signal: AbortSignal) =>
      (await api<{ files: string[] }>(`${path}/dockerfiles`, { signal })).files,
    [path],
  );
  // 배경의 상태 갱신은 경고만 동기화하고 편집 중인 입력은 보존한다.
  useEffect(() => {
    if (app.pendingConfigChanges) {
      build.setStatus({ pendingConfigChanges: app.pendingConfigChanges });
      runtime.setStatus({ pendingConfigChanges: app.pendingConfigChanges });
    }
  }, [app.pendingConfigChanges]);
  async function saveEnv() {
    env.setBusy(true);
    env.setError("");
    try {
      await api(`${path}/env`, json("PUT", { env: env.value }));
      notify("Environment variables saved. Restart is in progress.", "success");
      await onJob();
    } catch (e) {
      env.setError(errorMessage(e));
    } finally {
      env.setBusy(false);
    }
  }
  async function saveConfig(kind: "build" | "runtime") {
    const setting = kind === "build" ? build : runtime;
    setting.setBusy(true);
    setting.setError("");
    try {
      const value =
        kind === "build"
          ? buildPayload(build.value)
          : runtimePayload(runtime.value);
      const data = await api<Pending>(
        `${path}/${kind}`,
        json("PUT", { [kind]: value }),
      );
      setting.setStatus(data);
      notify(
        `${kind === "build" ? "Build" : "Runtime"} settings saved.`,
        "success",
      );
      await onChanged();
    } catch (e) {
      setting.setError(errorMessage(e));
    } finally {
      setting.setBusy(false);
    }
  }
  return (
    <section id="detail-panel-settings" className="panel detail-panel">
      <section aria-labelledby="detail-env-title">
        <h4 id="detail-env-title">Environment Variables</h4>
        <p className="env-help">
          One KEY=value per line. Saving restarts this app with the updated
          environment.
        </p>
        <textarea
          id="detail-env-textarea"
          className="env-textarea"
          rows={10}
          spellCheck={false}
          value={env.value}
          disabled={!env.loaded || env.busy}
          onChange={(e) => env.setValue(e.target.value)}
          aria-label="Environment Variables"
        />
        <ErrorText id="detail-env-error" message={env.error} />
        {!env.loaded && env.error && (
          <button type="button" className="ghost-btn" onClick={env.retry}>
            Retry loading
          </button>
        )}
        <div className="env-actions">
          <button
            id="detail-env-save-btn"
            className="primary-btn env-save-btn"
            type="button"
            disabled={!env.loaded || env.busy}
            onClick={saveEnv}
          >
            {env.busy ? "Saving…" : "Save and Restart"}
          </button>
        </div>
      </section>
      <div className="settings-separator" />
      <section
        className="settings-runtime"
        aria-labelledby="detail-runtime-title"
      >
        <h4 id="detail-runtime-title">Runtime configuration</h4>
        <p className="env-help">Changes are saved for the next redeployment.</p>
        <RuntimeFields
          prefix="detail-runtime"
          value={runtime.value}
          onChange={runtime.setValue}
          disabled={!runtime.loaded || runtime.busy}
        />
        <ErrorText id="detail-runtime-error" message={runtime.error} />
        {!runtime.loaded && runtime.error && (
          <button type="button" className="ghost-btn" onClick={runtime.retry}>
            Retry loading
          </button>
        )}
        <div className="env-actions">
          <button
            id="detail-runtime-save-btn"
            className="primary-btn env-save-btn"
            type="button"
            disabled={!runtime.loaded || runtime.busy}
            onClick={() => saveConfig("runtime")}
          >
            {runtime.busy ? "Saving…" : "Save runtime settings"}
          </button>
        </div>
        {runtime.status.pendingConfigChanges?.runtime && (
          <p
            id="detail-runtime-redeploy-warning"
            className="config-redeploy-warning"
            role="status"
          >
            Runtime configuration has changed. Redeploy this app to apply it.
          </p>
        )}
      </section>
      <div className="settings-separator" />
      <section className="settings-build" aria-labelledby="detail-build-title">
        <h4 id="detail-build-title">Build configuration</h4>
        <p className="env-help">
          Choose how this app is built. Changes are saved for the next
          redeployment.
        </p>
        <BuildFields
          prefix="detail-build"
          value={build.value}
          onChange={build.setValue}
          loadFiles={loadFiles}
          disabled={!build.loaded || build.busy}
        />
        <ErrorText id="detail-build-error" message={build.error} />
        {!build.loaded && build.error && (
          <button type="button" className="ghost-btn" onClick={build.retry}>
            Retry loading
          </button>
        )}
        <div className="env-actions">
          <button
            id="detail-build-save-btn"
            className="primary-btn env-save-btn"
            type="button"
            disabled={!build.loaded || build.busy}
            onClick={() => saveConfig("build")}
          >
            {build.busy ? "Saving…" : "Save build settings"}
          </button>
        </div>
        {build.status.pendingConfigChanges?.build && (
          <p
            id="detail-build-redeploy-warning"
            className="config-redeploy-warning"
            role="status"
          >
            Build configuration has changed. Redeploy this app to apply it.
          </p>
        )}
      </section>
      <div className="settings-separator" />
      <div className="settings-danger-zone">
        <h4 className="settings-danger-title">Deletion Options</h4>
        <label className="checkbox-row">
          <input
            id="keep-data-input"
            type="checkbox"
            checked={keepData}
            onChange={(e) => setKeepData(e.target.checked)}
          />
          <span>Keep the data folder when deleting the app</span>
        </label>
      </div>
    </section>
  );
}
