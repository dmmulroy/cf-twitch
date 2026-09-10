import { Context, Deferred, Effect, Layer, Ref, type Schema } from "effect";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

/** Synthetic provider transcript records only operation counts, never credentials or request bodies. */
export interface IProviderScenarioTranscript {
  readonly readRequestCount: () => Effect.Effect<number>;
  readonly readRequests: () => Effect.Effect<readonly ProviderScenarioRequest[]>;
  readonly awaitRefreshStarted: () => Effect.Effect<void>;
}

/** Bounded test transcript excludes query strings, headers, bodies and credentials. */
export interface ProviderScenarioRequest {
  readonly method: string;
  readonly path: string;
}

/** Test control is separate from the production HttpClient capability. */
export class ProviderScenarioTranscript extends Context.Service<
  ProviderScenarioTranscript,
  IProviderScenarioTranscript
>()("@cf-twitch/test/ProviderScenarioTranscript") {}

/** Track fixture crosses the real provider response parser in the workerd scenario. */
export const providerScenarioTrack = {
  id: "4uLU6hMCjMI75M1A2tKUQC",
  name: "Scenario Song",
  artists: [{ id: "artist", name: "Scenario Artist" }],
  album: {
    name: "Scenario Album",
    images: [
      { url: "https://images.local/large", height: 640, width: 640 },
      { url: "https://images.local/small", height: 64, width: 64 },
    ],
  },
};

type ProviderScenarioReply = (
  body: Schema.Json,
  status?: number,
  headers?: Readonly<Record<string, string>>,
) => HttpClientResponse.HttpClientResponse;

const makeProviderScenarioReply =
  (request: HttpClientRequest.HttpClientRequest): ProviderScenarioReply =>
  (body, status = 200, headers = {}) =>
    HttpClientResponse.fromWeb(request, Response.json(body, { status, headers }));

const providerScenarioNoContent = (
  request: HttpClientRequest.HttpClientRequest,
): HttpClientResponse.HttpClientResponse =>
  HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));

const providerScenarioTransportFailure = (
  request: HttpClientRequest.HttpClientRequest,
  description: string,
): HttpClientError.HttpClientError =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description }),
  });

const providerScenarioSpotifyApiResponse = (
  request: HttpClientRequest.HttpClientRequest,
  url: URL,
  mode: string,
): HttpClientResponse.HttpClientResponse => {
  const reply = makeProviderScenarioReply(request);

  if (mode === "no-device") return reply({ error: "No active device" }, 404);

  if (url.pathname.includes("/tracks/"))
    return mode === "missing-track"
      ? reply({ error: "Not found" }, 404)
      : reply(providerScenarioTrack);

  if (url.pathname === "/v1/me/player/queue" && request.method === "GET")
    return mode === "queue-error"
      ? reply({ error: "Queue unavailable" }, 503)
      : reply({ currently_playing: providerScenarioTrack, queue: [providerScenarioTrack] });

  if (url.pathname === "/v1/me/player/currently-playing") {
    if (mode === "current-error") return reply({ error: "Playback observation unavailable" }, 503);

    if (mode === "no-playback") return providerScenarioNoContent(request);

    return reply({
      is_playing: mode !== "paused",
      item: providerScenarioTrack,
      progress_ms: 1250,
    });
  }

  if (url.pathname === "/v1/me/player/devices")
    return reply({
      devices: [
        {
          id: "scenario-device",
          name: "Scenario device",
          type: "Computer",
          is_active: true,
        },
      ],
    });

  return providerScenarioNoContent(request);
};

const providerScenarioSpotifyConnectResponse = (
  request: HttpClientRequest.HttpClientRequest,
  mode: string,
): HttpClientResponse.HttpClientResponse => {
  if (mode === "connect-error")
    return makeProviderScenarioReply(request)({ error: "Connect unavailable" }, 503);

  if (request.method !== "PUT") return providerScenarioNoContent(request);

  const track = {
    uri: `spotify:track:${providerScenarioTrack.id}`,
    uid: "scenario-uid",
    metadata: {},
    provider: "queue",
  };

  return makeProviderScenarioReply(request)({
    player_state: {
      timestamp: "0",
      context_uri: "spotify:playlist:scenario",
      queue_revision: "revision-1",
      next_tracks: mode === "duplicate-tracks" ? [track, { ...track, uid: "other-uid" }] : [track],
      prev_tracks: [],
    },
  });
};

const providerScenarioTwitchApiResponse = (
  request: HttpClientRequest.HttpClientRequest,
  url: URL,
  mode: string,
): HttpClientResponse.HttpClientResponse => {
  const reply = makeProviderScenarioReply(request);

  if (url.pathname === "/helix/streams")
    return reply({
      data: [
        {
          id: "scenario-stream",
          viewer_count: 42,
          started_at: "2026-01-01T00:00:00Z",
          game_name: "Science",
          title: "Scenario",
        },
      ],
    });

  if (url.pathname === "/helix/chat/messages") {
    if (mode === "malformed-chat") return reply({ data: [] });

    return reply({
      data: [
        {
          message_id: "scenario-message",
          is_sent: mode !== "dropped-chat",
          drop_reason: mode === "dropped-chat" ? { code: "automod_held", message: "Held" } : null,
        },
      ],
    });
  }

  if (url.pathname.includes("custom_rewards/redemptions"))
    return reply({ data: [{ id: "scenario-redemption" }] });

  if (url.pathname === "/helix/eventsub/subscriptions" && request.method !== "DELETE")
    return reply({
      data: [
        {
          id: "scenario-subscription",
          status: "enabled",
          type: "stream.online",
          version: "1",
          condition: { broadcaster_user_id: "123" },
          transport: { method: "webhook", callback: "https://local.test/webhooks/twitch" },
        },
      ],
      pagination: {},
    });

  return providerScenarioNoContent(request);
};

