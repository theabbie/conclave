interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: unknown;
}

interface PlannerRequest {
  model?: { id?: string; api?: string; provider?: string };
  context?: {
    systemPrompt?: string;
    messages?: { role?: string; content?: unknown }[];
    tools?: ToolDefinition[];
  };
}

interface ToolAction {
  tool: string;
  arguments: Record<string, unknown>;
}

interface TextAction {
  type: "text";
  text: string;
}

const upstream = "https://demos.exa.ai/chatbot-demo/api/chat/stream";
const defaultModel = "google/gemini-2.5-flash";

class ExaReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private pending = "";
  private output = "";

  constructor(response: Response) {
    if (!response.body) throw new Error("LLM upstream returned no stream");
    this.reader = response.body.getReader();
  }

  async read(): Promise<string> {
    while (true) {
      const { done, value } = await this.reader.read();
      this.pending += this.decoder.decode(value, { stream: !done });
      const lines = this.pending.split("\n");
      this.pending = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (this.consume(line)) {
          await this.reader.cancel();
          return this.output.trim();
        }
      }
      if (done) break;
    }
    if (this.pending) this.consume(this.pending);
    return this.output.trim();
  }

  private consume(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return false;
    const source = trimmed.slice(5).trim();
    if (!source || source === "[DONE]") return false;
    try {
      const event: unknown = JSON.parse(source);
      if (!event || typeof event !== "object" || !("content" in event))
        return false;
      if (typeof event.content !== "string") return false;
      this.output += event.content;
      const marker = this.output.search(/```followups\b/i);
      if (marker >= 0) {
        this.output = this.output.slice(0, marker).trimEnd();
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }
}

class Planner {
  private context: NonNullable<PlannerRequest["context"]>;
  private tools: ToolDefinition[];

  constructor(private request: PlannerRequest) {
    this.context = request.context ?? {};
    this.tools = Array.isArray(this.context.tools) ? this.context.tools : [];
  }

  async run(signal: AbortSignal): Promise<(ToolAction | TextAction)[]> {
    let feedback = "";
    let failure = "Model output could not be adapted";
    for (let attempt = 0; attempt < 3; attempt++) {
      const raw = await this.complete(this.prompt(feedback), signal);
      try {
        return this.parse(raw);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        feedback = [
          "Your previous output was rejected by the Conclave Pi adapter.",
          `Rejected output:\n${raw}`,
          `Adapter error:\n${failure}`,
          "Return one valid JSON object only.",
        ].join("\n\n");
      }
    }
    throw new Error(failure);
  }

  private prompt(feedback: string): string {
    const messages = (this.context.messages ?? [])
      .map(
        (message) =>
          `${String(message.role ?? "user").toUpperCase()}:\n${this.content(message.content)}`,
      )
      .join("\n\n");
    const tools = this.tools.length
      ? JSON.stringify(
          this.tools.map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
          null,
          2,
        )
      : "No tools are available.";
    return [
      this.context.systemPrompt && `SYSTEM:\n${this.context.systemPrompt}`,
      messages,
      `TOOLS:\n${tools}`,
      feedback,
      [
        "Return exactly one JSON object and no markdown.",
        'The JSON shape is {"actions":[...]} with at least one action.',
        'For a final answer use exactly one action: {"type":"text","text":"..."}.',
        'For tool use, use one or more actions: {"tool":"tool_name","arguments":{...}}.',
        "When using tools, do not include text actions in the same response.",
        "Tool names and arguments must match the available tools and their JSON schema.",
        "Every tool in TOOLS is executable in this session. Call a relevant tool instead of claiming it is unavailable.",
        "Only report a capability or permission failure after a tool result demonstrates that failure.",
        "Do not invent tool names. Do not include followups.",
      ].join("\n"),
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private content(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return JSON.stringify(content ?? "");
    return content
      .map((part: unknown) => {
        if (!part || typeof part !== "object") return JSON.stringify(part);
        if ("type" in part && part.type === "text" && "text" in part)
          return String(part.text);
        if ("type" in part && part.type === "toolCall" && "name" in part)
          return `[tool call ${String(part.name)}: ${JSON.stringify("arguments" in part ? part.arguments : {})}]`;
        return JSON.stringify(part);
      })
      .join("\n");
  }

  private async complete(prompt: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(upstream, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        message: prompt,
        history: [],
        exaEnabled: false,
        model: this.request.model?.id || defaultModel,
        searchType: "instant",
      }),
    });
    if (!response.ok)
      throw new Error(
        `LLM upstream ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    const output = await new ExaReader(response).read();
    if (!output) throw new Error("LLM upstream returned no assistant content");
    return output;
  }

  private parse(raw: string): (ToolAction | TextAction)[] {
    const cleaned = raw
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/g, "")
      .replace(/```followups[\s\S]*$/i, "")
      .trim();
    let value: unknown;
    try {
      value = JSON.parse(cleaned);
    } catch {
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON object found");
      value = JSON.parse(match[0]);
    }
    if (
      !value ||
      typeof value !== "object" ||
      !("actions" in value) ||
      !Array.isArray(value.actions) ||
      !value.actions.length
    )
      throw new Error("Expected a non-empty actions array");
    const toolActions = value.actions.filter(
      (action: unknown) =>
        action && typeof action === "object" && "tool" in action,
    );
    const actions = toolActions.length ? toolActions : value.actions;
    return actions.map((action: unknown) => {
      if (!action || typeof action !== "object" || Array.isArray(action))
        throw new Error("Each action must be an object");
      if ("type" in action && action.type === "text") {
        if (
          !("text" in action) ||
          typeof action.text !== "string" ||
          !action.text.trim()
        )
          throw new Error("Text action needs text");
        const hasToolResult = (this.context.messages ?? []).some((message) =>
          /tool/i.test(String(message.role ?? "")),
        );
        if (
          this.tools.length &&
          !hasToolResult &&
          /\b(?:unable|cannot|can't|do not have|don't have)\b[\s\S]{0,180}\b(?:tools?|access|board|deploy|api)\b/i.test(
            action.text,
          )
        )
          throw new Error(
            "A listed capability cannot be declared unavailable before calling its tool",
          );
        return { type: "text", text: action.text };
      }
      if (!("tool" in action) || typeof action.tool !== "string")
        throw new Error("Tool action needs a tool name");
      if (!this.tools.some((tool) => tool.name === action.tool))
        throw new Error(`Unavailable tool: ${action.tool}`);
      const args = "arguments" in action ? action.arguments : {};
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error(`Invalid arguments for ${action.tool}`);
      return {
        tool: action.tool,
        arguments: Object.fromEntries(
          Object.entries(args).filter(([, item]) => item != null),
        ),
      };
    });
  }
}

class PiWriter {
  private encoder = new TextEncoder();
  private output;

  constructor(
    private controller: ReadableStreamDefaultController<Uint8Array>,
    model: PlannerRequest["model"] = {},
  ) {
    this.output = {
      role: "assistant",
      content: [] as unknown[],
      api: model?.api || "conclave-exa",
      provider: model?.provider || "conclave",
      model: model?.id || defaultModel,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  start(): void {
    this.send({ type: "start", partial: this.output });
  }

  text(value: string): void {
    const block = { type: "text", text: "" };
    this.output.content.push(block);
    const contentIndex = this.output.content.indexOf(block);
    this.send({ type: "text_start", contentIndex, partial: this.output });
    block.text = value;
    this.send({
      type: "text_delta",
      contentIndex,
      delta: value,
      partial: this.output,
    });
    this.send({
      type: "text_end",
      contentIndex,
      content: value,
      partial: this.output,
    });
    this.send({ type: "done", reason: "stop", message: this.output });
  }

  tools(actions: ToolAction[]): void {
    for (const action of actions) {
      const block = {
        type: "toolCall",
        id: `conclave-${crypto.randomUUID()}`,
        name: action.tool,
        arguments: {} as Record<string, unknown>,
      };
      this.output.content.push(block);
      const contentIndex = this.output.content.indexOf(block);
      this.send({ type: "toolcall_start", contentIndex, partial: this.output });
      block.arguments = action.arguments;
      this.send({
        type: "toolcall_delta",
        contentIndex,
        delta: JSON.stringify(action.arguments),
        partial: this.output,
      });
      this.send({
        type: "toolcall_end",
        contentIndex,
        toolCall: block,
        partial: this.output,
      });
    }
    this.output.stopReason = "toolUse";
    this.send({ type: "done", reason: "toolUse", message: this.output });
  }

  error(error: unknown, aborted: boolean): void {
    this.output.stopReason = aborted ? "aborted" : "error";
    const failure = {
      ...this.output,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
    this.send({
      type: "error",
      reason: this.output.stopReason,
      error: failure,
    });
  }

  private send(value: unknown): void {
    this.controller.enqueue(
      this.encoder.encode(`data: ${JSON.stringify(value)}\n\n`),
    );
  }
}

export async function streamLlm(request: Request): Promise<Response> {
  let body: PlannerRequest;
  try {
    body = (await request.json()) as PlannerRequest;
  } catch {
    return Response.json({ error: "Expected a JSON request" }, { status: 400 });
  }
  const signal = request.signal;
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const writer = new PiWriter(controller, body.model);
        try {
          writer.start();
          const actions = await new Planner(body).run(signal);
          const text = actions.find(
            (action): action is TextAction =>
              "type" in action && action.type === "text",
          );
          if (text) writer.text(text.text);
          else writer.tools(actions as ToolAction[]);
        } catch (error) {
          writer.error(error, signal.aborted);
        } finally {
          controller.close();
        }
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
      },
    },
  );
}
