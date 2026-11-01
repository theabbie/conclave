import { HttpError, readJson } from "./releases";
import {
  emptyRecordIds,
  type BoardDelta,
  type BoardLoadResult,
  type BoardRecordIds,
} from "../src/board/persistence";
import {
  parseBoardState,
  statuses,
  type BoardState,
  type Ticket,
  type TicketComment,
} from "../src/board/store";
import type { DeploymentTask } from "../src/domain/api-units";

export interface NotionEnvironment {
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  NOTION_SESSION_PRIVATE_KEY?: string;
}

interface NotionSession {
  kind: "notion_session";
  accessToken: string;
  refreshToken?: string;
  workspaceId: string;
  workspaceName: string;
  workspaceIcon?: string;
  dataSourceId?: string;
  boardPageId?: string;
  boardUrl?: string;
  iat: number;
  exp: number;
}

interface JsonObject {
  [key: string]: unknown;
}

const notionVersion = "2026-03-11";
const notionApi = "https://api.notion.com/v1";
const callbackUrl =
  "https://conclave.abbie.workers.dev/api/integrations/notion/callback";
const clientUrl = "https://theabbie.github.io/conclave/";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const stateTtl = 10 * 60;
const sessionTtl = 30 * 24 * 60 * 60;

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configured(
  env: NotionEnvironment,
): asserts env is Required<NotionEnvironment> {
  if (
    !env.NOTION_CLIENT_ID ||
    !env.NOTION_CLIENT_SECRET ||
    !env.NOTION_SESSION_PRIVATE_KEY
  )
    throw new HttpError(503, "Notion integration is not configured");
}

function base64Url(bytes: ArrayBuffer | Uint8Array): string {
  const value = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string): ArrayBuffer {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (character) =>
    character.charCodeAt(0),
  );
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function privateJwk(env: Required<NotionEnvironment>): JsonWebKey {
  try {
    const value: unknown = JSON.parse(env.NOTION_SESSION_PRIVATE_KEY);
    if (
      !object(value) ||
      value.kty !== "RSA" ||
      !value.n ||
      !value.e ||
      !value.d
    )
      throw new Error();
    return value as JsonWebKey;
  } catch {
    throw new HttpError(503, "Notion session key is invalid");
  }
}

async function encryptToken(
  payload: Omit<NotionSession, "iat" | "exp"> | JsonObject,
  env: NotionEnvironment,
  ttl = sessionTtl,
): Promise<string> {
  configured(env);
  const jwk = privateJwk(env);
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RSA-OAEP-256", ext: true },
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const contentKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const protectedHeader = base64Url(
    encoder.encode(
      JSON.stringify({ alg: "RSA-OAEP-256", enc: "A256GCM", typ: "JWT" }),
    ),
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const now = Math.floor(Date.now() / 1000);
  const plaintext = encoder.encode(
    JSON.stringify({ ...payload, iat: now, exp: now + ttl }),
  );
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(protectedHeader) },
      contentKey,
      plaintext,
    ),
  );
  const encryptedKey = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    keyBytes,
  );
  const tag = encrypted.slice(-16);
  const ciphertext = encrypted.slice(0, -16);
  return [
    protectedHeader,
    base64Url(encryptedKey),
    base64Url(iv),
    base64Url(ciphertext),
    base64Url(tag),
  ].join(".");
}

async function decryptToken(
  token: string,
  env: NotionEnvironment,
): Promise<JsonObject> {
  configured(env);
  const parts = token.split(".");
  if (parts.length !== 5) throw new HttpError(401, "Invalid Notion session");
  const [protectedHeader, encryptedKey, iv, ciphertext, tag] = parts;
  try {
    const header: unknown = JSON.parse(
      decoder.decode(fromBase64Url(protectedHeader)),
    );
    if (
      !object(header) ||
      header.alg !== "RSA-OAEP-256" ||
      header.enc !== "A256GCM"
    )
      throw new Error();
    const key = await crypto.subtle.importKey(
      "jwk",
      privateJwk(env),
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"],
    );
    const keyBytes = await crypto.subtle.decrypt(
      { name: "RSA-OAEP" },
      key,
      fromBase64Url(encryptedKey),
    );
    const contentKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const encrypted = new Uint8Array([
      ...new Uint8Array(fromBase64Url(ciphertext)),
      ...new Uint8Array(fromBase64Url(tag)),
    ]);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(iv),
        additionalData: encoder.encode(protectedHeader),
      },
      contentKey,
      encrypted,
    );
    const payload: unknown = JSON.parse(decoder.decode(plaintext));
    if (!object(payload) || typeof payload.exp !== "number") throw new Error();
    if (payload.exp <= Math.floor(Date.now() / 1000))
      throw new HttpError(401, "Notion session expired");
    return payload;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "Invalid Notion session");
  }
}

