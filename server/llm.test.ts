import { afterEach, describe, expect, it, vi } from "vitest";
import { streamLlm } from "./llm";

afterEach(() => vi.unstubAllGlobals());

describe("Conclave LLM adapter", () => {
  it("retries false tool-unavailability claims and returns executable tool calls", async () => {
    const outputs = [
      {
        actions: [
          {
            type: "text",
            text: "I cannot access the board tools in this session.",
          },
        ],
      },
      { actions: [{ tool: "read_ticket", arguments: { id: "root" } }] },
    ];
    const upstream = vi.fn(async () => {
      const value = outputs.shift();
      return new Response(
        `data: ${JSON.stringify({ content: JSON.stringify(value) })}\n`,
        {
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    });
    vi.stubGlobal("fetch", upstream);
    const response = await streamLlm(
      new Request("https://conclave.test/api/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: { id: "test" },
          context: {
            messages: [{ role: "user", content: "Read the ticket" }],
            tools: [
              {
                name: "read_ticket",
                description: "Read a ticket",
                parameters: { type: "object" },
              },
            ],
          },
        }),
      }),
    );
    const stream = await response.text();
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(stream).toContain('"name":"read_ticket"');
    expect(stream).toContain('"reason":"toolUse"');
  });
});
