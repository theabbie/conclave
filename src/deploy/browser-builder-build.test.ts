import { describe, expect, it, vi } from "vitest";

const esbuild = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  initialize: vi.fn(async () => undefined),
  build: vi.fn(async (options: Record<string, unknown>) => {
    esbuild.options = options;
    return {
      outputFiles: [
        {
          path: "/worker.js",
          text: 'import sourceSnapshot from "./generated/source.snapshot.txt";\nexport default sourceSnapshot;',
        },
      ],
    };
  }),
}));

vi.mock("esbuild-wasm", () => ({
  initialize: esbuild.initialize,
  build: esbuild.build,
}));

import { buildRelease } from "./browser-builder";

describe("browser Worker build", () => {
  it("requests a deterministic JavaScript output file", async () => {
    const release = await buildRelease("base", {
      schema: 1,
      revision: "revision",
      files: [
        {
          path: "server/worker.ts",
          content: "export default {};",
          sha256: "source",
        },
      ],
    });
    expect(esbuild.options).toMatchObject({
      outfile: "worker.js",
      write: false,
      format: "esm",
    });
    expect(release.artifact.content).toContain(
      "./generated/source.snapshot.txt",
    );
    expect(release.checks.passed).toContain("bundle");
  });
});
