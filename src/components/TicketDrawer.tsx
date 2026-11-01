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
  const start = React.useRef<number | undefined>(undefined);

  React.useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [close]);

  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    start.current = event.clientY;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (start.current === undefined) return;
    setOffset(Math.max(0, event.clientY - start.current));
  };
  const pointerUp = () => {
    if (offset > 72) close();
    else setOffset(0);
    start.current = undefined;
  };

  return (
    <div
      className="drawer-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <aside
        className="ticket-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ "--drawer-offset": `${offset}px` } as React.CSSProperties}
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
              onClick={close}
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
