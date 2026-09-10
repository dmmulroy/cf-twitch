import { Effect, FileSystem, PlatformError, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { join } from "node:path";

/** Exit status and interleaved stdout/stderr captured from one policy command invocation. */
export type OxlintPolicyCommandResult = {
  readonly status: ChildProcessSpawner.ExitCode;
  readonly output: string;
};

/** Allocate an automatically removed policy probe directory inside the repository. */
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

/** Run a policy command once while collecting its exit status and combined output. */
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
