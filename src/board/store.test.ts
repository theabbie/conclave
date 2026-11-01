import { describe, expect, it } from "vitest";
import { BoardStore, type BoardState } from "./store";

function memoryPersistence() {
  let state: BoardState = { tickets: [], comments: [], deployments: [] };
  return {
    load: () => structuredClone(state),
    save: async (next: BoardState) => {
      state = structuredClone(next);
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
    expect(board.getSnapshot().comments[0].message).toBe("Implemented");
    expect(board.listSubtasks(root.id)).toEqual([
      { id: child.id, title: "Child", status: "done" },
    ]);
  });

  it("updates ticket metadata and records it in the shared comment stream", () => {
    const board = new BoardStore();
    const ticket = board.createTicket("Draft", "Old description");
    board.updateTicket(ticket.id, "Final", "New description");
    expect(board.readTicket(ticket.id)).toMatchObject({
      title: "Final",
      description: "New description",
    });
    expect(board.getSnapshot().comments).toMatchObject([
      {
        ticketId: ticket.id,
        message: "Ticket title or description was updated.",
      },
    ]);
  });

  it("includes comments in ticket reads and emits user comment events", () => {
    const board = new BoardStore();
    const ticket = board.createTicket("Task", "");
    const events: import("./store").BoardEvent[] = [];
    board.subscribeEvents((event) => events.push(event));
    board.addComment(ticket.id, "New requirement", "user");
    expect(board.readTicket(ticket.id).comments).toMatchObject([
      { message: "New requirement" },
    ]);
    expect(events).toMatchObject([
      {
        type: "comment.added",
        ticketId: ticket.id,
        message: "New requirement",
        source: "user",
      },
    ]);
  });

  it("deletes only backlog tickets and removes their complete subtree", () => {
    const board = new BoardStore();
    const root = board.createTicket("Root", "");
    const child = board.createSubtask(root.id, "Child", "");
    board.addComment(child.id, "Nested context");
    board.deleteTicket(root.id);
    expect(board.listTickets()).toEqual([]);
    expect(board.getSnapshot().comments).toEqual([]);

    const active = board.createTicket("Active", "");
    board.moveTicket(active.id, "ready");
    expect(() => board.deleteTicket(active.id)).toThrow("Only backlog");
  });

  it("restores saved data and makes interrupted runs require explicit restart", async () => {
    const persistence = memoryPersistence();
    const board = new BoardStore(persistence.load(), persistence.save);
    const ticket = board.createTicket("Task", "");
    board.moveTicket(ticket.id, "in_progress");
    await board.whenSaved();
    const restored = new BoardStore(persistence.load(), persistence.save);
    expect(restored.readTicket(ticket.id).status).toBe("backlog");
    expect(restored.getSnapshot().comments).toHaveLength(1);
    await restored.whenSaved();
    expect(
      new BoardStore(persistence.load()).getSnapshot().comments,
    ).toHaveLength(1);
  });

  it("persists isolated ticket data and returns defensive copies", async () => {
    const persistence = memoryPersistence();
    const board = new BoardStore(persistence.load(), persistence.save);
    const ticket = board.createTicket("Task", "");
    board.setTicketData(ticket.id, "research", "Verified result");
    const copy = board.readTicket(ticket.id);
    expect(copy.data).toEqual({ research: "Verified result" });
    copy.data.research = "Changed";
    expect(board.readTicket(ticket.id).data.research).toBe("Verified result");
    await board.whenSaved();
    expect(
      new BoardStore(persistence.load()).readTicket(ticket.id).data,
    ).toEqual({
      research: "Verified result",
    });
    board.deleteTicketData(ticket.id, "research");
    expect(board.readTicket(ticket.id).data).toEqual({});
  });

  it("reports persistence failures without losing the working state", async () => {
    const board = new BoardStore(undefined, async () => {
      throw new Error("Notion unavailable");
    });
    let message = "";
    board.subscribeErrors((error) => {
      message = error.message;
    });
    board.createTicket("Task", "");
    await board.whenSaved();
    expect(message).toBe("Notion unavailable");
    expect(board.listTickets()).toHaveLength(1);
  });

  it("rejects malformed hierarchy and invalid input without partial changes", () => {
    const malformed = {
      tickets: [
        {
          id: "a",
          parentId: "a",
          title: "Cycle",
          description: "",
          status: "backlog",
          createdAt: 1,
          data: {},
        },
      ],
      comments: [],
    } as BoardState;
    expect(() => new BoardStore(malformed)).toThrow("Invalid ticket hierarchy");
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
    expect(board.getSnapshot().comments.at(-1)?.message).toContain(
      "Build rejected",
    );
  });
});

it("keeps external deployments active across reload without persisting an agent session", async () => {
  const persistence = memoryPersistence();
  const board = new BoardStore(persistence.load(), persistence.save);
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
  await board.whenSaved();
  const restored = new BoardStore(persistence.load(), persistence.save);
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