function bearer(request: Request): string {
  const match = request.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new HttpError(401, "Notion connection required");
  return match[1];
}

async function session(
  request: Request,
  env: NotionEnvironment,
): Promise<NotionSession> {
  const value = await decryptToken(bearer(request), env);
  if (
    value.kind !== "notion_session" ||
    typeof value.accessToken !== "string" ||
    typeof value.workspaceId !== "string" ||
    typeof value.workspaceName !== "string"
  )
    throw new HttpError(401, "Invalid Notion session");
  return value as unknown as NotionSession;
}

export async function authorizeNotionSession(
  request: Request,
  env: NotionEnvironment,
): Promise<void> {
  await session(request, env);
}

async function notion(
  path: string,
  accessToken: string,
  init: RequestInit = {},
  retryPost = false,
): Promise<JsonObject> {
  const method = init.method ?? "GET";
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${notionApi}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Notion-Version": notionVersion,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const value: unknown = await response.json().catch(() => ({}));
    if (response.ok) {
      if (!object(value))
        throw new HttpError(502, "Invalid response from Notion");
      return value;
    }
    const retryable =
      response.status === 429 ||
      response.status === 529 ||
      ((method !== "POST" || retryPost) &&
        [500, 502, 503, 504].includes(response.status));
    if (retryable && attempt < 4) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      const delay = Number.isFinite(retryAfter)
        ? Math.max(250, retryAfter * 1000)
        : Math.min(4000, 250 * 2 ** attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    const message =
      object(value) && typeof value.message === "string"
        ? value.message
        : `Notion request failed with ${response.status}`;
    throw new HttpError(response.status === 401 ? 401 : 502, message);
  }
  throw new HttpError(502, "Notion request failed");
}

function pageTitle(page: JsonObject): string {
  if (!object(page.properties)) return "Untitled";
  for (const property of Object.values(page.properties)) {
    if (
      !object(property) ||
      property.type !== "title" ||
      !Array.isArray(property.title)
    )
      continue;
    const title = property.title
      .map((item) =>
        object(item) && typeof item.plain_text === "string"
          ? item.plain_text
          : "",
      )
      .join("")
      .trim();
    return title || "Untitled";
  }
  return "Untitled";
}

function richText(value: string): JsonObject[] {
  if (value.length > 180_000)
    throw new HttpError(413, "Board is too large for its Notion document");
  const parts = value.match(/[\s\S]{1,1800}/g) ?? [""];
  return parts.map((content) => ({ type: "text", text: { content } }));
}

function emptyBoard(): JsonObject {
  return { tickets: [], comments: [], deployments: [] };
}

const entityKinds = ["ticket", "comment", "deployment"] as const;
type EntityKind = (typeof entityKinds)[number];

function normalizedSchema(): JsonObject {
  return {
    Kind: {
      select: {
        options: entityKinds.map((name) => ({ name })),
      },
    },
    "Entity ID": { rich_text: {} },
    "Ticket ID": { rich_text: {} },
    "Parent ID": { rich_text: {} },
    Status: {
      select: {
        options: [...statuses, "queued", "succeeded", "failed"].map((name) => ({
          name,
        })),
      },
    },
    Created: { date: {} },
    Attention: { checkbox: {} },
    Payload: { rich_text: {} },
  };
}

function textValue(value: string): JsonObject {
  return { rich_text: richText(value) };
}

function titleValue(value: string): JsonObject {
  return {
    title: [
      {
        type: "text",
        text: { content: value.slice(0, 2000) || "Untitled" },
      },
    ],
  };
}

