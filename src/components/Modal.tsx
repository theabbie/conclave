import { X } from "lucide-react";
import React from "react";

export function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = React.useRef<HTMLDialogElement>(null);
  React.useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      aria-label={title}
      ref={ref}
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal-content">
        <header>
          <h2>{title}</h2>
          <button aria-label="Close dialog" onClick={close}>
            <X size={20} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}
