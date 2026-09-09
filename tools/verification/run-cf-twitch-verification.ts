import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Runtime, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const CfTwitchVerificationCommand = Schema.Literals([
  "architecture",
  "e2e",
  "format",
  "inspect",
  "lint",
  "tests",
  "typecheck",
]);

type CfTwitchVerificationCommand = typeof CfTwitchVerificationCommand.Type;

class CfTwitchVerificationCommandFailed extends Schema.TaggedError<CfTwitchVerificationCommandFailed>()(
  "CfTwitchVerificationCommandFailed",
  {
    command: CfTwitchVerificationCommand,
    exitCode: Schema.Number,
  },
) {
  override readonly [Runtime.errorReported] = false;

  override get [Runtime.errorExitCode](): number {
    return this.exitCode;
  }

  override get message(): string {
    return `CF Twitch verification command ${this.command} failed with exit code ${this.exitCode}.`;
  }
}

const runCfTwitchVerificationCommand = Effect.fn(
  "CfTwitchVerification.runCfTwitchVerificationCommand",
)(function* (name: CfTwitchVerificationCommand, command: ChildProcess.Command) {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* childProcessSpawner.exitCode(command);

  if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
    return yield* Effect.fail(new CfTwitchVerificationCommandFailed({ command: name, exitCode }));
  }
});

const inheritedCommand = (executable: string, arguments_: ReadonlyArray<string>) =>
  ChildProcess.make(executable, arguments_, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    extendEnv: true,
  });

/** Runs every static check, unit suite, and isolated local-workerd acceptance suite in order. */
export const runCfTwitchVerification = Effect.fn("CfTwitchVerification.runCfTwitchVerification")(
  function* () {
    yield* runCfTwitchVerificationCommand(
      "format",
      inheritedCommand("vp", ["fmt", "--check", "."]),
    );
    yield* runCfTwitchVerificationCommand("lint", inheritedCommand("vp", ["lint", "."]));
    yield* runCfTwitchVerificationCommand(
      "architecture",
      inheritedCommand("node", ["tools/architecture/check-cf-twitch-architecture.ts"]),
    );
    yield* runCfTwitchVerificationCommand(
      "inspect",
      inheritedCommand("node", ["apps/api/scripts/inspect-api.ts", "--check"]),
    );
    yield* runCfTwitchVerificationCommand(
      "typecheck",
      inheritedCommand("pnpm", ["run", "typecheck"]),
    );
    yield* runCfTwitchVerificationCommand("tests", inheritedCommand("pnpm", ["run", "test:unit"]));
    yield* runCfTwitchVerificationCommand(
      "e2e",
      inheritedCommand("pnpm", ["run", "test:e2e:local"]),
    );
  },
);

if (import.meta.main) {
  NodeRuntime.runMain(runCfTwitchVerification().pipe(Effect.provide(NodeServices.layer)));
}
