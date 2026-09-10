import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { generateIsolatedCfTwitchTestStage } from "@cf-twitch/shared-infrastructure";
import { Effect, Runtime, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const CfTwitchLocalTestTarget = Schema.Literal("local");

class CfTwitchLocalEndToEndCommandFailed extends Schema.TaggedError<CfTwitchLocalEndToEndCommandFailed>()(
  "CfTwitchLocalEndToEndCommandFailed",
  { exitCode: Schema.Number },
) {
  override readonly [Runtime.errorReported] = false;

  override get [Runtime.errorExitCode](): number {
    return this.exitCode;
  }

  override get message(): string {
    return `cf-twitch local E2E tests failed with exit code ${this.exitCode}.`;
  }
}

/** Runs the isolated local-workerd suite without invoking an Alchemy deploy command. */
export const runCfTwitchLocalEndToEndTests = Effect.fn(
  "CfTwitchLocalEndToEnd.runCfTwitchLocalEndToEndTests",
)(function* () {
  const stage = yield* generateIsolatedCfTwitchTestStage();
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const command = ChildProcess.make(
    "vp",
    [
      "test",
      "run",
      "--config",
      "vite.config.ts",
      "--mode",
      "e2e",
      "src/features",
      "test/e2e.test.ts",
    ],
    {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      extendEnv: true,
      env: {
        ALCHEMY_DEV: "true",
        CF_TWITCH_TEST_STAGE: stage,
        CF_TWITCH_TEST_TARGET: "local",
      },
    },
  );

  const exitCode = yield* childProcessSpawner.exitCode(command);

  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* Effect.fail(new CfTwitchLocalEndToEndCommandFailed({ exitCode }));
  }
});

if (import.meta.main) {
  const main = Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(CfTwitchLocalTestTarget)(process.argv[2]);
    yield* runCfTwitchLocalEndToEndTests();
  });

  NodeRuntime.runMain(main.pipe(Effect.provide(NodeServices.layer)));
}
