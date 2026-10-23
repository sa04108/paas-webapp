import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorMessage, json } from "./api";
import type { Notice, User } from "./types";
import { ErrorText, Modal, formatDate } from "./ui";

export function LoginPage({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("Enter your login details.");
  const [kind, setKind] = useState<"info" | "error">("info");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<{ user: User }>("/auth/me", { signal: controller.signal })
      .then(({ user }) => onLogin(user))
      .catch((error) => {
        if (
          !controller.signal.aborted &&
          (error as { status?: number }).status !== 401
        ) {
          setMessage(errorMessage(error));
          setKind("error");
        }
      });
    return () => controller.abort();
  }, [onLogin]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!username.trim() || !password) {
      setMessage("Enter your login ID and password.");
      setKind("error");
      return;
    }
    setBusy(true);
    setMessage("Logging in...");
    setKind("info");
    try {
      const { user } = await api<{ user: User }>(
        "/auth/login",
        json("POST", { username: username.trim(), password }),
      );
      onLogin(user);
    } catch (error) {
      setMessage(errorMessage(error));
      setKind("error");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page auth-page">
      <section className="panel login-view auth-standalone">
        <div className="panel-head">
          <h2>Portal Login</h2>
        </div>
        <p className="login-description">
          You will be redirected to the dashboard after logging in.
        </p>
        <p id="status-banner" className={`status-banner ${kind}`} role="status">
          {message}
        </p>
        <form
          id="login-form"
          className="auth-form"
          onSubmit={submit}
          noValidate
        >
          <label htmlFor="login-username-input">Login ID</label>
          <input
            type="text"
            id="login-username-input"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter your login ID"
            autoComplete="username"
            required
          />
          <label htmlFor="login-password-input">Password</label>
          <input
            id="login-password-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter your password"
            autoComplete="current-password"
            required
          />
          <button
            id="login-btn"
            className="primary-btn"
            type="submit"
            disabled={busy}
          >
            {busy ? "Logging in…" : "Log In"}
          </button>
        </form>
      </section>
    </div>
  );
}

