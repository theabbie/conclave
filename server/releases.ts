export interface ReleaseEnvironment {
  CONCLAVE_DEPLOY_TOKEN?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  WORKER_NAME?: string;
  WORKER_ROLE?: string;
  WORKSPACE_URL?: string;
  WORKSPACE_SOURCE_TOKEN?: string;
  VERSION?: { id: string };
}

import type { SourceFile, ReleasePayload } from "../src/deploy/types";
export type { ReleasePayload } from "../src/deploy/types";

const encoder = new TextEncoder();
const maximumBody = 8 * 1024 * 1024;
export const requiredCheckProfiles = [
  ["typecheck", "test", "lint", "build"],
  ["api-schema", "api-lint", "bundle"],
];

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function authorize(
  request: Request,
  env: ReleaseEnvironment,
): Promise<void> {
  if (!env.CONCLAVE_DEPLOY_TOKEN)
    throw new HttpError(503, "Release access is not configured");
  const received = request.headers.get("Authorization") ?? "";
  const expected = `Bearer ${env.CONCLAVE_DEPLOY_TOKEN}`;
  const [left, right] = await Promise.all([sha256(received), sha256(expected)]);
  let different = 0;
  for (let index = 0; index < left.length; index++)
    different |= left.charCodeAt(index) ^ right.charCodeAt(index);
  if (different !== 0) throw new HttpError(401, "Unauthorized");
}

export async function readJson(request: Request): Promise<unknown> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    throw new HttpError(415, "Expected application/json");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Missing request body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximumBody) {
      await reader.cancel();
      throw new HttpError(413, "Release exceeds 8 MiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function validateRelease(value: unknown): Promise<ReleasePayload> {
  if (
    !object(value) ||
    typeof value.baseVersion !== "string" ||
    !object(value.source) ||
    !object(value.artifact) ||
    !object(value.checks)
  )
    throw new HttpError(400, "Invalid release envelope");
  const { source, artifact, checks } = value;
  if (
    source.schema !== 1 ||
    typeof source.revision !== "string" ||
    !Array.isArray(source.files) ||
    source.files.length === 0 ||
    source.files.length > 500
  )
    throw new HttpError(400, "Invalid source archive");
  let previous = "";
  for (const file of source.files) {
    if (
      !object(file) ||
      typeof file.path !== "string" ||
      typeof file.content !== "string" ||
      typeof file.sha256 !== "string"
    )
      throw new HttpError(400, "Invalid source file");
    if (
      !/^[a-zA-Z0-9_@.-]+(?:\/[a-zA-Z0-9_@.-]+)*$/.test(file.path) ||
      file.path
        .split("/")
        .some(
          (part) =>
            part === "." ||
            part === ".." ||
            part === "node_modules" ||
            part === ".git" ||
            part.startsWith(".env") ||
            part.startsWith(".dev.vars"),
        ) ||
      file.path <= previous
    )
      throw new HttpError(400, "Unsafe, duplicate, or unsorted source path");
    if ((await sha256(file.content)) !== file.sha256)
      throw new HttpError(400, "Source file digest mismatch");
    previous = file.path;
  }
  const revision = await sha256(
    JSON.stringify(
      source.files.map((file: SourceFile) => [file.path, file.sha256]),
    ),
  );
  if (revision !== source.revision)
    throw new HttpError(400, "Source revision mismatch");
  if (
    typeof artifact.content !== "string" ||
    typeof artifact.sha256 !== "string" ||
    (await sha256(artifact.content)) !== artifact.sha256
  )
    throw new HttpError(400, "Artifact digest mismatch");
  if (
    !/^import\s+[\w$]+\s+from\s+["']\.\/generated\/source\.snapshot\.txt["'];/m.test(
      artifact.content,
    )
  )
    throw new HttpError(400, "Artifact must import the source snapshot module");
  if (
    checks.sourceRevision !== revision ||
    checks.artifactSha256 !== artifact.sha256 ||
    !Array.isArray(checks.passed) ||
    !requiredCheckProfiles.some((profile) =>
      profile.every((check) => (checks.passed as unknown[]).includes(check)),
    )
  )
    throw new HttpError(
      400,
      "Required build checks are missing or refer to different content",
    );
  return value as unknown as ReleasePayload;
}

async function cloudflare<T>(
  env: ReleaseEnvironment,
  suffix: string,
  init: RequestInit = {},
): Promise<T> {
  if (
    !env.CLOUDFLARE_API_TOKEN ||
    !env.CLOUDFLARE_ACCOUNT_ID ||
    !env.WORKER_NAME
  )
    throw new HttpError(
      503,
      "Cloudflare release credentials are not configured",
    );
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${env.CLOUDFLARE_API_TOKEN}`);
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID)}/workers/scripts/${encodeURIComponent(env.WORKER_NAME)}${suffix}`,
    { ...init, headers },
  );
  const body = (await response.json()) as { success: boolean; result: T };
  if (!response.ok || !body.success)
    throw new HttpError(502, "Cloudflare release operation failed");
  return body.result;
}

