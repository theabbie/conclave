import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const sourceDirectory = "server/api-units";
const outputPath = "server/generated/api-units.ts";
const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const reserved = ["/api/health", "/api/source", "/api/releases"];

function validate(unit, file) {
  if (!unit || typeof unit !== "object" || Array.isArray(unit))
    throw new Error(`Invalid API unit: ${file}`);
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(unit.id) ||
    typeof unit.name !== "string" ||
    !unit.name.trim() ||
    typeof unit.handlerSource !== "string" ||
    !unit.handlerSource.trim() ||
    unit.handlerSource.length > 50_000
  )
    throw new Error(`API unit fields are required: ${file}`);
  if (/\beval\s*\(|\bnew\s+Function\b/.test(unit.handlerSource))
    throw new Error(`Dynamic code evaluation is not allowed: ${file}`);
  if (!methods.has(unit.method)) throw new Error(`Invalid API method: ${file}`);
  if (
    !/^\/api\/[a-zA-Z0-9_\-/:]*$/.test(unit.path) ||
    unit.path.includes("//")
  )
    throw new Error(`Invalid API path: ${file}`);
  if (
    reserved.some(
      (path) => unit.path === path || unit.path.startsWith(`${path}/`),
    )
  )
    throw new Error(`Reserved API path: ${file}`);
  for (const schema of [unit.requestSchema, unit.responseSchema]) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema))
      throw new Error(`Invalid API schema: ${file}`);
  }
}

export async function generateApiUnits() {
  await mkdir(sourceDirectory, { recursive: true });
  const names = (await readdir(sourceDirectory))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const units = [];
  const routes = new Set();
  for (const name of names) {
    const file = join(sourceDirectory, name);
    const unit = JSON.parse(await readFile(file, "utf8"));
    validate(unit, file);
    const route = `${unit.method} ${unit.path}`;
    if (routes.has(route)) throw new Error(`Duplicate API route: ${route}`);
    routes.add(route);
    units.push(unit);
  }
  const definitions = units.map(
    (unit) => `{
    id: ${JSON.stringify(unit.id)},
    name: ${JSON.stringify(unit.name)},
    method: ${JSON.stringify(unit.method)},
    path: ${JSON.stringify(unit.path)},
    requestSchema: ${JSON.stringify(unit.requestSchema)},
    responseSchema: ${JSON.stringify(unit.responseSchema)},
    handler: async (request, env, params) => {${unit.handlerSource}\n},
  }`,
  );
  const output = `export const apiUnits = [\n${definitions.join(",\n")}\n];\n`;
  await mkdir("server/generated", { recursive: true });
  await writeFile(outputPath, output);
  return units;
}

if (process.argv[1]?.endsWith("generate-api-units.mjs")) {
  const units = await generateApiUnits();
  process.stdout.write(`Generated ${units.length} API units\n`);
}
