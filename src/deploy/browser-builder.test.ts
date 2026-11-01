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

  it("keeps source paths in the server's deterministic code-point order", async () => {
    const paths = [
      "README.md",
      "public/favicon.svg",
      "src/App.tsx",
      "src/agent/transport.ts",
    ];
    const source = {
      schema: 1 as const,
      revision: "old",
      files: paths.map((path) => ({ path, content: "", sha256: "hash" })),
    };
    const added = await upsertApiUnitSource(source, unit, "add");
    expect(added.files.map((file) => file.path)).toEqual(
      [...paths, "server/api-units/hello.json"].sort(),
    );
  });
});
