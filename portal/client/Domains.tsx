import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, errorMessage, json } from "./api";
import { appPath, type Domain, type Notice } from "./types";
import { ErrorText, Modal, Icon } from "./ui";

export function Domains({
  userid,
  appname,
  notify,
}: {
  userid: string;
  appname: string;
  notify: Notice;
}) {
  const path = `${appPath(userid, appname)}/domains`;
  const [domains, setDomains] = useState<Domain[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [modal, setModal] = useState(false);
  const [domain, setDomain] = useState("");
  const [modalError, setModalError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const data = await api<{ domains: Domain[] }>(path, { signal });
      if (!signal?.aborted) {
        setDomains(data.domains);
        setError("");
        setLoading(false);
      }
    },
    [path],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch((e) => {
      if (!controller.signal.aborted) {
        setError(errorMessage(e));
        setLoading(false);
      }
    });
    return () => controller.abort();
  }, [load]);
  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setModalError("");
    try {
      await api(path, json("POST", { domain: domain.trim() }));
      setModal(false);
      setDomain("");
      await load();
      notify(
        "Domain added. Configure its CNAME record, then verify.",
        "success",
      );
    } catch (e) {
      setModalError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function action(item: Domain, remove: boolean) {
    if (remove && !window.confirm(`Remove domain ${item.domain}?`)) return;
    setBusy(true);
    try {
      await api(
        `${path}/${item.id}${remove ? "" : "/verify"}`,
        json(remove ? "DELETE" : "POST"),
      );
      await load();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section id="detail-panel-domains" className="panel detail-panel">
      <div className="panel-head">
        <h3>Custom Domains</h3>
        <button
          id="detail-add-domain-btn"
          className="ghost-btn"
          type="button"
          onClick={() => {
            setModalError("");
            setModal(true);
          }}
        >
          Add Domain
        </button>
      </div>
      <p className="field-hint">
        Point a CNAME record at the target below, then click Verify.
      </p>
      <ErrorText message={error} />
      {error && (
        <button
          type="button"
          className="ghost-btn"
          onClick={() => void load().catch((e) => setError(errorMessage(e)))}
        >
          Retry
        </button>
      )}
      {loading ? (
        <p>Loading domains…</p>
      ) : !domains.length ? (
        <p className="empty-state">No custom domains yet.</p>
      ) : (
        <div id="domains-table-wrap" className="users-table-wrap">
          <table className="users-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Domain</th>
                <th>CNAME target</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="domains-table-body">
              {domains.map((item) => (
                <tr key={item.id}>
                  <td>CNAME</td>
                  <td>
                    <a
                      href={`https://${item.domain}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {item.domain}
                    </a>
                  </td>
                  <td>
                    <div className="domain-cname-cell">
                      <code>{item.cnameTarget}</code>
                      <button
                        className="ghost-btn domains-copy-btn"
                        title="Copy CNAME target"
                        type="button"
                        onClick={() =>
                          navigator.clipboard
                            .writeText(item.cnameTarget)
                            .then(() => notify("CNAME copied.", "success"))
                            .catch(() =>
                              notify(
                                "Could not copy. Select and copy the CNAME text.",
                                "error",
                              ),
                            )
                        }
                      >
                        <Icon name="copy" />
                      </button>
                    </div>
                  </td>
                  <td>
                    <span
                      className={`domain-status-badge domain-status-${item.status}`}
                    >
                      {item.status}
                    </span>
                  </td>
                  <td>
                    <div className="users-action-group">
                      <button
                        className="ghost-btn"
                        type="button"
                        disabled={busy}
                        onClick={() => action(item, false)}
                      >
                        Verify
                      </button>
                      <button
                        className="ghost-btn danger-ghost-btn"
                        type="button"
                        disabled={busy}
                        onClick={() => action(item, true)}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {modal && (
        <Modal
          title="Add Custom Domain"
          id="add-domain-modal"
          onClose={() => {
            if (!busy) setModal(false);
          }}
        >
          <form id="add-domain-form" onSubmit={add}>
            <label htmlFor="add-domain-input">Domain</label>
            <input
              type="text"
              id="add-domain-input"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="app.example.com"
              required
            />
            <ErrorText id="add-domain-error" message={modalError} />
            <div className="modal-actions">
              <button className="primary-btn" type="submit" disabled={busy}>
                {busy ? "Adding…" : "Add Domain"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
