import { expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Option, Redacted } from "effect";
import {
  TwitchConfiguration,
  twitchConfigurationLayer,
  twitchConfigurationTestLayer,
} from "./twitch-configuration.ts";

const configurationFixture = {
  TWITCH_CLIENT_ID: "twitch-client",
  TWITCH_CLIENT_SECRET: "fixture-twitch-secret",
  TWITCH_BROADCASTER_ID: "1234",
  TWITCH_BROADCASTER_NAME: "Fixture Broadcaster",
  TWITCH_EVENTSUB_SECRET: "fixture-eventsub-secret",
  SPOTIFY_CLIENT_ID: "spotify-client",
  SPOTIFY_CLIENT_SECRET: "fixture-spotify-secret",
  OAUTH_SETUP_SECRET: "fixture-oauth-secret",
  ADMIN_SECRET: "fixture-admin-secret",
  SONG_REQUEST_REWARD_ID: "song-reward",
  KEYBOARD_RAFFLE_REWARD_ID: "raffle-reward",
};

it.effect("captures parsed runtime identities and redacts every credential", () =>
  Effect.gen(function* () {
    const configuration = yield* TwitchConfiguration;
    expect(configuration.twitch.broadcaster.id).toBe("1234");
    expect(Redacted.value(configuration.spotify.clientSecret)).toBe("fixture-spotify-secret");
    expect(JSON.stringify(configuration)).not.toContain("fixture-spotify-secret");
    expect(JSON.stringify(configuration)).not.toContain("fixture-admin-secret");
  }).pipe(
    Effect.provide(twitchConfigurationLayer),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(configurationFixture))),
  ),
);

it.effect("names the invalid setting without leaking source values or parse causes", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Effect.gen(function* () {
        return yield* TwitchConfiguration;
      }).pipe(
        Effect.provide(twitchConfigurationLayer),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ ...configurationFixture, TWITCH_CLIENT_SECRET: "" }),
          ),
        ),
      ),
    );

    expect(error._tag).toBe("TwitchConfigurationError");
    expect(error.operation).toBe("readTwitchConfiguration");
    expect(error.reason).toBe("SettingInvalid");
    expect(error.setting).toEqual(Option.some("TWITCH_CLIENT_SECRET"));
    expect(JSON.stringify(error)).not.toContain("fixture-");
    expect(error.message).toBe(
      "Twitch configuration setting TWITCH_CLIENT_SECRET is missing or invalid. Set it as described in apps/api/.env.example and restart the Worker.",
    );
  }),
);

it.effect("parses the synthetic test settings through the production reader", () =>
  Effect.gen(function* () {
    const configuration = yield* TwitchConfiguration;
    expect(configuration.twitch.broadcaster.id).toBe("12345");
    expect(configuration.rewardRouting.songRequestRewardId).toBe("song-reward");
    expect(Redacted.value(configuration.administratorSecret)).toBe("admin-secret");
  }).pipe(Effect.provide(twitchConfigurationTestLayer)),
);
