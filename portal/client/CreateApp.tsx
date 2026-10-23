import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorMessage, json } from "./api";
import {
  BuildFields,
  RuntimeFields,
  buildPayload,
  runtimePayload,
} from "./configuration";
import { useRequestScope } from "./hooks";
import { ErrorText } from "./ui";
import type {
  BuildConfig,
  RuntimeConfig,
  PortalConfig,
  User,
  Notice,
} from "./types";

type Repo = {
  cloneUrl: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
};
export function CreateApp({
  user,
  config,
  notify,
  onJob,
}: {
  user: User;
  config: PortalConfig;
  notify: Notice;
  onJob: () => Promise<void>;
}) {
  const navigate = useNavigate();
  const scope = useRequestScope();
  const [appname, setAppname] = useState("");
  const [source, setSource] = useState("url");
  const [repoUrl, setRepoUrl] = useState("");
  const [selectedRepo, setSelectedRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [env, setEnv] = useState("");
  const [build, setBuild] = useState<BuildConfig>({ mode: "auto" });
  const [runtime, setRuntime] = useState<RuntimeConfig>({ mode: "single" });
  const [github, setGithub] = useState({ configured: false, connected: false });
  const [repos, setRepos] = useState<Repo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [githubError, setGithubError] = useState("");
  const [githubLoading, setGithubLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const status = await api<typeof github>("/github/status", {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setGithub(status);
        setSource(status.configured ? "github" : "url");
        if (status.connected) {
          const data = await api<{ repos: Repo[] }>("/github/repos", {
            signal: controller.signal,
          });
          if (!controller.signal.aborted) setRepos(data.repos);
        }
      } catch (e) {
        if (!controller.signal.aborted) setGithubError(errorMessage(e));
      } finally {
        if (!controller.signal.aborted) setGithubLoading(false);
      }
    })();
    return () => controller.abort();
  }, []);
  const repository = source === "github" ? selectedRepo : repoUrl;
  const loadFiles = useCallback(
    async (signal: AbortSignal) => {
      if (!repository.trim()) throw new Error("Select a repository first.");
      const data = await api<{ files: string[] }>("/apps/dockerfiles", {
        ...json("POST", {
          repoUrl: repository.trim(),
          branch: branch.trim() || "main",
          usePrivate: source === "github",
        }),
        signal,
      });
      return data.files;
    },
    [repository, branch, source],
  );
  async function submit(event: FormEvent) {
    event.preventDefault();
    const signal = scope.current.signal;
    setError("");
    try {
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{2,29}$/.test(appname.trim()))
        throw new Error(
          "App name must be 3–30 characters, starting with a letter or number, using letters, numbers or hyphens.",
        );
      if (!repository.trim())
        throw new Error("Select a repository or enter its URL.");
      const body = {
        appname: appname.trim(),
        repoUrl: repository.trim(),
        branch: branch.trim() || "main",
        build: buildPayload(build),
        runtime: runtimePayload(runtime),
        env,
        usePrivate: source === "github",
      };
      setBusy(true);
      await api("/apps", { ...json("POST", body), signal });
      if (signal.aborted) return;
      notify("App creation started. Check Jobs for progress.", "success");
      await onJob();
      if (!signal.aborted) navigate("/dashboard");
    } catch (e) {
      if (!signal.aborted) setError(errorMessage(e));
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }
  async function disconnect() {
    const signal = scope.current.signal;
    try {
      await api("/github/disconnect", { ...json("POST"), signal });
      if (signal.aborted) return;
      setGithub((v) => ({ ...v, connected: false }));
      setRepos([]);
      setSelectedRepo("");
    } catch (e) {
      if (!signal.aborted) setGithubError(errorMessage(e));
    }
  }
  return (
    <section id="view-create" className="view-section">
      <header className="view-header">
        <h2>Create App</h2>
        <p className="view-subtitle">Create and deploy a new app.</p>
      </header>
      <article className="panel create-panel">
        <form id="create-form" onSubmit={submit} noValidate>
          <fieldset className="form-fields" disabled={busy}>
            <label htmlFor="appname-input">App Name</label>
            <input
              type="text"
              id="appname-input"
              value={appname}
              onChange={(e) => setAppname(e.target.value)}
              placeholder="myapp"
              required
            />
            <span className="field-label">Source Repository</span>
            <div
              className="repo-source-toggle"
              role="radiogroup"
              aria-label="Repository source"
            >
              <label className="repo-source-option">
                <input
                  type="radio"
                  name="repoSource"
                  value="github"
                  checked={source === "github"}
                  disabled={!github.configured || githubLoading}
                  onChange={() => setSource("github")}
                />
                <span className="repo-source-option-label">
                  My GitHub Repositories
                </span>
              </label>
              <label className="repo-source-option">
                <input
                  type="radio"
                  name="repoSource"
                  value="url"
                  checked={source === "url"}
                  onChange={() => setSource("url")}
                />
                <span className="repo-source-option-label">
                  Public Repository URL
                </span>
              </label>
            </div>
            {source === "github" ? (
              <div id="repo-source-github-panel">
                <div className="github-connect-row">
                  <p id="github-status-text" className="field-hint">
                    {githubLoading
                      ? "Loading GitHub…"
                      : github.connected
                        ? "GitHub connected"
                        : "GitHub not connected"}
                  </p>
                  {github.connected ? (
                    <button
                      id="github-disconnect-btn"
                      type="button"
                      className="ghost-btn"
                      onClick={disconnect}
                    >
                      Disconnect
                    </button>
                  ) : (
                    <a
                      id="github-connect-btn"
                      className="ghost-btn"
                      href="/api/github/connect"
                    >
                      Connect GitHub
                    </a>
                  )}
                </div>
                <label htmlFor="repo-select">Repository</label>
                <select
                  id="repo-select"
                  value={selectedRepo}
                  disabled={!github.connected}
                  onChange={(e) => {
                    setSelectedRepo(e.target.value);
                    setBranch(
                      repos.find((repo) => repo.cloneUrl === e.target.value)
                        ?.defaultBranch || "main",
                    );
                  }}
                >
                  <option value="">Select a repository</option>
                  {repos.map((repo) => (
                    <option key={repo.cloneUrl} value={repo.cloneUrl}>
                      {repo.fullName}
                      {repo.private ? " (private)" : ""}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div id="repo-source-url-panel">
                <label htmlFor="repo-url-input">Repository URL</label>
                <input
                  id="repo-url-input"
                  type="url"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  placeholder="https://github.com/user/repository.git"
                />
              </div>
            )}
            <ErrorText message={githubError} />
            <label htmlFor="repo-branch-input">Branch</label>
            <input
              type="text"
              id="repo-branch-input"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
            />
            <RuntimeFields value={runtime} onChange={setRuntime} />
            <BuildFields
              value={build}
              onChange={setBuild}
              loadFiles={loadFiles}
            />
            <label htmlFor="create-env-input">Environment Variables</label>
            <textarea
              id="create-env-input"
              className="env-textarea create-env-textarea"
              rows={6}
              spellCheck={false}
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              placeholder={"KEY=value\nANOTHER_KEY=value"}
            />
            <p className="field-hint">
              One KEY=value per line. Applied when the app is first deployed.
            </p>
            <p className="domain-preview">
              Domain:{" "}
              <strong id="domain-preview">
                {user.username}-{appname.trim() || "appname"}.
                {config.appsDomain}
              </strong>
            </p>
            <ErrorText message={error} />
            <button
              id="create-submit-btn"
              className="primary-btn"
              type="submit"
            >
              {busy ? "Creating…" : "Create App"}
            </button>
          </fieldset>
        </form>
      </article>
    </section>
  );
}
