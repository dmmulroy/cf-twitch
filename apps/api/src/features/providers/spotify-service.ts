import { SpotifyTrackId } from "@cf-twitch/contracts/identity";
import {
  ProviderError,
  type ProviderOperation,
  SpotifyConnectState,
  type SpotifyDevice,
} from "@cf-twitch/contracts/provider";
import type { SpotifyPlayback, SpotifyTrack } from "@cf-twitch/contracts/spotify-track";
import { Cause, Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { SecureRandom } from "effect/crypto";
import { HttpClient, HttpClientRequest } from "effect/http";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import {
  ProviderAccessTokens,
  providerAccessTokensLayer,
  providerAccessTokensTestLayer,
} from "./provider-access-tokens.ts";
import {
  confirmProviderMutationStatus,
  decodeProviderResponse,
  executeProviderRequest,
} from "./provider-http.ts";

/** Spotify queue observation, authoritative only after successful provider response decoding. */
export interface SpotifyServiceQueueSnapshot {
  /** Track currently in playback, or none when nothing is playing. */
  readonly currentlyPlaying: Option.Option<SpotifyTrack>;
  /** Upcoming Spotify Queue in playback order, including autoplay tracks. */
  readonly queue: readonly SpotifyTrack[];
}

/**
 * Spotify Web API capability, including best-effort internal queue compensation.
 *
 * **Details**
 *
 * Unknown outcomes of non-idempotent mutations are never retried internally.
 */
export interface ISpotifyService {
  /**
   * Returns track metadata.
   *
   * @returns The track, or fails with `ProviderError` reason `not-found` for an unknown track ID, or another reason when Spotify is unreachable, refuses the request or returns a malformed response.
   */
  readonly getTrack: (trackId: SpotifyTrackId) => Effect.Effect<SpotifyTrack, ProviderError>;
  /**
   * Returns the currently playing track and the upcoming Spotify Queue.
   *
   * @returns The snapshot, or fails with `ProviderError` reason `no-active-device` when no device is playing, or another reason for transport, refusal or malformed responses.
   */
  readonly getQueue: () => Effect.Effect<SpotifyServiceQueueSnapshot, ProviderError>;
  /**
   * Returns the currently playing track, or none when playback is paused or absent.
   *
   * @returns The track, or fails with `ProviderError` for transport, refusal or malformed responses.
   */
  readonly getCurrentlyPlaying: () => Effect.Effect<Option.Option<SpotifyTrack>, ProviderError>;
  /**
   * Returns the queue and playback state, observed concurrently.
   *
   * **Details**
   *
   * When only the currently-playing observation fails, the queue's current track is used instead.
   *
   * @returns The playback, or fails with the `ProviderError` of the queue observation.
   */
  readonly getPlayback: () => Effect.Effect<SpotifyPlayback, ProviderError>;
  /**
   * Appends a track to the Spotify Queue.
   *
   * @returns Nothing, or fails with `ProviderError` reason `outcome-unknown` when success cannot be confirmed, `no-active-device` when no device is playing, or another reason for refusal or token failure.
   */
  readonly addToQueue: (trackId: SpotifyTrackId) => Effect.Effect<void, ProviderError>;
  /**
   * Skips to the next track.
   *
   * @returns Nothing, or fails with `ProviderError` reason `outcome-unknown` when success cannot be confirmed, or another reason for refusal or token failure.
   */
  readonly skipTrack: () => Effect.Effect<void, ProviderError>;
  /**
   * Returns the active playback device, or none when no device is active.
   *
   * @returns The device, or fails with `ProviderError` for transport, refusal or malformed responses.
   */
  readonly getActiveDevice: () => Effect.Effect<Option.Option<SpotifyDevice>, ProviderError>;
  /**
   * Reads internal Spotify Connect queue state for a device.
   *
   * @returns The Connect state, or fails with `ProviderError` reason `randomness` when a client token device ID cannot be generated, or another reason for transport, refusal or malformed responses.
   */
  readonly getConnectState: (deviceId: string) => Effect.Effect<SpotifyConnectState, ProviderError>;
  /**
   * Removes the single upcoming occurrence of a track as best-effort compensation.
   *
   * **Gotchas**
   *
   * Returns `false` without removing anything when Connect state is unavailable, when several upcoming occurrences match, or when Spotify rejects the command. Returns `true` when the track is already absent.
   *
   * @returns Whether the track is no longer queued, or fails with `ProviderError` reason `no-active-device` when no device is active, or another reason when the removal outcome cannot be confirmed.
   */
  readonly removeFromQueue: (trackId: SpotifyTrackId) => Effect.Effect<boolean, ProviderError>;
}

/** Service that owns Spotify playback operations and best-effort internal queue compensation. */
export class SpotifyService extends Context.Service<SpotifyService, ISpotifyService>()(
  "@cf-twitch/SpotifyService",
) {}

const SpotifyTrackResponse = Schema.Struct({
  id: SpotifyTrackId,
  name: Schema.String,
  artists: Schema.Array(Schema.Struct({ name: Schema.String })),
  album: Schema.Struct({
    name: Schema.String,
    images: Schema.Array(
      Schema.Struct({ url: Schema.String, height: Schema.NullOr(Schema.Number) }),
    ),
  }),
});

const SpotifyQueueResponse = Schema.Struct({
  currently_playing: Schema.NullOr(SpotifyTrackResponse),
  queue: Schema.Array(SpotifyTrackResponse),
});

const SpotifyCurrentlyPlayingResponse = Schema.Struct({
  is_playing: Schema.Boolean,
  item: Schema.NullOr(SpotifyTrackResponse),
  progress_ms: Schema.OptionFromOptionalKey(Schema.NullOr(Schema.Number)),
});

const SpotifyDeviceResponse = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  name: Schema.String,
  type: Schema.String,
  is_active: Schema.Boolean,
});

