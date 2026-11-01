import { describe, expect, it, vi } from "vitest";

vi.mock("./generated/source.snapshot.txt", () => ({
  default: JSON.stringify({ schema: 1, revision: "test", files: [] }),
}));

import worker from "./worker";

const origin = "https://theabbie.github.io";

describe("Worker access boundary", () => {
  it("keeps source unavailable without configured authorization", async () => {
    const response = await worker.fetch(
      new Request("https://conclave.test/api/source", {
        headers: { Origin: origin },
      }),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  });

  it("returns current source only to the owner", async () => {
    const env = {
      CONCLAVE_DEPLOY_TOKEN: "owner",
      WORKER_ROLE: "workspace",
      VERSION: { id: "version" },
    };
    const unauthorized = await worker.fetch(
      new Request("https://conclave.test/api/source"),
      env,
    );
    expect(unauthorized.status).toBe(401);
    const response = await worker.fetch(
      new Request("https://conclave.test/api/source", {
        headers: { Authorization: "Bearer owner" },
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      versionId: "version",
      source: { revision: "test" },
    });
  });

  it("allows authenticated browser release preflights", async () => {
    const response = await worker.fetch(
      new Request("https://conclave.test/api/releases", {
        method: "OPTIONS",
        headers: {
          Origin: origin,
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
  });

  it("does not grant CORS to other origins", async () => {
    const response = await worker.fetch(
      new Request("https://conclave.test/api/releases", {
        method: "OPTIONS",
        headers: {
          Origin: "https://example.com",
          "Access-Control-Request-Method": "POST",
        },
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
