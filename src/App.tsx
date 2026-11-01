import React, { useState, useSyncExternalStore } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Circle,
  Columns3,
  GripVertical,
  LoaderCircle,
  Orbit,
  Plus,
  Search,
  Settings2,
  Square,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { createTicketAgent } from "./agent/runtime";
import type { AgentSettings } from "./agent/transport";
import { BoardStore, type Status, type Ticket } from "./board/store";
import { Modal } from "./components/Modal";
import { TicketDrawer } from "./components/TicketDrawer";
import { ApiWorkspace } from "./deploy/api-workspace";
import { ReleaseClient } from "./deploy/client";

const columns: { id: Status; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "ready", label: "Ready" },
  { id: "in_progress", label: "In progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

interface ConnectionSettings extends AgentSettings {
  deployEndpoint: string;
  deployToken: string;
}

function BoardColumn({
  status,
  children,
}: {
  status: Status;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: `column:${status}` });
  return (
    <div ref={setNodeRef} className={`cards ${isOver ? "is-over" : ""}`}>
      {children}
    </div>
  );
}

function TicketCard({
  ticket,
  number,
  subtasks,
  parentTitle,
  select,
}: {
  ticket: Ticket;
  number: number;
  subtasks: number;
  parentTitle?: string;
  select(): void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: ticket.id });
  return (
    <button
      ref={setNodeRef}
      className={`ticket ${parentTitle ? "subtask-ticket" : ""} ${isDragging ? "is-dragging" : ""}`}
      style={
        transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
          : undefined
      }
      onClick={select}
      {...listeners}
      {...attributes}
    >
      <span className="ticket-label">
        T-{String(number).padStart(3, "0")}
        <GripVertical size={12} aria-hidden="true" />
      </span>
      <h4>{ticket.title}</h4>
      {parentTitle && <span className="parent-label">Under {parentTitle}</span>}
      {ticket.description && <p>{ticket.description}</p>}
      <footer>
        <span>{subtasks} subtasks</span>
        {ticket.status === "in_progress" ? (
          <LoaderCircle size={13} />
        ) : (
          <UserRound size={13} />
        )}
      </footer>
    </button>
  );
}

