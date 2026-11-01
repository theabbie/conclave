import { describe, expect, it, vi } from "vitest";

vi.mock("./generated/api-units", () => ({
  apiUnits: [
    {
      id: "json-value",
      method: "GET",
      path: "/api/value",
      handler: () => ({ message: "Hello, world!" }),
    },
    {
      id: "invalid",
      method: "GET",
      path: "/api/invalid",
      handler: () => undefined,
    },
  ],
}));

import { routeApiUnit } from "./api-router";

describe("API unit router", () => {
  it("encodes plain handler values as JSON responses", async () => {
    const response = await routeApiUnit(
      new Request("https://conclave.test/api/value"),
      {},
    );
    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({
      message: "Hello, world!",
    });
  });

  it("rejects missing handler results", async () => {
    const response = await routeApiUnit(
      new Request("https://conclave.test/api/invalid"),
      {},
    );
    expect(response?.status).toBe(500);
    await expect(response?.json()).resolves.toEqual({
      error: "API unit invalid returned an invalid response",
    });
  });
});
