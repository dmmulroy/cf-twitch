import {
  CreateEventSubSubscription,
  CreateShoutout,
  ProviderError,
  SendChatMessage,
  type ProviderOperation,
  TwitchStreamInfo,
  UpdateRedemptionStatus,
  type ProviderEventSubSubscription,
} from "@cf-twitch/contracts/provider";
import {
  Cache,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import {
  ProviderAccessTokens,
  providerAccessTokensLayer,
  providerAccessTokensTestLayer,
} from "./provider-access-tokens.ts";
import {
  ProviderTokenExchange,
  providerTokenExchangeLayer,
  providerTokenExchangeTestLayer,
} from "./provider-token-exchange.ts";
import {
  confirmProviderMutationStatus,
  decodeProviderResponse,
  executeProviderRequest,
} from "./provider-http.ts";
import { twitchConfigurationTestLayer } from "../../runtime/twitch-configuration.ts";

/**
 * Twitch Helix capability that distinguishes confirmed delivery from unknown mutation outcomes.
 *
 * **Details**
 *
 * Unknown mutation outcomes are never retried internally. Read operations use the app token; chat, shoutouts and redemption updates use the broadcaster's user token.
 */
export interface ITwitchService {
  /**
   * Returns live stream information for a Twitch login, or none while the stream is offline.
   *
   * @returns The stream information, or fails with `ProviderError` operation `getStreamInfo` when Twitch is unreachable, refuses the request or returns a malformed response.
   */
  readonly getStreamInfo: (
    userLogin: string,
  ) => Effect.Effect<Option.Option<TwitchStreamInfo>, ProviderError>;
  /**
   * Sends a chat message as the broadcaster and confirms Twitch delivered it.
   *
   * @returns Nothing, or fails with `ProviderError` reason `chat-dropped` when Twitch declined to deliver the message, `outcome-unknown` when delivery cannot be confirmed, or another reason for refusal or token failure.
   */
  readonly sendChatMessage: (input: SendChatMessage) => Effect.Effect<void, ProviderError>;
  /**
   * Sends a native shoutout from the broadcaster.
   *
   * @returns Nothing, or fails with `ProviderError` reason `outcome-unknown` when success cannot be confirmed, or another reason for refusal or token failure.
   */
  readonly createShoutout: (input: CreateShoutout) => Effect.Effect<void, ProviderError>;
  /**
   * Fulfills or cancels a channel point redemption.
   *
   * @returns Nothing, or fails with `ProviderError` reason `outcome-unknown` when success cannot be confirmed, or another reason for refusal or token failure.
   */
  readonly updateRedemptionStatus: (
    input: UpdateRedemptionStatus,
  ) => Effect.Effect<void, ProviderError>;
  /**
   * Creates an EventSub webhook subscription.
   *
   * @returns The created subscription, or fails with `ProviderError` reason `outcome-unknown` when creation cannot be confirmed, or another reason for refusal.
   */
  readonly createEventSubSubscription: (
    input: CreateEventSubSubscription,
  ) => Effect.Effect<ProviderEventSubSubscription, ProviderError>;
  /**
   * Lists every EventSub subscription across at most 100 pages.
   *
   * @returns All subscriptions, or fails with `ProviderError` reason `invalid-response` when a page is malformed or more than 100 pages exist, or another reason when Twitch is unreachable or refuses the request.
   */
  readonly listEventSubSubscriptions: () => Effect.Effect<
    readonly ProviderEventSubSubscription[],
    ProviderError
  >;
  /**
   * Deletes an EventSub subscription.
   *
   * @returns Nothing, or fails with `ProviderError` reason `outcome-unknown` when deletion cannot be confirmed, or another reason for refusal.
   */
  readonly deleteEventSubSubscription: (
    subscriptionId: string,
  ) => Effect.Effect<void, ProviderError>;
}

/** Service that owns Twitch Helix authorization, pagination and delivery evidence. */
export class TwitchService extends Context.Service<TwitchService, ITwitchService>()(
  "@cf-twitch/TwitchService",
) {}

const TwitchStreamResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: TwitchStreamInfo.fields.id,
      viewer_count: Schema.Number,
      started_at: TwitchStreamInfo.fields.startedAt,
      game_name: Schema.String,
      title: Schema.String,
    }),
  ),
});

