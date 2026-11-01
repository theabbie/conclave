import { describe, expect, it } from "vitest";
import { diffBoard, emptyRecordIds } from "./persistence";
import type { BoardState } from "./store";

const empty: BoardState = { tickets: [], comments: [], deployments: [] };

describe("board persistence", () => {
  it("produces backend-neutral entity changes", () => {
    const ticket = {
      id: "ticket-1",
      title: "Ship",
      description: "",
      status: "backlog" as const,
      createdAt: 1,
      data: {},
    };
    const next = { ...empty, tickets: [ticket] };
    expect(diffBoard(empty, next, emptyRecordIds())).toMatchObject({
      tickets: { upsert: [ticket], remove: [] },
      comments: { upsert: [], remove: [] },
      deployments: { upsert: [], remove: [] },
    });
  });

  it("includes signed backend records when entities are removed", () => {
    const ticket = {
      id: "ticket-1",
      title: "Ship",
      description: "",
      status: "backlog" as const,
      createdAt: 1,
      data: {},
    };
    const records = emptyRecordIds();
    records.tickets[ticket.id] = "record.signature";
    expect(
      diffBoard({ ...empty, tickets: [ticket] }, empty, records).tickets,
    ).toEqual({
      upsert: [],
      remove: [{ id: ticket.id, recordId: "record.signature" }],
    });
  });
});
