import { HttpError, readJson } from "./releases";

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
): Promise<JsonObject> {
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
  if (!response.ok) {
    const message =
      object(value) && typeof value.message === "string"
        ? value.message
        : `Notion request failed with ${response.status}`;
    throw new HttpError(response.status === 401 ? 401 : 502, message);
  }
  if (!object(value)) throw new HttpError(502, "Invalid response from Notion");
  return value;
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
    initialized: Boolean(value.dataSourceId && value.boardPageId),
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
  const result = await notion("/search", value.accessToken, {
    method: "POST",
    body: JSON.stringify({
      filter: { property: "object", value: "page" },
      sort: { direction: "descending", timestamp: "last_edited_time" },
      page_size: 100,
    }),
  });
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
          State: { rich_text: {} },
          Revision: { number: {} },
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
  const initial = JSON.stringify(emptyBoard());
  const boardPage = await notion("/pages", current.accessToken, {
    method: "POST",
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: firstSource.id },
      properties: {
        Name: { title: [{ type: "text", text: { content: "Board" } }] },
        State: { rich_text: richText(initial) },
        Revision: { number: 0 },
      },
    }),
  });
  if (typeof boardPage.id !== "string")
    throw new HttpError(502, "Notion did not create a board page");
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
      boardPageId: boardPage.id,
      ...(typeof boardPage.url === "string" ? { boardUrl: boardPage.url } : {}),
    },
    env,
  );
  return Response.json({ token: updated, board: emptyBoard() });
}

export async function notionReadBoard(
  request: Request,
  env: NotionEnvironment,
): Promise<Response> {
  const value = await session(request, env);
  if (!value.boardPageId)
    throw new HttpError(409, "Notion board is not initialized");
  const page = await notion(`/pages/${value.boardPageId}`, value.accessToken);
  return Response.json({ board: boardProperty(page) });
}

export async function notionWriteBoard(
  request: Request,
  env: NotionEnvironment,
): Promise<Response> {
  const value = await session(request, env);
  if (!value.boardPageId)
    throw new HttpError(409, "Notion board is not initialized");
  const body = await readJson(request);
  if (!object(body) || !object(body.board))
    throw new HttpError(400, "Invalid board state");
  const source = JSON.stringify(body.board);
  await notion(`/pages/${value.boardPageId}`, value.accessToken, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        State: { rich_text: richText(source) },
        Revision: { number: Date.now() },
      },
      notifications: { mode: "silent" },
    }),
  });
  return Response.json({ saved: true });
}
