import { describe, expect, it, vi } from "vitest";
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
  it("waits for deployment completion and returns the public API URL", async () => {
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
    });
  });
});
