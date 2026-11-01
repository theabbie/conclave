import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createSnapshot } from "./snapshot.mjs";

const output = process.argv[2];
const endpoint =
  process.env.CONCLAVE_SERVER_URL ?? "https://conclave.abbie.workers.dev";
const token = process.env.CONCLAVE_DEPLOY_TOKEN;
if (!output || !token)
  throw new Error(
    "Usage: CONCLAVE_DEPLOY_TOKEN=... node scripts/deploy/prepare.mjs /tmp/release.json",
  );
const current = await fetch(new URL("/api/source", endpoint), {
  headers: { Authorization: `Bearer ${token}` },
});
if (!current.ok)
  throw new Error(`Could not read current source: HTTP ${current.status}`);
const { versionId } = await current.json();
if (typeof versionId !== "string")
  throw new Error("Server did not return its deployed version ID");
const initial = await createSnapshot();
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed`);
};
run("npx", ["tsc", "--noEmit"]);
run("npx", ["tsc", "-p", "tsconfig.server.json"]);
run("npm", ["test"]);
run("npx", ["tsc", "--noEmit", "--noUnusedLocals", "--noUnusedParameters"]);
run("npx", [
  "tsc",
  "-p",
  "tsconfig.server.json",
  "--noUnusedLocals",
  "--noUnusedParameters",
]);
run("npm", ["run", "build"]);
const directory = await mkdtemp(join(tmpdir(), "conclave-release-"));
try {
  run("npx", ["wrangler", "deploy", "--dry-run", "--outdir", directory]);
  const source = await createSnapshot();
  if (source.revision !== initial.revision)
    throw new Error("Source changed during validation; rebuild the release");
  const content = await readFile(join(directory, "worker.js"), "utf8");
  const sha256 = createHash("sha256").update(content).digest("hex");
  const release = {
    baseVersion: versionId,
    source,
    artifact: { content, sha256 },
    checks: {
      sourceRevision: source.revision,
      artifactSha256: sha256,
      passed: ["typecheck", "test", "lint", "build"],
    },
  };
  await writeFile(resolve(output), JSON.stringify(release), { mode: 0o600 });
  process.stdout.write(`Prepared ${source.revision} at ${resolve(output)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
