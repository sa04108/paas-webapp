import { useEffect, useRef, useState } from "react";
import type { BuildConfig, RuntimeConfig } from "./types";
import { errorMessage } from "./api";
import { ErrorText } from "./ui";

const maxBytes = 65536;
const byteSize = (value: string) => new TextEncoder().encode(value).byteLength;
export function buildPayload(value: BuildConfig): BuildConfig {
  if (value.mode === "repository") {
    if (!value.dockerfile) throw new Error("Choose a root Dockerfile.");
    return { mode: value.mode, dockerfile: value.dockerfile };
  }
  if (value.mode === "custom") {
    const content = value.content || "";
    if (
      !content.trim() ||
      content.includes("\0") ||
      byteSize(content) > maxBytes
    )
      throw new Error(
        "Enter Dockerfile contents, up to 64 KiB, without NUL characters.",
      );
    return { mode: value.mode, content };
  }
  if (value.mode === "railpack") {
    const config = value.config || "";
    if (byteSize(config) > maxBytes)
      throw new Error("Railpack configuration must be 64 KiB or smaller.");
    if (config.trim()) {
      let parsed;
      try {
        parsed = JSON.parse(config);
      } catch {
        throw new Error("Enter valid JSON for the Railpack configuration.");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Railpack configuration must be a JSON object.");
    }
    return { mode: value.mode, config };
  }
  return { mode: "auto" };
}
export function runtimePayload(value: RuntimeConfig): RuntimeConfig {
  if (value.mode === "single") return { mode: "single" };
  const webService = value.webService?.trim() || "";
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(webService))
    throw new Error(
      "Enter a valid web service name (lowercase letters, numbers and hyphens).",
    );
  if (value.source === "repository") {
    const file = value.file?.trim() || "";
    if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(file) || file.length > 255)
      throw new Error(
        "Choose a root Compose filename ending in .yaml or .yml.",
      );
    return { mode: "compose", source: "repository", file, webService };
  }
  const content = value.content || "";
  if (!content.trim() || content.includes("\0") || byteSize(content) > maxBytes)
    throw new Error(
      "Enter Compose YAML, up to 64 KiB, without NUL characters.",
    );
  return { mode: "compose", source: "inline", content, webService };
}