function entityProperties(
  kind: EntityKind,
  entity: Ticket | TicketComment | DeploymentTask,
): JsonObject {
  const ticketId =
    kind === "ticket" ? entity.id : (entity as TicketComment).ticketId;
  const ticket = kind === "ticket" ? (entity as Ticket) : undefined;
  const comment = kind === "comment" ? (entity as TicketComment) : undefined;
  const deployment =
    kind === "deployment" ? (entity as DeploymentTask) : undefined;
  const name = ticket
    ? ticket.title
    : comment
      ? comment.message
      : `Deployment ${deployment!.unitId}`;
  const status = ticket?.status ?? deployment?.status;
  const createdAt =
    ticket?.createdAt ??
    comment?.createdAt ??
    deployment?.createdAt ??
    Date.now();
  return {
    Name: titleValue(name),
    Kind: { select: { name: kind } },
    "Entity ID": textValue(entity.id),
    "Ticket ID": textValue(ticketId),
    "Parent ID": textValue(ticket?.parentId ?? ""),
    Status: status ? { select: { name: status } } : { select: null },
    Created: { date: { start: new Date(createdAt).toISOString() } },
    Attention: { checkbox: comment?.attention ?? false },
    Payload: textValue(JSON.stringify(entity)),
  };
}

function propertyText(page: JsonObject, name: string): string {
  if (!object(page.properties)) return "";
  const property = page.properties[name];
  if (!object(property)) return "";
  const values = Array.isArray(property.rich_text)
    ? property.rich_text
    : Array.isArray(property.title)
      ? property.title
      : [];
  return values
    .map((item) =>
      object(item) && typeof item.plain_text === "string"
        ? item.plain_text
        : "",
    )
    .join("");
}

function propertySelect(page: JsonObject, name: string): string {
  if (!object(page.properties)) return "";
  const property = page.properties[name];
  if (!object(property) || !object(property.select)) return "";
  return typeof property.select.name === "string" ? property.select.name : "";
}

