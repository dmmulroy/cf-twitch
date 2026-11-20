import { Config, Effect, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

/** Identifies the exact production stage or an isolated local, development, or test stage. */
export const CfTwitchInfrastructureStage = Schema.String.check(
  Schema.isPattern(
    /^(?:production|local|dev_[a-z0-9](?:[a-z0-9_-]{0,42}[a-z0-9])?|test-[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?)$/,
  ),
).pipe(Schema.brand("CfTwitchInfrastructureStage"));

/** Parsed Alchemy stage that cannot select an unrecognized infrastructure environment. */
export type CfTwitchInfrastructureStage = typeof CfTwitchInfrastructureStage.Type;

const decodeCfTwitchInfrastructureStage = Schema.decodeEffect(CfTwitchInfrastructureStage);

/** Parses a string stage at a CLI, test-runner, or infrastructure boundary. */
export const parseCfTwitchInfrastructureStage = (
  input: string,
): Effect.Effect<CfTwitchInfrastructureStage, Schema.SchemaError> =>
  decodeCfTwitchInfrastructureStage(input);

/** Reads the Alchemy-injected stage available during hosted runtime initialization. */
export const alchemyRuntimeInfrastructureStageConfig: Config.Config<CfTwitchInfrastructureStage> =
  Config.schema(CfTwitchInfrastructureStage, "ALCHEMY_STAGE");

/** Reads the required isolated test stage from the active Effect Config provider. */
export const cfTwitchInfrastructureStageConfig: Config.Config<CfTwitchInfrastructureStage> =
  Config.schema(CfTwitchInfrastructureStage, "CF_TWITCH_TEST_STAGE");

/** Generates and parses a cryptographically isolated Alchemy stage for one test run. */
export const generateIsolatedCfTwitchTestStage: () => Effect.Effect<
  CfTwitchInfrastructureStage,
  Schema.SchemaError,
  SecureRandom.SecureRandom
> = Effect.fn("CfTwitchInfrastructure.generateIsolatedCfTwitchTestStage")(function* () {
  const secureRandom = yield* SecureRandom.SecureRandom;
  const entropy = (yield* secureRandom.uuidV4()).replaceAll("-", "").slice(0, 32);

  return yield* parseCfTwitchInfrastructureStage(`test-${entropy}`);
});
