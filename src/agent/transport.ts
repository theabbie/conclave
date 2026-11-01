import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type TranscriptContext,
  type Tool,
} from "@earendil-works/pi-ai";

export interface AgentSettings {
  endpoint: string;
  model: string;
  token?: string;
}

export function webiomeContext(context: TranscriptContext) {
  const instructions: string[] = [];
  const sections = new Map<string, string>();
  const tools = new Map<string, Tool>();
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    instructions.push(
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text).join("\n"),
    );
    for (const [name, content] of Object.entries(message.sections ?? {})) {
      if (content === null) sections.delete(name);
      else sections.set(name, content);
    }
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  return {
    systemPrompt: [...instructions, ...sections.values()]
      .filter(Boolean)
      .join("\n\n"),
    messages: context.messages.filter((message) => message.role !== "system"),
    tools: [...tools.values()],
  };
}

const eventTypes = new Set([
  "start",
  "text_start",
  "text_delta",
  "text_end",
  "thinking_start",
  "thinking_delta",
  "thinking_end",
  "toolcall_start",
  "toolcall_delta",
  "toolcall_end",
  "done",
  "error",
]);

function parseEvent(data: string): AssistantMessageEvent {
  const event = JSON.parse(data);
  if (!event || !eventTypes.has(event.type))
    throw new Error("Unsupported LLM stream event");
  const message =
    event.type === "done"
      ? event.message
      : event.type === "error"
        ? event.error
        : event.partial;
  if (
    !message ||
    message.role !== "assistant" ||
    !Array.isArray(message.content) ||
    !message.usage
  ) {
    throw new Error("Expected the Webiome full-message SSE protocol");
  }
  for (const block of message.content) {
    if (!block || !["text", "thinking", "toolCall"].includes(block.type))
      throw new Error("Invalid assistant content block");
    if (block.type === "text" && typeof block.text !== "string")
      throw new Error("Invalid assistant text");
    if (block.type === "thinking" && typeof block.thinking !== "string")
      throw new Error("Invalid assistant thinking");
    if (
      block.type === "toolCall" &&
      (typeof block.id !== "string" ||
        typeof block.name !== "string" ||
        !block.arguments ||
        typeof block.arguments !== "object" ||
        Array.isArray(block.arguments))
    )
      throw new Error("Invalid assistant tool call");
  }
  if (
    event.type === "done" &&
    (!["stop", "length", "toolUse"].includes(event.reason) ||
      message.stopReason !== event.reason)
  )
    throw new Error("Invalid stream completion reason");
  if (
    event.type === "error" &&
    (!["error", "aborted"].includes(event.reason) ||
      message.stopReason !== event.reason)
  )
    throw new Error("Invalid stream failure reason");
  if (event.type.endsWith("_delta") && typeof event.delta !== "string")
    throw new Error("Invalid stream delta");
  return event as AssistantMessageEvent;
}

export function createWebiomeTransport(configuration: AgentSettings): StreamFn {
  const settings = { ...configuration };
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    let partial: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: "pending",
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
    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const url = new URL(settings.endpoint);
        if (!["http:", "https:"].includes(url.protocol))
          throw new Error("LLM endpoint must use HTTP or HTTPS");
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        };
        if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
        const response = await fetch(url, {
          method: "POST",
          headers,
          signal: options?.signal,
          body: JSON.stringify({
            model,
            context: webiomeContext(context),
            options: {
              reasoning: options?.reasoning,
              maxTokens: options?.maxTokens,
            },
          }),
        });
        if (!response.ok)
          throw new Error(`LLM endpoint returned HTTP ${response.status}`);
        if (
          !response.headers.get("content-type")?.includes("text/event-stream")
        )
          throw new Error("LLM endpoint must return text/event-stream");
        if (!response.body) throw new Error("LLM response has no stream");
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let started = false;
        let terminal = false;
        const consume = (frame: string) => {
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) return;
          const event = parseEvent(data);
          if (terminal) throw new Error("LLM sent data after a terminal event");
          if (event.type === "start") started = true;
          else if (!started && event.type !== "error")
            throw new Error("LLM stream did not start correctly");
          if ("partial" in event) partial = event.partial;
          if (event.type === "done" || event.type === "error") terminal = true;
          stream.push(event);
        };
        while (!terminal) {
          const { value, done } = await reader.read();
          buffer = (buffer + decoder.decode(value, { stream: !done })).replace(
            /\r\n/g,
            "\n",
          );
          if (buffer.length > 8_000_000)
            throw new Error("LLM event exceeds the size limit");
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1 && !terminal) {
            consume(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
          }
          if (done) {
            if (!terminal && buffer.trim()) consume(buffer);
            break;
          }
        }
        if (!terminal) throw new Error("LLM stream ended before a final event");
      } catch (error) {
        const reason = options?.signal?.aborted ? "aborted" : "error";
        stream.push({
          type: "error",
          reason,
          error: {
            ...partial,
            stopReason: reason,
            errorMessage:
              error instanceof Error ? error.message : String(error),
          },
        });
      } finally {
        await reader?.cancel().catch(() => undefined);
        stream.end();
      }
    })();
    return stream;
  };
}
