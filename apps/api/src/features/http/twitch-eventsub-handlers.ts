import { Crypto, Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { BroadcasterId } from "@cf-twitch/contracts/identity";
import { TwitchHttpApi, TwitchSubscriptionResponse } from "@cf-twitch/contracts/twitch-api";
import { ProviderEventSubSubscription, type ProviderError } from "@cf-twitch/contracts/provider";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { TwitchService } from "../providers/twitch-service.ts";
import { EventSubReceipts } from "../eventsub/eventsub-receipts.ts";
import { handleEventSubWebhook } from "./eventsub-webhook-handlers.ts";
import {
  HttpBoundaryError,
  encodeHttpResponse,
  handleHttpBoundary,
  requireHttpAdministrator,
} from "./http-boundary.ts";

const providerCode = (error: ProviderError) => {
  if (error.kind === "invalid-response") return "TwitchParseError";

  if (error.operation === "createEventSubSubscription") return "TwitchSubscriptionCreateError";

  if (
    error.operation === "deleteEventSubSubscription" &&
    error.kind !== "network" &&
    error.kind !== "outcome-unknown"
  )
    return "TwitchSubscriptionDeleteError";

  return "TwitchNetworkError";
};

const subscriptionList = Schema.Struct({
  subscriptions: Schema.Array(TwitchSubscriptionResponse),
  total: Schema.Int,
});

const subscriptionConfigurations = (broadcasterId: BroadcasterId) => [
  { type: "stream.online", version: "1", condition: { broadcaster_user_id: broadcasterId } },
  { type: "stream.offline", version: "1", condition: { broadcaster_user_id: broadcasterId } },
  {
    type: "channel.channel_points_custom_reward_redemption.add",
    version: "1",
    condition: { broadcaster_user_id: broadcasterId },
  },
  {
    type: "channel.chat.message",
    version: "1",
    condition: { broadcaster_user_id: broadcasterId, user_id: broadcasterId },
  },
  { type: "channel.raid", version: "1", condition: { to_broadcaster_user_id: broadcasterId } },
];

/** Webhook intake and authenticated subscription management preserve Twitch-facing URLs. */
export const twitchEventSubHandlersLayer = HttpApiBuilder.group(
  TwitchHttpApi,
  "eventsub",
  (handlers) =>
    Effect.gen(function* () {
      const configuration = yield* TwitchConfiguration;
      const crypto = yield* Crypto.Crypto;
      const twitch = yield* TwitchService;
      const receipts = yield* EventSubReceipts;

      const admin = <R>(
        effect: Effect.Effect<HttpServerResponse.HttpServerResponse, HttpBoundaryError, R>,
      ) =>
        requireHttpAdministrator(configuration.administratorSecret, "EventSub management").pipe(
          Effect.andThen(effect),
          handleHttpBoundary,
        );

      return handlers
        .handleRaw("webhook", () =>
          handleEventSubWebhook().pipe(
            Effect.provideService(TwitchConfiguration, configuration),
            Effect.provideService(EventSubReceipts, receipts),
            Effect.provideService(Crypto.Crypto, crypto),
          ),
        )
        .handleRaw("listSubscriptions", () =>
          admin(
            Effect.gen(function* () {
              const subscriptions = yield* twitch.listEventSubSubscriptions().pipe(
                Effect.mapError(
                  (error) =>
                    new HttpBoundaryError({
                      status: 500,
                      error: error.message,
                      code: providerCode(error),
                    }),
                ),
              );

              return yield* encodeHttpResponse(subscriptionList, {
                subscriptions,
                total: subscriptions.length,
              });
            }),
          ),
        )
        .handleRaw("deleteSubscription", ({ params }) =>
          admin(
            twitch.deleteEventSubSubscription(params.id).pipe(
              Effect.match({
                onSuccess: () =>
                  HttpServerResponse.jsonUnsafe({
                    success: true,
                    message: "Subscription deleted successfully",
                  }),
                onFailure: (error) =>
                  HttpServerResponse.jsonUnsafe(
                    { success: false, message: error.message, code: providerCode(error) },
                    { status: 500 },
                  ),
              }),
            ),
          ),
        )
        .handleRaw("setupSubscriptions", () =>
          admin(
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const callbackUrl = `${new URL(request.originalUrl).origin}/webhooks/twitch`;
              const existing = yield* twitch.listEventSubSubscriptions().pipe(Effect.result);

              if (existing._tag === "Failure")
                return HttpServerResponse.jsonUnsafe(
                  {
                    success: false,
                    message: existing.failure.message,
                    code: providerCode(existing.failure),
                  },
                  { status: 500 },
                );

              const configurations = subscriptionConfigurations(
                configuration.twitch.broadcaster.id,
              );

              const created: ProviderEventSubSubscription[] = [];
              const skipped: typeof configurations = [];
              const errors: { type: string; error: string; code: string }[] = [];

              for (const config of configurations) {
                if (
                  existing.success.some(
                    (subscription) =>
                      subscription.type === config.type &&
                      subscription.version === config.version &&
                      (subscription.status === "enabled" ||
                        subscription.status === "webhook_callback_verification_pending") &&
                      Option.getOrNull(subscription.transport.callback) === callbackUrl &&
                      Object.entries(config.condition).every(
                        ([key, value]) => subscription.condition[key] === value,
                      ),
                  )
                ) {
                  skipped.push(config);
                  continue;
                }

                const result = yield* twitch
                  .createEventSubSubscription({
                    ...config,
                    callbackUrl,
                    secret: configuration.eventSubSecret,
                  })
                  .pipe(Effect.result);

                if (result._tag === "Success") created.push(result.success);
                else
                  errors.push({
                    type: config.type,
                    error: result.failure.message,
                    code: providerCode(result.failure),
                  });
              }

              const subscriptions = yield* Schema.encodeEffect(
                Schema.Array(TwitchSubscriptionResponse),
              )(created).pipe(
                Effect.mapError(
                  () => new HttpBoundaryError({ status: 502, error: "Invalid service response" }),
                ),
              );

              return errors.length > 0
                ? HttpServerResponse.jsonUnsafe(
                    {
                      success: false,
                      message: "Some subscriptions failed to create",
                      created: subscriptions,
                      skipped,
                      errors,
                    },
                    { status: 500 },
                  )
                : HttpServerResponse.jsonUnsafe({
                    success: true,
                    message: "All EventSub subscriptions are configured",
                    subscriptions,
                    skipped,
                  });
            }),
          ),
        )
        .handleRaw("cleanupSubscriptions", () =>
          admin(
            Effect.gen(function* () {
              const subscriptions = yield* twitch.listEventSubSubscriptions().pipe(
                Effect.mapError(
                  (error) =>
                    new HttpBoundaryError({
                      status: 500,
                      error: error.message,
                      code: providerCode(error),
                    }),
                ),
              );

              let deleted = 0;
              let failed = 0;

              for (const subscription of subscriptions) {
                const result = yield* twitch
                  .deleteEventSubSubscription(subscription.id)
                  .pipe(Effect.result);

                if (result._tag === "Success") deleted++;
                else failed++;
              }

              return HttpServerResponse.jsonUnsafe({
                success: failed === 0,
                message: `Deleted ${deleted} subscriptions, ${failed} failed`,
                deleted,
                failed,
              });
            }),
          ),
        );
    }),
);
