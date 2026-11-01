import * as esbuild from "esbuild-wasm";
import wasmUrl from "esbuild-wasm/esbuild.wasm?url";
import type { ApiUnitSpec } from "../domain/api-units";
import { validateApiUnit } from "../domain/api-units";
import type { ReleasePayload, SourceArchive, SourceFile } from "./types";

let initialization: Promise<void> | undefined;

function initialize(): Promise<void> {
  initialization ??= esbuild.initialize({ wasmURL: wasmUrl, worker: true });
  return initialization;
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function normalized(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function resolveFile(
  path: string,
  files: Map<string, string>,
): string | undefined {
  const candidates = [
    path,
    `${path}.ts`,
    `${path}.tsx`,
    `${path}.js`,
    `${path}.mjs`,
    `${path}.txt`,
    `${path}/index.ts`,
  ];
  return candidates.find((candidate) => files.has(candidate));
}

function generatedApiUnits(units: ApiUnitSpec[]): string {
  const routes = new Set<string>();
  const definitions = units.map((unit) => {
    validateApiUnit(unit);
    const route = `${unit.method} ${unit.path}`;
    if (routes.has(route)) throw new Error(`Duplicate API route: ${route}`);
    routes.add(route);
    return `{
      id: ${JSON.stringify(unit.id)},
      name: ${JSON.stringify(unit.name)},
      method: ${JSON.stringify(unit.method)},
      path: ${JSON.stringify(unit.path)},
      requestSchema: ${JSON.stringify(unit.requestSchema)},
      responseSchema: ${JSON.stringify(unit.responseSchema)},
      handler: async (request, env, params) => {${unit.handlerSource}\n},
    }`;
  });
  return `export const apiUnits = [\n${definitions.join(",\n")}\n];`;
}

export function apiUnitsFromSource(source: SourceArchive): ApiUnitSpec[] {
  return source.files
    .filter(
      (file) =>
        file.path.startsWith("server/api-units/") &&
        file.path.endsWith(".json"),
    )
    .map((file) => JSON.parse(file.content) as ApiUnitSpec)
    .map((unit) => {
      validateApiUnit(unit);
      return unit;
    });
}

export async function upsertApiUnitSource(
  source: SourceArchive,
  unit: ApiUnitSpec,
  mode: "add" | "update",
): Promise<SourceArchive> {
  validateApiUnit(unit);
  const path = `server/api-units/${unit.id}.json`;
  const exists = source.files.some((file) => file.path === path);
  if (mode === "add" && exists) throw new Error("API unit already exists");
  if (mode === "update" && !exists) throw new Error("API unit not found");
  const content = `${JSON.stringify(unit, null, 2)}\n`;
  const file: SourceFile = { path, content, sha256: await digest(content) };
  const files = source.files
    .filter((current) => current.path !== path)
    .concat(file)
    .sort((left, right) => left.path.localeCompare(right.path));
  const revision = await digest(
    JSON.stringify(files.map((current) => [current.path, current.sha256])),
  );
  return { schema: 1, revision, files };
}

export async function buildRelease(
  baseVersion: string,
  source: SourceArchive,
): Promise<ReleasePayload> {
  await initialize();
  const files = new Map(source.files.map((file) => [file.path, file.content]));
  files.set(
    "server/generated/api-units.ts",
    generatedApiUnits(apiUnitsFromSource(source)),
  );
  const result = await esbuild.build({
    entryPoints: ["server/worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    plugins: [
      {
        name: "conclave-source",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === "entry-point") {
              const entry = resolveFile(normalized(args.path), files);
              return entry
                ? { path: entry, namespace: "conclave-source" }
                : { errors: [{ text: `Entry point not found: ${args.path}` }] };
            }
            if (args.path.endsWith("generated/source.snapshot.txt"))
              return { path: "./source.snapshot.txt", external: true };
            if (!args.path.startsWith("."))
              return {
                errors: [
                  { text: `External import is not allowed: ${args.path}` },
                ],
              };
            const base = args.importer.includes("/")
              ? args.importer.slice(0, args.importer.lastIndexOf("/") + 1)
              : "";
            const path = resolveFile(normalized(`${base}${args.path}`), files);
            return path
              ? { path, namespace: "conclave-source" }
              : { errors: [{ text: `Source file not found: ${args.path}` }] };
          });
          build.onLoad(
            { filter: /.*/, namespace: "conclave-source" },
            (args) => ({
              contents: files.get(args.path),
              loader: args.path.endsWith(".tsx")
                ? "tsx"
                : args.path.endsWith(".ts")
                  ? "ts"
                  : args.path.endsWith(".json")
                    ? "json"
                    : args.path.endsWith(".txt")
                      ? "text"
                      : "js",
            }),
          );
        },
      },
    ],
  });
  const artifact = result.outputFiles.find((file) => file.path.endsWith(".js"));
  if (!artifact) throw new Error("Worker build did not produce JavaScript");
  const content = artifact.text;
  const sha256 = await digest(content);
  return {
    baseVersion,
    source,
    artifact: { content, sha256 },
    checks: {
      sourceRevision: source.revision,
      artifactSha256: sha256,
      passed: ["api-schema", "api-lint", "bundle"],
    },
  };
}