async function recordReference(
  pageId: string,
  dataSourceId: string,
  env: NotionEnvironment,
): Promise<string> {
  configured(env);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.NOTION_SESSION_PRIVATE_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${dataSourceId}:${pageId}`),
  );
  return `${pageId}.${base64Url(signature)}`;
}

async function pageIdFromReference(
  reference: string,
  dataSourceId: string,
  env: NotionEnvironment,
): Promise<string> {
  configured(env);
  const separator = reference.lastIndexOf(".");
  if (separator < 1) throw new HttpError(400, "Invalid board record");
  const pageId = reference.slice(0, separator);
  const signature = reference.slice(separator + 1);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.NOTION_SESSION_PRIVATE_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(signature),
    encoder.encode(`${dataSourceId}:${pageId}`),
  );
  if (!valid) throw new HttpError(400, "Invalid board record");
  return pageId;
}

async function ensureNormalizedSchema(
  dataSourceId: string,
  accessToken: string,
): Promise<void> {
  const source = await notion(`/data_sources/${dataSourceId}`, accessToken);
  if (object(source.properties) && object(source.properties.Kind)) return;
  await notion(`/data_sources/${dataSourceId}`, accessToken, {
    method: "PATCH",
    body: JSON.stringify({ properties: normalizedSchema() }),
  });
}

async function queryAllPages(
  dataSourceId: string,
  accessToken: string,
): Promise<JsonObject[]> {
  const pages: JsonObject[] = [];
  let cursor: string | undefined;
  do {
    const result = await notion(
      `/data_sources/${dataSourceId}/query`,
      accessToken,
      {
        method: "POST",
        body: JSON.stringify({
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      },
      true,
    );
    const results = Array.isArray(result.results) ? result.results : [];
    pages.push(...results.filter((page): page is JsonObject => object(page)));
    cursor =
      result.has_more === true && typeof result.next_cursor === "string"
        ? result.next_cursor
        : undefined;
  } while (cursor);
  return pages;
}

async function loadNormalizedBoard(
  dataSourceId: string,
  accessToken: string,
  env: NotionEnvironment,
): Promise<
  BoardLoadResult & { legacy?: { page: JsonObject; board: BoardState } }
> {
  const pages = await queryAllPages(dataSourceId, accessToken);
  const records = emptyRecordIds();
  const tickets: Ticket[] = [];
  const comments: TicketComment[] = [];
  const deployments: DeploymentTask[] = [];
  let legacy: { page: JsonObject; board: BoardState } | undefined;
  for (const page of pages) {
    if (typeof page.id !== "string") continue;
    const kind = propertySelect(page, "Kind");
    if (!entityKinds.includes(kind as EntityKind)) {
      if (propertyText(page, "State")) {
        legacy = {
          page,
          board: parseBoardState(boardProperty(page)),
        };
      }
      continue;
    }
    const payload = propertyText(page, "Payload");
    let entity: unknown;
    try {
      entity = JSON.parse(payload);
    } catch {
      throw new HttpError(502, "Notion board record is invalid");
    }
    if (!object(entity) || typeof entity.id !== "string")
      throw new HttpError(502, "Notion board record is malformed");
    const reference = await recordReference(page.id, dataSourceId, env);
    if (kind === "ticket") {
      tickets.push(entity as unknown as Ticket);
      records.tickets[entity.id] = reference;
    } else if (kind === "comment") {
      comments.push(entity as unknown as TicketComment);
      records.comments[entity.id] = reference;
    } else {
      deployments.push(entity as unknown as DeploymentTask);
      records.deployments[entity.id] = reference;
    }
  }
  const board = parseBoardState({ tickets, comments, deployments });
  return { board, records, ...(legacy ? { legacy } : {}) };
}

function boardProperty(page: JsonObject): unknown {
  if (!object(page.properties))
    throw new HttpError(502, "Notion board is malformed");
  const state = page.properties.State;
  if (!object(state) || !Array.isArray(state.rich_text))
    throw new HttpError(502, "Notion board state is missing");
  const source = state.rich_text
    .map((item) =>
      object(item) && typeof item.plain_text === "string"
        ? item.plain_text
        : "",
    )
    .join("");
  try {
    return JSON.parse(source);
  } catch {
    throw new HttpError(502, "Notion board state is invalid");
  }
}

export async function notionStart(env: NotionEnvironment): Promise<Response> {
  configured(env);
  const state = await encryptToken(
    { kind: "notion_oauth_state", nonce: crypto.randomUUID() },
    env,
    stateTtl,
  );
  const url = new URL("https://api.notion.com/v1/oauth/authorize");
  url.searchParams.set("client_id", env.NOTION_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("owner", "user");
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("state", state);
  return Response.redirect(url.toString(), 302);
}

export async function notionCallback(
  request: Request,
  env: NotionEnvironment,
): Promise<Response> {
  configured(env);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new HttpError(400, "Missing OAuth code or state");
  const stateValue = await decryptToken(state, env);
  if (stateValue.kind !== "notion_oauth_state")
    throw new HttpError(400, "Invalid OAuth state");
  const credentials = btoa(
    `${env.NOTION_CLIENT_ID}:${env.NOTION_CLIENT_SECRET}`,
  );
  const response = await fetch(`${notionApi}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl,
    }),
  });
  const value: unknown = await response.json().catch(() => ({}));
  if (!response.ok || !object(value) || typeof value.access_token !== "string")
    throw new HttpError(502, "Notion token exchange failed");
  const token = await encryptToken(
    {
      kind: "notion_session",
      accessToken: value.access_token,
      ...(typeof value.refresh_token === "string"
        ? { refreshToken: value.refresh_token }
        : {}),
      workspaceId:
        typeof value.workspace_id === "string" ? value.workspace_id : "",
      workspaceName:
        typeof value.workspace_name === "string"
          ? value.workspace_name
          : "Notion",
      ...(typeof value.workspace_icon === "string"
        ? { workspaceIcon: value.workspace_icon }
        : {}),
    },
    env,
  );
  const destination = JSON.stringify(clientUrl);
  const sessionToken = JSON.stringify(token);
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Conclave · Notion</title><script>location.replace(${destination}+"#notion_session="+encodeURIComponent(${sessionToken}))</script>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function notionStatus(
  request: Request,
  env: NotionEnvironment,
): Promise<Response> {
  const value = await session(request, env);
  return Response.json({
    connected: true,
    initialized: Boolean(value.dataSourceId),
    workspaceName: value.workspaceName,
    workspaceIcon: value.workspaceIcon ?? null,
    boardUrl: value.boardUrl ?? null,
  });
}

