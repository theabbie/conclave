import { readFile, writeFile } from "node:fs/promises";

const [operation, path, receiptPath] = process.argv.slice(2);
const endpoint =
  process.env.CONCLAVE_SERVER_URL ?? "https://conclave.abbie.workers.dev";
const token = process.env.CONCLAVE_DEPLOY_TOKEN;
if (
  !token ||
  !path ||
  !["stage", "activate"].includes(operation) ||
  (operation === "stage" && !receiptPath)
)
  throw new Error(
    "Usage: CONCLAVE_DEPLOY_TOKEN=... node scripts/deploy/publish.mjs stage release.json receipt.json | activate receipt.json",
  );
const url = operation === "stage" ? "/api/releases" : "/api/releases/activate";
const response = await fetch(new URL(url, endpoint), {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  },
  body: await readFile(path, "utf8"),
});
const body = await response.json();
if (!response.ok)
  throw new Error(
    `${operation} failed (HTTP ${response.status}): ${body.error ?? "unknown error"}`,
  );
if (operation === "stage") {
  await writeFile(receiptPath, JSON.stringify(body), { mode: 0o600 });
  process.stdout.write(
    `Staged version ${body.receipt.versionId}. Receipt saved to ${receiptPath}; production is unchanged.\n`,
  );
} else {
  process.stdout.write(
    `Activated version ${body.versionId}, source ${body.sourceRevision}.\n`,
  );
}