const TwitchSubscription = Schema.Struct({
  id: Schema.NonEmptyString,
  status: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  condition: Schema.Record(Schema.String, Schema.String),
  transport: Schema.Struct({
    method: Schema.String,
    callback: Schema.OptionFromOptionalKey(Schema.String),
  }),
});

const TwitchSubscriptionResponse = Schema.Struct({
  data: Schema.Array(TwitchSubscription),
  pagination: Schema.OptionFromOptionalKey(
    Schema.Struct({ cursor: Schema.OptionFromOptionalKey(Schema.NonEmptyString) }),
  ),
});

const TwitchSubscriptionCreateResponse = Schema.Struct({
  ...TwitchSubscriptionResponse.fields,
  data: Schema.NonEmptyArray(TwitchSubscription),
});

const TwitchChatResponse = Schema.Struct({
  data: Schema.NonEmptyArray(
    Schema.Struct({
      message_id: Schema.NonEmptyString,
      is_sent: Schema.Boolean,
      drop_reason: Schema.NullOr(
        Schema.Struct({ code: Schema.NonEmptyString, message: Schema.String }),
      ),
    }),
  ),
});

const TwitchRedemptionResponse = Schema.Struct({
  data: Schema.NonEmptyArray(Schema.Struct({ id: Schema.optionalKey(Schema.String) })),
});

const streamDecode = decodeProviderResponse(TwitchStreamResponse, {
  provider: "twitch",
  operation: "getStreamInfo",
  mutation: false,
});

const subscriptionsDecode = decodeProviderResponse(TwitchSubscriptionResponse, {
  provider: "twitch",
  operation: "listEventSubSubscriptions",
  mutation: false,
});

const subscriptionCreateDecode = decodeProviderResponse(TwitchSubscriptionCreateResponse, {
  provider: "twitch",
  operation: "createEventSubSubscription",
  mutation: true,
});

const chatDecode = decodeProviderResponse(TwitchChatResponse, {
  provider: "twitch",
  operation: "sendChatMessage",
  mutation: true,
});

const redemptionDecode = decodeProviderResponse(TwitchRedemptionResponse, {
  provider: "twitch",
  operation: "updateRedemptionStatus",
  mutation: true,
});

