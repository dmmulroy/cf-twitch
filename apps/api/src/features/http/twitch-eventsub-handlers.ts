import { Effect, Option, Result, Schema } from "effect";
import { Digest } from "effect/crypto";
import { HttpApiBuilder } from "effect/http-api";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import type { BroadcasterId } from "@cf-twitch/contracts/identity";
import {
  TwitchHttpApi,
  TwitchSubscriptionResponse,
  type TwitchHttpOperation,
} from "@cf-twitch/contracts/twitch-api";
import { ProviderEventSubSubscription, type ProviderError } from "@cf-twitch/contracts/provider";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { TwitchService } from "../providers/twitch-service.ts";
import { EventSubReceipts } from "../eventsub/eventsub-receipts.ts";
import { handleEventSubWebhook } from "./eventsub-webhook-handlers.ts";
import {
  HttpBoundaryError,
  encodeHttpResponse,
  handleHttpBoundary,
  invalidHttpServiceResponse,
  requireHttpAdministrator,
} from "./http-boundary.ts";
import { twitchProviderHttpFailure } from "./http-service-failures.ts";

/**
 * Returns the historical per-subscription error code for a failed subscription creation.
 *
 * @returns `TwitchParseError` for an invalid Twitch response, otherwise `TwitchSubscriptionCreateError`.
 */
const subscriptionCreateErrorCode = (error: ProviderError) =>
  error.reason === "invalid-response"
    ? ("TwitchParseError" as const)
    : ("TwitchSubscriptionCreateError" as const);

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

/**
 * Returns whether a subscription creation failure is transient, so repeating setup may succeed.
 *
 * **Details**
 *
 * An unknown outcome counts as transient because setup skips subscriptions that already exist.
 */
const isTransientSubscriptionFailure = (kind: ProviderError["reason"]): boolean => {
  switch (kind) {
    case "network":
    case "rate-limited":
    case "outcome-unknown":
    case "unauthorized":
    case "persistence":
      return true;
    case "invalid-response":
    case "rejected":
    case "invalid-input":
    case "not-found":
    case "no-active-device":
    case "chat-dropped":
    case "not-configured":
    case "offline":
    case "reauthorization-required":
    case "stored-state-invalid":
    case "randomness":
      return false;
  }
};

/**
 * Layer that serves the EventSub webhook and authenticated subscription management.
 *
 * **Details**
 *
 * Webhook intake authenticates exact signed bytes before parsing. Management endpoints require the
 * administrator bearer token; setup skips matching enabled or pending subscriptions, so repeating
 * setup after a partial failure is safe.
 */
