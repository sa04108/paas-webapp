import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Icon({
  name,
}: {
  name:
    | "settings"
    | "close"
    | "jobs"
    | "sun"
    | "moon"
    | "menu"
    | "copy"
    | "logs";
}) {
  const paths = {
    settings:
      "M19.14 12.94a7.8 7.8 0 0 0 0-1.88l2.03-1.58-1.92-3.32-2.39.96a7.2 7.2 0 0 0-1.62-.94L14.88 3h-3.84l-.36 3.18a7.2 7.2 0 0 0-1.62.94l-2.39-.96-1.92 3.32 2.03 1.58a7.8 7.8 0 0 0 0 1.88l-2.03 1.58 1.92 3.32 2.39-.96c.5.39 1.04.7 1.62.94l.36 3.18h3.84l.36-3.18c.58-.24 1.12-.55 1.62-.94l2.39.96 1.92-3.32-2.03-1.58ZM13 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z",
    close: "m6 4 6 6 6-6 2 2-6 6 6 6-2 2-6-6-6 6-2-2 6-6-6-6z",
    jobs: "M3 7h2v2H3zm4 0h14v2H7zM3 11h2v2H3zm4 0h14v2H7zM3 15h2v2H3zm4 0h14v2H7z",
    sun: "M11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4 3l3 3-1 1-3-3zm13 14 3 3 1-1-3-3zM3 20l3-3 1 1-3 3zM17 6l3-3 1 1-3 3zM12 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z",
    moon: "M20.99 12.97A9 9 0 0 1 11.03 3.01a9 9 0 1 0 9.96 9.96Z",
    menu: "M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z",
    copy: "M16 1H4v16h2V3h10zm4 4H8v18h12zm-2 16h-8V7h8z",
    logs: "M5 3h14v18H5zm2 4v2h10V7zm0 4v2h10v-2zm0 4v2h7v-2z",
  };
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" d={paths[name]} />
    </svg>
  );
}
export function ErrorText({ message, id }: { message?: string; id?: string }) {
  return message ? (
    <p id={id} className="modal-error" role="alert">
      {message}
    </p>
  ) : null;
}
export function formatDate(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}
export function Modal({
  title,
  onClose,
  children,
  className = "",
  id,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const startedOutside = useRef(false);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal();
    document.body.classList.add("modal-open");
    return () => {
      element.close();
      if (!document.querySelector("dialog[open]"))
        document.body.classList.remove("modal-open");
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      id={id}
      className="react-modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close.current();
      }}
      onMouseDown={(event) => {
        startedOutside.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && startedOutside.current)
          close.current();
        startedOutside.current = false;
      }}
    >
      <section className={`panel-inset modal-card ${className}`}>
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        {children}
      </section>
    </dialog>,
    document.body,
  );
}
