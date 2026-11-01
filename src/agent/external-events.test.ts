import { describe, expect, it, vi } from "vitest";
import {
  createExternalEventInbox,
  type ExternalAgentEvent,
} from "./external-events";

const event: ExternalAgentEvent = {
  id: "change-1",
  source: "board",
  type: "ticket.updated",
  ticketId: "root",
  payload: { message: "Requirements updated" },
};
function target() {
  return {
    isAccepting: () => true,
    isInScope: (id: string) => id === "root",
    steer: vi.fn(),
    followUp: vi.fn(),
  };
}

describe("external event inbox", () => {
  it("queues serialized external data through the selected Pi queue and deduplicates IDs", () => {
    const receiver = target();
    const inbox = createExternalEventInbox(receiver);
    expect(inbox.deliver(event)).toBe("queued");
    expect(inbox.deliver(event)).toBe("duplicate");
    expect(receiver.steer).toHaveBeenCalledTimes(1);
    expect(receiver.steer.mock.calls[0][0].role).toBe("user");
    expect(receiver.steer.mock.calls[0][0].content).toContain(
      JSON.stringify(event),
    );
    inbox.deliver({ ...event, id: "change-2" }, "follow-up");
    expect(receiver.followUp).toHaveBeenCalledTimes(1);
  });
  it("rejects idle delivery, foreign tickets and bounded overflow", () => {
    expect(() =>
      createExternalEventInbox({
        ...target(),
        isAccepting: () => false,
      }).deliver(event),
    ).toThrow("No active");
    const inbox = createExternalEventInbox(target(), 1);
    expect(() => inbox.deliver({ ...event, ticketId: "other" })).toThrow(
      "another ticket",
    );
    expect(() =>
      inbox.deliver({ ...event, payload: "x".repeat(16000) }),
    ).toThrow("16,000");
    inbox.deliver(event);
    expect(() => inbox.deliver({ ...event, id: "change-2" })).toThrow(
      "event limit",
    );
    inbox.reset();
    expect(inbox.deliver(event)).toBe("queued");
  });
});