export async function notionPages(
  request: Request,
  env: NotionEnvironment,
): Promise<Response> {
  const value = await session(request, env);
  const result = await notion(
    "/search",
    value.accessToken,
    {
      method: "POST",
      body: JSON.stringify({
        filter: { property: "object", value: "page" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: 100,
      }),
    },
    true,
  );
  const results = Array.isArray(result.results) ? result.results : [];
  return Response.json({
    pages: results
      .filter(
        (page): page is JsonObject =>
          object(page) && typeof page.id === "string",
      )
      .map((page) => ({
        id: page.id,
        title: pageTitle(page),
        url: page.url ?? null,
      })),
  });
}

export async function notionSetup(
  request: Request,
  env: NotionEnvironment,
): Promise<Response> {
  const current = await session(request, env);
  const body = await readJson(request);
  if (
    !object(body) ||
    typeof body.parentPageId !== "string" ||
    !body.parentPageId
  )
    throw new HttpError(400, "Choose a Notion page");
  const database = await notion("/databases", current.accessToken, {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "page_id", page_id: body.parentPageId },
      title: [{ type: "text", text: { content: "Conclave" } }],
      initial_data_source: {
        properties: {
          Name: { title: {} },
          ...normalizedSchema(),
        },
      },
    }),
  });
  const databaseId = typeof database.id === "string" ? database.id : "";
  let sources = Array.isArray(database.data_sources)
    ? database.data_sources
    : [];
  if (!sources.length && databaseId) {
    const retrieved = await notion(
      `/databases/${databaseId}`,
      current.accessToken,
    );
    sources = Array.isArray(retrieved.data_sources)
      ? retrieved.data_sources
      : [];
  }
  const firstSource = sources.find(
    (source) => object(source) && typeof source.id === "string",
  );
  if (!object(firstSource) || typeof firstSource.id !== "string")
    throw new HttpError(502, "Notion did not create a board data source");
  const updated = await encryptToken(
    {
      kind: "notion_session",
      accessToken: current.accessToken,
      ...(current.refreshToken ? { refreshToken: current.refreshToken } : {}),
      workspaceId: current.workspaceId,
      workspaceName: current.workspaceName,
      ...(current.workspaceIcon
        ? { workspaceIcon: current.workspaceIcon }
        : {}),
      dataSourceId: firstSource.id,
      ...(typeof database.url === "string" ? { boardUrl: database.url } : {}),
    },
    env,
  );
  return Response.json({ token: updated, board: emptyBoard() });
}

function deltaGroup(value: unknown): value is {
  upsert: JsonObject[];
  remove: { id: string; recordId: string }[];
} {
  return (
    object(value) &&
    Array.isArray(value.upsert) &&
    value.upsert.every(
      (item) => object(item) && typeof item.id === "string" && item.id,
    ) &&
    Array.isArray(value.remove) &&
    value.remove.every(
      (item) =>
        object(item) &&
        typeof item.id === "string" &&
        typeof item.recordId === "string",
    )
  );
}

function parseDelta(value: unknown): BoardDelta {
  if (
    !object(value) ||
    !deltaGroup(value.tickets) ||
    !deltaGroup(value.comments) ||
    !deltaGroup(value.deployments) ||
    !object(value.records) ||
    !object(value.records.tickets) ||
    !object(value.records.comments) ||
    !object(value.records.deployments)
  )
    throw new HttpError(400, "Invalid board changes");
  const count =
    value.tickets.upsert.length +
    value.tickets.remove.length +
    value.comments.upsert.length +
    value.comments.remove.length +
    value.deployments.upsert.length +
    value.deployments.remove.length;
  if (count > 500) throw new HttpError(413, "Too many board changes");
  return value as unknown as BoardDelta;
}

async function findEntityPage(
  dataSourceId: string,
  entityId: string,
  accessToken: string,
): Promise<JsonObject | undefined> {
  const result = await notion(
    `/data_sources/${dataSourceId}/query`,
    accessToken,
    {
      method: "POST",
      body: JSON.stringify({
        page_size: 2,
        filter: {
          property: "Entity ID",
          rich_text: { equals: entityId },
        },
      }),
    },
    true,
  );
  const results = Array.isArray(result.results) ? result.results : [];
  return results.find((item): item is JsonObject => object(item));
}

async function createEntity(
  kind: EntityKind,
  entity: Ticket | TicketComment | DeploymentTask,
  dataSourceId: string,
  accessToken: string,
): Promise<JsonObject> {
  try {
    return await notion("/pages", accessToken, {
      method: "POST",
      body: JSON.stringify({
        parent: { type: "data_source_id", data_source_id: dataSourceId },
        properties: entityProperties(kind, entity),
      }),
    });
  } catch (error) {
    const existing = await findEntityPage(dataSourceId, entity.id, accessToken);
    if (existing) return existing;
    throw error;
  }
}

