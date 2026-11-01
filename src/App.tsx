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
  Circle,
  Columns3,
  Flag,
  GripVertical,
  LoaderCircle,
  Orbit,
  Pencil,
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
import { SelectControl } from "./components/SelectControl";
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
    <section
      ref={setNodeRef}
      className={`column ${status} ${isOver ? "is-over" : ""}`}
    >
      {children}
    </section>
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

interface NotionConnection {
  workspaceName: string;
  boardUrl: string | null;
  sessionToken: string;
  disconnect(): void;
}

export function App({
  store,
  notion,
  persistenceError,
}: {
  store: BoardStore;
  notion: NotionConnection;
  persistenceError?: string;
}) {
  const board = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [editingTicket, setEditingTicket] = useState(false);
  const [highlightedComment, setHighlightedComment] = useState<string>();
  const [configuring, setConfiguring] = useState(false);
  const [settings, setSettings] = useState<ConnectionSettings>({
    endpoint: "https://conclave.abbie.workers.dev/api/stream",
    model: "google/gemini-2.5-flash",
    token: "",
    deployEndpoint: "https://conclave.abbie.workers.dev",
  });
  const [running, setRunning] = useState<{ id: string; abort: () => void }>();
  const [notice, setNotice] = useState("");
  const [tool, setTool] = useState("");
  const activeRun = React.useRef<string | null>(null);
  const runtimeRef = React.useRef<
    ReturnType<typeof createTicketAgent> | undefined
  >(undefined);

  React.useEffect(() => {
    if (persistenceError) setNotice(`Notion save failed: ${persistenceError}`);
  }, [persistenceError]);

  React.useEffect(() => {
    if (!highlightedComment || !selected) return;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(`comment-${highlightedComment}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    const timer = window.setTimeout(
      () => setHighlightedComment(undefined),
      1000,
    );
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [highlightedComment, selected]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  React.useEffect(
    () =>
      store.subscribeEvents((event) => {
        if (event.type === "deployment.status_changed") return;
        const runtime = runtimeRef.current;
        if (
          !runtime ||
          !activeRun.current ||
          !store.isInScope(activeRun.current, event.ticketId)
        )
          return;
        try {
          if (event.type === "comment.added") {
            if (event.source !== "user") return;
            runtime.deliverExternalEvent(
              {
                id: event.id,
                source: event.source,
                type: event.type,
                ticketId: event.ticketId,
                payload: {
                  message: event.message,
                  attention: event.attention,
                  occurredAt: event.occurredAt,
                },
              },
              "steer",
            );
            return;
          }
          if (
            event.type !== "ticket.status_changed" ||
            event.source === "agent"
          )
            return;
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
  const attentionComments = board.comments
    .filter((comment) => comment.attention)
    .map((comment) => ({
      comment,
      ticket: board.tickets.find((item) => item.id === comment.ticketId),
    }))
    .filter((item): item is { comment: typeof item.comment; ticket: Ticket } =>
      Boolean(item.ticket),
    )
    .sort((left, right) => right.comment.createdAt - left.comment.createdAt);
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

  const settleInactiveSubtasks = (rootId: string) => {
    const snapshot = store.getSnapshot();
    const externallyActive = new Set(
      (snapshot.deployments ?? [])
        .filter(
          (deployment) =>
            deployment.status === "queued" ||
            deployment.status === "in_progress",
        )
        .map((deployment) => deployment.ticketId),
    );
    for (const candidate of snapshot.tickets) {
      if (
        candidate.parentId &&
        candidate.status === "in_progress" &&
        store.isInScope(rootId, candidate.id) &&
        !externallyActive.has(candidate.id)
      )
        store.updateSubtask(
          candidate.id,
          "review",
          "The agent run ended without an active deployment. Review this subtask before continuing.",
        );
    }
  };

  const start = async (target: Ticket, followUp?: string) => {
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
        new ReleaseClient(settings.deployEndpoint, notion.sessionToken),
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
      store.addComment(target.id, "Agent started.", "system");
      setRunning({
        id: target.id,
        abort: () => {
          stopped = true;
          runtime.abort();
        },
      });
      setNotice("");
      const current = store.readTicket(target.id);
      const subtasks = store.listSubtasks(target.id);
      await runtime.run(
        [
          `Current ticket context:\n${JSON.stringify(current, null, 2)}`,
          `Direct subtask index:\n${JSON.stringify(subtasks, null, 2)}`,
          followUp
            ? `User follow-up:\n${followUp}`
            : "Assess and work on this ticket.",
        ].join("\n\n"),
      );
      const last = runtime.agent.state.messages
        .filter((message) => message.role === "assistant")
        .at(-1);
      if (last?.role === "assistant") {
        const summary = last.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        if (summary) store.addComment(target.id, summary, "agent");
      }
      settleInactiveSubtasks(target.id);
      const finalStatus = store.readTicket(target.id).status;
      if (stopped) store.moveTicket(target.id, "ready", "agent");
      else if (finalStatus === "ready" || finalStatus === "in_progress")
        store.moveTicket(target.id, "review", "agent");
      store.addComment(
        target.id,
        stopped
          ? "Run stopped by you."
          : "Run finished. Review the result before marking this ticket done.",
        "system",
      );
    } catch (error) {
      const message = stopped
        ? "Run stopped by you."
        : error instanceof Error
          ? error.message
          : String(error);
      attempt(() => {
        settleInactiveSubtasks(target.id);
        store.moveTicket(target.id, stopped ? "ready" : "review", "agent");
        store.addComment(target.id, message, "system");
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
      attempt(() => store.moveTicket(target.id, status));
      void start({ ...target, status });
      return;
    }
    attempt(() => store.moveTicket(target.id, status));
    if (status === "ready") void start({ ...target, status });
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
        {attentionComments.length > 0 && (
          <section
            className="attention-panel"
            aria-labelledby="attention-title"
          >
            <header>
              <Flag size={15} />
              <h2 id="attention-title">Attention needed</h2>
              <span>{attentionComments.length}</span>
            </header>
            <div className="attention-list">
              {attentionComments.map(({ comment, ticket: target }) => (
                <button
                  key={comment.id}
                  onClick={() => {
                    setEditingTicket(false);
                    setSelected(target.id);
                    setHighlightedComment(comment.id);
                  }}
                >
                  <strong>{target.title}</strong>
                  <span>{comment.message}</span>
                  <time>
                    {new Date(comment.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </button>
              ))}
            </div>
          </section>
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
                  <BoardColumn status={column.id} key={column.id}>
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
                    <div className="cards">
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
                          select={() => {
                            setEditingTicket(false);
                            setSelected(item.id);
                          }}
                        />
                      ))}
                      {!tickets.length && (
                        <div className="empty-column">No tickets</div>
                      )}
                    </div>
                  </BoardColumn>
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
              Description
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
            Agent sessions remain in working memory. Notion authorizes board and
            deployment access.
          </p>
          <div className="notion-connection">
            <div>
              <span className="muted">Notion workspace</span>
              <strong>{notion.workspaceName}</strong>
            </div>
            {notion.boardUrl && (
              <a href={notion.boardUrl} target="_blank" rel="noreferrer">
                Open board <ArrowUpRight size={14} />
              </a>
            )}
            <button type="button" onClick={notion.disconnect}>
              Disconnect
            </button>
          </div>
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
        <TicketDrawer
          title={ticket.title}
          action={
            <button
              className="icon-button"
              aria-label="Edit ticket"
              onClick={() => setEditingTicket((value) => !value)}
            >
              <Pencil size={15} />
            </button>
          }
          close={() => {
            setEditingTicket(false);
            setSelected(undefined);
          }}
        >
          {editingTicket ? (
            <form
              className="ticket-edit-form"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                attempt(() => {
                  const updated = store.updateTicket(
                    ticket.id,
                    String(data.get("title")),
                    String(data.get("description")),
                  );
                  setEditingTicket(false);
                  if (!activeRun.current && updated.status === "review")
                    void start(
                      updated,
                      "The user updated the ticket title or description.",
                    );
                });
              }}
            >
              <label>
                Title
                <input
                  name="title"
                  required
                  maxLength={200}
                  defaultValue={ticket.title}
                />
              </label>
              <label>
                Description
                <textarea
                  name="description"
                  rows={5}
                  defaultValue={ticket.description}
                />
              </label>
              <button className="secondary full" type="submit">
                Save ticket
              </button>
            </form>
          ) : (
            <p className="ticket-description">
              {ticket.description || "No description added."}
            </p>
          )}
          <label className="field-label">
            Status
            <SelectControl
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
            </SelectControl>
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
                onClick={() => {
                  setEditingTicket(false);
                  setSelected(child.id);
                }}
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
            Agent data <span>{Object.keys(ticket.data).length}</span>
          </h3>
          <div className="ticket-data">
            {Object.entries(ticket.data).map(([key, value]) => (
              <article key={key}>
                <header>
                  <strong>{key}</strong>
                </header>
                <pre>{value}</pre>
              </article>
            ))}
            {!Object.keys(ticket.data).length && (
              <p className="muted">Agent key-value context will appear here.</p>
            )}
          </div>
          <h3 className="detail-heading">Comments</h3>
          <form
            className="comment-form"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              const message = String(data.get("comment"));
              try {
                store.addComment(ticket.id, message, "user");
                event.currentTarget.reset();
                setNotice("");
                if (!activeRun.current && ticket.status === "review")
                  void start(store.readTicket(ticket.id), message);
              } catch (error) {
                setNotice(
                  error instanceof Error ? error.message : String(error),
                );
              }
            }}
          >
            <textarea
              name="comment"
              rows={3}
              required
              placeholder="Add context or a note for the agent"
            />
            <button className="secondary full" type="submit">
              Add comment
            </button>
          </form>
          <div className="ticket-comments">
            {board.comments
              .filter((item) => item.ticketId === ticket.id)
              .map((item) => (
                <article
                  id={`comment-${item.id}`}
                  className={
                    highlightedComment === item.id ? "is-highlighted" : ""
                  }
                  key={item.id}
                >
                  <time>
                    {item.attention && (
                      <Flag size={10} aria-label="Attention needed" />
                    )}
                    {new Date(item.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                  <p>{item.message}</p>
                </article>
              ))}
            {!board.comments.some((item) => item.ticketId === ticket.id) && (
              <p className="muted">No comments yet.</p>
            )}
          </div>
          {ticket.status === "backlog" && (
            <button
              className="danger-button full"
              onClick={() => {
                if (
                  !window.confirm("Delete this ticket and all of its subtasks?")
                )
                  return;
                attempt(() => {
                  store.deleteTicket(ticket.id);
                  setEditingTicket(false);
                  setSelected(undefined);
                });
              }}
            >
              <Trash2 size={14} /> Delete ticket
            </button>
          )}
        </TicketDrawer>
      )}
    </div>
  );
}
