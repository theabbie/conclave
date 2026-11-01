import React from "react";
import { X } from "lucide-react";

interface TicketDrawerProps {
  title: string;
  action?: React.ReactNode;
  close(): void;
  children: React.ReactNode;
}

export function TicketDrawer({
  title,
  action,
  close,
  children,
}: TicketDrawerProps) {
  const [offset, setOffset] = React.useState(0);
  const [dragging, setDragging] = React.useState(false);
  const [closing, setClosing] = React.useState(false);
  const start = React.useRef<number | undefined>(undefined);
  const offsetRef = React.useRef(0);

  const requestClose = React.useCallback(() => {
    setDragging(false);
    setClosing(true);
  }, []);

  React.useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [requestClose]);

  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    start.current = event.clientY;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (start.current === undefined) return;
    const next = Math.max(0, event.clientY - start.current);
    offsetRef.current = next;
    setOffset(next);
  };
  const pointerUp = () => {
    setDragging(false);
    if (offsetRef.current > 72) {
      requestClose();
      offsetRef.current = window.innerHeight;
      setOffset(window.innerHeight);
    } else {
      offsetRef.current = 0;
      setOffset(0);
    }
    start.current = undefined;
  };

  return (
    <div
      className="drawer-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) requestClose();
      }}
    >
      <aside
        className={`ticket-drawer ${dragging ? "is-dragging" : ""} ${closing ? "is-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ "--drawer-offset": `${offset}px` } as React.CSSProperties}
        onTransitionEnd={(event) => {
          if (closing && event.propertyName === "transform") close();
        }}
      >
        <div
          className="drawer-handle"
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerUp}
        >
          <span />
        </div>
        <header className="drawer-header">
          <h2>{title}</h2>
          <div className="drawer-actions">
            {action}
            <button
              className="icon-button"
              aria-label="Close ticket"
              onClick={requestClose}
            >
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="drawer-content">{children}</div>
      </aside>
    </div>
  );
}