async function saveEntity(
  kind: EntityKind,
  entity: Ticket | TicketComment | DeploymentTask,
  records: BoardRecordIds,
  dataSourceId: string,
  accessToken: string,
  env: NotionEnvironment,
): Promise<void> {
  const collection =
    kind === "ticket"
      ? records.tickets
      : kind === "comment"
        ? records.comments
        : records.deployments;
  const reference = collection[entity.id];
  let page: JsonObject;
  if (reference) {
    const pageId = await pageIdFromReference(reference, dataSourceId, env);
    page = await notion(`/pages/${pageId}`, accessToken, {
      method: "PATCH",
      body: JSON.stringify({ properties: entityProperties(kind, entity) }),
    });
  } else {
    page = await createEntity(kind, entity, dataSourceId, accessToken);
  }
  if (typeof page.id !== "string")
    throw new HttpError(502, "Notion did not return a board record");
  collection[entity.id] = await recordReference(page.id, dataSourceId, env);
}

async function removeEntity(
  id: string,
  reference: string,
  records: Record<string, string>,
  dataSourceId: string,
  accessToken: string,
  env: NotionEnvironment,
): Promise<void> {
  const pageId = await pageIdFromReference(reference, dataSourceId, env);
  await notion(`/pages/${pageId}`, accessToken, {
    method: "PATCH",
    body: JSON.stringify({ in_trash: true }),
  });
  delete records[id];
}

async function applyDelta(
  delta: BoardDelta,
  dataSourceId: string,
  accessToken: string,
  env: NotionEnvironment,
): Promise<BoardRecordIds> {
  const records = structuredClone(delta.records);
  for (const item of delta.deployments.remove)
    await removeEntity(
      item.id,
      item.recordId,
      records.deployments,
      dataSourceId,
      accessToken,
      env,
    );
  for (const item of delta.comments.remove)
    await removeEntity(
      item.id,
      item.recordId,
      records.comments,
      dataSourceId,
      accessToken,
      env,
    );
  for (const item of delta.tickets.remove)
    await removeEntity(
      item.id,
      item.recordId,
      records.tickets,
      dataSourceId,
      accessToken,
      env,
    );
  for (const ticket of delta.tickets.upsert)
    await saveEntity("ticket", ticket, records, dataSourceId, accessToken, env);
  for (const comment of delta.comments.upsert)
    await saveEntity(
      "comment",
      comment,
      records,
      dataSourceId,
      accessToken,
      env,
    );
  for (const deployment of delta.deployments.upsert)
    await saveEntity(
      "deployment",
      deployment,
      records,
      dataSourceId,
      accessToken,
      env,
    );
  return records;
}

function fullBoardDelta(
  board: BoardState,
  records: BoardRecordIds,
): BoardDelta {
  return {
    tickets: { upsert: board.tickets, remove: [] },
    comments: { upsert: board.comments, remove: [] },
    deployments: { upsert: board.deployments ?? [], remove: [] },
    records,
  };
}

export async function notionReadBoard(
  request: Request,
  env: NotionEnvironment,
): Promise<Response> {
  const value = await session(request, env);
  if (!value.dataSourceId)
    throw new HttpError(409, "Notion board is not initialized");
  await ensureNormalizedSchema(value.dataSourceId, value.accessToken);
  const loaded = await loadNormalizedBoard(
    value.dataSourceId,
    value.accessToken,
    env,
  );
  if (!loaded.legacy) return Response.json(loaded);
  const records = await applyDelta(
    fullBoardDelta(loaded.legacy.board, loaded.records),
    value.dataSourceId,
    value.accessToken,
    env,
  );
  if (typeof loaded.legacy.page.id === "string")
    await notion(`/pages/${loaded.legacy.page.id}`, value.accessToken, {
      method: "PATCH",
      body: JSON.stringify({ in_trash: true }),
    });
  return Response.json({ board: loaded.legacy.board, records });
}

export async function notionWriteBoard(
  request: Request,
  env: NotionEnvironment,
): Promise<Response> {
  const value = await session(request, env);
  if (!value.dataSourceId)
    throw new HttpError(409, "Notion board is not initialized");
  const delta = parseDelta(await readJson(request));
  const records = await applyDelta(
    delta,
    value.dataSourceId,
    value.accessToken,
    env,
  );
  return Response.json({ records });
}

export async function notionClearBoard(
  request: Request,
  env: NotionEnvironment,
): Promise<Response> {
  const value = await session(request, env);
  if (!value.dataSourceId)
    throw new HttpError(409, "Notion board is not initialized");
  const pages = await queryAllPages(value.dataSourceId, value.accessToken);
  for (const page of pages) {
    if (typeof page.id !== "string") continue;
    await notion(`/pages/${page.id}`, value.accessToken, {
      method: "PATCH",
      body: JSON.stringify({ in_trash: true }),
    });
  }
  return Response.json({ board: emptyBoard(), records: emptyRecordIds() });
}
