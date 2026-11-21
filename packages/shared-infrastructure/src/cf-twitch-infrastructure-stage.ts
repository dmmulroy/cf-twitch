import { Config, Effect, Schema } from "effect";
import { SecureRandom } from "effect/crypto";

/**
 * Schema for the exact production stage or an isolated local, development, or test stage.
 *
 * **Details**
 *
 * Accepts `production`, `local`, `dev_<name>`, and `test-<id>`; aliases such as `prod` are
 * rejected so a typo cannot select an unrecognized infrastructure environment.
 */
export const CfTwitchInfrastructureStage = Schema.String.check(
  Schema.isPattern(
    /^(?:production|local|dev_[a-z0-9](?:[a-z0-9_-]{0,42}[a-z0-9])?|test-[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?)$/,
  ),
).pipe(Schema.brand("CfTwitchInfrastructureStage"));

/** Parsed Alchemy stage that cannot select an unrecognized infrastructure environment. */
export type CfTwitchInfrastructureStage = typeof CfTwitchInfrastructureStage.Type;

const decodeCfTwitchInfrastructureStage = Schema.decodeEffect(CfTwitchInfrastructureStage);

/**
 * Parses a string stage at a CLI, test-runner, or infrastructure boundary.
 *
 * @param input - Stage name received from Alchemy, a CLI argument, or configuration.
 * @returns The permitted stage, or fails with `SchemaError` when the name is not a permitted stage.
 */
export const parseCfTwitchInfrastructureStage = (
  input: string,
): Effect.Effect<CfTwitchInfrastructureStage, Schema.SchemaError> =>
  decodeCfTwitchInfrastructureStage(input);

/**
 * Config for the Alchemy-injected `ALCHEMY_STAGE` available during hosted runtime initialization.
 *
 * **Details**
 *
 * Reading it fails with `ConfigError` when the setting is missing or not a permitted stage.
 */
export const alchemyRuntimeInfrastructureStageConfig: Config.Config<CfTwitchInfrastructureStage> =
  Config.schema(CfTwitchInfrastructureStage, "ALCHEMY_STAGE");

/**
 * Config for the required isolated `CF_TWITCH_TEST_STAGE` set by the local E2E runner.
 *
 * **Details**
 *
 * Reading it fails with `ConfigError` when the setting is missing or not a permitted stage.
 */
export const cfTwitchInfrastructureStageConfig: Config.Config<CfTwitchInfrastructureStage> =
  Config.schema(CfTwitchInfrastructureStage, "CF_TWITCH_TEST_STAGE");

/**
 * Generates and parses a cryptographically isolated Alchemy stage for one test run.
 *
 * @returns A `test-<32 hex characters>` stage, or fails with `SchemaError` only if the generator
 *   and `CfTwitchInfrastructureStage` disagree about the test-stage format.
 * @throws A defect when `SecureRandom` cannot produce a UUID.
 */
export const generateIsolatedCfTwitchTestStage: () => Effect.Effect<
  CfTwitchInfrastructureStage,
  Schema.SchemaError,
  SecureRandom.SecureRandom
> = Effect.fn("CfTwitchInfrastructure.generateIsolatedCfTwitchTestStage")(function* () {
  const secureRandom = yield* SecureRandom.SecureRandom;
  const entropy = (yield* secureRandom.uuidV4()).replaceAll("-", "").slice(0, 32);

  return yield* parseCfTwitchInfrastructureStage(`test-${entropy}`);
});
