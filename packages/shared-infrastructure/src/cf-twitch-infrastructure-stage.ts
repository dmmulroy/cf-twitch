import { Config, Crypto, Effect, PlatformError, Schema } from "effect";

/** Identifies a non-production Alchemy stage owned by local development or one isolated test run. */
export const CfTwitchInfrastructureStage = Schema.String.check(
  Schema.isPattern(
    /^(?:local|dev_[a-z0-9](?:[a-z0-9_-]{0,42}[a-z0-9])?|test-[a-z0-9](?:[a-z0-9-]{0,43}[a-z0-9])?)$/,
  ),
).pipe(Schema.brand("CfTwitchInfrastructureStage"));

/** Parsed non-production Alchemy stage that cannot select production infrastructure. */
export type CfTwitchInfrastructureStage = typeof CfTwitchInfrastructureStage.Type;

const decodeCfTwitchInfrastructureStage = Schema.decodeEffect(CfTwitchInfrastructureStage);

/** Parses a string stage at a CLI, test-runner, or infrastructure boundary. */
export const parseCfTwitchInfrastructureStage = (
  input: string,
): Effect.Effect<CfTwitchInfrastructureStage, Schema.SchemaError> =>
  decodeCfTwitchInfrastructureStage(input);

/** Reads the required non-production Alchemy stage from the active Effect Config provider. */
export const cfTwitchInfrastructureStageConfig: Config.Config<CfTwitchInfrastructureStage> =
  Config.schema(CfTwitchInfrastructureStage, "CF_TWITCH_TEST_STAGE");

/** Generates and parses a cryptographically isolated Alchemy stage for one test run. */
export const generateIsolatedCfTwitchTestStage: () => Effect.Effect<
  CfTwitchInfrastructureStage,
  PlatformError.PlatformError | Schema.SchemaError,
  Crypto.Crypto
> = Effect.fn("CfTwitchInfrastructure.generateIsolatedCfTwitchTestStage")(function* () {
  const crypto = yield* Crypto.Crypto;
  const entropy = (yield* crypto.randomUUIDv4).replaceAll("-", "").slice(0, 32);
  return yield* parseCfTwitchInfrastructureStage(`test-${entropy}`);
});