const SpotifyDevicesResponse = Schema.Struct({
  devices: Schema.Array(SpotifyDeviceResponse),
});

const isActiveSpotifyDevice = (
  candidate: typeof SpotifyDeviceResponse.Type,
): candidate is typeof SpotifyDeviceResponse.Type & { readonly id: string } =>
  candidate.is_active && candidate.id !== null;

const SpotifyClientTokenResponse = Schema.Struct({
  granted_token: Schema.Struct({
    token: Schema.RedactedFromValue(Schema.NonEmptyString),
    expires_after_seconds: Schema.Number,
  }),
});

const SpotifyConnectResponse = Schema.Struct({ player_state: SpotifyConnectState });

const trackInfo = (track: typeof SpotifyTrackResponse.Type): SpotifyTrack => ({
  id: track.id,
  name: track.name,
  artists: track.artists.map((artist) => artist.name),
  album: track.album.name,
  albumCoverUrl: Option.fromUndefinedOr(
    [...track.album.images].sort((a, b) => (a.height ?? 0) - (b.height ?? 0))[0]?.url,
  ),
});

const queueDecode = decodeProviderResponse(SpotifyQueueResponse, {
  provider: "spotify",
  operation: "getQueue",
  mutation: false,
});

const trackDecode = decodeProviderResponse(SpotifyTrackResponse, {
  provider: "spotify",
  operation: "getTrack",
  mutation: false,
});

const playingDecode = decodeProviderResponse(SpotifyCurrentlyPlayingResponse, {
  provider: "spotify",
  operation: "getCurrentlyPlaying",
  mutation: false,
});

const devicesDecode = decodeProviderResponse(SpotifyDevicesResponse, {
  provider: "spotify",
  operation: "getActiveDevice",
  mutation: false,
});

const clientTokenDecode = decodeProviderResponse(SpotifyClientTokenResponse, {
  provider: "spotify",
  operation: "getClientToken",
  mutation: false,
});

const connectDecode = decodeProviderResponse(SpotifyConnectResponse, {
  provider: "spotify",
  operation: "getConnectState",
  mutation: false,
});

