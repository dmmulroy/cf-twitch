import { BroadcasterId, RewardId } from "@cf-twitch/contracts/identity";
import { Config, Context, Effect, Layer, Schema } from "effect";

const providerClientId = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed());

const configurationSecret = Schema.Redacted(Schema.NonEmptyString);

/** Runtime settings shared by Twitch integration capabilities, excluding deployment credentials. */
export const TwitchRuntimeSettings = Schema.Struct({
  twitch: Schema.Struct({
    clientId: providerClientId,
    clientSecret: configurationSecret,
    broadcaster: Schema.Struct({ id: BroadcasterId, displayName: Schema.NonEmptyString }),
  }),
  spotify: Schema.Struct({ clientId: providerClientId, clientSecret: configurationSecret }),
  eventSubSecret: configurationSecret,
  oauthSetupSecret: configurationSecret,
  administratorSecret: configurationSecret,
  rewardRouting: Schema.Struct({ songRequestRewardId: RewardId, keyboardRaffleRewardId: RewardId }),
});

/** Parsed runtime configuration; secrets stay redacted until their final I/O boundary. */
export interface ITwitchConfiguration extends Schema.Schema.Type<typeof TwitchRuntimeSettings> {}

/** Runtime configuration authority captured during Alchemy init for automatic secret bindings. */
export class TwitchConfiguration extends Context.Service<
  TwitchConfiguration,
  ITwitchConfiguration
>()("@cf-twitch/TwitchConfiguration") {}

/** Configuration cannot start; diagnostics intentionally exclude source values and parser causes. */
export class TwitchConfigurationError extends Schema.TaggedError<TwitchConfigurationError>()(
  "TwitchConfigurationError",
  {},
) {
  /** Safe startup guidance without including credentials or raw environment values. */
  override get message(): string {
    return "Twitch configuration is invalid. Check the required settings in .env.example before starting the Worker.";
  }
}

/** Read runtime configuration once through Alchemy's intercepted Effect Config provider. */
export const makeTwitchConfiguration = Effect.gen(function* () {
  const settings = yield* Config.all({
    twitch: Config.all({
      clientId: Config.schema(providerClientId, "TWITCH_CLIENT_ID"),
      clientSecret: Config.schema(configurationSecret, "TWITCH_CLIENT_SECRET"),
      broadcaster: Config.all({
        id: Config.schema(BroadcasterId, "TWITCH_BROADCASTER_ID"),
        displayName: Config.schema(Schema.NonEmptyString, "TWITCH_BROADCASTER_NAME"),
      }),
    }),
    spotify: Config.all({
      clientId: Config.schema(providerClientId, "SPOTIFY_CLIENT_ID"),
      clientSecret: Config.schema(configurationSecret, "SPOTIFY_CLIENT_SECRET"),
    }),
    eventSubSecret: Config.schema(configurationSecret, "TWITCH_EVENTSUB_SECRET"),
    oauthSetupSecret: Config.schema(configurationSecret, "OAUTH_SETUP_SECRET"),
    administratorSecret: Config.schema(configurationSecret, "ADMIN_SECRET"),
    rewardRouting: Config.all({
      songRequestRewardId: Config.schema(RewardId, "SONG_REQUEST_REWARD_ID"),
      keyboardRaffleRewardId: Config.schema(RewardId, "KEYBOARD_RAFFLE_REWARD_ID"),
    }),
  });

  return TwitchConfiguration.of(settings);
}).pipe(Effect.catchTag("ConfigError", () => Effect.fail(new TwitchConfigurationError())));

/** Construct runtime configuration without selecting an environment provider. */
export const twitchConfigurationLayerWithoutDependencies = Layer.effect(
  TwitchConfiguration,
  makeTwitchConfiguration,
);

/** Use the current environment provider installed by Alchemy at init and runtime cold start. */
export const twitchConfigurationLayer = twitchConfigurationLayerWithoutDependencies;
