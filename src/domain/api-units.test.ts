import { describe, expect, it } from "vitest";
import {
  reduceApiUnits,
  type ApiUnitSpec,
  type DeploymentTask,
} from "./api-units";

const unit: ApiUnitSpec = {
  id: "hello",
  name: "Hello",
  method: "GET",
  path: "/api/hello",
  requestSchema: {},
  responseSchema: { type: "string" },
  handlerSource: 'return new Response("hello")',
};
const task: DeploymentTask = {
  id: "task",
  unitId: "hello",
  ticketId: "ticket",
  status: "queued",
  createdAt: 1,
  updatedAt: 1,
};

describe("atomic API units", () => {
  it("adds and updates units without allowing route collisions", () => {
    const initial = { units: [], tasks: [] };
    const added = reduceApiUnits(initial, { type: "unit.add", unit });
    expect(initial.units).toEqual([]);
    expect(() =>
      reduceApiUnits(added, {
        type: "unit.add",
        unit: { ...unit, id: "other" },
      }),
    ).toThrow("API route already exists");
    const updated = reduceApiUnits(added, {
      type: "unit.update",
      unit: { ...unit, name: "Renamed" },
    });
    expect(updated.units[0].name).toBe("Renamed");
    expect(added.units[0].name).toBe("Hello");
  });

  it("enforces asynchronous lifecycle and ignores stale notifications", () => {
    let state = reduceApiUnits(
      { units: [unit], tasks: [] },
      { type: "deployment.queue", task },
    );
    expect(() =>
      reduceApiUnits(state, {
        type: "deployment.status_changed",
        id: "event",
        taskId: task.id,
        status: "succeeded",
        occurredAt: 2,
      }),
    ).toThrow("Invalid deployment transition");
    state = reduceApiUnits(state, {
      type: "deployment.status_changed",
      id: "event",
      taskId: task.id,
      status: "in_progress",
      occurredAt: 3,
    });
    expect(
      reduceApiUnits(state, {
        type: "deployment.status_changed",
        id: "old",
        taskId: task.id,
        status: "failed",
        error: "old",
        occurredAt: 2,
      }),
    ).toBe(state);
    state = reduceApiUnits(state, {
      type: "deployment.status_changed",
      id: "done",
      taskId: task.id,
      status: "succeeded",
      occurredAt: 4,
    });
    expect(state.tasks[0].status).toBe("succeeded");
    expect(() =>
      reduceApiUnits(state, {
        type: "deployment.status_changed",
        id: "late",
        taskId: task.id,
        status: "failed",
        error: "late",
        occurredAt: 5,
      }),
    ).toThrow("Invalid deployment transition");
  });
});
