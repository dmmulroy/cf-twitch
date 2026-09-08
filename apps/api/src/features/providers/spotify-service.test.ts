import { expect, it } from "@effect/vitest";
import { SpotifyTrackId } from "@cf-twitch/contracts/identity";
import { Effect, Layer, Option, Redacted } from "effect";
import { ProviderAccessTokens } from "./provider-access-tokens.ts";
import {
  providerLocalAccessTokensLayer,
  providerLocalConfigurationLayer,
  providerLocalCryptoLayer,
} from "./provider-local-sql.test-support.ts";
import {
  ProviderScenarioTranscript,
  providerScenarioTrack,
  providerScenarioTransportLayer,
} from "./provider-scenario-transport.test-support.ts";
import { SpotifyService, spotifyServiceLayerWithoutDependencies } from "./spotify-service.ts";

const layer = spotifyServiceLayerWithoutDependencies.pipe(
  Layer.provideMerge(providerLocalAccessTokensLayer),
  Layer.provide([providerLocalConfigurationLayer, providerLocalCryptoLayer]),
  Layer.provideMerge(providerScenarioTransportLayer),
);
const trackId = SpotifyTrackId.make(providerScenarioTrack.id);
const seed = Effect.fn("SpotifyTest.seed")(function* (mode: string) {
  const tokens = yield* ProviderAccessTokens;
  yield* tokens.setTokens({
    provider: "spotify",
    tokens: {
      accessToken: Redacted.make(`scenario:${mode}`),
      refreshToken: Option.some(Redacted.make("scenario-refresh")),
      tokenType: "Bearer",
      expiresIn: 3600,
      scopes: [],
    },
  });
});

it.effect(
  "Spotify getTrack parses metadata and selects the smallest album cover through real token SQL",
  () =>
    Effect.gen(function* () {
      yield* seed("normal");
      const spotify = yield* SpotifyService;
      expect(yield* spotify.getTrack(trackId)).toEqual({
        id: trackId,
        name: "Scenario Song",
        artists: ["Scenario Artist"],
        album: "Scenario Album",
        albumCoverUrl: Option.some("https://images.local/small"),
      });
    }).pipe(Effect.provide(layer)),
);

for (const mode of ["normal", "paused", "no-playback", "current-error"] as const) {
  it.effect(
    `Spotify playback ${mode} preserves queue authority and current observation semantics`,
    () =>
      Effect.gen(function* () {
        yield* seed(mode);
        const spotify = yield* SpotifyService;
        const playback = yield* spotify.getPlayback();
        expect(playback.queue.map((track) => track.id)).toEqual([trackId]);
        expect(Option.isSome(playback.currentlyPlaying)).toBe(
          mode === "normal" || mode === "current-error",
        );
        expect(playback.isPlaying).toBe(mode === "normal" || mode === "current-error");
        expect(playback.progressMs).toBe(
          mode === "no-playback" || mode === "current-error" ? 0 : 1250,
        );
      }).pipe(Effect.provide(layer)),
  );
}
for (const [mode, kind] of [
  ["queue-error", "network"],
  ["no-device", "no-active-device"],
  ["unauthorized", "unauthorized"],
] as const) {
  it.effect(
    `Spotify playback ${mode} fails rather than returning an empty replacement snapshot`,
    () =>
      Effect.gen(function* () {
        yield* seed(mode);
        const spotify = yield* SpotifyService;
        expect(yield* spotify.getPlayback().pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { kind },
        });
      }).pipe(Effect.provide(layer)),
  );
}
for (const [mode, kind] of [
  ["missing-track", "not-found"],
  ["rate-limited", "rate-limited"],
] as const) {
  it.effect(`Spotify track lookup ${mode} exposes precise typed failure`, () =>
    Effect.gen(function* () {
      yield* seed(mode);
      const spotify = yield* SpotifyService;
      const result = yield* spotify.getTrack(trackId).pipe(Effect.result);
      expect(result).toMatchObject({ _tag: "Failure", failure: { kind } });
      if (result._tag === "Failure" && mode === "rate-limited")
        expect(result.failure.retryAfterMs).toEqual(Option.some(12_000));
    }).pipe(Effect.provide(layer)),
  );
}
it.effect("Spotify mutations execute once and an unknown queue outcome is never retried", () =>
  Effect.gen(function* () {
    yield* seed("unknown");
    const spotify = yield* SpotifyService;
    const transcript = yield* ProviderScenarioTranscript;
    expect(yield* spotify.addToQueue(trackId).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { kind: "outcome-unknown" },
    });
    expect(yield* transcript.readRequests()).toEqual([
      { method: "POST", path: "/v1/me/player/queue" },
    ]);
  }).pipe(Effect.provide(layer)),
);
it.effect(
  "Spotify confirmed queue append and skip expose success after a single request each",
  () =>
    Effect.gen(function* () {
      yield* seed("normal");
      const spotify = yield* SpotifyService;
      const transcript = yield* ProviderScenarioTranscript;
      yield* spotify.addToQueue(trackId);
      yield* spotify.skipTrack();
      expect(yield* transcript.readRequests()).toEqual([
        { method: "POST", path: "/v1/me/player/queue" },
        { method: "POST", path: "/v1/me/player/next" },
      ]);
    }).pipe(Effect.provide(layer)),
);
it.effect("Spotify internal compensation removes a uniquely identifiable queued track", () =>
  Effect.gen(function* () {
    yield* seed("normal");
    const spotify = yield* SpotifyService;
    expect(yield* spotify.removeFromQueue(trackId)).toBe(true);
    const transcript = yield* ProviderScenarioTranscript;
    expect(
      (yield* transcript.readRequests()).filter(
        (request) => request.path.includes("/player/command/") && request.method === "POST",
      ),
    ).toHaveLength(1);
  }).pipe(Effect.provide(layer)),
);
it.effect("Spotify duplicate URI compensation refuses to remove unrelated occurrences", () =>
  Effect.gen(function* () {
    yield* seed("duplicate-tracks");
    const spotify = yield* SpotifyService;
    expect(yield* spotify.removeFromQueue(trackId)).toBe(false);
    const transcript = yield* ProviderScenarioTranscript;
    expect(
      (yield* transcript.readRequests()).filter((request) =>
        request.path.includes("/player/command/"),
      ),
    ).toHaveLength(0);
  }).pipe(Effect.provide(layer)),
);
