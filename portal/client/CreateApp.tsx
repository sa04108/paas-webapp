import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorMessage, json } from "./api";
import {
  BuildFields,
  RuntimeFields,
  buildPayload,
  runtimePayload,
} from "./configuration";
import { useRequestScope } from "./hooks";
import { ErrorText, Icon } from "./ui";
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
type GithubInstallation = { id: string; account: string; type: string };
type GithubStatus = {
  configured: boolean;
  connected: boolean;
  pending?: {
    kind: "install" | "select";
    installations: GithubInstallation[];
  };
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
  const [github, setGithub] = useState<GithubStatus>({
    configured: false,
    connected: false,
  });
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedInstallation, setSelectedInstallation] = useState("");
  const [connectingInstallation, setConnectingInstallation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [githubError, setGithubError] = useState("");
  const [githubLoading, setGithubLoading] = useState(true);
  const githubRequest = useRef<AbortController | null>(null);
  const disconnecting = useRef(false);
  const connectionMutation = useRef(false);
  const initializedGithub = useRef(false);
  const installationChoices =
    github.pending?.kind === "select" ? github.pending.installations : [];
  const applyGithubStatus = useCallback((status: GithubStatus) => {
    setGithub(status);
    setSelectedInstallation((current) => {
      const options =
        status.pending?.kind === "select"
          ? status.pending.installations
          : [];
      if (current && options.some((item) => item.id === current)) return current;
      return options.length === 1 ? options[0].id : "";
    });
    if (!status.connected) {
      setRepos([]);
      setSelectedRepo("");
    }
  }, []);
  const refreshGithub = useCallback(async () => {
    if (disconnecting.current || connectionMutation.current) return;
    if (githubRequest.current) return;
    const controller = new AbortController();
    githubRequest.current = controller;
    setGithubLoading(true);
    try {
      let status = await api<GithubStatus>("/github/status", {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      applyGithubStatus(status);
      if (!initializedGithub.current) {
        setSource(status.configured ? "github" : "url");
        initializedGithub.current = true;
      }
      if (status.pending) {
        status = await api<GithubStatus>(
          "/github/complete-connection",
          { ...json("POST", {}), signal: controller.signal },
        );
        if (controller.signal.aborted) return;
      }
      applyGithubStatus(status);
      setGithubError("");
      if (status.connected) {
        const data = await api<{ repos: Repo[] }>("/github/repos", {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setRepos(data.repos);
      }
    } catch (e) {
      if (!controller.signal.aborted) setGithubError(errorMessage(e));
    } finally {
      if (githubRequest.current === controller) githubRequest.current = null;
      if (!controller.signal.aborted) setGithubLoading(false);
    }
  }, [applyGithubStatus]);
  useEffect(() => {
    // 새 탭에서 인증을 마치고 돌아오면 입력값을 유지한 채 연결 상태만 갱신한다.
    const resume = () => {
      if (!document.hidden) void refreshGithub();
    };
    void refreshGithub();
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      githubRequest.current?.abort();
      githubRequest.current = null;
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [refreshGithub]);
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
    if (disconnecting.current || connectionMutation.current) return;
    disconnecting.current = true;
    connectionMutation.current = true;
    githubRequest.current?.abort();
    githubRequest.current = null;
    try {
      await api("/github/disconnect", { ...json("POST"), signal });
      if (signal.aborted) return;
      applyGithubStatus({ configured: github.configured, connected: false });
      setGithubError("");
    } catch (e) {
      if (!signal.aborted) setGithubError(errorMessage(e));
    } finally {
      disconnecting.current = false;
      connectionMutation.current = false;
      if (!signal.aborted) setGithubLoading(false);
    }
  }
  async function connectInstallation() {
    const signal = scope.current.signal;
    if (
      !selectedInstallation ||
      disconnecting.current ||
      connectionMutation.current ||
      githubRequest.current
    ) return;
    connectionMutation.current = true;
    const controller = new AbortController();
    githubRequest.current = controller;
    setConnectingInstallation(true);
    setGithubLoading(true);
    setGithubError("");
    try {
      const status = await api<GithubStatus>(
        "/github/complete-connection",
        {
          ...json("POST", { installationId: selectedInstallation }),
          signal: controller.signal,
        },
      );
      if (signal.aborted || controller.signal.aborted) return;
      applyGithubStatus(status);
      if (status.connected) {
        const data = await api<{ repos: Repo[] }>("/github/repos", {
          signal: controller.signal,
        });
        if (!signal.aborted && !controller.signal.aborted)
          setRepos(data.repos);
      }
    } catch (e) {
      if (!signal.aborted && !controller.signal.aborted)
        setGithubError(errorMessage(e));
    } finally {
      if (githubRequest.current === controller) githubRequest.current = null;
      connectionMutation.current = false;
      if (!controller.signal.aborted) {
        setConnectingInstallation(false);
        setGithubLoading(false);
      }
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
                  disabled={
                    (!github.configured && !github.pending) || githubLoading
                  }
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
                        : github.pending?.kind === "install"
                          ? "GitHub installation pending"
                          : github.pending?.kind === "select"
                            ? "Choose a GitHub account to connect"
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
                  ) : github.pending?.kind === "install" ? (
                    <a
                      id="github-install-btn"
                      className="ghost-btn github-connect-btn"
                      href="/api/github/install"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Install GitHub App
                      <Icon name="external-link" />
                    </a>
                  ) : !github.pending ? (
                    <a
                      id="github-connect-btn"
                      className="ghost-btn github-connect-btn"
                      href="/api/github/connect"
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Connect GitHub (opens in a new tab)"
                      aria-label="Connect GitHub (opens in a new tab)"
                    >
                      Connect GitHub
                      <Icon name="external-link" />
                    </a>
                  ) : null}
                </div>
                {github.pending?.kind === "install" && (
                  <div className="repo-source-panel github-connection-panel">
                    <p className="field-hint">
                      Finish installing the GitHub App in the new tab, then
                      return here to check the connection.
                    </p>
                    <button
                      id="github-check-connection-btn"
                      type="button"
                      className="ghost-btn"
                      disabled={githubLoading || connectingInstallation}
                      onClick={() => void refreshGithub()}
                    >
                      {githubLoading ? "Checking…" : "Check connection"}
                    </button>
                  </div>
                )}
                {github.pending?.kind === "select" && (
                  <div className="repo-source-panel github-connection-panel">
                    <p className="field-hint">
                      Choose the account where the GitHub App is installed.
                    </p>
                    <label htmlFor="github-installation-select">
                      GitHub account
                    </label>
                    <select
                      id="github-installation-select"
                      value={selectedInstallation}
                      disabled={connectingInstallation || githubLoading}
                      onChange={(event) =>
                        setSelectedInstallation(event.target.value)
                      }
                    >
                      <option value="">Select an account</option>
                      {installationChoices.map((installation) => (
                        <option key={installation.id} value={installation.id}>
                          {installation.account} ({installation.type})
                        </option>
                      ))}
                    </select>
                    <button
                      id="github-connect-installation-btn"
                      type="button"
                      className="ghost-btn"
                      disabled={
                        !selectedInstallation ||
                        connectingInstallation ||
                        githubLoading
                      }
                      onClick={() => void connectInstallation()}
                    >
                      {connectingInstallation
                        ? "Connecting…"
                        : "Connect selected account"}
                    </button>
                  </div>
                )}
                {github.pending && (
                  <p>
                    <a
                      className="ghost-btn"
                      href="/api/github/connect"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Restart GitHub connection
                    </a>
                  </p>
                )}
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