export function App({ store }: { store: BoardStore }) {
  const board = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [configuring, setConfiguring] = useState(false);
  const [settings, setSettings] = useState<ConnectionSettings>({
    endpoint: "https://webiome.abbie.workers.dev/api/stream",
    model: "google/gemini-2.5-flash",
    token: "",
    deployEndpoint: "https://conclave.abbie.workers.dev",
    deployToken: "",
  });
  const [running, setRunning] = useState<{ id: string; abort: () => void }>();
  const [notice, setNotice] = useState("");
  const [tool, setTool] = useState("");
  const activeRun = React.useRef<string | null>(null);
  const runtimeRef = React.useRef<
    ReturnType<typeof createTicketAgent> | undefined
  >(undefined);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  React.useEffect(
    () =>
      store.subscribeEvents((event) => {
        if (event.type !== "ticket.status_changed") return;
        const runtime = runtimeRef.current;
        if (
          !runtime ||
          !activeRun.current ||
          !store.isInScope(activeRun.current, event.ticketId)
        )
          return;
        try {
          runtime.deliverExternalEvent(
            {
              id: event.id,
              source: event.source,
              type: event.type,
              ticketId: event.ticketId,
              payload: {
                previousStatus: event.previousStatus,
                status: event.status,
                occurredAt: event.occurredAt,
              },
            },
            "steer",
          );
        } catch {
          return;
        }
      }),
    [store],
  );

  const roots = board.tickets.filter((item) => !item.parentId);
  const ticket = board.tickets.find((item) => item.id === selected);
  const filtered = board.tickets.filter((item) =>
    `${item.title} ${item.description}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  const attempt = (action: () => void) => {
    try {
      action();
      setNotice("");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  };

  const start = async (target: Ticket) => {
    if (activeRun.current) {
      setNotice("An agent is already working. Stop that run first.");
      return;
    }
    if (!settings.endpoint || !settings.model) {
      setNotice("Connect an LLM backend before starting this ticket.");
      setConfiguring(true);
      return;
    }
    activeRun.current = target.id;
    let stopped = false;
    try {
      const apis = new ApiWorkspace(
        new ReleaseClient(settings.deployEndpoint, settings.deployToken),
        {
          taskQueued: (task) => store.linkDeployment(task),
          statusChanged: (event) => {
            store.handleExternalEvent(event);
            const task = store
              .getSnapshot()
              .deployments?.find((item) => item.id === event.taskId);
            if (!task || !runtimeRef.current) return;
            try {
              runtimeRef.current.deliverExternalEvent(
                {
                  id: event.id,
                  source: "deployment",
                  type: event.type,
                  ticketId: task.ticketId,
                  payload: {
                    taskId: event.taskId,
                    status: event.status,
                    occurredAt: event.occurredAt,
                    ...(event.error ? { error: event.error } : {}),
                  },
                },
                "steer",
              );
            } catch {
              return;
            }
          },
        },
      );
      const runtime = createTicketAgent({
        rootId: target.id,
        settings,
        board: store,
        apis,
        onEvent: (event) => {
          if (event.type === "tool_execution_start")
            setTool(event.toolName.replaceAll("_", " "));
        },
      });
      runtimeRef.current = runtime;
      store.moveTicket(target.id, "in_progress");
      store.addProgress(target.id, "Agent started.");
      setRunning({
        id: target.id,
        abort: () => {
          stopped = true;
          runtime.abort();
        },
      });
      setNotice("");
      await runtime.run(
        `Work on ticket ${target.id}: ${target.title}\n${target.description}`,
      );
      const last = runtime.agent.state.messages
        .filter((message) => message.role === "assistant")
        .at(-1);
      if (last?.role === "assistant") {
        const summary = last.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        if (summary) store.addProgress(target.id, summary);
      }
      store.moveTicket(target.id, stopped ? "ready" : "review");
      store.addProgress(
        target.id,
        stopped
          ? "Run stopped by you."
          : "Run finished. Review the result before marking this ticket done.",
      );
    } catch (error) {
      const message = stopped
        ? "Run stopped by you."
        : error instanceof Error
          ? error.message
          : String(error);
      attempt(() => {
        store.moveTicket(target.id, "ready");
        store.addProgress(target.id, message);
      });
      setNotice(message);
    } finally {
      activeRun.current = null;
      runtimeRef.current = undefined;
      setRunning(undefined);
      setTool("");
    }
  };

  const move = (target: Ticket, status: Status) => {
    if (activeRun.current && store.isInScope(activeRun.current, target.id)) {
      setNotice("Stop the active run before moving its ticket.");
      return;
    }
    if (status === "in_progress") {
      void start(target);
      return;
    }
    attempt(() => store.moveTicket(target.id, status));
    if (status === "ready") void start(target);
  };

  const dropTicket = ({ active, over }: DragEndEvent) => {
    if (!over || typeof over.id !== "string") return;
    const status = over.id.startsWith("column:")
      ? (over.id.slice(7) as Status)
      : undefined;
    const target = board.tickets.find((item) => item.id === active.id);
    if (!target || !status || target.status === status) return;
    move(target, status);
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <a className="brand" href="./" aria-label="Conclave home">
          <span className="brand-icon">
            <Orbit size={18} />
          </span>
          <span>conclave</span>
        </a>
        <div className="header-context">
          <strong>Agent board</strong>
          <span>{roots.length} tickets</span>
        </div>
        <div className="header-actions">
          <span className={`agent-indicator ${running ? "is-running" : ""}`}>
            <span />
            {running ? tool || "Working" : "Ready"}
          </span>
          {running && (
            <button className="quiet-button" onClick={running.abort}>
              <Square size={13} /> Stop
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Connection settings"
            onClick={() => setConfiguring(true)}
          >
            <Settings2 size={17} />
          </button>
          <button className="primary compact" onClick={() => setCreating(true)}>
            <Plus size={16} /> New ticket
          </button>
        </div>
      </header>

      <main className="main-shell">
        <section className="board-heading">
          <div>
            <h1>Work in motion</h1>
            <p>You set priorities. Agents break down and advance the work.</p>
          </div>
          <div className="board-stats">
            <span>
              <strong>
                {roots.filter((item) => item.status === "in_progress").length}
              </strong>{" "}
              active
            </span>
            <span>
              <strong>
                {roots.filter((item) => item.status === "review").length}
              </strong>{" "}
              review
            </span>
            <span>
              <strong>
                {roots.filter((item) => item.status === "done").length}
              </strong>{" "}
              done
            </span>
          </div>
        </section>

        {notice && (
          <div role="alert" className="notice">
            <span>{notice}</span>
            <button
              className="icon-button"
              aria-label="Dismiss"
              onClick={() => setNotice("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
        <section className="board-section" aria-labelledby="board-title">
          <header className="board-toolbar">
            <div className="board-title">
              <Columns3 size={16} />
              <h2 id="board-title">Board</h2>
            </div>
            <label className="search">
              <Search size={15} />
              <input
                aria-label="Search tickets"
                placeholder="Search tickets"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
          </header>
          <DndContext sensors={sensors} onDragEnd={dropTicket}>
            <div className="board">
              {columns.map((column) => {
                const tickets = filtered.filter(
                  (item) => item.status === column.id,
                );
                return (
                  <section className={`column ${column.id}`} key={column.id}>
                    <header>
                      <span className="column-dot" />
                      <h3>{column.label}</h3>
                      <span className="count">{tickets.length}</span>
                      {column.id === "backlog" && (
                        <button
                          className="icon-button small"
                          aria-label="Create ticket"
                          onClick={() => setCreating(true)}
                        >
                          <Plus size={14} />
                        </button>
                      )}
                    </header>
                    <BoardColumn status={column.id}>
                      {tickets.map((item) => (
                        <TicketCard
                          key={item.id}
                          ticket={item}
                          number={board.tickets.indexOf(item) + 1}
                          subtasks={
                            board.tickets.filter(
                              (child) => child.parentId === item.id,
                            ).length
                          }
                          parentTitle={
                            board.tickets.find(
                              (parent) => parent.id === item.parentId,
                            )?.title
                          }
                          select={() => setSelected(item.id)}
                        />
                      ))}
                      {!tickets.length && (
                        <div className="empty-column">No tickets</div>
                      )}
                    </BoardColumn>
                  </section>
                );
              })}
            </div>
          </DndContext>
        </section>
      </main>

      {creating && (
        <Modal title="Create ticket" close={() => setCreating(false)}>
          <p className="modal-intro">
            Describe the outcome clearly. Move it to Ready when the agent should
            begin.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              attempt(() => {
                store.createTicket(
                  String(data.get("title")),
                  String(data.get("description")),
                );
                setCreating(false);
              });
            }}
          >
            <label>
              Title
              <input
                name="title"
                placeholder="Outcome to deliver"
                required
                maxLength={200}
                autoFocus
              />
            </label>
            <label>
              Direction
              <textarea
                name="description"
                placeholder="Context, constraints, and definition of done"
                rows={4}
              />
            </label>
            <footer className="modal-actions">
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="primary" type="submit">
                <Plus size={15} /> Create
              </button>
            </footer>
          </form>
        </Modal>
      )}

      {configuring && (
        <Modal title="Connections" close={() => setConfiguring(false)}>
          <p className="modal-intro">
            Agent sessions remain in working memory. Deployment credentials stay
            in this browser session.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const endpoint = String(data.get("endpoint"));
              const deployEndpoint = String(data.get("deployEndpoint"));
              try {
                for (const value of [endpoint, deployEndpoint]) {
                  const url = new URL(value);
                  if (!["https:", "http:"].includes(url.protocol))
                    throw new Error();
                }
              } catch {
                setNotice("Enter valid HTTP or HTTPS endpoints.");
                return;
              }
              setSettings({
                endpoint,
                model: String(data.get("model")),
                token: String(data.get("token")),
                deployEndpoint,
                deployToken: String(data.get("deployToken")),
              });
              setConfiguring(false);
              setNotice("Connections updated.");
            }}
          >
            <label>
              Stream endpoint
              <input
                name="endpoint"
                type="url"
                required
                defaultValue={settings.endpoint}
              />
            </label>
            <label>
              Model ID
              <input name="model" required defaultValue={settings.model} />
            </label>
            <label>
              Access token <span className="muted">optional</span>
              <input
                name="token"
                type="password"
                autoComplete="off"
                defaultValue={settings.token}
              />
            </label>
            <label>
              Conclave server
              <input
                name="deployEndpoint"
                type="url"
                required
                defaultValue={settings.deployEndpoint}
              />
            </label>
            <label>
              Deployment token <span className="muted">optional</span>
              <input
                name="deployToken"
                type="password"
                autoComplete="off"
                defaultValue={settings.deployToken}
              />
            </label>
            <footer className="modal-actions">
              <button type="button" onClick={() => setConfiguring(false)}>
                Cancel
              </button>
              <button type="submit" className="primary">
                Save <ArrowUpRight size={15} />
              </button>
            </footer>
          </form>
        </Modal>
      )}

      {ticket && (
        <TicketDrawer title={ticket.title} close={() => setSelected(undefined)}>
          <p className="ticket-description">
            {ticket.description || "No direction added."}
          </p>
          <label className="field-label">
            Status
            <span className="select-control">
              <select
                value={ticket.status}
                disabled={Boolean(
                  running && store.isInScope(running.id, ticket.id),
                )}
                onChange={(event) => move(ticket, event.target.value as Status)}
              >
                {columns.map((column) => (
                  <option key={column.id} value={column.id}>
                    {column.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={15} aria-hidden="true" />
            </span>
          </label>
          <p className="field-hint">
            Ready starts the agent. Completed runs return here for review.
          </p>
          {ticket.status === "ready" && !running && (
            <button className="primary full" onClick={() => void start(ticket)}>
              Start agent <ArrowUpRight size={15} />
            </button>
          )}
          <h3 className="detail-heading">
            Subtasks{" "}
            <span>
              {
                board.tickets.filter((item) => item.parentId === ticket.id)
                  .length
              }
            </span>
          </h3>
          {board.tickets
            .filter((item) => item.parentId === ticket.id)
            .map((child) => (
              <button
                className="subtask"
                key={child.id}
                onClick={() => setSelected(child.id)}
              >
                {child.status === "done" ? (
                  <Check size={14} />
                ) : (
                  <Circle size={14} />
                )}
                <span>{child.title}</span>
                <small>
                  {columns.find((column) => column.id === child.status)?.label}
                </small>
              </button>
            ))}
          {!board.tickets.some((item) => item.parentId === ticket.id) && (
            <p className="muted">
              The agent can break this ticket into smaller steps.
            </p>
          )}
          <h3 className="detail-heading">
            Working data <span>{Object.keys(ticket.data).length}</span>
          </h3>
          <div className="ticket-data">
            {Object.entries(ticket.data).map(([key, value]) => (
              <article key={key}>
                <header>
                  <strong>{key}</strong>
                  <button
                    className="icon-button small"
                    aria-label={`Delete ${key}`}
                    onClick={() =>
                      attempt(() => store.deleteTicketData(ticket.id, key))
                    }
                  >
                    <Trash2 size={13} />
                  </button>
                </header>
                <pre>{value}</pre>
              </article>
            ))}
            {!Object.keys(ticket.data).length && (
              <p className="muted">Shared working context will appear here.</p>
            )}
          </div>
          <form
            className="ticket-data-form"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              attempt(() =>
                store.setTicketData(
                  ticket.id,
                  String(data.get("key")),
                  String(data.get("value")),
                ),
              );
              event.currentTarget.reset();
            }}
          >
            <label>
              Key
              <input
                name="key"
                required
                maxLength={64}
                placeholder="research"
              />
            </label>
            <label>
              Value
              <textarea
                name="value"
                maxLength={20000}
                rows={3}
                placeholder="Ticket-specific context"
              />
            </label>
            <button className="secondary full" type="submit">
              Save data
            </button>
          </form>
          <h3 className="detail-heading">Progress</h3>
          <div className="ticket-progress">
            {board.progress
              .filter((item) => item.ticketId === ticket.id)
              .map((item) => (
                <article key={item.id}>
                  <time>
                    {new Date(item.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  <p>{item.message}</p>
                </article>
              ))}
            {!board.progress.some((item) => item.ticketId === ticket.id) && (
              <p className="muted">No progress recorded yet.</p>
            )}
          </div>
        </TicketDrawer>
      )}
    </div>
  );
}
