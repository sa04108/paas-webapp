import {
  Component,
  StrictMode,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useNavigate } from "react-router-dom";
import { api, errorMessage, json } from "./api";
import { LoginPage } from "./account";
import { Portal } from "./Portal";
import type { User, PortalConfig } from "./types";
import "../public/styles.css";
import "./react.css";
import "./theme.css";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="page">
        <p role="alert">The portal could not display this screen.</p>
        <button
          className="primary-btn"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}
function App() {
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);
  const [config, setConfig] = useState<PortalConfig | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const login = useCallback(
    (next: User) => {
      setUser(next);
      if (window.location.pathname === "/auth")
        navigate("/dashboard", { replace: true });
    },
    [navigate],
  );
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    api<PortalConfig>("/config", { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted) setConfig(data);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      });
    if (window.location.pathname !== "/auth") {
      api<{ user: User }>("/auth/me", { signal: controller.signal })
        .then((data) => {
          if (!controller.signal.aborted) setUser(data.user);
        })
        .catch((e) => {
          if (controller.signal.aborted) return;
          if (e.status === 401) window.location.replace("/auth");
          else setError(errorMessage(e));
        });
    }
    return () => controller.abort();
  }, [attempt]);
  async function logout() {
    await api("/auth/logout", json("POST"));
    window.location.replace("/auth");
  }
  if (error)
    return (
      <main className="page">
        <p role="alert">{error}</p>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Retry
        </button>
      </main>
    );
  if (!user && window.location.pathname === "/auth")
    return <LoginPage onLogin={login} />;
  if (!user || !config)
    return (
      <main className="page">
        <p role="status">Loading portal…</p>
      </main>
    );
  return (
    <Portal user={user} config={config} onUser={setUser} onLogout={logout} />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
        <footer className="portal-footer">
          <span>Hyunbbai Portal</span>
          <a href="/third-party-notices.txt" target="_blank" rel="noreferrer">
            Open source licenses
          </a>
        </footer>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
);