export const twitchEventSubHandlersLayer = HttpApiBuilder.group(
  TwitchHttpApi,
  "eventsub",
  (handlers) =>
    Effect.gen(function* () {
      const configuration = yield* TwitchConfiguration;
      const digestService = yield* Digest.Digest;
      const twitch = yield* TwitchService;
      const receipts = yield* EventSubReceipts;

      const admin = <R>(
        operation: TwitchHttpOperation,
        effect: Effect.Effect<HttpServerResponse.HttpServerResponse, HttpBoundaryError, R>,
      ) =>
        requireHttpAdministrator(configuration.administratorSecret, "EventSub management").pipe(
          Effect.andThen(effect),
          handleHttpBoundary(operation),
        );

      const listSubscriptions = twitch
        .listEventSubSubscriptions()
        .pipe(
          Effect.catchTag("ProviderError", (error) =>
            Effect.fail(twitchProviderHttpFailure(error, "listSubscriptions", Option.none())),
          ),
        );

      return handlers
        .handleRaw("webhook", () =>
          handleEventSubWebhook().pipe(
            Effect.provideService(TwitchConfiguration, configuration),
            Effect.provideService(EventSubReceipts, receipts),
            Effect.provideService(Digest.Digest, digestService),
          ),
        )
        .handleRaw("listSubscriptions", () =>
          admin(
            "listSubscriptions",
            Effect.gen(function* () {
              const subscriptions = yield* listSubscriptions;

              return yield* encodeHttpResponse("twitch", subscriptionList, {
                subscriptions,
                total: subscriptions.length,
              });
            }),
          ),
        )
        .handleRaw("deleteSubscription", ({ params }) =>
          admin(
            "deleteSubscription",
            twitch.deleteEventSubSubscription(params.id).pipe(
              Effect.catchTag("ProviderError", (error) =>
                Effect.fail(
                  twitchProviderHttpFailure(error, "deleteSubscription", Option.some(params.id)),
                ),
              ),
              Effect.as(
                HttpServerResponse.jsonUnsafe({
                  success: true,
                  message: "Subscription deleted successfully",
                }),
              ),
            ),
          ),
        )
        .handleRaw("setupSubscriptions", () =>
          admin(
            "setupSubscriptions",
            Effect.gen(function* () {
              const request = yield* HttpServerRequest.HttpServerRequest;
              const callbackUrl = `${new URL(request.originalUrl).origin}/webhooks/twitch`;
              const existing = yield* listSubscriptions;

              const configurations = subscriptionConfigurations(
                configuration.twitch.broadcaster.id,
              );

              const created: ProviderEventSubSubscription[] = [];
              const skipped: typeof configurations = [];

              const errors: {
                type: string;
                error: string;
                code: ReturnType<typeof subscriptionCreateErrorCode>;
              }[] = [];

              const failureKinds: ProviderError["reason"][] = [];

              for (const config of configurations) {
                if (
                  existing.some(
                    (subscription) =>
                      subscription.type === config.type &&
                      subscription.version === config.version &&
                      (subscription.status === "enabled" ||
                        subscription.status === "webhook_callback_verification_pending") &&
                      Option.contains(subscription.transport.callback, callbackUrl) &&
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

                if (Result.isSuccess(result)) created.push(result.success);
                else {
                  failureKinds.push(result.failure.reason);
                  errors.push({
                    type: config.type,
                    error: `Twitch subscription creation failed (${result.failure.reason}) for ${config.type}.`,
                    code: subscriptionCreateErrorCode(result.failure),
                  });
                }
              }

              if (errors.length > 0) {
                const transient = failureKinds.every(isTransientSubscriptionFailure);

                return yield* Effect.fail(
                  new HttpBoundaryError({
                    operation: "callService",
                    status: transient ? 503 : 500,
                    failure: {
                      code: "SubscriptionSetupIncomplete",
                      message: transient
                        ? `Subscription setup incomplete: ${errors.length} of ${configurations.length} EventSub subscriptions could not be created because Twitch was temporarily unavailable; ${created.length} were created and ${skipped.length} already existed. Run setup again in a few seconds; it skips subscriptions that already exist.`
                        : `Subscription setup incomplete: Twitch rejected ${errors.length} of ${configurations.length} EventSub subscriptions; ${created.length} were created and ${skipped.length} already existed. Check the errors in details and the Twitch app configuration before running setup again.`,
                      details: { created, skipped, errors },
                      retryable: transient,
                    },
                  }),
                );
              }

              const subscriptions = yield* Schema.encodeEffect(
                Schema.Array(TwitchSubscriptionResponse),
              )(created).pipe(
                Effect.mapError(() => invalidHttpServiceResponse("encodeResponse", "twitch")),
              );

              return HttpServerResponse.jsonUnsafe({
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
            "cleanupSubscriptions",
            Effect.gen(function* () {
              const subscriptions = yield* listSubscriptions;

              let deleted = 0;
              let failed = 0;

              for (const subscription of subscriptions) {
                const result = yield* twitch
                  .deleteEventSubSubscription(subscription.id)
                  .pipe(Effect.result);

                if (Result.isSuccess(result)) deleted++;
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