/** Creates the Twitch service with app credentials independent of stream-aware user tokens. */
export const makeTwitchService = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const configuration = yield* TwitchConfiguration;
  const tokens = yield* ProviderAccessTokens;
  const exchange = yield* ProviderTokenExchange;

  // Token values may be reused within one Worker invocation, but the lookup and its
  // in-flight HTTP request must never cross the execution Scope that owns the transport.
  const twitchAppTokenCache = yield* makeExecutionMemo(
    Cache.makeWith(() => exchange.getTwitchAppToken(), {
      capacity: 1,
      timeToLive: (exit) =>
        Exit.isSuccess(exit)
          ? Duration.millis(Math.max(0, exit.value.expiresIn * 1000 - 300_000))
          : Duration.zero,
    }),
  );

  const getTwitchAppAccessToken = Effect.fn("TwitchService.getTwitchAppAccessToken")(function* () {
    const cache = yield* twitchAppTokenCache;
    const appToken = yield* Cache.get(cache, "twitch-app-token");

    return appToken.accessToken;
  });

  const invalidateTwitchAppAccessToken = Effect.fn("TwitchService.invalidateTwitchAppAccessToken")(
    function* () {
      const cache = yield* twitchAppTokenCache;
      yield* Cache.invalidate(cache, "twitch-app-token");
    },
  );

  const request = Effect.fn("TwitchService.request")(function* (
    operation: ProviderOperation,
    outgoing: HttpClientRequest.HttpClientRequest,
    authorization: "app" | "user",
    mutation: boolean,
  ) {
    const token = yield* authorization === "app"
      ? getTwitchAppAccessToken()
      : tokens.getValidAccessToken("twitch");

    return yield* executeProviderRequest(client, {
      provider: "twitch",
      operation,
      mutation,
      notFound: "not-found",
      request: outgoing.pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.setHeader("Client-ID", configuration.twitch.clientId),
      ),
    }).pipe(
      Effect.tapError((error) =>
        authorization === "app" && error.reason === "unauthorized"
          ? invalidateTwitchAppAccessToken()
          : Effect.void,
      ),
    );
  });

  const getStreamInfo = Effect.fn("TwitchService.getStreamInfo")(function* (userLogin: string) {
    const response = yield* request(
      "getStreamInfo",
      HttpClientRequest.get("https://api.twitch.tv/helix/streams").pipe(
        HttpClientRequest.setUrlParam("user_login", userLogin),
      ),
      "app",
      false,
    ).pipe(Effect.flatMap(streamDecode));

    const stream = response.data[0];

    return stream === undefined
      ? Option.none()
      : Option.some({
          id: stream.id,
          viewerCount: stream.viewer_count,
          startedAt: stream.started_at,
          gameName: stream.game_name,
          title: stream.title,
        });
  });

  const sendChatMessage = Effect.fn("TwitchService.sendChatMessage")(function* (
    input: SendChatMessage,
  ) {
    const response = yield* request(
      "sendChatMessage",
      HttpClientRequest.post("https://api.twitch.tv/helix/chat/messages").pipe(
        HttpClientRequest.bodyJsonUnsafe({
          broadcaster_id: configuration.twitch.broadcaster.id,
          sender_id: configuration.twitch.broadcaster.id,
          message: input.message,
        }),
      ),
      "user",
      true,
    ).pipe(Effect.flatMap(chatDecode));

    const delivery = response.data[0];

    if (!delivery.is_sent)
      return yield* Effect.fail(
        new ProviderError({
          provider: "twitch",
          operation: "sendChatMessage",
          reason: "chat-dropped",
          status: Option.some(200),
          retryAfterMs: Option.none(),
        }),
      );
  });

  const createShoutout = Effect.fn("TwitchService.createShoutout")((input: CreateShoutout) =>
    request(
      "createShoutout",
      HttpClientRequest.post("https://api.twitch.tv/helix/chat/shoutouts").pipe(
        HttpClientRequest.setUrlParams({
          from_broadcaster_id: configuration.twitch.broadcaster.id,
          to_broadcaster_id: input.toBroadcasterId,
          moderator_id: configuration.twitch.broadcaster.id,
        }),
      ),
      "user",
      true,
    ).pipe(
      Effect.flatMap((response) =>
        confirmProviderMutationStatus(response, {
          provider: "twitch",
          operation: "createShoutout",
          statuses: [204],
        }),
      ),
    ),
  );

  const updateRedemptionStatus = Effect.fn("TwitchService.updateRedemptionStatus")(
    (input: UpdateRedemptionStatus) =>
      request(
        "updateRedemptionStatus",
        HttpClientRequest.patch(
          "https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions",
        ).pipe(
          HttpClientRequest.setUrlParams({
            broadcaster_id: configuration.twitch.broadcaster.id,
            reward_id: input.rewardId,
            id: input.redemptionId,
          }),
          HttpClientRequest.bodyJsonUnsafe({ status: input.status }),
        ),
        "user",
        true,
      ).pipe(Effect.flatMap(redemptionDecode), Effect.asVoid),
  );

  const createEventSubSubscription = Effect.fn("TwitchService.createEventSubSubscription")(
    function* (input: CreateEventSubSubscription) {
      const response = yield* request(
        "createEventSubSubscription",
        HttpClientRequest.post("https://api.twitch.tv/helix/eventsub/subscriptions").pipe(
          HttpClientRequest.bodyJsonUnsafe({
            type: input.type,
            version: input.version,
            condition: input.condition,
            transport: {
              method: "webhook",
              callback: input.callbackUrl,
              secret: Redacted.value(input.secret),
            },
          }),
        ),
        "app",
        true,
      ).pipe(Effect.flatMap(subscriptionCreateDecode));

      return response.data[0];
    },
  );

  const listEventSubSubscriptions = Effect.fn("TwitchService.listEventSubSubscriptions")(
    function* () {
      const token = yield* getTwitchAppAccessToken();

      const pages = Stream.paginate(
        { cursor: Option.none<string>(), page: 1 },
        ({ cursor, page }) =>
          Effect.gen(function* () {
            const outgoing = HttpClientRequest.get(
              "https://api.twitch.tv/helix/eventsub/subscriptions",
            ).pipe(
              HttpClientRequest.bearerToken(token),
              HttpClientRequest.setHeader("Client-ID", configuration.twitch.clientId),
            );

            const response = yield* executeProviderRequest(client, {
              provider: "twitch",
              operation: "listEventSubSubscriptions",
              mutation: false,
              notFound: "not-found",
              request: Option.match(cursor, {
                onNone: () => outgoing,
                onSome: (after) => outgoing.pipe(HttpClientRequest.setUrlParam("after", after)),
              }),
            }).pipe(
              Effect.tapError((error) =>
                error.reason === "unauthorized" ? invalidateTwitchAppAccessToken() : Effect.void,
              ),
              Effect.flatMap(subscriptionsDecode),
            );

            const nextCursor = Option.flatMap(
              response.pagination,
              (pagination) => pagination.cursor,
            );

            if (page === 100 && Option.isSome(nextCursor))
              return yield* Effect.fail(
                new ProviderError({
                  provider: "twitch",
                  operation: "listEventSubSubscriptions",
                  reason: "invalid-response",
                  status: Option.some(200),
                  retryAfterMs: Option.none(),
                }),
              );

            return [
              response.data,
              Option.map(nextCursor, (after) => ({ cursor: Option.some(after), page: page + 1 })),
            ];
          }),
      );

      return yield* Stream.runCollect(pages);
    },
  );

  const deleteEventSubSubscription = Effect.fn("TwitchService.deleteEventSubSubscription")(
    (subscriptionId: string) =>
      request(
        "deleteEventSubSubscription",
        HttpClientRequest.delete("https://api.twitch.tv/helix/eventsub/subscriptions").pipe(
          HttpClientRequest.setUrlParam("id", subscriptionId),
        ),
        "app",
        true,
      ).pipe(
        Effect.flatMap((response) =>
          confirmProviderMutationStatus(response, {
            provider: "twitch",
            operation: "deleteEventSubSubscription",
            statuses: [204],
          }),
        ),
      ),
  );

  return TwitchService.of({
    getStreamInfo,
    sendChatMessage,
    createShoutout,
    updateRedemptionStatus,
    createEventSubSubscription,
    listEventSubSubscriptions,
    deleteEventSubSubscription,
  });
});

/** Layer that provides the Twitch service with HTTP transport, configuration, access-token and token-exchange requirements visible. */
export const twitchServiceLayerWithoutDependencies = Layer.effect(TwitchService, makeTwitchService);

/** Production Twitch service Layer that selects durable user tokens and provider app-token exchange. */
export const twitchServiceLayer = twitchServiceLayerWithoutDependencies.pipe(
  Layer.provide([providerAccessTokensLayer, providerTokenExchangeLayer]),
);

/**
 * Layer that provides the Twitch service over in-memory user tokens and app-token exchange.
 *
 * **Details**
 *
 * Uses the synthetic test configuration. Leaves `HttpClient.HttpClient` required so tests supply a
 * controlled Helix transport that cannot reach the network.
 */
export const twitchServiceTestLayer = twitchServiceLayerWithoutDependencies.pipe(
  Layer.provide([
    providerAccessTokensTestLayer,
    providerTokenExchangeTestLayer,
    twitchConfigurationTestLayer,
  ]),
);
