import { NodeCrypto, NodeRuntime, NodeServices } from "@effect/platform-node";
import { generateIsolatedCfTwitchTestStage } from "@cf-twitch/shared-infrastructure";
import { Effect, Layer, Option, Runtime, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

const CfTwitchLocalEndToEndTarget = Schema.Literal("local");

const decodeCfTwitchLocalEndToEndTarget = Schema.decodeUnknownEffect(CfTwitchLocalEndToEndTarget);

/** Error returned when the local end-to-end run cannot start or its test command fails. */
class CfTwitchLocalEndToEndError extends Schema.TaggedError<CfTwitchLocalEndToEndError>()(
  "CfTwitchLocalEndToEndError",
  {
    operation: Schema.Literals([
      "parseCfTwitchLocalEndToEndTarget",
      "runCfTwitchLocalEndToEndTests",
    ]),
    reason: Schema.Literals(["TargetNotLocal", "TestCommandFailed"]),
    /** Exit code of the test command, present only for `TestCommandFailed`. */
    exitCode: Schema.Option(Schema.Number),
  },
) {
  /** Marks the failure as not yet reported so `NodeRuntime.runMain` logs its message. */
  override readonly [Runtime.errorReported] = false;

  /** Process exit code `NodeRuntime.runMain` uses, matching the failed child command. */
  override get [Runtime.errorExitCode](): number {
    return Option.getOrElse(this.exitCode, () => 1);
  }

  /** Operator guidance naming the failure and how to rerun the suite. */
  override get message(): string {
    return Option.match(this.exitCode, {
      onNone: () =>
        "cf-twitch local E2E target is not local. Run `pnpm test:e2e:local`, which passes the local target.",
      onSome: (exitCode) =>
        `cf-twitch local E2E tests failed with exit code ${exitCode}. Read the failing test output above, fix it, and rerun \`pnpm test:e2e:local\`.`,
    });
  }
}

/** Parses the command-line target, which must be `local` so the run cannot reach deployed resources. */
const parseCfTwitchLocalEndToEndTarget = (input: string | undefined) =>
  decodeCfTwitchLocalEndToEndTarget(input).pipe(
    Effect.catchTag("SchemaError", () =>
      Effect.fail(
        new CfTwitchLocalEndToEndError({
          operation: "parseCfTwitchLocalEndToEndTarget",
          reason: "TargetNotLocal",
          exitCode: Option.none(),
        }),
      ),
    ),
  );

/**
 * Runs the isolated local-workerd suite without invoking an Alchemy deploy command.
 *
 * @returns Nothing on success; fails with `CfTwitchLocalEndToEndError` (`TestCommandFailed`) when
 *   the test command exits non-zero, with `PlatformError` when the command cannot be spawned, or
 *   with `SchemaError` only if the generated test stage violates the stage policy.
 * @throws A defect when `SecureRandom` cannot produce a UUID.
 */
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
    return yield* Effect.fail(
      new CfTwitchLocalEndToEndError({
        operation: "runCfTwitchLocalEndToEndTests",
        reason: "TestCommandFailed",
        exitCode: Option.some(exitCode),
      }),
    );
  }
});

if (import.meta.main) {
  const main = Effect.gen(function* () {
    yield* parseCfTwitchLocalEndToEndTarget(process.argv[2]);
    yield* runCfTwitchLocalEndToEndTests();
  });

  NodeRuntime.runMain(
    main.pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layerSecureRandom))),
  );
}
