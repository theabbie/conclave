import React from "react";
import { createRoot } from "react-dom/client";
import { Database, Link2, LoaderCircle } from "lucide-react";
import { BoardStore } from "./board/store";
import { App } from "./App";
import { SelectControl } from "./components/SelectControl";
import {
  NotionClient,
  type NotionPage,
  type NotionStatus,
} from "./notion/client";
import "./styles.css";

const notion = new NotionClient();

function Setup({ status, ready }: { status: NotionStatus; ready(): void }) {
  const [pages, setPages] = React.useState<NotionPage[]>([]);
  const [selected, setSelected] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    void notion
      .pages()
      .then((items) => {
        setPages(items);
        setSelected(items[0]?.id ?? "");
      })
      .catch((reason: unknown) =>
        setError(reason instanceof Error ? reason.message : String(reason)),
      )
      .finally(() => setLoading(false));
  }, []);

  const setup = async () => {
    if (!selected) return;
    setLoading(true);
    setError("");
    try {
      await notion.setup(selected);
      ready();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setLoading(false);
    }
  };

  return (
    <main className="connection-screen">
      <section className="connection-card">
        <span className="connection-mark">
          <Database size={20} />
        </span>
        <p className="eyebrow">Notion connected</p>
        <h1>Choose where Conclave lives</h1>
        <p>
          Conclave will create its board database inside a page in{" "}
          {status.workspaceName}. Tickets, agent data, and comments will be
          stored there.
        </p>
        {loading ? (
          <div className="connection-loading">
            <LoaderCircle size={18} /> Loading pages
          </div>
        ) : (
          <label>
            Parent page
            <SelectControl
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
            >
              {pages.map((page) => (
                <option key={page.id} value={page.id}>
                  {page.title}
                </option>
              ))}
            </SelectControl>
          </label>
        )}
        {!loading && !pages.length && (
          <p className="connection-error">
            No accessible pages were returned. Grant the integration access to a
            page in Notion and reconnect.
          </p>
        )}
        {error && <p className="connection-error">{error}</p>}
        <button
          className="primary full"
          disabled={loading || !selected}
          onClick={() => void setup()}
        >
          Create Notion board
        </button>
      </section>
    </main>
  );
}

function Bootstrap() {
  const [phase, setPhase] = React.useState<
    "loading" | "connect" | "setup" | "ready" | "error"
  >("loading");
  const [status, setStatus] = React.useState<NotionStatus>();
  const [store, setStore] = React.useState<BoardStore>();
  const [error, setError] = React.useState("");

  const load = React.useCallback(async () => {
    try {
      notion.captureCallback();
      if (!notion.isConnected()) {
        setPhase("connect");
        return;
      }
      const current = await notion.status();
      setStatus(current);
      if (!current.initialized) {
        setPhase("setup");
        return;
      }
      const board = await notion.loadBoard();
      const next = new BoardStore(board, (state) => notion.saveBoard(state));
      next.subscribeErrors((failure) => setError(failure.message));
      setStore(next);
      setPhase("ready");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase(notion.isConnected() ? "error" : "connect");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  if (phase === "loading")
    return (
      <main className="connection-screen">
        <LoaderCircle className="spin" size={22} />
      </main>
    );
  if (phase === "connect")
    return (
      <main className="connection-screen">
        <section className="connection-card">
          <span className="connection-mark">
            <Link2 size={20} />
          </span>
          <p className="eyebrow">Workspace persistence</p>
          <h1>Connect Notion</h1>
          <p>
            Your board starts clean and remains in your Notion workspace.
            Conclave stores no local board copy.
          </p>
          {error && <p className="connection-error">{error}</p>}
          <a className="primary full" href={notion.connectUrl()}>
            Continue with Notion
          </a>
        </section>
      </main>
    );
  if (phase === "setup" && status)
    return (
      <Setup
        status={status}
        ready={() => {
          setPhase("loading");
          void load();
        }}
      />
    );
  if (phase === "ready" && store && status)
    return (
      <App
        store={store}
        notion={{
          ...status,
          sessionToken: notion.sessionToken(),
          disconnect: () => {
            notion.disconnect();
            location.reload();
          },
        }}
        persistenceError={error}
      />
    );
  return (
    <main className="connection-screen">
      <section className="connection-card">
        <h1>Notion could not be opened</h1>
        <p className="connection-error">{error}</p>
        <button
          className="primary full"
          onClick={() => {
            notion.disconnect();
            location.reload();
          }}
        >
          Reconnect Notion
        </button>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Bootstrap />);
