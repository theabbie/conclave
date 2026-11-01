import { describe, expect, it } from "vitest";
import type { ApiUnitSpec } from "../domain/api-units";
import { apiUnitsFromSource, upsertApiUnitSource } from "./browser-builder";

const unit: ApiUnitSpec = {
  id: "hello",
  name: "Hello",
  method: "GET",
  path: "/api/hello/:name",
  requestSchema: { type: "object" },
  responseSchema: { type: "object" },
  handlerSource: "return Response.json({ message: `Hello ${params.name}` });",
};

describe("browser release source", () => {
  it("adds and updates an atomic API unit with a content-addressed revision", async () => {
    const empty = { schema: 1 as const, revision: "old", files: [] };
    const added = await upsertApiUnitSource(empty, unit, "add");
    expect(added.revision).not.toBe("old");
    expect(apiUnitsFromSource(added)).toEqual([unit]);
    await expect(upsertApiUnitSource(added, unit, "add")).rejects.toThrow(
      "already exists",
    );
    const updated = await upsertApiUnitSource(
      added,
      { ...unit, name: "Hello v2" },
      "update",
    );
    expect(apiUnitsFromSource(updated)[0].name).toBe("Hello v2");
    expect(updated.revision).not.toBe(added.revision);
  });
});
