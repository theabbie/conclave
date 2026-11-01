import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateApiUnits } from "./generate-api-units.mjs";

const roots = ["src", "server", "scripts", "public"];
const rootFiles = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.server.json",
  "vite.config.ts",
  "wrangler.jsonc",
  "index.html",
  ".gitignore",
  "README.md",
];
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function collect(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Source archive cannot contain symbolic links: ${path}`);
    if (
      path === "server/generated/source.snapshot.txt" ||
      entry.name.startsWith(".env") ||
      entry.name.startsWith(".dev.vars")
    )
      continue;
    if (entry.isDirectory()) files.push(...(await collect(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function createSnapshot() {
  await generateApiUnits();
  const paths = [...rootFiles];
  for (const root of roots) paths.push(...(await collect(root)));
  const files = [];
  for (const path of paths.sort()) {
    let bytes;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (error.code === "ENOENT" && rootFiles.includes(path)) continue;
      throw error;
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    files.push({ path, content, sha256: hash(content) });
  }
  const source = {
    schema: 1,
    revision: hash(
      JSON.stringify(files.map((file) => [file.path, file.sha256])),
    ),
    files,
  };
  await mkdir("server/generated", { recursive: true });
  await writeFile(
    "server/generated/source.snapshot.txt",
    JSON.stringify(source),
  );
  return source;
}

if (process.argv[1]?.endsWith("snapshot.mjs")) {
  const source = await createSnapshot();
  process.stdout.write(
    `Source revision ${source.revision} (${source.files.length} files)\n`,
  );
}
