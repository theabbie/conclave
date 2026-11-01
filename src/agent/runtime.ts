import {
  Agent,
  type AgentEvent,
  type AgentTool,
} from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { Type, type TSchema } from "typebox";
import type { ApiUnitSpec } from "../domain/api-units";
import { createExternalEventInbox } from "./external-events";
import { createWebiomeTransport, type AgentSettings } from "./transport";

export type SubtaskStatus =
  "backlog" | "ready" | "in_progress" | "review" | "done";

export interface BoardAgentAdapter {
  listTickets(): unknown;
  readTicket(id: string): unknown;
  createSubtask(parentId: string, title: string, description: string): unknown;
  updateSubtask(id: string, status: SubtaskStatus, summary?: string): unknown;
  moveTicket(
    id: string,
    status: SubtaskStatus,
    source?: "user" | "agent" | "deployment",
  ): unknown;
  addComment(
    ticketId: string,
    message: string,
    source?: "user" | "agent" | "system",
  ): unknown;
  setTicketData(ticketId: string, key: string, value: string): unknown;
  deleteTicketData(ticketId: string, key: string): unknown;
  isInScope(rootId: string, ticketId: string): boolean;
}

export interface ApiAgentAdapter {
  listApiUnits(): ApiUnitSpec[] | Promise<ApiUnitSpec[]>;
  readApiUnit(id: string): ApiUnitSpec | Promise<ApiUnitSpec>;
  addApiUnit(unit: ApiUnitSpec): ApiUnitSpec | Promise<ApiUnitSpec>;
  updateApiUnit(unit: ApiUnitSpec): ApiUnitSpec | Promise<ApiUnitSpec>;
  deployApiUnit(unitId: string, ticketId: string): unknown | Promise<unknown>;
}

export interface TicketAgentOptions {
  rootId: string;
  settings: AgentSettings;
  board: BoardAgentAdapter;
  apis?: ApiAgentAdapter;
  onEvent?: (event: AgentEvent) => void;
  maxTurns?: number;
}

function defineTool<T extends TSchema>(tool: AgentTool<T>): AgentTool<T> {
  return tool;
}

