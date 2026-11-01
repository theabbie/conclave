import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiUnitSpec } from "../domain/api-units";
import { ApiWorkspace } from "./api-workspace";
import type { ReleaseClient } from "./client";

const unit: ApiUnitSpec = {
  id: "hello",
  name: "Hello",
  method: "GET",
  path: "/api/hello",
  requestSchema: {},
  responseSchema: {},
  handlerSource: "return Response.json({ message: 'Hello' });",
};

vi.mock("./browser-builder", () => ({
  apiUnitsFromSource: () => [unit],
  upsertApiUnitSource: vi.fn(),
  buildRelease: async () => ({ release: true }),
}));

describe("ApiWorkspace", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("waits for deployment completion and returns the public API URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: "Hello" })),
    );
    const client = {
      current: vi.fn(async () => ({
        versionId: "base",
        source: { schema: 1, revision: "revision", files: [] },
      })),
      stage: vi.fn(async () => ({ receipt: {}, signature: "signature" })),
      activate: vi.fn(async () => ({
        deploymentId: "deployment",
        versionId: "version",
        sourceRevision: "revision",
      })),
    } as unknown as ReleaseClient;
    const statuses: string[] = [];
    const workspace = new ApiWorkspace(client, {
      taskQueued: () => undefined,
      statusChanged: (event) => statuses.push(event.status),
    });
    const result = await workspace.deployApiUnit("hello", "child");
    expect(statuses).toEqual(["in_progress", "succeeded"]);
    expect(result).toMatchObject({
      status: "succeeded",
      url: "https://conclave-workspace.abbie.workers.dev/api/hello",
      verification: { status: 200, body: '{"message":"Hello"}' },
    });
  });

  it("marks the task failed when live verification fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "broken" }, { status: 500 })),
    );
    const client = {
      current: vi.fn(async () => ({
        versionId: "base",
        source: { schema: 1, revision: "revision", files: [] },
      })),
      stage: vi.fn(async () => ({ receipt: {}, signature: "signature" })),
      activate: vi.fn(async () => ({
        deploymentId: "deployment",
        versionId: "version",
        sourceRevision: "revision",
      })),
    } as unknown as ReleaseClient;
    const statuses: string[] = [];
    const workspace = new ApiWorkspace(client, {
      taskQueued: () => undefined,
      statusChanged: (event) => statuses.push(event.status),
    });
    const result = await workspace.deployApiUnit("hello", "child");
    expect(statuses).toEqual(["in_progress", "failed"]);
    expect(result).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Live verification failed (HTTP 500)"),
    });
    expect(result).not.toHaveProperty("url");
  });
});