/** Creates the Spotify service over durable access tokens, runtime configuration and an Effect HTTP transport. */
export const makeSpotifyService = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const tokens = yield* ProviderAccessTokens;
  const configuration = yield* TwitchConfiguration;
  const secureRandom = yield* SecureRandom.SecureRandom;

  const generateProviderCommandId = Effect.fn("SpotifyService.generateProviderCommandId")(() =>
    // Effect 4.1 SecureRandom reports randomness failure as a defect, not a typed failure.
    secureRandom.uuidV4().pipe(
      Effect.catchCauseIf(
        (cause) => Cause.hasDies(cause) && !Cause.hasInterrupts(cause),
        () =>
          Effect.fail(
            new ProviderError({
              provider: "spotify",
              operation: "generateProviderCommandId",
              reason: "randomness",
              status: Option.none(),
              retryAfterMs: Option.none(),
            }),
          ),
      ),
    ),
  );

  const request = Effect.fn("SpotifyService.request")(function* (
    operation: ProviderOperation,
    outgoing: HttpClientRequest.HttpClientRequest,
    mutation = false,
  ) {
    const token = yield* tokens.getValidAccessToken("spotify");

    return yield* executeProviderRequest(client, {
      provider: "spotify",
      operation,
      request: outgoing.pipe(HttpClientRequest.bearerToken(token)),
      mutation,
      notFound: operation === "getTrack" ? "not-found" : "no-active-device",
    });
  });

  const getTrack = Effect.fn("SpotifyService.getTrack")(function* (trackId: SpotifyTrackId) {
    return trackInfo(
      yield* request(
        "getTrack",
        HttpClientRequest.get(`https://api.spotify.com/v1/tracks/${encodeURIComponent(trackId)}`),
      ).pipe(Effect.flatMap(trackDecode)),
    );
  });

  const getQueue = Effect.fn("SpotifyService.getQueue")(function* (): Effect.fn.Return<
    SpotifyServiceQueueSnapshot,
    ProviderError
  > {
    const response = yield* request(
      "getQueue",
      HttpClientRequest.get("https://api.spotify.com/v1/me/player/queue"),
    ).pipe(Effect.flatMap(queueDecode));

    return {
      currentlyPlaying: Option.map(Option.fromNullOr(response.currently_playing), trackInfo),
      queue: response.queue.map(trackInfo),
    };
  });

  const getPlaying = Effect.fn("SpotifyService.getPlaying")(function* () {
    const response = yield* request(
      "getCurrentlyPlaying",
      HttpClientRequest.get("https://api.spotify.com/v1/me/player/currently-playing"),
    );

    if (response.status === 204)
      return { currentlyPlaying: Option.none<SpotifyTrack>(), isPlaying: false, progressMs: 0 };
    const playing = yield* playingDecode(response);

    return {
      currentlyPlaying: playing.is_playing
        ? Option.map(Option.fromNullOr(playing.item), trackInfo)
        : Option.none<SpotifyTrack>(),
      isPlaying: playing.is_playing,
      progressMs: Option.getOrElse(Option.flatMap(playing.progress_ms, Option.fromNullOr), () => 0),
    };
  });

  const getCurrentlyPlaying = Effect.fn("SpotifyService.getCurrentlyPlaying")(() =>
    getPlaying().pipe(Effect.map((playing) => playing.currentlyPlaying)),
  );

  const getPlayback = Effect.fn("SpotifyService.getPlayback")(function* (): Effect.fn.Return<
    SpotifyPlayback,
    ProviderError
  > {
    const [queue, playingOption] = yield* Effect.all(
      [getQueue(), getPlaying().pipe(Effect.option)],
      { concurrency: "unbounded" },
    );

    const playing = Option.getOrElse(playingOption, () => ({
      currentlyPlaying: queue.currentlyPlaying,
      isPlaying: Option.isSome(queue.currentlyPlaying),
      progressMs: 0,
    }));

    return { ...playing, queue: queue.queue };
  });

  const addToQueue = Effect.fn("SpotifyService.addToQueue")((trackId: SpotifyTrackId) =>
    request(
      "addToQueue",
      HttpClientRequest.post("https://api.spotify.com/v1/me/player/queue").pipe(
        HttpClientRequest.setUrlParam("uri", `spotify:track:${trackId}`),
      ),
      true,
    ).pipe(
      Effect.flatMap((response) =>
        confirmProviderMutationStatus(response, {
          provider: "spotify",
          operation: "addToQueue",
          statuses: [200, 204],
        }),
      ),
    ),
  );

  const skipTrack = Effect.fn("SpotifyService.skipTrack")(() =>
    request(
      "skipTrack",
      HttpClientRequest.post("https://api.spotify.com/v1/me/player/next"),
      true,
    ).pipe(
      Effect.flatMap((response) =>
        confirmProviderMutationStatus(response, {
          provider: "spotify",
          operation: "skipTrack",
          statuses: [204],
        }),
      ),
    ),
  );

  const getActiveDevice = Effect.fn("SpotifyService.getActiveDevice")(
    function* (): Effect.fn.Return<Option.Option<SpotifyDevice>, ProviderError> {
      const response = yield* request(
        "getActiveDevice",
        HttpClientRequest.get("https://api.spotify.com/v1/me/player/devices"),
      ).pipe(Effect.flatMap(devicesDecode));

      const device = response.devices.find(isActiveSpotifyDevice);

      return device === undefined
        ? Option.none()
        : Option.some({
            id: device.id,
            name: device.name,
            type: device.type,
            isActive: device.is_active,
          });
    },
  );

  const getClientToken = Effect.fn("SpotifyService.getClientToken")(function* () {
    const deviceId = yield* generateProviderCommandId();

    const outgoing = HttpClientRequest.post("https://clienttoken.spotify.com/v1/clienttoken").pipe(
      HttpClientRequest.bodyJsonUnsafe({
        client_data: {
          client_version: "1.2.52.442",
          client_id: configuration.spotify.clientId,
          js_sdk_data: {
            device_brand: "unknown",
            device_model: "desktop",
            os: "Linux",
            os_version: "unknown",
            device_id: deviceId,
            device_type: "computer",
          },
        },
      }),
    );

    const response = yield* executeProviderRequest(client, {
      provider: "spotify",
      operation: "getClientToken",
      request: outgoing,
      mutation: false,
      notFound: "not-found",
    }).pipe(Effect.flatMap(clientTokenDecode));

    return response.granted_token.token;
  });

  const getConnectState = Effect.fn("SpotifyService.getConnectState")(function* (deviceId: string) {
    const clientToken = yield* getClientToken();

    const response = yield* request(
      "getConnectState",
      HttpClientRequest.put(
        `https://gue1-spclient.spotify.com/connect-state/v1/devices/hobs_${encodeURIComponent(deviceId)}`,
      ).pipe(
        HttpClientRequest.setHeader("client-token", Redacted.value(clientToken)),
        HttpClientRequest.bodyJsonUnsafe({
          member_type: "CONNECT_STATE",
          device: { device_info: { capabilities: { can_be_player: false } } },
        }),
      ),
    ).pipe(Effect.flatMap(connectDecode));

    return response.player_state;
  });

  const removeFromQueue = Effect.fn("SpotifyService.removeFromQueue")(function* (
    trackId: SpotifyTrackId,
  ) {
    const device = yield* getActiveDevice();

    if (Option.isNone(device))
      return yield* Effect.fail(
        new ProviderError({
          provider: "spotify",
          operation: "removeFromQueue",
          reason: "no-active-device",
          status: Option.some(404),
          retryAfterMs: Option.none(),
        }),
      );

    const state = yield* getConnectState(device.value.id).pipe(Effect.option);

    if (Option.isNone(state)) return false;
    const trackUri = `spotify:track:${trackId}`;
    const matchingTracks = state.value.next_tracks.filter((track) => track.uri === trackUri);

    if (matchingTracks.length === 0) return true;

    // Track ID alone cannot prove which duplicate belongs to this compensation.
    // Refuse rather than removing another viewer's successfully queued occurrence.
    if (matchingTracks.length > 1) return false;
    const clientToken = yield* getClientToken();
    const commandId = yield* generateProviderCommandId();

    return yield* request(
      "removeFromQueue",
      HttpClientRequest.post(
        `https://gue1-spclient.spotify.com/connect-state/v1/player/command/from/${encodeURIComponent(device.value.id)}/to/${encodeURIComponent(device.value.id)}`,
      ).pipe(
        HttpClientRequest.setHeader("client-token", Redacted.value(clientToken)),
        HttpClientRequest.bodyJsonUnsafe({
          command: {
            next_tracks: state.value.next_tracks.filter((track) => track.uri !== trackUri),
            prev_tracks: state.value.prev_tracks,
            queue_revision: state.value.queue_revision,
            endpoint: "set_queue",
            logging_params: { command_id: commandId.replace(/-/g, "") },
          },
        }),
      ),
      true,
    ).pipe(
      Effect.as(true),
      Effect.catchTag("ProviderError", (error) =>
        error.reason === "rejected" ? Effect.succeed(false) : Effect.fail(error),
      ),
    );
  });

  return SpotifyService.of({
    getTrack,
    getQueue,
    getCurrentlyPlaying,
    getPlayback,
    addToQueue,
    skipTrack,
    getActiveDevice,
    getConnectState,
    removeFromQueue,
  });
});

/** Layer that provides the Spotify service with configuration, HTTP transport, randomness and access-token requirements visible. */
export const spotifyServiceLayerWithoutDependencies = Layer.effect(
  SpotifyService,
  makeSpotifyService,
);

/** Production Spotify service Layer that selects durable access tokens, leaving runtime HTTP, configuration and randomness visible. */
export const spotifyServiceLayer = spotifyServiceLayerWithoutDependencies.pipe(
  Layer.provide(providerAccessTokensLayer),
);

/**
 * Layer that provides the Spotify service over in-memory access tokens.
 *
 * **Details**
 *
 * Leaves `HttpClient.HttpClient`, `TwitchConfiguration` and `SecureRandom` required so tests supply a controlled Spotify transport that cannot reach the network.
 */
export const spotifyServiceTestLayer = spotifyServiceLayerWithoutDependencies.pipe(
  Layer.provide(providerAccessTokensTestLayer),
);
