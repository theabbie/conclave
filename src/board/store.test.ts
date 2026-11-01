import { describe, expect, it } from "vitest";
import { BoardStore } from "./store";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("BoardStore", () => {
  it("keeps snapshots stable until a mutation and notifies subscribers", () => {
    const board = new BoardStore();
    const first = board.getSnapshot();
    let notifications = 0;
    const unsubscribe = board.subscribe(() => {
      notifications++;
    });
    expect(board.getSnapshot()).toBe(first);
    const ticket = board.createTicket(" Ship it ", " Description ");
    expect(ticket.title).toBe("Ship it");
    expect(board.getSnapshot()).not.toBe(first);
    expect(first.tickets).toEqual([]);
    expect(notifications).toBe(1);
    unsubscribe();
    board.moveTicket(ticket.id, "ready");
    expect(notifications).toBe(1);
  });

  it("scopes nested subtasks to their own root and protects root updates", () => {
    const board = new BoardStore();
    const root = board.createTicket("Root", "");
    const other = board.createTicket("Other", "");
    const child = board.createSubtask(root.id, "Child", "");
    const grandchild = board.createSubtask(child.id, "Grandchild", "");
    expect(board.isInScope(root.id, grandchild.id)).toBe(true);
    expect(board.isInScope(other.id, grandchild.id)).toBe(false);
    expect(board.isInScope("missing", "missing")).toBe(false);
    expect(() => board.updateSubtask(root.id, "done")).toThrow("Only subtasks");
    expect(() => board.createSubtask("missing", "Child", "")).toThrow(
      "Ticket not found",
    );
    board.updateSubtask(child.id, "done", "Implemented");
    expect(board.readTicket(child.id).status).toBe("done");
    expect(board.getSnapshot().progress[0].message).toBe("Implemented");
  });

  it("restores saved data and makes interrupted runs require explicit restart", () => {
    const storage = memoryStorage();
    const board = new BoardStore(storage);
    const ticket = board.createTicket("Task", "");
    board.moveTicket(ticket.id, "in_progress");
    const restored = new BoardStore(storage);
    expect(restored.readTicket(ticket.id).status).toBe("backlog");
    expect(restored.getSnapshot().progress).toHaveLength(1);
    expect(new BoardStore(storage).getSnapshot().progress).toHaveLength(1);
  });

  it("persists isolated ticket data and returns defensive copies", () => {
    const storage = memoryStorage();
    const board = new BoardStore(storage);
    const ticket = board.createTicket("Task", "");
    board.setTicketData(ticket.id, "research", "Verified result");
    const copy = board.readTicket(ticket.id);
    expect(copy.data).toEqual({ research: "Verified result" });
    copy.data.research = "Changed";
    expect(board.readTicket(ticket.id).data.research).toBe("Verified result");
    expect(new BoardStore(storage).readTicket(ticket.id).data).toEqual({
      research: "Verified result",
    });
    board.deleteTicketData(ticket.id, "research");
    expect(board.readTicket(ticket.id).data).toEqual({});
  });

  it("does not mutate state when persistence fails", () => {
    const board = new BoardStore({
      getItem: () => null,
      setItem: () => {
        throw new Error("Storage full");
      },
    });
    expect(() => board.createTicket("Task", "")).toThrow("Storage full");
    expect(board.listTickets()).toEqual([]);
  });

  it("rejects malformed hierarchy and invalid input without partial changes", () => {
    const storage = memoryStorage();
    storage.setItem(
      "conclave.board.v1",
      JSON.stringify({
        tickets: [
          {
            id: "a",
            parentId: "a",
            title: "Cycle",
            description: "",
            status: "backlog",
            createdAt: 1,
          },
        ],
        progress: [],
      }),
    );
    expect(() => new BoardStore(storage)).toThrow("Invalid ticket hierarchy");
    const board = new BoardStore();
    expect(() => board.createTicket(" ", "")).toThrow("Title is required");
    const ticket = board.createTicket("Root", "");
    const child = board.createSubtask(ticket.id, "Child", "");
    expect(() => board.updateSubtask(child.id, "done", " ")).toThrow(
      "Summary is required",
    );
    expect(board.readTicket(child.id).status).toBe("backlog");
    const copy = board.readTicket(ticket.id);
    copy.title = "Changed";
    expect(board.readTicket(ticket.id).title).toBe("Root");
  });
});

