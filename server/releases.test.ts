import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activateRelease,
  authorize,
  readJson,
  sha256,
  stageRelease,
  validateRelease,
  type ReleasePayload,
} from "./releases";

const env = {
  CONCLAVE_DEPLOY_TOKEN: "test-owner-token",
  CLOUDFLARE_API_TOKEN: "test-cloudflare-token",
  CLOUDFLARE_ACCOUNT_ID: "account",
  WORKER_NAME: "conclave",
};

async function payload(): Promise<ReleasePayload> {
  const content =
    'import source from "./generated/source.snapshot.txt"; export default { fetch() { return new Response(source) } };';
  const files = [
    { path: "server/worker.ts", content, sha256: await sha256(content) },
  ];
  const revision = await sha256(
    JSON.stringify(files.map((file) => [file.path, file.sha256])),
  );
  const digest = await sha256(content);
  return {
    baseVersion: "current",
    source: { schema: 1, revision, files },
    artifact: { content, sha256: digest },
    checks: {
      sourceRevision: revision,
      artifactSha256: digest,
      passed: ["typecheck", "test", "lint", "build"],
    },
  };
}

function request(body: unknown) {
  return new Request("https://conclave.test/api/releases", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function response(result: unknown) {
  return Response.json({ success: true, result });
}

const current = () =>
  response({
    deployments: [{ versions: [{ version_id: "current", percentage: 100 }] }],
  });

afterEach(() => vi.unstubAllGlobals());

describe("release validation", () => {
  it("validates every source digest and the aggregate revision", async () => {
    const release = await payload();
    await expect(validateRelease(release)).resolves.toEqual(release);
    release.source.files[0].content += "tampered";
    await expect(validateRelease(release)).rejects.toThrow(
      "Source file digest mismatch",
    );
  });

  it("rejects traversal and duplicate source paths", async () => {
    const release = await payload();
    release.source.files[0].path = "../secret";
    await expect(validateRelease(release)).rejects.toThrow("Unsafe");
    const duplicate = await payload();
    duplicate.source.files.push(duplicate.source.files[0]);
    await expect(validateRelease(duplicate)).rejects.toThrow("Unsafe");
  });

  it("rejects missing checks and reports for other source", async () => {
    const release = await payload();
    release.checks.passed = ["build"];
    await expect(validateRelease(release)).rejects.toThrow(
      "Required build checks",
    );
    release.checks.passed = ["typecheck", "test", "lint", "build"];
    release.checks.sourceRevision = "other";
    await expect(validateRelease(release)).rejects.toThrow(
      "Required build checks",
    );
  });

  it("accepts the browser atomic-API validation profile", async () => {
    const release = await payload();
    release.checks.passed = ["api-schema", "api-lint", "bundle"];
    await expect(validateRelease(release)).resolves.toEqual(release);
  });

  it("rejects tampered artifacts", async () => {
    const release = await payload();
    release.artifact.content += "changed";
    await expect(validateRelease(release)).rejects.toThrow(
      "Artifact digest mismatch",
    );
  });

  it("fails closed without owner credentials", async () => {
    const incoming = new Request("https://conclave.test/api/source");
    await expect(authorize(incoming, {})).rejects.toMatchObject({
      status: 503,
    });
    await expect(authorize(incoming, env)).rejects.toMatchObject({
      status: 401,
    });
    await expect(
      authorize(
        new Request(incoming, {
          headers: { Authorization: "Bearer test-owner-token" },
        }),
        env,
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects oversized bodies before parsing", async () => {
    await expect(
      readJson(request("x".repeat(8 * 1024 * 1024))),
    ).rejects.toMatchObject({ status: 413 });
  });
});

describe("release lifecycle", () => {
  it("stages exact source and artifact without activating, then accepts its signed receipt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(current())
      .mockResolvedValueOnce(response({ id: "next" }))
      .mockResolvedValueOnce(current())
      .mockResolvedValueOnce(response({ id: "deployment" }));
    vi.stubGlobal("fetch", fetchMock);
    const release = await payload();
    const staged = await stageRelease(request(release), env);
    expect(staged.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url.endsWith("/versions")).toBe(true);
    const form = init.body as FormData;
    expect(
      await (form.get("generated/source.snapshot.txt") as Blob).text(),
    ).toBe(JSON.stringify(release.source));
    expect(await (form.get("worker.mjs") as Blob).text()).toBe(
      release.artifact.content,
    );
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.keep_bindings).toEqual(["secret_text", "plain_text"]);
    const receipt = await staged.json();
    const activated = await activateRelease(request(receipt), env);
    expect(await activated.json()).toMatchObject({
      versionId: "next",
      deploymentId: "deployment",
    });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({
      strategy: "percentage",
      versions: [{ version_id: "next", percentage: 100 }],
    });
  });

  it("rejects a stale base before uploading anything", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        deployments: [{ versions: [{ version_id: "newer", percentage: 100 }] }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      stageRelease(request(await payload()), env),
    ).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects forged activation receipts before any upstream operation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      activateRelease(
        request({
          receipt: {
            versionId: "arbitrary",
            baseVersion: "current",
            sourceRevision: "x",
            artifactSha256: "y",
            expiresAt: Date.now() + 1000,
          },
          signature: "forged",
        }),
        env,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
