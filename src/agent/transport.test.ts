import { afterEach, describe, expect, it, vi } from "vitest";
import type { Model, TranscriptContext } from "@earendil-works/pi-ai";
import { createWebiomeTransport } from "./transport";

const model: Model<"webiome-exa"> = {
  id: "test-model",
  name: "test-model",
  api: "webiome-exa",
  provider: "webiome",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  contextWindow: 1000,
  maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
} as TranscriptContext;
const message = {
  role: "assistant",
  content: [{ type: "text", text: "hello" }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  stopReason: "stop",
  timestamp: 0,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};
const transport = createWebiomeTransport({
  endpoint: "https://example.test/api/stream",
  model: "test-model",
});

afterEach(() => vi.unstubAllGlobals());

describe("Webiome transport", () => {
  it("handles fragmented SSE frames and finishes with the authoritative message", async () => {
    const data = `data: ${JSON.stringify({ type: "start", partial: message })}\n\ndata: ${JSON.stringify({ type: "done", reason: "stop", message })}\n\n`;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                for (let i = 0; i < data.length; i += 7)
                  controller.enqueue(
                    new TextEncoder().encode(data.slice(i, i + 7)),
                  );
                controller.close();
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      ),
    );
    const stream = await transport(model, context);
    expect((await stream.result()).content).toEqual(message.content);
  });

  it("reports truncated streams as errors instead of hanging", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            `data: ${JSON.stringify({ type: "start", partial: message })}\n\n`,
            { headers: { "Content-Type": "text/event-stream" } },
          ),
      ),
    );
    const result = await (await transport(model, context)).result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("before a final event");
  });

  it("rejects the incompatible compact Pi proxy protocol explicitly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('data: {"type":"start"}\n\n', {
            headers: { "Content-Type": "text/event-stream" },
          }),
      ),
    );
    expect(
      (await (await transport(model, context)).result()).errorMessage,
    ).toContain("full-message SSE");
  });

  it("passes cancellation to fetch and produces an aborted terminal event", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        expect(init.signal).toBe(controller.signal);
        throw new DOMException("Aborted", "AbortError");
      }),
    );
    expect(
      (
        await (
          await transport(model, context, { signal: controller.signal })
        ).result()
      ).stopReason,
    ).toBe("aborted");
  });
});