describe("deployment events", () => {
  it("updates linked subtasks from external events and publishes genuine manual changes", () => {
    const board = new BoardStore();
    const root = board.createTicket("Root", "");
    const subtask = board.createSubtask(root.id, "Deploy", "");
    const events: import("./store").BoardEvent[] = [];
    board.subscribeEvents((event) => events.push(event));
    board.linkDeployment({
      id: "task",
      unitId: "unit",
      ticketId: subtask.id,
      status: "queued",
      createdAt: 1,
      updatedAt: 1,
    });
    board.handleExternalEvent({
      type: "deployment.status_changed",
      id: "started",
      taskId: "task",
      status: "in_progress",
      occurredAt: 2,
    });
    expect(board.readTicket(subtask.id).status).toBe("in_progress");
    board.handleExternalEvent({
      type: "deployment.status_changed",
      id: "done",
      taskId: "task",
      status: "succeeded",
      occurredAt: 3,
    });
    expect(board.readTicket(subtask.id).status).toBe("done");
    expect(board.readTicket(root.id).status).toBe("backlog");
    const count = events.length;
    board.handleExternalEvent({
      type: "deployment.status_changed",
      id: "duplicate",
      taskId: "task",
      status: "succeeded",
      occurredAt: 3,
    });
    expect(events).toHaveLength(count);
    board.moveTicket(subtask.id, "review");
    expect(events.at(-1)).toMatchObject({
      type: "ticket.status_changed",
      source: "user",
      previousStatus: "done",
      status: "review",
    });
    expect(board.getSnapshot().deployments?.[0].status).toBe("succeeded");
  });

  it("moves failures to review with the error and prevents root or concurrent links", () => {
    const board = new BoardStore();
    const root = board.createTicket("Root", "");
    const subtask = board.createSubtask(root.id, "Deploy", "");
    const task = {
      id: "task",
      unitId: "unit",
      ticketId: subtask.id,
      status: "queued" as const,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(() => board.linkDeployment({ ...task, ticketId: root.id })).toThrow(
      "subtask",
    );
    board.linkDeployment(task);
    expect(() => board.linkDeployment({ ...task, id: "second" })).toThrow(
      "active deployment",
    );
    board.handleExternalEvent({
      type: "deployment.status_changed",
      id: "failed",
      taskId: "task",
      status: "failed",
      occurredAt: 2,
      error: "Build rejected",
    });
    expect(board.readTicket(subtask.id).status).toBe("review");
    expect(board.getSnapshot().progress.at(-1)?.message).toContain(
      "Build rejected",
    );
  });
});

it("keeps external deployments active across reload without persisting an agent session", () => {
  const storage = memoryStorage();
  const board = new BoardStore(storage);
  const root = board.createTicket("Root", "");
  const child = board.createSubtask(root.id, "Deploy", "");
  board.linkDeployment({
    id: "task",
    unitId: "unit",
    ticketId: child.id,
    status: "queued",
    createdAt: 1,
    updatedAt: 1,
  });
  board.handleExternalEvent({
    type: "deployment.status_changed",
    id: "start",
    taskId: "task",
    status: "in_progress",
    occurredAt: 2,
  });
  const restored = new BoardStore(storage);
  expect(restored.readTicket(child.id).status).toBe("in_progress");
  restored.handleExternalEvent({
    type: "deployment.status_changed",
    id: "end",
    taskId: "task",
    status: "succeeded",
    occurredAt: 3,
  });
  expect(restored.readTicket(child.id).status).toBe("done");
});