/** Controlled Effect HTTP transport never delegates to network fetch or live provider APIs. */
export const providerScenarioTransportLayer = Layer.effectContext(
  Effect.gen(function* () {
    const requestCount = yield* Ref.make(0);
    const requests = yield* Ref.make<readonly ProviderScenarioRequest[]>([]);
    const refreshCount = yield* Ref.make(0);
    const refreshStarted = yield* Deferred.make<void>();

    const executeAuthorizationRequest = Effect.fn(
      "ProviderScenarioTransport.executeAuthorizationRequest",
    )(function* (request: HttpClientRequest.HttpClientRequest, url: URL) {
      const reply = makeProviderScenarioReply(request);

      const form = new URLSearchParams(
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
      );

      const grant = form.get("grant_type");
      const spotify = url.hostname === "accounts.spotify.com";

      if (grant !== "refresh_token")
        return reply({
          access_token: grant === "client_credentials" ? "scenario-app" : "scenario:normal",
          refresh_token: "scenario-refresh",
          token_type: "Bearer",
          expires_in: 3600,
          scope: spotify
            ? "user-read-playback-state user-modify-playback-state"
            : ["user:write:chat", "moderator:manage:shoutouts"],
        });

      yield* Deferred.succeed(refreshStarted, undefined);
      const refresh = form.get("refresh_token");

      if (refresh === "scenario-revoked")
        return reply(
          { error: "invalid_grant", error_description: "scenario-secret-never-log" },
          400,
        );

      if (refresh === "scenario-network") return reply({ error: "temporarily_unavailable" }, 503);

      if (refresh === "scenario-malformed") return reply({ access_token: "scenario-invalid" });
      const count = yield* Ref.updateAndGet(refreshCount, (value) => value + 1);
      // Allows public requests to overlap while the real token lifecycle holds its refresh lock.
      yield* Effect.sleep("100 millis");

      const fields = {
        access_token: `scenario-access-${count}`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: spotify ? "user-read-playback-state" : ["user:write:chat"],
      };

      return refresh === "scenario-retain"
        ? reply(fields)
        : reply({ ...fields, refresh_token: `scenario-rotated-${count}` });
    });

    const transport = HttpClient.make(
      Effect.fn("ProviderScenarioTransport.execute")(function* (request) {
        yield* Ref.update(requestCount, (count) => count + 1);
        const url = new URL(request.url);
        yield* Ref.update(requests, (previous) => [
          ...previous.slice(-127),
          { method: request.method, path: url.pathname },
        ]);

        if (url.hostname === "accounts.spotify.com" || url.hostname === "id.twitch.tv")
          return yield* executeAuthorizationRequest(request, url);

        const mode = (request.headers["authorization"] ?? "").replace("Bearer scenario:", "");
        const reply = makeProviderScenarioReply(request);

        if (mode === "unauthorized") return reply({ error: "Unauthorized" }, 401);

        if (mode === "rate-limited")
          return reply({ error: "Rate limited" }, 429, { "retry-after": "12" });

        if (mode === "unknown" && request.method !== "GET")
          return yield* Effect.fail(
            providerScenarioTransportFailure(
              request,
              "Controlled provider connection lost after dispatch",
            ),
          );

        if (url.hostname === "api.spotify.com")
          return providerScenarioSpotifyApiResponse(request, url, mode);

        if (url.hostname === "clienttoken.spotify.com")
          return reply({
            granted_token: { token: "scenario-client-token", expires_after_seconds: 3600 },
          });

        if (url.hostname === "gue1-spclient.spotify.com")
          return providerScenarioSpotifyConnectResponse(request, mode);

        if (url.hostname === "api.twitch.tv")
          return providerScenarioTwitchApiResponse(request, url, mode);

        return yield* Effect.fail(
          providerScenarioTransportFailure(
            request,
            "Controlled provider transport refused an unknown origin",
          ),
        );
      }),
    );

    return Context.make(HttpClient.HttpClient, transport).pipe(
      Context.add(ProviderScenarioTranscript, {
        readRequestCount: Effect.fn("ProviderScenarioTranscript.readRequestCount")(() =>
          Ref.get(requestCount),
        ),
        readRequests: Effect.fn("ProviderScenarioTranscript.readRequests")(() => Ref.get(requests)),
        awaitRefreshStarted: Effect.fn("ProviderScenarioTranscript.awaitRefreshStarted")(() =>
          Deferred.await(refreshStarted),
        ),
      }),
    );
  }),
);
