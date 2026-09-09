import { describe, expect, it } from "@effect/vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RuleTester } from "oxlint/plugins-dev";

import { requireReadableSpacingRule } from "./anti-slop/rules/require-readable-spacing.ts";

RuleTester.describe = describe;

RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } });

tester.run("anti-slop/require-readable-spacing", requireReadableSpacingRule, {
  valid: [
    "export type A = string;\n\n/** B docs. */\nexport type B = number;",
    "function f() {\nconst a = 1;\nconst b = 2;\n\nreturn a + b;\n}",
    "export function f(a: string): string;\nexport function f(a: number): number;\nexport function f(a: string | number) { return a; }",
  ],
  invalid: [
    {
      code: "export const a = 1;\n/** B docs. */\nexport type B = number;",
      output: "export const a = 1;\n\n/** B docs. */\nexport type B = number;",
      errors: [{ messageId: "expectedBlankLine" }],
    },
    {
      code: "const a = 1; // trailing\n// leading\nconst b = 2;",
      output: "const a = 1; // trailing\n\n// leading\nconst b = 2;",
      errors: [{ messageId: "expectedBlankLine" }],
    },
    {
      code: "const f = Effect.gen(function* () {\nconst a = yield* A;\nconst b = yield* B;\nreturn a + b;\n});",
      output:
        "const f = Effect.gen(function* () {\nconst a = yield* A;\nconst b = yield* B;\n\nreturn a + b;\n});",
      errors: [{ messageId: "expectedBlankLine" }],
    },
  ],
});

const probeRoot = join("tools", "oxlint", `.generated-spacing-probe-${process.pid}`);

const runSpacingProbeCommand = (...args: ReadonlyArray<string>) => {
  const result = spawnSync("pnpm", ["exec", "vp", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
};

describe("root readable spacing policy", () => {
  it("rejects condensed code, fixes it through the root plugin, and converges with Oxfmt", () => {
    mkdirSync(probeRoot, { recursive: true });

    const file = join(probeRoot, "spacing.ts");

    writeFileSync(
      file,
      "export const firstSpacingProbe = 1;\n/** Keep this attached. */\nexport const secondSpacingProbe = 2;\n",
    );

    try {
      const rejected = runSpacingProbeCommand("lint", file);

      expect(rejected.status, rejected.output).not.toBe(0);
      expect(rejected.output).toContain("require-readable-spacing");

      const fixed = runSpacingProbeCommand("lint", "--fix", file);

      expect(fixed.status, fixed.output).toBe(0);
      expect(readFileSync(file, "utf8")).toContain("1;\n\n/** Keep this attached. */");

      const formatted = runSpacingProbeCommand("fmt", file);

      expect(formatted.status, formatted.output).toBe(0);

      const stable = readFileSync(file, "utf8");
      const clean = runSpacingProbeCommand("lint", file);

      expect(clean.status, clean.output).toBe(0);

      const fixedAgain = runSpacingProbeCommand("lint", "--fix", file);
      const formattedAgain = runSpacingProbeCommand("fmt", file);

      expect(fixedAgain.status, fixedAgain.output).toBe(0);
      expect(formattedAgain.status, formattedAgain.output).toBe(0);
      expect(readFileSync(file, "utf8")).toBe(stable);
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("ships identical spacing code, license, and provenance in both maintained copies", () => {
    for (const file of [
      "rules/require-readable-spacing.ts",
      "vendor/eslint-stylistic/padding-line-between-statements.ts",
      "vendor/eslint-stylistic/padding-line-ast.ts",
      "vendor/eslint-stylistic/padding-line-options.d.ts",
      "vendor/eslint-stylistic/LICENSE",
      "vendor/eslint-stylistic/UPSTREAM.md",
    ]) {
      expect(readFileSync(join("tools/oxlint/anti-slop", file), "utf8")).toBe(
        readFileSync(join(".agents/skills/install-anti-slop/assets/anti-slop", file), "utf8"),
      );
    }
  });
});
