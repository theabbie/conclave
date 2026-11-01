import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTicketAgent,
  type ApiAgentAdapter,
  type BoardAgentAdapter,
} from "./runtime";

function adapter(): BoardAgentAdapter {
  return {
    listTickets: vi.fn(() => [{ id: "root", title: "Task" }]),
    readTicket: vi.fn(() => ({ id: "root" })),
    createSubtask: vi.fn(),
    updateSubtask: vi.fn(),
    moveTicket: vi.fn(),
    addComment: vi.fn(),
    setTicketData: vi.fn(),
    deleteTicketData: vi.fn(),
    isInScope: (root, id) => root === id || id === "child",
  };
}
const settings = {
  endpoint: "https://example.test/api/stream",
  model: "test-model",
};

afterEach(() => vi.unstubAllGlobals());

describe("ticket agent", () => {
  it("enforces mutation scope and prevents root status changes at execution time", async () => {
    const board = adapter();
    const { agent } = createTicketAgent({ rootId: "root", settings, board });
    const create = agent.state.tools.find(
      (tool) => tool.name === "create_subtask",
    )!;
    const update = agent.state.tools.find(
      (tool) => tool.name === "update_subtask",
    )!;
    await expect(
      create.execute("1", {
        parentId: "outside",
        title: "bad",
        description: "",
      }),
    ).rejects.toThrow("outside");
    await expect(
      update.execute("2", { id: "root", status: "done" }),
    ).rejects.toThrow("root ticket");
    expect(board.createSubtask).not.toHaveBeenCalled();
    expect(board.updateSubtask).not.toHaveBeenCalled();
  });

  it("lets the agent explicitly accept work or request root-ticket review", async () => {
    const board = adapter();
    const { agent } = createTicketAgent({ rootId: "root", settings, board });
    const status = agent.state.tools.find(
      (tool) => tool.name === "update_ticket_status",
    )!;
    await status.execute("accept", { status: "in_progress" });
    await status.execute("review", { status: "review" });
    expect(board.moveTicket).toHaveBeenNthCalledWith(
      1,
      "root",
      "in_progress",
      "agent",
    );
    expect(board.moveTicket).toHaveBeenNthCalledWith(
      2,
      "root",
      "review",
      "agent",
    );
  });

  it("exposes atomic API tools and requires a scoped deployment subtask", async () => {
    const apis: ApiAgentAdapter = {
      listApiUnits: vi.fn(() => []),
      readApiUnit: vi.fn(),
      addApiUnit: vi.fn((unit) => unit),
      updateApiUnit: vi.fn((unit) => unit),
      deployApiUnit: vi.fn(() => ({ id: "deployment" })),
    };
    const { agent } = createTicketAgent({
      rootId: "root",
      settings,
      board: adapter(),
      apis,
    });
    expect(agent.state.tools.map((tool) => tool.name)).toContain(
      "add_api_unit",
    );
    const deploy = agent.state.tools.find(
      (tool) => tool.name === "deploy_api_unit",
    )!;
    await expect(
      deploy.execute("root", { unitId: "hello", ticketId: "root" }),
    ).rejects.toThrow("subtask");
    await deploy.execute("child", { unitId: "hello", ticketId: "child" });
    expect(apis.deployApiUnit).toHaveBeenCalledWith("hello", "child");
  });

  it("exposes scoped ticket data as durable agent working context", async () => {
    const board = adapter();
    const { agent } = createTicketAgent({ rootId: "root", settings, board });
    const setData = agent.state.tools.find(
      (tool) => tool.name === "set_ticket_data",
    )!;
    await setData.execute("set", {
      ticketId: "child",
      key: "research",
      value: "Verified result",
    });
    expect(board.setTicketData).toHaveBeenCalledWith(
      "child",
      "research",
      "Verified result",
    );
    await expect(
      setData.execute("outside", {
        ticketId: "outside",
        key: "research",
        value: "No",
      }),
    ).rejects.toThrow("outside");
  });

  it("rejects concurrent runs and reports explicit cancellation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            if (init.signal.aborted)
              reject(new DOMException("Aborted", "AbortError"));
            else
              init.signal.addEventListener(
                "abort",
                () => reject(new DOMException("Aborted", "AbortError")),
                { once: true },
              );
          }),
      ),
    );
    const runtime = createTicketAgent({
      rootId: "root",
      settings,
      board: adapter(),
    });
    const first = runtime.run("First");
    const firstFailure = expect(first).rejects.toThrow("Agent run stopped");
    await expect(runtime.run("Second")).rejects.toThrow("already running");
    runtime.abort();
    await firstFailure;
    expect(runtime.agent.state.isStreaming).toBe(false);
  });

  it("delivers an external event into a real running Pi loop without starting a second run", async () => {
    const requests: Array<{
      context: { messages: Array<{ content: unknown }> };
    }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        requests.push(JSON.parse(init.body));
        const message = {
          role: "assistant",
          content: [{ type: "text", text: "Acknowledged" }],
          api: "webiome-exa",
          provider: "webiome",
          model: "test-model",
          stopReason: "stop",
          timestamp: Date.now(),
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        };
        return new Response(
          `data: ${JSON.stringify({ type: "start", partial: message })}\n\ndata: ${JSON.stringify({ type: "done", reason: "stop", message })}\n\n`,
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }),
    );
    let delivered = false;
    const event = {
      id: "e1",
      ticketId: "root",
      source: "board",
      type: "update",
      payload: { requirement: "Use revised requirements" },
    };
    const runtime = createTicketAgent({
      rootId: "root",
      settings,
      board: adapter(),
      onEvent: (message) => {
        if (
          message.type === "message_end" &&
          message.message.role === "assistant" &&
          !delivered
        ) {
          delivered = true;
          expect(runtime.deliverExternalEvent(event)).toBe("queued");
        }
      },
    });
    await runtime.run("Start");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1].context.messages)).toContain(
      "Use revised requirements",
    );
    expect(() => runtime.deliverExternalEvent({ ...event, id: "e2" })).toThrow(
      "No active",
    );
    expect(runtime.agent.hasQueuedMessages()).toBe(false);
  });

  it("runs real Pi tool execution and stops an endless tool loop at its configured turn budget", async () => {
    const board = adapter();
    const fetchMock = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      expect(
        body.context.tools.some(
          (tool: { name: string }) => tool.name === "list_tickets",
        ),
      ).toBe(true);
      expect(body.context.systemPrompt).toContain("root");
      const message = {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: crypto.randomUUID(),
            name: "list_tickets",
            arguments: {},
          },
        ],
        api: "webiome-exa",
        provider: "webiome",
        model: "test-model",
        stopReason: "toolUse",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      return new Response(
        `data: ${JSON.stringify({ type: "start", partial: message })}\n\ndata: ${JSON.stringify({ type: "done", reason: "toolUse", message })}\n\n`,
        { headers: { "Content-Type": "text/event-stream" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtime = createTicketAgent({
      rootId: "root",
      settings,
      board,
      maxTurns: 2,
    });
    await expect(runtime.run("Work on root")).rejects.toThrow(
      "paused after 2 turns",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(board.listTickets).toHaveBeenCalledTimes(2);
    expect(runtime.agent.state.isStreaming).toBe(false);
  });
});
