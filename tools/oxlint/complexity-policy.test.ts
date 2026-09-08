import { describe, expect, it } from "@effect/vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { cfTwitchMaximumCyclomaticComplexity } from "../../vite.config.ts";

const probeRoot = join("tools", "oxlint", `.generated-complexity-probe-${process.pid}`);

const complexityProbeSource = (complexity: number): string => {
  const branches = Array.from(
    { length: complexity - 1 },
    (_, index) => `  if (flags[${index}] === true) total += 1;`,
  ).join("\n");
  return `export const measureComplexityProbe = (flags: ReadonlyArray<boolean>): number => {\n  let total = 0;\n${branches}\n  return total;\n};\n`;
};

const runRootLint = (file: string) =>
  spawnSync("pnpm", ["exec", "vp", "lint", file], {
    cwd: process.cwd(),
    encoding: "utf8",
  });

const lintOutput = (result: ReturnType<typeof runRootLint>): string =>
  `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

describe("root cyclomatic complexity policy", () => {
  it("accepts the configured maximum and rejects maximum plus one", () => {
    mkdirSync(probeRoot, { recursive: true });
    const allowedProbe = join(probeRoot, "allowed.ts");
    const rejectedProbe = join(probeRoot, "rejected.ts");
    writeFileSync(allowedProbe, complexityProbeSource(cfTwitchMaximumCyclomaticComplexity));
    writeFileSync(rejectedProbe, complexityProbeSource(cfTwitchMaximumCyclomaticComplexity + 1));

    try {
      const allowed = runRootLint(allowedProbe);
      const rejected = runRootLint(rejectedProbe);

      expect(allowed.status, lintOutput(allowed)).toBe(0);
      expect(rejected.status).not.toBe(0);
      expect(lintOutput(rejected)).toContain(
        `Maximum allowed is ${cfTwitchMaximumCyclomaticComplexity}`,
      );
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
  });

  it("applies the root-derived ceiling to both maintained anti-slop copies", () => {
    mkdirSync(probeRoot, { recursive: true });
    const auditConfig = join(probeRoot, "anti-slop-complexity.json");
    writeFileSync(
      auditConfig,
      JSON.stringify({
        rules: {
          "eslint/complexity": ["error", cfTwitchMaximumCyclomaticComplexity],
        },
      }),
    );

    try {
      const result = spawnSync(
        "pnpm",
        [
          "exec",
          "oxlint",
          "tools/oxlint/anti-slop",
          ".agents/skills/install-anti-slop/assets/anti-slop",
          "--config",
          auditConfig,
        ],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect(result.status, `${result.stdout ?? ""}\n${result.stderr ?? ""}`).toBe(0);
    } finally {
      rmSync(probeRoot, { recursive: true, force: true });
    }
  });
});
