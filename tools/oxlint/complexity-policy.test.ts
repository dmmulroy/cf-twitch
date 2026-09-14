import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, FileSystem, Fiber, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { join } from "node:path";

import { cfTwitchMaximumCyclomaticComplexity } from "../../vite.config.ts";
import { makeOxlintPolicyProbeDirectory, runOxlintPolicyCommand } from "./oxlint-policy-process.ts";

const complexityProbeSource = (complexity: number): string => {
  const branches = Array.from(
    { length: complexity - 1 },
    (_, index) => `  if (flags[${index}] === true) total += 1;`,
  ).join("\n\n");

  return `export const measureComplexityProbe = (flags: ReadonlyArray<boolean>): number => {\n  let total = 0;\n\n${branches}\n\n  return total;\n};\n`;
};

const runRootLint = (file: string) =>
  runOxlintPolicyCommand(
    ChildProcess.make("pnpm", ["exec", "vp", "lint", file], {
      cwd: process.cwd(),
      extendEnv: true,
    }),
  );

const withNodeServices = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

describe("root cyclomatic complexity policy", () => {
  it.effect("accepts the configured maximum and rejects maximum plus one", () =>
    withNodeServices(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const probeRoot = yield* makeOxlintPolicyProbeDirectory(".generated-complexity-probe-");
          const allowedProbe = join(probeRoot, "allowed.ts");
          const rejectedProbe = join(probeRoot, "rejected.ts");
          yield* fileSystem.writeFileString(
            allowedProbe,
            complexityProbeSource(cfTwitchMaximumCyclomaticComplexity),
          );
          yield* fileSystem.writeFileString(
            rejectedProbe,
            complexityProbeSource(cfTwitchMaximumCyclomaticComplexity + 1),
          );

          const allowed = yield* runRootLint(allowedProbe);
          const rejected = yield* runRootLint(rejectedProbe);

          expect(allowed.status, allowed.output).toBe(ChildProcessSpawner.ExitCode(0));
          expect(rejected.status).not.toBe(ChildProcessSpawner.ExitCode(0));
          expect(rejected.output).toContain(
            `Maximum allowed is ${cfTwitchMaximumCyclomaticComplexity}`,
          );
        }),
      ),
    ),
  );

  it.effect("applies the root-derived ceiling to both maintained anti-slop copies", () =>
    withNodeServices(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const probeRoot = yield* makeOxlintPolicyProbeDirectory(".generated-complexity-audit-");
          const auditConfig = join(probeRoot, "anti-slop-complexity.json");
          yield* fileSystem.writeFileString(
            auditConfig,
            JSON.stringify({
              rules: {
                "eslint/complexity": ["error", cfTwitchMaximumCyclomaticComplexity],
              },
            }),
          );

          const result = yield* runOxlintPolicyCommand(
            ChildProcess.make(
              "pnpm",
              [
                "exec",
                "oxlint",
                "tools/oxlint/anti-slop",
                ".agents/skills/install-anti-slop/assets/anti-slop",
                "--config",
                auditConfig,
              ],
              { cwd: process.cwd(), extendEnv: true },
            ),
          );

          expect(result.status, result.output).toBe(ChildProcessSpawner.ExitCode(0));
        }),
      ),
    ),
  );

  it.effect("terminates an interrupted policy subprocess and removes its scoped probe", () =>
    withNodeServices(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        const started = yield* Deferred.make<{
          readonly handle: ChildProcessSpawner.ChildProcessHandle;
          readonly probeRoot: string;
        }>();

        const running = yield* Effect.scoped(
          Effect.gen(function* () {
            const probeRoot = yield* makeOxlintPolicyProbeDirectory(
              ".generated-process-lifetime-probe-",
            );

            const handle = yield* childProcessSpawner.spawn(
              ChildProcess.make(
                process.execPath,
                ["-e", "console.log('ready'); setInterval(() => {}, 1000)"],
                {
                  cwd: process.cwd(),
                  forceKillAfter: "1 second",
                },
              ),
            );

            const ready = yield* Stream.runHead(
              Stream.splitLines(Stream.decodeText(handle.stdout)),
            );

            expect(ready).toEqual(Option.some("ready"));
            yield* Deferred.succeed(started, { handle, probeRoot });

            return yield* Effect.never;
          }),
        ).pipe(Effect.forkChild);

        const probe = yield* Deferred.await(started);

        yield* Fiber.interrupt(running);

        expect(yield* probe.handle.isRunning).toBe(false);
        expect(yield* fileSystem.exists(probe.probeRoot)).toBe(false);
      }),
    ),
  );
});