export function PasswordSettings({
  user: account,
  onClose,
  onUpdated,
}: {
  user: User;
  onClose: () => void;
  onUpdated: (user: User) => void;
}) {
  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (newPassword !== confirm) {
      setError("The new password and confirmation do not match.");
      return;
    }
    setBusy(true);
    try {
      const { user } = await api<{ user: User }>(
        "/auth/change-password",
        json("POST", { currentPassword, newPassword }),
      );
      onUpdated(user);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Change Password"
      onClose={() => {
        if (!busy) onClose();
      }}
      className="settings-modal"
      id="settings-modal"
    >
      <form className="auth-form" onSubmit={submit}>
        <input
          type="text"
          autoComplete="username"
          value={account.username}
          readOnly
          hidden
        />
        <ErrorText message={error} id="settings-error" />
        <label htmlFor="current-password-input">Current password</label>
        <input
          id="current-password-input"
          type="password"
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
        <label htmlFor="new-password-input">New password</label>
        <input
          id="new-password-input"
          type="password"
          autoComplete="new-password"
          value={newPassword}
          onChange={(e) => setNew(e.target.value)}
          minLength={8}
          required
        />
        <label htmlFor="new-password-confirm-input">Confirm new password</label>
        <input
          id="new-password-confirm-input"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
        <div className="modal-actions">
          <button
            className="ghost-btn"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button className="primary-btn" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Change Password"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

type AdminUser = User & { createdAt?: string; lastAccessAt?: string };
export function UsersPage({ notify }: { notify: Notice }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"create" | "delete" | "promote" | null>(
    null,
  );
  const [target, setTarget] = useState<AdminUser | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const load = async (signal?: AbortSignal) => {
    const data = await api<{ users: AdminUser[] }>("/users", { signal });
    setUsers(data.users || []);
  };
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(errorMessage(e));
    });
    return () => controller.abort();
  }, []);
  function clearForm(force = false) {
    if (busy && !force) return;
    setMode(null);
    setTarget(null);
    setError("");
    setUsername("");
    setPassword("");
    setConfirm("");
    setCurrentPassword("");
    setIsAdmin(false);
  }
  function openForm(next: "create" | "delete" | "promote", item?: AdminUser) {
    if (busy) return;
    setError("");
    setUsername("");
    setPassword("");
    setConfirm("");
    setCurrentPassword("");
    setIsAdmin(false);
    setTarget(item || null);
    setMode(next);
  }
  async function perform(event: FormEvent) {
    event.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "create") {
        if (password !== confirm)
          throw new Error("The password and confirmation do not match.");
        const data = await api<{ user: User }>(
          "/users",
          json("POST", { username: username.trim(), password, isAdmin }),
        );
        notify(`User created: ${data.user.username}`, "success");
      } else if (mode === "delete" && target) {
        const data = await api<{ user: User }>(
          `/users/${target.id}`,
          json("DELETE", { currentPassword }),
        );
        notify(`User removed: ${data.user.username}`, "success");
      } else if (mode === "promote" && target) {
        const data = await api<{ user: User }>(
          `/users/${target.id}/role`,
          json("PATCH"),
        );
        notify(`${data.user.username} has been promoted to Admin.`, "success");
      }
      clearForm(true);
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section id="view-users" className="view-section">
      <header className="view-header">
        <h2>User Management</h2>
        <p className="view-subtitle">
          View usernames, roles, registration dates, and last access dates.
        </p>
      </header>
      <article className="panel users-panel">
        <div className="panel-head">
          <h3>Users</h3>
          <div className="users-head-actions">
            <span id="users-count" className="users-count">
              Users: {users.length}
            </span>
            <button
              id="open-create-user-btn"
              className="ghost-btn users-add-btn"
              type="button"
              onClick={() => openForm("create")}
            >
              Add
            </button>
          </div>
        </div>
        {error && !mode && <ErrorText message={error} />}{" "}
        {!users.length ? (
          <p id="users-empty-state" className="empty-state">
            No users registered.
          </p>
        ) : (
          <div className="users-table-wrap">
            <table className="users-table">
              <thead>
                <tr>
                  <th>username</th>
                  <th>Role</th>
                  <th>Registered</th>
                  <th>Last Access</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="users-table-body">
                {users.map((item) => (
                  <tr key={item.id}>
                    <td>{item.username}</td>
                    <td>
                      <span
                        className={`role-badge ${item.isAdmin ? "role-admin" : "role-user"}`}
                      >
                        {item.isAdmin ? "Admin" : "User"}
                      </span>
                    </td>
                    <td>{formatDate(item.createdAt)}</td>
                    <td>{formatDate(item.lastAccessAt)}</td>
                    <td>
                      {item.isAdmin ? (
                        <span
                          className="users-protected"
                          title="Admin accounts cannot be removed or demoted"
                        >
                          Protected
                        </span>
                      ) : (
                        <div className="users-action-group">
                          <button
                            className="action-btn users-promote-btn"
                            data-action="promote-user"
                            type="button"
                            disabled={busy}
                            onClick={() => openForm("promote", item)}
                          >
                            Promote to Admin
                          </button>
                          <button
                            className="action-btn danger users-remove-btn"
                            data-action="remove-user"
                            type="button"
                            disabled={busy}
                            onClick={() => openForm("delete", item)}
                          >
                            Remove
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </article>
      {mode && (
        <Modal
          title={
            mode === "create"
              ? "Add User"
              : mode === "delete"
                ? "Remove User"
                : "Confirm Admin Promotion"
          }
          onClose={() => clearForm()}
          id={`${mode}-user-modal`}
        >
          <form onSubmit={perform} noValidate>
            <ErrorText id={`${mode}-user-error`} message={error} />
            {mode === "create" ? (
              <>
                <label htmlFor="create-username-input">username</label>
                <input
                  type="text"
                  id="create-username-input"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  maxLength={20}
                  autoComplete="username"
                  required
                />
                <label htmlFor="create-password-input">Password</label>
                <input
                  id="create-password-input"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <label htmlFor="confirm-password-input">Confirm password</label>
                <input
                  id="confirm-password-input"
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                />
                <label htmlFor="create-user-role-input">Role</label>
                <select
                  id="create-user-role-input"
                  value={isAdmin ? "admin" : "user"}
                  onChange={(e) => setIsAdmin(e.target.value === "admin")}
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </>
            ) : mode === "delete" ? (
              <>
                <p className="modal-description">Remove {target?.username}?</p>
                <label htmlFor="delete-user-password-input">
                  Current Admin Password
                </label>
                <input
                  id="delete-user-password-input"
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                />
              </>
            ) : (
              <>
                <p className="promote-target-text">
                  Promote {target?.username} to Admin?
                </p>
                <p className="modal-description">
                  Admin accounts are protected and cannot be removed or demoted.
                </p>
              </>
            )}
            <div className="modal-actions">
              <button
                className="ghost-btn"
                type="button"
                onClick={() => clearForm()}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className={
                  mode === "create" ? "primary-btn" : "action-btn danger"
                }
                type="submit"
                disabled={busy}
              >
                {busy
                  ? "Working…"
                  : mode === "create"
                    ? "Confirm"
                    : mode === "delete"
                      ? "Remove"
                      : "Promote to Admin"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}

export function PortalLogs() {
  const [lines, setLines] = useState("120");
  const [logs, setLogs] = useState("Loading...");
  const [auto, setAuto] = useState(false);
  const inFlight = useRef(false);
  const queuedLoad = useRef<(() => void) | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let mounted = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const load = async () => {
      if (inFlight.current) {
        queuedLoad.current = () => {
          if (mounted) void load();
        };
        return;
      }
      inFlight.current = true;
      const count = Math.max(
        1,
        Math.min(1000, Number.parseInt(lines, 10) || 120),
      );
      try {
        const data = await api<{ logs: string }>(
          `/admin/portal-logs?lines=${count}`,
          { signal: controller.signal },
        );
        if (mounted) setLogs(data.logs || "(empty)");
      } catch {
        if (mounted && !controller.signal.aborted)
          setLogs("Failed to load portal logs.");
      } finally {
        inFlight.current = false;
        const next = queuedLoad.current;
        queuedLoad.current = null;
        next?.();
      }
    };
    void load();
    if (auto) timer = setInterval(() => void load(), 5000);
    return () => {
      mounted = false;
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [lines, auto]);
  return (
    <section id="admin-panel-logs" className="panel detail-panel">
      <div className="panel-head logs-head">
        <h3>Portal System Logs</h3>
        <div className="logs-controls">
          <input
            id="admin-portal-log-lines-input"
            type="number"
            className="log-lines-input"
            min="1"
            max="1000"
            value={lines}
            onChange={(e) => setLines(e.target.value)}
            aria-label="Number of log lines"
          />
          <button
            id="admin-refresh-portal-logs-btn"
            className="ghost-btn logs-refresh-btn"
            data-auto={auto}
            type="button"
            onClick={() => setAuto((v) => !v)}
          >
            <span className="refresh-icon">↻</span>
            <span className="refresh-label">{auto ? "Auto" : "Refresh"}</span>
          </button>
        </div>
      </div>
      <pre id="admin-portal-logs-output" className="logs-output">
        {logs}
      </pre>
    </section>
  );
}