export function BuildFields({
  value,
  onChange,
  loadFiles,
  prefix = "build",
  disabled = false,
}: {
  value: BuildConfig;
  onChange: (value: BuildConfig) => void;
  loadFiles: (signal: AbortSignal) => Promise<string[]>;
  prefix?: string;
  disabled?: boolean;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const currentValue = useRef(value);
  currentValue.current = value;
  const change = useRef(onChange);
  change.current = onChange;
  useEffect(() => {
    if (value.mode !== "repository") return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setFiles([]);
    const selected = currentValue.current.dockerfile;
    change.current({ ...currentValue.current, dockerfile: "" });
    loadFiles(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setFiles(result);
        change.current({
          ...currentValue.current,
          dockerfile:
            selected && result.includes(selected) ? selected : result[0] || "",
        });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [value.mode, loadFiles, reload]);
  const id = (field: string) => `${prefix}-${field}`;
  const modes = [
    ["auto", "Detect automatically"],
    ["repository", "Choose a root Dockerfile"],
    ["custom", "Write a Dockerfile"],
    ["railpack", "Use Railpack"],
  ] as const;
  return (
    <fieldset
      id={`${prefix}-options`}
      className="build-options"
      disabled={disabled}
    >
      <legend>Build method</legend>
      {modes.map(([mode, label]) => (
        <div key={mode}>
          <label className="build-option">
            <input
              type="radio"
              name={`${prefix}Mode`}
              value={mode}
              checked={value.mode === mode}
              onChange={() => onChange({ ...value, mode })}
            />
            <span>{label}</span>
          </label>
          {value.mode === mode && mode === "repository" && (
            <div className="build-mode-panel">
              <div className="build-file-heading">
                <label htmlFor={id("dockerfile")}>Dockerfile</label>
                <button
                  id={id("files-refresh")}
                  className="ghost-btn"
                  type="button"
                  disabled={loading}
                  onClick={() => setReload((n) => n + 1)}
                >
                  Refresh
                </button>
              </div>
              <select
                id={id("dockerfile")}
                value={value.dockerfile || ""}
                disabled={loading || !files.length}
                onChange={(e) =>
                  onChange({ ...value, dockerfile: e.target.value })
                }
              >
                <option value="">
                  {loading ? "Loading Dockerfiles…" : "Select a Dockerfile"}
                </option>
                {files.map((file) => (
                  <option key={file}>{file}</option>
                ))}
              </select>
              <p className="field-hint" role="status">
                {loading
                  ? "Reading repository root…"
                  : files.length
                    ? `${files.length} Dockerfile(s) found in the repository root.`
                    : "No Dockerfiles loaded. Check the repository and branch, then refresh."}
              </p>
              <ErrorText message={error} />
            </div>
          )}
          {value.mode === mode && mode === "custom" && (
            <div className="build-mode-panel">
              <label htmlFor={id("custom-content")}>Dockerfile contents</label>
              <textarea
                id={id("custom-content")}
                rows={10}
                maxLength={65536}
                spellCheck={false}
                value={value.content || ""}
                onChange={(e) =>
                  onChange({ ...value, content: e.target.value })
                }
              />
              <p className="field-hint">Maximum size: 64 KiB.</p>
            </div>
          )}
          {value.mode === mode && mode === "railpack" && (
            <div className="build-mode-panel">
              <label htmlFor={id("railpack-config")}>
                Railpack build configuration (JSON)
              </label>
              <textarea
                id={id("railpack-config")}
                rows={8}
                spellCheck={false}
                value={value.config || ""}
                onChange={(e) => onChange({ ...value, config: e.target.value })}
              />
              <p className="field-hint">
                Leave blank to use Railpack defaults. Optional configuration
                must be a JSON object, up to 64 KiB.
              </p>
            </div>
          )}
        </div>
      ))}
    </fieldset>
  );
}

const composeExample =
  "services:\n  app:\n    image: ${PAAS_APP_IMAGE}\n    depends_on:\n      redis:\n        condition: service_started\n  redis:\n    image: redis:7";
export function RuntimeFields({
  value,
  onChange,
  prefix = "create",
  disabled = false,
}: {
  value: RuntimeConfig;
  onChange: (value: RuntimeConfig) => void;
  prefix?: string;
  disabled?: boolean;
}) {
  const id = (field: string) => `${prefix}-${field}`;
  return (
    <fieldset className="build-options runtime-options" disabled={disabled}>
      <legend>Runtime</legend>
      <label className="build-option">
        <input
          type="radio"
          name={id("runtimeMode")}
          value="single"
          checked={value.mode === "single"}
          onChange={() => onChange({ ...value, mode: "single" })}
        />
        <span>Single service</span>
      </label>
      <label className="build-option">
        <input
          type="radio"
          name={id("runtimeMode")}
          value="compose"
          checked={value.mode === "compose"}
          onChange={() =>
            onChange({
              source: "inline",
              file: "compose.yaml",
              webService: "app",
              ...value,
              mode: "compose",
            })
          }
        />
        <span>Compose (multiple services)</span>
      </label>
      {value.mode === "compose" && (
        <div className="build-mode-panel">
          <p className="field-hint">
            Use {"${PAAS_APP_IMAGE}"} for this app's built image. All services
            are managed together with the app.
          </p>
          <label className="build-option">
            <input
              type="radio"
              name={id("composeSource")}
              value="inline"
              checked={value.source !== "repository"}
              onChange={() => onChange({ ...value, source: "inline" })}
            />
            <span>Paste Compose YAML</span>
          </label>
          <label className="build-option">
            <input
              type="radio"
              name={id("composeSource")}
              value="repository"
              checked={value.source === "repository"}
              onChange={() => onChange({ ...value, source: "repository" })}
            />
            <span>Use a repository file</span>
          </label>
          {value.source === "repository" ? (
            <>
              <label htmlFor={id("compose-file")}>Root Compose file</label>
              <input
                type="text"
                id={id("compose-file")}
                value={value.file || ""}
                placeholder="compose.yaml"
                onChange={(e) => onChange({ ...value, file: e.target.value })}
              />
            </>
          ) : (
            <>
              <label htmlFor={id("compose-content")}>Compose YAML</label>
              <textarea
                id={id("compose-content")}
                rows={10}
                maxLength={65536}
                spellCheck={false}
                value={value.content || ""}
                onChange={(e) =>
                  onChange({ ...value, content: e.target.value })
                }
              />
              <p className="field-hint">Example (maximum size: 64 KiB):</p>
              <pre className="compose-sample">{composeExample}</pre>
            </>
          )}
          <label htmlFor={id("web-service")}>Web service name</label>
          <input
            type="text"
            id={id("web-service")}
            value={value.webService || ""}
            placeholder="app"
            onChange={(e) => onChange({ ...value, webService: e.target.value })}
          />
          <p className="field-hint">
            The service that receives traffic from the app's domain.
          </p>
        </div>
      )}
    </fieldset>
  );
}
