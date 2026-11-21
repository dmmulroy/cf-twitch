import { BroadcasterId, RewardId } from "@cf-twitch/contracts/identity";
import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Option,
  Schema,
  SchemaIssue,
} from "effect";

const providerClientId = Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed());

const configurationSecret = Schema.Redacted(Schema.NonEmptyString);

/** Schema for runtime settings shared by Twitch integration capabilities, excluding deployment credentials. */
const TwitchConfigurationSettings = Schema.Struct({
  /** Twitch application credentials and the broadcaster channel the integration serves. */
  twitch: Schema.Struct({
    clientId: providerClientId,
    clientSecret: configurationSecret,
    broadcaster: Schema.Struct({ id: BroadcasterId, displayName: Schema.NonEmptyString }),
  }),
  /** Spotify application credentials used for OAuth and token refresh. */
  spotify: Schema.Struct({ clientId: providerClientId, clientSecret: configurationSecret }),
  /** Shared secret that authenticates Twitch EventSub webhook signatures. */
  eventSubSecret: configurationSecret,
  /** Secret required in `x-setup-secret` to start provider OAuth authorization. */
  oauthSetupSecret: configurationSecret,
  /** Bearer secret required by administrator routes. */
  administratorSecret: configurationSecret,
  /** Channel point rewards that start a Song Request or a Keyboard Raffle. */
  rewardRouting: Schema.Struct({ songRequestRewardId: RewardId, keyboardRaffleRewardId: RewardId }),
});

/** Parsed runtime configuration whose secrets stay redacted until their final I/O boundary. */
export interface ITwitchConfiguration extends Schema.Schema.Type<
  typeof TwitchConfigurationSettings
> {}

/** Runtime configuration service captured during Alchemy init so Alchemy can bind secrets automatically. */
export class TwitchConfiguration extends Context.Service<
  TwitchConfiguration,
  ITwitchConfiguration
>()("@cf-twitch/TwitchConfiguration") {}

/** Operations that can fail while reading Twitch runtime configuration. */
export const TwitchConfigurationOperation = Schema.Literals(["readTwitchConfiguration"]);

/** Operation that failed while reading Twitch runtime configuration. */
export type TwitchConfigurationOperation = typeof TwitchConfigurationOperation.Type;

/**
 * Classified reasons Twitch runtime configuration cannot be read.
 *
 * **Details**
 *
 * `SettingInvalid` covers a missing or malformed setting; `SettingsUnreadable` means the
 * configuration provider itself could not supply values.
 */
export const TwitchConfigurationFailureReason = Schema.Literals([
  "SettingInvalid",
  "SettingsUnreadable",
]);

/** Classified reason Twitch runtime configuration cannot be read. */
export type TwitchConfigurationFailureReason = typeof TwitchConfigurationFailureReason.Type;

/**
 * Error that stops startup because Twitch runtime configuration cannot be read.
 *
 * **Details**
 *
 * Carries the setting name when the provider identifies one. It never carries the setting's
 * value or the parser cause, because either can contain a credential.
 */
export class TwitchConfigurationError extends Schema.TaggedError<TwitchConfigurationError>()(
  "TwitchConfigurationError",
  {
    operation: TwitchConfigurationOperation,
    reason: TwitchConfigurationFailureReason,
    /** Environment setting name that failed, such as `TWITCH_CLIENT_SECRET`, when known. */
    setting: Schema.Option(Schema.String),
  },
) {
  /** Startup guidance naming the failed setting without its value. */
  override get message(): string {
    if (this.reason === "SettingsUnreadable") {
      return "Twitch configuration settings could not be read from the Worker environment. Check the Worker's environment bindings and restart the Worker.";
    }

    return Option.match(this.setting, {
      onNone: () =>
        "Twitch configuration has a missing or invalid setting. Set every value listed in apps/api/.env.example and restart the Worker.",
      onSome: (setting) =>
        `Twitch configuration setting ${setting} is missing or invalid. Set it as described in apps/api/.env.example and restart the Worker.`,
    });
  }
}

/** Returns the environment setting name addressed by a configuration schema failure. */
const configurationSettingName = (issue: SchemaIssue.Issue): Option.Option<string> =>
  issue instanceof SchemaIssue.Pointer && issue.path.length > 0
    ? Option.some(issue.path.map(String).join("."))
    : Option.none();

/** Classifies a configuration failure while discarding the raw value and parser cause. */
const toTwitchConfigurationError = (error: Config.ConfigError): TwitchConfigurationError =>
  error.cause instanceof Schema.SchemaError
    ? new TwitchConfigurationError({
        operation: "readTwitchConfiguration",
        reason: "SettingInvalid",
        setting: configurationSettingName(error.cause.issue),
      })
    : new TwitchConfigurationError({
        operation: "readTwitchConfiguration",
        reason: "SettingsUnreadable",
        setting: Option.none(),
      });

/**
 * Creates the runtime configuration by reading Alchemy's intercepted Effect Config provider once.
 *
 * @returns The parsed configuration, or fails with `TwitchConfigurationError` when a setting is
 *   missing or invalid (`SettingInvalid`) or the provider cannot be read (`SettingsUnreadable`).
 */
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
}).pipe(Effect.catchTag("ConfigError", (error) => Effect.fail(toTwitchConfigurationError(error))));

/** Layer that builds runtime configuration from whichever Config provider the caller installs. */
export const twitchConfigurationLayerWithoutDependencies = Layer.effect(
  TwitchConfiguration,
  makeTwitchConfiguration,
);

/** Layer that reads the environment provider Alchemy installs at init and runtime cold start. */
export const twitchConfigurationLayer = twitchConfigurationLayerWithoutDependencies;

/**
 * Synthetic environment settings parsed by `twitchConfigurationTestLayer`.
 *
 * **Details**
 *
 * Contains no real credentials or production resource identities.
 */
export const twitchConfigurationTestSettings = {
  TWITCH_CLIENT_ID: "twitch-client",
  TWITCH_CLIENT_SECRET: "twitch-secret",
  TWITCH_BROADCASTER_ID: "12345",
  TWITCH_BROADCASTER_NAME: "Dillon",
  TWITCH_EVENTSUB_SECRET: "webhook-secret",
  SPOTIFY_CLIENT_ID: "spotify-client",
  SPOTIFY_CLIENT_SECRET: "spotify-secret",
  OAUTH_SETUP_SECRET: "setup-secret",
  ADMIN_SECRET: "admin-secret",
  SONG_REQUEST_REWARD_ID: "song-reward",
  KEYBOARD_RAFFLE_REWARD_ID: "raffle-reward",
};

/**
 * Layer that parses `twitchConfigurationTestSettings` through the production configuration reader.
 *
 * **When to use**
 *
 * Use in tests that need a complete, valid configuration without an Alchemy environment.
 */
export const twitchConfigurationTestLayer = twitchConfigurationLayerWithoutDependencies.pipe(
  Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(twitchConfigurationTestSettings))),
);
