import {
  transitionDeployment,
  validateQueuedTask,
  type DeploymentTask,
  type DeploymentStatusEvent,
} from "../domain/api-units";

export const statuses = [
  "backlog",
  "ready",
  "in_progress",
  "review",
  "done",
] as const;
export type Status = (typeof statuses)[number];

export interface Ticket {
  id: string;
  title: string;
  description: string;
  status: Status;
  parentId?: string;
  createdAt: number;
  data: Record<string, string>;
}

export interface TicketComment {
  id: string;
  ticketId: string;
  message: string;
  createdAt: number;
}

export interface TicketStatusEvent {
  type: "ticket.status_changed";
  id: string;
  ticketId: string;
  previousStatus: Status;
  status: Status;
  source: "user" | "agent" | "deployment";
  occurredAt: number;
}

export interface CommentAddedEvent {
  type: "comment.added";
  id: string;
  ticketId: string;
  message: string;
  source: "user" | "agent" | "system";
  occurredAt: number;
}

export type BoardEvent =
  TicketStatusEvent | CommentAddedEvent | DeploymentStatusEvent;

export interface BoardState {
  tickets: Ticket[];
  comments: TicketComment[];
  deployments?: DeploymentTask[];
}

export type BoardSaver = (state: BoardState) => Promise<void>;

