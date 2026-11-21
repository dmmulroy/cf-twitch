import { Effect, FileSystem, PlatformError, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { join } from "node:path";

/** Exit status and interleaved stdout/stderr captured from one policy command invocation. */
export interface OxlintPolicyCommandResult {
  /** Exit code of the command; non-zero means the policy rejected the probe. */
  readonly status: ChildProcessSpawner.ExitCode;
  /** Combined stdout and stderr in arrival order. */
  readonly output: string;
}

/**
 * Creates a policy probe directory under `tools/oxlint` that is removed when the scope closes.
 *
 * **Details**
 *
 * The probe lives inside the repository so root lint and format configuration apply to it.
 *
 * @param prefix - Directory name prefix, such as `.generated-complexity-probe-`.
 * @returns The directory path, or fails with `PlatformError` when it cannot be created.
 */
export const makeOxlintPolicyProbeDirectory = (
  prefix: string,
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) =>
      fileSystem.makeTempDirectoryScoped({
        directory: join(process.cwd(), "tools", "oxlint"),
        prefix,
      }),
    ),
  );

/**
 * Runs a policy command once while collecting its exit status and combined output.
 *
 * @returns The exit status and output, or fails with `PlatformError` when the command cannot be
 *   spawned or its output cannot be read. A non-zero exit is a successful result, not a failure.
 */
export const runOxlintPolicyCommand = (
  command: ChildProcess.Command,
): Effect.Effect<
  OxlintPolicyCommandResult,
  PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* childProcessSpawner.spawn(command);

      const [output, status] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.all)), handle.exitCode],
        { concurrency: "unbounded" },
      );

      return { status, output };
    }),
  );