async function assertCurrentVersion(
  env: ReleaseEnvironment,
  baseVersion: string,
): Promise<void> {
  const result = await cloudflare<{
    deployments: { versions: { version_id: string; percentage: number }[] }[];
  }>(env, "/deployments");
  const versions = result.deployments[0]?.versions;
  if (
    !versions ||
    versions.length !== 1 ||
    versions[0].percentage !== 100 ||
    versions[0].version_id !== baseVersion
  )
    throw new HttpError(
      409,
      "Production changed; fetch current source and rebuild",
    );
}

interface Receipt {
  versionId: string;
  baseVersion: string;
  sourceRevision: string;
  artifactSha256: string;
  expiresAt: number;
}

async function signature(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function stageRelease(
  request: Request,
  env: ReleaseEnvironment,
): Promise<Response> {
  const release = await validateRelease(await readJson(request));
  await assertCurrentVersion(env, release.baseVersion);
  const form = new FormData();
  form.set(
    "metadata",
    new Blob(
      [
        JSON.stringify({
          main_module: "worker.mjs",
          compatibility_date: "2026-10-31",
          compatibility_flags: ["nodejs_compat"],
          keep_bindings: ["secret_text", "plain_text"],
          bindings: [{ type: "version_metadata", name: "VERSION" }],
          annotations: {
            "workers/message": `Conclave source ${release.source.revision}`,
          },
        }),
      ],
      { type: "application/json" },
    ),
  );
  form.set(
    "worker.mjs",
    new Blob([release.artifact.content], {
      type: "application/javascript+module",
    }),
    "worker.mjs",
  );
  form.set(
    "generated/source.snapshot.txt",
    new Blob([JSON.stringify(release.source)], { type: "text/plain" }),
    "generated/source.snapshot.txt",
  );
  const version = await cloudflare<{ id: string }>(env, "/versions", {
    method: "POST",
    body: form,
  });
  const receipt: Receipt = {
    versionId: version.id,
    baseVersion: release.baseVersion,
    sourceRevision: release.source.revision,
    artifactSha256: release.artifact.sha256,
    expiresAt: Date.now() + 30 * 60 * 1000,
  };
  const encoded = JSON.stringify(receipt);
  return Response.json(
    {
      receipt,
      signature: await signature(encoded, env.CONCLAVE_DEPLOY_TOKEN!),
    },
    { status: 201 },
  );
}

export async function activateRelease(
  request: Request,
  env: ReleaseEnvironment,
): Promise<Response> {
  const body = await readJson(request);
  if (
    !object(body) ||
    !object(body.receipt) ||
    typeof body.signature !== "string"
  )
    throw new HttpError(400, "Invalid activation receipt");
  const receipt = body.receipt;
  if (
    typeof receipt.versionId !== "string" ||
    typeof receipt.baseVersion !== "string" ||
    typeof receipt.sourceRevision !== "string" ||
    typeof receipt.artifactSha256 !== "string" ||
    typeof receipt.expiresAt !== "number"
  )
    throw new HttpError(400, "Invalid activation receipt");
  const expected = await signature(
    JSON.stringify(receipt),
    env.CONCLAVE_DEPLOY_TOKEN!,
  );
  if (body.signature !== expected || receipt.expiresAt < Date.now())
    throw new HttpError(403, "Invalid or expired activation receipt");
  await assertCurrentVersion(env, receipt.baseVersion);
  const deployment = await cloudflare<{ id: string }>(env, "/deployments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      strategy: "percentage",
      versions: [{ version_id: receipt.versionId, percentage: 100 }],
    }),
  });
  return Response.json({
    deploymentId: deployment.id,
    versionId: receipt.versionId,
    sourceRevision: receipt.sourceRevision,
  });
}
