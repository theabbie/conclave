import React from "react";
import { LoaderCircle, Terminal, Trash2 } from "lucide-react";
import { LOCAL_SHELL_COMMAND } from "../local-shell/client";
import { LocalShellHub, type ShellCommandEntry } from "../local-shell/hub";
import { TicketDrawer } from "./TicketDrawer";

export function LocalShellDrawer({
  hub,
  entries,
  close,
  configure,
}: {
  hub: LocalShellHub;
  entries: readonly ShellCommandEntry[];
  close(): void;
  configure(): void;
}) {
  const [running, setRunning] = React.useState(false);
  const end = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [entries]);

  return (
    <TicketDrawer
      title="Local shell"
      close={close}
      action={
        entries.length ? (
          <button
            className="icon-button"
            aria-label="Clear terminal history"
            onClick={() => hub.clear()}
          >
            <Trash2 size={15} />
          </button>
        ) : undefined
      }
    >
      <div className="shell-terminal">
        <div className="shell-screen" role="log" aria-live="polite">
          {!hub.isConfigured() ? (
            <div className="shell-empty">
              <Terminal size={20} />
              <span>No local shell configured.</span>
              <code className="shell-setup-command">{LOCAL_SHELL_COMMAND}</code>
              <button type="button" onClick={configure}>
                Open connections
              </button>
            </div>
          ) : entries.length ? (
            entries.map((entry) => (
              <article className="shell-entry" key={entry.id}>
                <header>
                  <span>{entry.source}</span>
                  <time>
                    {new Date(entry.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </time>
                </header>
                <pre className="shell-command">
                  <span>$</span> {entry.command}
                </pre>
                {entry.output && (
                  <pre className="shell-output">{entry.output}</pre>
                )}
                <footer className={entry.status}>
                  {entry.status === "running" && (
                    <LoaderCircle className="spin" size={11} />
                  )}
                  <span>{entry.status}</span>
                  {entry.exitCode !== undefined && (
                    <span>exit {entry.exitCode}</span>
                  )}
                  {entry.durationMs !== undefined && (
                    <span>{entry.durationMs} ms</span>
                  )}
                  {entry.error && <span>{entry.error}</span>}
                </footer>
              </article>
            ))
          ) : (
            <div className="shell-empty">
              <Terminal size={20} />
              <span>Commands from you and the agent appear here.</span>
            </div>
          )}
          <div ref={end} />
        </div>
        <form
          className="shell-prompt"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            const command = String(data.get("command")).trim();
            if (!command || running || !hub.isConfigured()) return;
            setRunning(true);
            form.reset();
            void hub
              .runManual(command)
              .catch(() => undefined)
              .finally(() => setRunning(false));
          }}
        >
          <span>$</span>
          <input
            name="command"
            aria-label="Shell command"
            autoComplete="off"
            spellCheck={false}
            disabled={!hub.isConfigured() || running}
            placeholder={
              hub.isConfigured() ? "Run a command" : "Configure a shell first"
            }
          />
          <button type="submit" disabled={!hub.isConfigured() || running}>
            Run
          </button>
        </form>
      </div>
    </TicketDrawer>
  );
}
