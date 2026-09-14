import { describe, expect, it } from "@effect/vitest";

import { parseCfTwitchSourceImports } from "./check-cf-twitch-architecture.ts";

describe("parseCfTwitchSourceImports", () => {
  it("returns only parser-owned module specifiers", () => {
    const source = `
      // import "comment-only-package";
      import {
        Effect,
      } from "effect";
      export { Schema } from "effect";
      const client = import("./client.ts");
      const computedClient = import(runtimeModule);
      type Client = import("./client-types.ts").Client;
    `;

    const parsed = parseCfTwitchSourceImports("fixture.ts", source);

    expect(parsed.errors).toEqual([]);
    expect(parsed.specifiers).toEqual(["effect", "effect", "./client.ts", "./client-types.ts"]);
  });

  it("reports malformed TypeScript instead of extracting textual matches", () => {
    const parsed = parseCfTwitchSourceImports(
      "malformed.ts",
      'import "false-confidence"; const broken = ;',
    );

    expect(parsed.errors.length).toBeGreaterThan(0);
  });
});