export function createTicketAgent({
  rootId,
  settings,
  board,
  apis,
  onEvent,
  maxTurns = 20,
}: TicketAgentOptions) {
  if (!Number.isInteger(maxTurns) || maxTurns < 1)
    throw new Error("maxTurns must be a positive integer");
  let active = false;
  let acceptingEvents = false;
  let aborted = false;
  let turns = 0;
  let limitReached = false;
  const assertScope = (id: string) => {
    if (!board.isInScope(rootId, id))
      throw new Error("This ticket is outside the active task");
  };
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value ?? null) }],
    details: {},
  });
  const tools = [
    defineTool({
      name: "list_tickets",
      label: "List tickets",
      description: "Read the board overview.",
      parameters: Type.Object({}),
      execute: async () => result(await board.listTickets()),
    }),
    defineTool({
      name: "read_ticket",
      label: "Read ticket",
      description: "Read the active ticket or one of its subtasks.",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_, args) => {
        assertScope(args.id);
        return result(await board.readTicket(args.id));
      },
    }),
    defineTool({
      name: "update_ticket_status",
      label: "Update active ticket status",
      description:
        "Move the active root ticket to in progress when taking ownership, or to review when asking the user a question or presenting a result.",
      parameters: Type.Object({
        status: Type.Union([
          Type.Literal("in_progress"),
          Type.Literal("review"),
        ]),
      }),
      execute: async (_, args) =>
        result(await board.moveTicket(rootId, args.status, "agent")),
    }),
    defineTool({
      name: "create_subtask",
      label: "Create subtask",
      description:
        "Create a subtask beneath the active ticket or one of its subtasks.",
      parameters: Type.Object({
        parentId: Type.String(),
        title: Type.String({ minLength: 1 }),
        description: Type.String(),
      }),
      execute: async (_, args) => {
        assertScope(args.parentId);
        return result(
          await board.createSubtask(
            args.parentId,
            args.title,
            args.description,
          ),
        );
      },
    }),
    defineTool({
      name: "update_subtask",
      label: "Update subtask",
      description:
        "Update a subtask status and optional result. The main user controls the root ticket.",
      parameters: Type.Object({
        id: Type.String(),
        status: Type.Union(
          ["backlog", "ready", "in_progress", "review", "done"].map((value) =>
            Type.Literal(value),
          ),
        ),
        summary: Type.Optional(Type.String()),
      }),
      execute: async (_, args) => {
        assertScope(args.id);
        if (args.id === rootId)
          throw new Error("The agent cannot change the root ticket status");
        return result(
          await board.updateSubtask(args.id, args.status, args.summary),
        );
      },
    }),
    defineTool({
      name: "add_comment",
      label: "Add comment",
      description:
        "Add a chronological update, finding, blocker, or result to a ticket comment stream.",
      parameters: Type.Object({
        ticketId: Type.String(),
        message: Type.String({ minLength: 1 }),
      }),
      execute: async (_, args) => {
        assertScope(args.ticketId);
        return result(
          await board.addComment(args.ticketId, args.message, "agent"),
        );
      },
    }),
    defineTool({
      name: "set_ticket_data",
      label: "Set ticket data",
      description:
        "Store or replace structured working data on the active ticket or one of its subtasks. Use stable descriptive keys.",
      parameters: Type.Object({
        ticketId: Type.String(),
        key: Type.String({ minLength: 1, maxLength: 64 }),
        value: Type.String({ maxLength: 20_000 }),
      }),
      execute: async (_, args) => {
        assertScope(args.ticketId);
        return result(
          await board.setTicketData(args.ticketId, args.key, args.value),
        );
      },
    }),
    defineTool({
      name: "delete_ticket_data",
      label: "Delete ticket data",
      description:
        "Delete obsolete working data from the active ticket or one of its subtasks.",
      parameters: Type.Object({
        ticketId: Type.String(),
        key: Type.String({ minLength: 1, maxLength: 64 }),
      }),
      execute: async (_, args) => {
        assertScope(args.ticketId);
        return result(await board.deleteTicketData(args.ticketId, args.key));
      },
    }),
    ...(apis
      ? [
          defineTool({
            name: "list_api_units",
            label: "List API units",
            description: "List the backend API units in the current source.",
            parameters: Type.Object({}),
            execute: async () => result(await apis.listApiUnits()),
          }),
          defineTool({
            name: "read_api_unit",
            label: "Read API unit",
            description: "Read one backend API unit before changing it.",
            parameters: Type.Object({ id: Type.String() }),
            execute: async (_, args) => result(await apis.readApiUnit(args.id)),
          }),
          ...(["add", "update"] as const).map((operation) =>
            defineTool({
              name: `${operation}_api_unit`,
              label: `${operation === "add" ? "Add" : "Update"} API unit`,
              description: `${operation === "add" ? "Add" : "Update"} one atomic backend API. handlerSource is the body of an async function receiving request, env and params.`,
              parameters: Type.Object({
                id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }),
                name: Type.String({ minLength: 1 }),
                method: Type.Union(
                  ["GET", "POST", "PUT", "PATCH", "DELETE"].map((method) =>
                    Type.Literal(method),
                  ),
                ),
                path: Type.String({ pattern: "^/api/" }),
                requestSchema: Type.Record(Type.String(), Type.Unknown()),
                responseSchema: Type.Record(Type.String(), Type.Unknown()),
                handlerSource: Type.String({ minLength: 1, maxLength: 50_000 }),
              }),
              execute: async (_, args) =>
                result(
                  await (operation === "add"
                    ? apis.addApiUnit(args)
                    : apis.updateApiUnit(args)),
                ),
            }),
          ),
          defineTool({
            name: "deploy_api_unit",
            label: "Deploy API unit",
            description:
              "Queue validation, build, staging and activation for an API unit. Link it to a deployment subtask in the active ticket tree.",
            parameters: Type.Object({
              unitId: Type.String(),
              ticketId: Type.String(),
            }),
            execute: async (_, args) => {
              assertScope(args.ticketId);
              if (args.ticketId === rootId)
                throw new Error("Deployments must be linked to a subtask");
              return result(
                await apis.deployApiUnit(args.unitId, args.ticketId),
              );
            },
          }),
        ]
      : []),
  ];
  const model: Model<"webiome-exa"> = {
    id: settings.model,
    name: settings.model,
    api: "webiome-exa",
    provider: "webiome",
    baseUrl: settings.endpoint,
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const agent = new Agent({
    initialState: {
      model,
      tools,
      systemPrompt: `Work on ticket ${rootId}. The tools listed in this session are executable. Never claim a listed tool is unavailable unless calling it returned an error. The initial prompt includes the current ticket, its data, comments, and deployments. While the ticket is ready, assess it before taking ownership. Move it to in progress with update_ticket_status only when you will perform work. Move it to review when asking the user a question or presenting a result. Use ticket data for durable key-value working context and comments for chronological updates shared with the user. Use board tools to track meaningful work and create subtasks when helpful. Only the user creates root tickets. You may modify only this ticket's subtree. API units are atomic: read before updating, use one unit per route, and link every deployment to a subtask. A deploy_api_unit call waits for completion and returns the public URL on success. Do not claim work you have not performed. Finish with a concise result for user review.`,
    },
    streamFn: createWebiomeTransport(settings),
    toolExecution: "sequential",
    finishTurn: () => {
      turns += 1;
      limitReached = turns >= maxTurns;
      return limitReached ? { action: "end" } : undefined;
    },
  });
  const externalEvents = createExternalEventInbox({
    isAccepting: () => active && acceptingEvents && !aborted,
    isInScope: (ticketId) => board.isInScope(rootId, ticketId),
    steer: (message) => agent.steer(message),
    followUp: (message) => agent.followUp(message),
  });
  agent.subscribe((event) => {
    if (event.type === "agent_end") acceptingEvents = false;
  });
  if (onEvent) agent.subscribe(onEvent);
  return {
    agent,
    deliverExternalEvent: externalEvents.deliver,
    abort: () => {
      aborted = true;
      agent.abort();
    },
    run: async (prompt: string) => {
      if (active) throw new Error("This agent is already running");
      active = true;
      acceptingEvents = true;
      externalEvents.reset();
      aborted = false;
      turns = 0;
      limitReached = false;
      try {
        await agent.prompt(prompt);
        if (aborted) throw new Error("Agent run stopped");
        if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
        const last = agent.state.messages.at(-1);
        if (last?.role === "assistant" && last.stopReason === "aborted")
          throw new Error("Agent run stopped");
        if (limitReached && last?.role === "toolResult")
          throw new Error(
            `Agent paused after ${maxTurns} turns; review the comments before continuing`,
          );
      } finally {
        acceptingEvents = false;
        agent.clearAllQueues();
        active = false;
      }
    },
  };
}
