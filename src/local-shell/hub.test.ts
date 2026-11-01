import { describe, expect, it, vi } from "vitest";
import type { LocalCommandOptions, LocalCommandResult } from "./client";
import { LocalShellHub } from "./hub";

describe("LocalShellHub", () => {
  it("serializes commands and publishes live output for every source", async () => {
    let finishFirst: ((result: LocalCommandResult) => void) | undefined;
    const run = vi.fn((command: string, options: LocalCommandOptions) => {
      options.onOutput?.(`running ${command}`);
      if (command === "first")
        return new Promise<LocalCommandResult>((resolve) => {
          finishFirst = resolve;
        });
      return Promise.resolve({ output: "second", exitCode: 0, durationMs: 2 });
    });
    const hub = new LocalShellHub(() => ({ run }));
    hub.configure("ws://127.0.0.1:8080");
    const first = hub.run("first");
    const second = hub.runManual("second");
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(hub.getSnapshot()[0]).toMatchObject({
      source: "agent",
      status: "running",
      output: "running first",
    });
    expect(hub.getSnapshot()[1]).toMatchObject({
      source: "manual",
      status: "queued",
    });
    finishFirst!({ output: "first", exitCode: 0, durationMs: 1 });
    await Promise.all([first, second]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(hub.getSnapshot().map((entry) => entry.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
  });
});