function requiredText(value: string, name: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required`);
  return value.trim();
}

function validStatus(value: string): asserts value is Status {
  if (!statuses.includes(value as Status))
    throw new Error("Unknown ticket status");
}

function freeze(state: BoardState): BoardState {
  state.tickets.forEach((ticket) => {
    Object.freeze(ticket.data);
    Object.freeze(ticket);
  });
  state.comments.forEach(Object.freeze);
  Object.freeze(state.tickets);
  Object.freeze(state.comments);
  state.deployments?.forEach(Object.freeze);
  if (state.deployments) Object.freeze(state.deployments);
  return Object.freeze(state);
}

export function parseBoardState(state: unknown): BoardState {
  if (
    !state ||
    typeof state !== "object" ||
    !("tickets" in state) ||
    !("comments" in state)
  )
    throw new Error("Invalid saved board");
  const { tickets, comments } = state;
  if (!Array.isArray(tickets) || !Array.isArray(comments))
    throw new Error("Invalid saved board");
  const ids = new Set<string>();
  for (const ticket of tickets) {
    if (
      !ticket ||
      typeof ticket.id !== "string" ||
      !ticket.id ||
      ids.has(ticket.id) ||
      typeof ticket.title !== "string" ||
      !ticket.title.trim() ||
      typeof ticket.description !== "string" ||
      !Number.isFinite(ticket.createdAt)
    )
      throw new Error("Invalid saved ticket");
    validStatus(ticket.status);
    const data = ticket.data ?? {};
    if (
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.entries(data).some(
        ([key, entry]) =>
          !key.trim() ||
          key.length > 64 ||
          typeof entry !== "string" ||
          entry.length > 20_000,
      )
    )
      throw new Error("Invalid ticket data");
    if (ticket.parentId !== undefined && typeof ticket.parentId !== "string")
      throw new Error("Invalid saved parent");
    ids.add(ticket.id);
  }
  for (const ticket of tickets) {
    const visited = new Set<string>([ticket.id]);
    let parentId = ticket.parentId;
    while (parentId !== undefined) {
      if (!ids.has(parentId) || visited.has(parentId))
        throw new Error("Invalid ticket hierarchy");
      visited.add(parentId);
      parentId = tickets.find(
        (candidate) => candidate.id === parentId,
      )?.parentId;
    }
  }
  const commentIds = new Set<string>();
  for (const entry of comments) {
    if (
      !entry ||
      typeof entry.id !== "string" ||
      !entry.id ||
      commentIds.has(entry.id) ||
      !ids.has(entry.ticketId) ||
      typeof entry.message !== "string" ||
      !entry.message.trim() ||
      !Number.isFinite(entry.createdAt)
    )
      throw new Error("Invalid saved comment");
    commentIds.add(entry.id);
  }
  const deployments = "deployments" in state ? state.deployments : [];
  if (!Array.isArray(deployments)) throw new Error("Invalid saved deployments");
  for (const task of deployments) {
    if (
      !task ||
      typeof task.id !== "string" ||
      !ids.has(task.ticketId) ||
      !["queued", "in_progress", "succeeded", "failed"].includes(task.status) ||
      !Number.isFinite(task.updatedAt)
    )
      throw new Error("Invalid saved deployment");
  }
  return {
    tickets: tickets.map((ticket) => ({ ...ticket, data: ticket.data ?? {} })),
    comments,
    deployments,
  };
}

export class BoardStore {
  private state: BoardState;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(event: BoardEvent) => void>();
  private errorListeners = new Set<(error: Error) => void>();
  private saves = Promise.resolve();

  constructor(
    initialState: BoardState = { tickets: [], comments: [], deployments: [] },
    private save?: BoardSaver,
  ) {
    const state = parseBoardState(initialState);
    const externallyRunning = new Set(
      (state.deployments ?? [])
        .filter(
          (task) => task.status === "queued" || task.status === "in_progress",
        )
        .map((task) => task.ticketId),
    );
    const interrupted = state.tickets.filter(
      (ticket) =>
        ticket.status === "in_progress" && !externallyRunning.has(ticket.id),
    );
    const interruptedIds = new Set(interrupted.map((ticket) => ticket.id));
    this.state = freeze({
      deployments: state.deployments ?? [],
      tickets: state.tickets.map((ticket) =>
        interruptedIds.has(ticket.id)
          ? { ...ticket, status: "backlog" }
          : { ...ticket, data: { ...ticket.data } },
      ),
      comments: [
        ...state.comments,
        ...interrupted.map((ticket) => ({
          id: crypto.randomUUID(),
          ticketId: ticket.id,
          message:
            "Run interrupted when the page closed. Move this ticket to Ready to start again.",
          createdAt: Date.now(),
        })),
      ],
    });
    if (interrupted.length) this.persist(this.state);
  }

  getSnapshot = (): BoardState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  subscribeEvents = (listener: (event: BoardEvent) => void): (() => void) => {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  };

  subscribeErrors = (listener: (error: Error) => void): (() => void) => {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  };

  whenSaved = (): Promise<void> => this.saves;

  private persist(state: BoardState): void {
    if (!this.save) return;
    const operation = this.saves.then(() => this.save?.(state));
    this.saves = operation.catch((error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.errorListeners.forEach((listener) => listener(failure));
    });
  }

  private emit(event: BoardEvent): void {
    this.eventListeners.forEach((listener) => listener(event));
  }

  private statusEvent(
    previous: Ticket,
    ticket: Ticket,
    source: TicketStatusEvent["source"],
  ): void {
    if (previous.status !== ticket.status)
      this.emit({
        type: "ticket.status_changed",
        id: crypto.randomUUID(),
        ticketId: ticket.id,
        previousStatus: previous.status,
        status: ticket.status,
        source,
        occurredAt: Date.now(),
      });
  }

  private commit(state: BoardState): void {
    this.state = freeze(state);
    this.listeners.forEach((listener) => listener());
    this.persist(this.state);
  }

  private ticket(id: string): Ticket {
    const ticket = this.state.tickets.find((candidate) => candidate.id === id);
    if (!ticket) throw new Error("Ticket not found");
    return ticket;
  }

  createTicket(title: string, description: string): Ticket {
    return this.create(title, description);
  }

  private create(
    title: string,
    description: string,
    parentId?: string,
  ): Ticket {
    if (typeof description !== "string")
      throw new Error("Description must be text");
    const ticket: Ticket = {
      id: crypto.randomUUID(),
      title: requiredText(title, "Title"),
      description: description.trim(),
      status: "backlog",
      createdAt: Date.now(),
      data: {},
      ...(parentId ? { parentId } : {}),
    };
    this.commit({ ...this.state, tickets: [...this.state.tickets, ticket] });
    return { ...ticket };
  }

  moveTicket(
    id: string,
    status: Status,
    source: TicketStatusEvent["source"] = "user",
  ): Ticket {
    validStatus(status);
    const previous = this.ticket(id);
    const ticket = { ...previous, status };
    this.commit({
      ...this.state,
      tickets: this.state.tickets.map((candidate) =>
        candidate.id === id ? ticket : candidate,
      ),
    });
    this.statusEvent(previous, ticket, source);
    return { ...ticket };
  }

  listTickets(): Ticket[] {
    return this.state.tickets.map((ticket) => ({
      ...ticket,
      data: { ...ticket.data },
    }));
  }

  readTicket(id: string): Ticket & {
    comments: TicketComment[];
    deployments: DeploymentTask[];
  } {
    const ticket = this.ticket(id);
    return {
      ...ticket,
      data: { ...ticket.data },
      comments: this.state.comments
        .filter((comment) => comment.ticketId === id)
        .map((comment) => ({ ...comment })),
      deployments: (this.state.deployments ?? [])
        .filter((deployment) => deployment.ticketId === id)
        .map((deployment) => ({ ...deployment })),
    };
  }

  updateTicket(id: string, title: string, description: string): Ticket {
    const previous = this.ticket(id);
    if (typeof description !== "string")
      throw new Error("Description must be text");
    const ticket = {
      ...previous,
      title: requiredText(title, "Title"),
      description: description.trim(),
    };
    if (
      ticket.title === previous.title &&
      ticket.description === previous.description
    )
      return { ...ticket, data: { ...ticket.data } };
    const entry = {
      id: crypto.randomUUID(),
      ticketId: id,
      message: "Ticket title or description was updated.",
      createdAt: Date.now(),
    };
    this.commit({
      ...this.state,
      tickets: this.state.tickets.map((candidate) =>
        candidate.id === id ? ticket : candidate,
      ),
      comments: [...this.state.comments, entry],
    });
    this.emit({
      type: "comment.added",
      id: crypto.randomUUID(),
      ticketId: id,
      message: entry.message,
      source: "user",
      occurredAt: entry.createdAt,
    });
    return { ...ticket, data: { ...ticket.data } };
  }

  deleteTicket(id: string): void {
    const ticket = this.ticket(id);
    if (ticket.status !== "backlog")
      throw new Error("Only backlog tickets can be deleted");
    const removed = new Set<string>([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const candidate of this.state.tickets) {
        if (
          candidate.parentId &&
          removed.has(candidate.parentId) &&
          !removed.has(candidate.id)
        ) {
          removed.add(candidate.id);
          changed = true;
        }
      }
    }
    this.commit({
      tickets: this.state.tickets.filter((item) => !removed.has(item.id)),
      comments: this.state.comments.filter(
        (comment) => !removed.has(comment.ticketId),
      ),
      deployments: (this.state.deployments ?? []).filter(
        (deployment) => !removed.has(deployment.ticketId),
      ),
    });
  }

  setTicketData(ticketId: string, key: string, value: string): Ticket {
    const previous = this.ticket(ticketId);
    const normalizedKey = requiredText(key, "Data key");
    if (normalizedKey.length > 64) throw new Error("Data key is too long");
    if (typeof value !== "string") throw new Error("Data value must be text");
    if (value.length > 20_000) throw new Error("Data value is too long");
    const ticket = {
      ...previous,
      data: { ...previous.data, [normalizedKey]: value },
    };
    this.commit({
      ...this.state,
      tickets: this.state.tickets.map((candidate) =>
        candidate.id === ticketId ? ticket : candidate,
      ),
    });
    return { ...ticket, data: { ...ticket.data } };
  }

  deleteTicketData(ticketId: string, key: string): Ticket {
    const previous = this.ticket(ticketId);
    const normalizedKey = requiredText(key, "Data key");
    const data = { ...previous.data };
    delete data[normalizedKey];
    const ticket = { ...previous, data };
    this.commit({
      ...this.state,
      tickets: this.state.tickets.map((candidate) =>
        candidate.id === ticketId ? ticket : candidate,
      ),
    });
    return { ...ticket, data: { ...ticket.data } };
  }

  createSubtask(parentId: string, title: string, description: string): Ticket {
    this.ticket(parentId);
    return this.create(title, description, parentId);
  }

  updateSubtask(id: string, status: Status, summary?: string): Ticket {
    const previous = this.ticket(id);
    if (!previous.parentId)
      throw new Error("Only subtasks can be updated by this tool");
    validStatus(status);
    const message =
      summary === undefined ? undefined : requiredText(summary, "Summary");
    const ticket = { ...previous, status };
    this.commit({
      ...this.state,
      tickets: this.state.tickets.map((candidate) =>
        candidate.id === id ? ticket : candidate,
      ),
      comments: message
        ? [
            ...this.state.comments,
            {
              id: crypto.randomUUID(),
              ticketId: id,
              message,
              createdAt: Date.now(),
            },
          ]
        : this.state.comments,
    });
    this.statusEvent(previous, ticket, "agent");
    return { ...ticket };
  }

  addComment(
    ticketId: string,
    message: string,
    source: CommentAddedEvent["source"] = "user",
  ): TicketComment {
    this.ticket(ticketId);
    const entry = {
      id: crypto.randomUUID(),
      ticketId,
      message: requiredText(message, "Comment"),
      createdAt: Date.now(),
    };
    this.commit({ ...this.state, comments: [...this.state.comments, entry] });
    this.emit({
      type: "comment.added",
      id: crypto.randomUUID(),
      ticketId,
      message: entry.message,
      source,
      occurredAt: entry.createdAt,
    });
    return { ...entry };
  }

  linkDeployment(task: DeploymentTask): DeploymentTask {
    validateQueuedTask(task);
    const previous = this.ticket(task.ticketId);
    if (!previous.parentId)
      throw new Error("Deployments must be linked to a subtask");
    const deployments = this.state.deployments ?? [];
    if (deployments.some((item) => item.id === task.id))
      throw new Error("Deployment task already linked");
    if (
      deployments.some(
        (item) =>
          item.ticketId === task.ticketId &&
          ["queued", "in_progress"].includes(item.status),
      )
    )
      throw new Error("Subtask already has an active deployment");
    const ticket = { ...previous, status: "ready" as const };
    this.commit({
      ...this.state,
      tickets: this.state.tickets.map((item) =>
        item.id === ticket.id ? ticket : item,
      ),
      deployments: [...deployments, { ...task }],
    });
    this.statusEvent(previous, ticket, "deployment");
    this.emit({
      type: "deployment.status_changed",
      id: crypto.randomUUID(),
      taskId: task.id,
      status: "queued",
      occurredAt: task.updatedAt,
    });
    return { ...task };
  }

  handleExternalEvent(event: DeploymentStatusEvent): void {
    const deployments = this.state.deployments ?? [];
    const task = deployments.find((item) => item.id === event.taskId);
    if (!task) throw new Error("Deployment task not linked");
    const updated = transitionDeployment(task, event);
    if (updated === task) return;
    const previous = this.ticket(task.ticketId);
    const status: Status =
      updated.status === "succeeded"
        ? "done"
        : updated.status === "failed"
          ? "review"
          : "in_progress";
    const ticket = { ...previous, status };
    const message =
      updated.status === "failed"
        ? `Deployment failed: ${updated.error}`
        : `Deployment ${updated.status.replaceAll("_", " ")}.`;
    this.commit({
      ...this.state,
      tickets: this.state.tickets.map((item) =>
        item.id === ticket.id ? ticket : item,
      ),
      deployments: deployments.map((item) =>
        item.id === updated.id ? updated : item,
      ),
      comments: [
        ...this.state.comments,
        {
          id: crypto.randomUUID(),
          ticketId: ticket.id,
          message,
          createdAt: event.occurredAt,
        },
      ],
    });
    this.statusEvent(previous, ticket, "deployment");
    this.emit({ ...event });
  }

  isInScope(rootId: string, ticketId: string): boolean {
    let ticket = this.state.tickets.find(
      (candidate) => candidate.id === ticketId,
    );
    while (ticket) {
      if (ticket.id === rootId) return true;
      ticket = this.state.tickets.find(
        (candidate) => candidate.id === ticket?.parentId,
      );
    }
    return false;
  }
}
