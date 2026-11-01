import { describe, expect, it } from "vitest";
import { LocalShellClient, validateLocalShellUrl } from "./client";

class FakeSocket extends EventTarget {
  readyState = 0;
  sent = "";

  constructor() {
    super();
    queueMicrotask(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(value: string) {
    this.sent = value;
    const marker = value.match(/(__CONCLAVE_EXIT_[a-f0-9]+__)/)?.[1];
    const event = new Event("message") as Event & { data: string };
    event.data = `command output\n${marker}=7\n`;
    this.dispatchEvent(event);
  }

  close() {
    this.readyState = 3;
  }
}

describe("LocalShellClient", () => {
  it("accepts local ws URLs and tunneled wss URLs", () => {
    expect(validateLocalShellUrl("ws://127.0.0.1:8080")).toBe(
      "ws://127.0.0.1:8080/",
    );
    expect(validateLocalShellUrl("wss://shell.example.test/session?a=1")).toBe(
      "wss://shell.example.test/session?a=1",
    );
    expect(() => validateLocalShellUrl("ws://example.test")).toThrow(
      "Use wss://",
    );
    expect(() => validateLocalShellUrl("https://example.test")).toThrow(
      "ws:// or wss://",
    );
  });

  it("captures output and the command exit code", async () => {
    const socket = new FakeSocket();
    const client = new LocalShellClient(
      "ws://localhost:8080",
      () => socket as unknown as WebSocket,
    );
    await expect(client.run("printf '%s' hello")).resolves.toMatchObject({
      output: "command output",
      exitCode: 7,
    });
    expect(socket.sent).toContain("bash -lc");
    expect(socket.sent).toContain("printf");
  });
});
