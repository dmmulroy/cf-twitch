import { Effect, Option } from "effect";
import type { AchievementError } from "@cf-twitch/contracts/achievement";
import type {
  CommandAliasConflictError,
  CommandAlreadyExistsError,
  CommandInputParseError,
  CommandInvalidDefinitionError,
  CommandNotFoundError,
  CommandNotUpdateableError,
  CommandUpdatePermissionDeniedError,
  CommandsDbError,
  CommandsInvalidResponseError,
  CommandsStateParseError,
} from "@cf-twitch/contracts/chat-command";
import type { EventBusError } from "@cf-twitch/contracts/event-bus";
import type { EventSubReceiptError } from "@cf-twitch/contracts/eventsub";
import type { OAuthError } from "@cf-twitch/contracts/oauth";
import type { OAuthProvider, ProviderError } from "@cf-twitch/contracts/provider";
import type { RaffleError } from "@cf-twitch/contracts/raffle";
import type { SongQueueError } from "@cf-twitch/contracts/song-queue";
import type { StreamLifecycleError } from "@cf-twitch/contracts/stream";
import type { TwitchHttpService } from "@cf-twitch/contracts/twitch-api";
import { HttpBoundaryError } from "./http-boundary.ts";

/**
 * How an endpoint uses a service, which decides whether an unavailable service leaves an unknown outcome.
 *
 * **Details**
 *
 * `repeatable` covers reads and requests that are safe to send again, such as starting a new OAuth
 * attempt. A `change` names, in `reconcile`, the read that shows whether the change was applied,
 * phrased as a complete sentence.
 */
export type HttpServiceAccess =
  | { readonly kind: "repeatable" }
  | { readonly kind: "change"; readonly reconcile: string };

/** Display names of services as callers know them, used inside public messages. */
const serviceLabels: Record<TwitchHttpService, string> = {
  songQueue: "the Song Queue",
  keyboardRaffle: "the Keyboard Raffle",
  achievements: "Achievements",
  eventBus: "the Event Bus",
  chatCommands: "Chat Commands",
  streamLifecycle: "Stream Lifecycle",
  oauthState: "OAuth state storage",
  eventSubReceipts: "EventSub receipt storage",
  twitch: "Twitch",
  spotify: "Spotify",
};

/**
 * Builds the failure for a service that could not be reached.
 *
 * **Details**
 *
 * A repeatable request is safe to retry. A change may already have been applied, so it reports `OutcomeUnknown`
 * and directs the caller to the read that reconciles it.
 *
 * @returns `ServiceUnavailable` (503, retryable) for a repeatable request, or `OutcomeUnknown` (503, not retryable) for a change.
 */
export const unavailableHttpService = (
  service: TwitchHttpService,
  access: HttpServiceAccess,
): HttpBoundaryError =>
  access.kind === "repeatable"
    ? new HttpBoundaryError({
        operation: "callService",
        status: 503,
        failure: {
          code: "ServiceUnavailable",
          message: `Service temporarily unavailable: ${serviceLabels[service]} could not be reached. Retry the request in a few seconds.`,
          details: { service },
          retryable: true,
        },
      })
    : new HttpBoundaryError({
        operation: "callService",
        status: 503,
        failure: {
          code: "OutcomeUnknown",
          message: `Outcome unknown: ${serviceLabels[service]} became unavailable before confirming the change. ${access.reconcile}`,
          details: { service },
          retryable: false,
        },
      });

/**
 * Builds the failure for a service whose internal response violated its contract.
 *
 * @returns `InvalidServiceResponse` (500, not retryable).
 */
export const invalidHttpServiceResult = (service: TwitchHttpService): HttpBoundaryError =>
  new HttpBoundaryError({
    operation: "callService",
    status: 500,
    failure: {
      code: "InvalidServiceResponse",
      message: `Invalid service response: ${serviceLabels[service]} returned a response outside its internal contract. Contact support with the request ID in this response.`,
      details: { service },
      retryable: false,
    },
  });

/**
 * Builds the failure for durable service data that failed validation when read.
 *
 * @returns `StoredDataInvalid` (500, not retryable).
 */
export const invalidHttpStoredData = (service: TwitchHttpService): HttpBoundaryError =>
  new HttpBoundaryError({
    operation: "callService",
    status: 500,
    failure: {
      code: "StoredDataInvalid",
      message: `Stored data invalid: ${serviceLabels[service]} found stored records that failed validation. Contact support with the request ID in this response.`,
      details: { service },
      retryable: false,
    },
  });

/**
 * Builds the failure for a service that rejected a request the HTTP boundary had already validated.
 *
 * @returns `ServiceFailed` (500, not retryable), naming the service's classified reason.
 */
export const failedHttpService = (service: TwitchHttpService, reason: string): HttpBoundaryError =>
  new HttpBoundaryError({
    operation: "callService",
    status: 500,
    failure: {
      code: "ServiceFailed",
      message: `Service failed: ${serviceLabels[service]} rejected an internal request (${reason}). Contact support with the request ID in this response.`,
      details: { service },
      retryable: false,
    },
  });

/**
 * Translates a Song Queue failure by its classified reason.
 *
 * @returns `ServiceUnavailable` or `OutcomeUnknown` (503) for storage, coordination, transport or
 * provider outages; `StoredDataInvalid` or `InvalidServiceResponse` (500) for invalid data; and
 * `ServiceFailed` (500) for rejected internal input.
 */
export const songQueueHttpFailure = (
  error: SongQueueError,
  access: HttpServiceAccess,
): HttpBoundaryError => {
  switch (error.reason) {
    case "storage_unavailable":
    case "coordination_unavailable":
    case "transport_unavailable":
    case "provider_unavailable":
      return unavailableHttpService("songQueue", access);
    case "stored_data_invalid":
      return invalidHttpStoredData("songQueue");
    case "invalid_response":
      return invalidHttpServiceResult("songQueue");
    case "invalid_input":
      return failedHttpService("songQueue", error.reason);
  }
};

/**
 * Translates a Keyboard Raffle failure by its classified reason.
 *
 * @returns `ServiceUnavailable` or `OutcomeUnknown` (503) for persistence, transport or randomness
 * outages; `StoredDataInvalid` or `InvalidServiceResponse` (500) for invalid data; and
 * `ServiceFailed` (500) for rejected input, replay conflicts and compensated rolls.
 */
export const raffleHttpFailure = (
  error: RaffleError,
  access: HttpServiceAccess,
): HttpBoundaryError => {
  switch (error.reason) {
    case "persistence_unavailable":
    case "transport_unavailable":
    case "randomness_unavailable":
      return unavailableHttpService("keyboardRaffle", access);
    case "invalid_stored_data":
      return invalidHttpStoredData("keyboardRaffle");
    case "invalid_response":
      return invalidHttpServiceResult("keyboardRaffle");
    case "idempotency_conflict":
    case "compensated":
      return failedHttpService("keyboardRaffle", error.reason);
  }
};

/**
 * Translates an Achievements failure by its classified reason.
 *
 * @returns `ServiceUnavailable` or `OutcomeUnknown` (503) for persistence or transport outages;
 * `StoredDataInvalid` or `InvalidServiceResponse` (500) for invalid data; and `ServiceFailed`
 * (500) for rejected internal input.
 */
export const achievementHttpFailure = (
  error: AchievementError,
  access: HttpServiceAccess,
): HttpBoundaryError => {
  switch (error.reason) {
    case "persistence_unavailable":
    case "transport_unavailable":
      return unavailableHttpService("achievements", access);
    case "invalid_stored_data":
      return invalidHttpStoredData("achievements");
    case "invalid_response":
      return invalidHttpServiceResult("achievements");
    case "invalid_input":
      return failedHttpService("achievements", error.reason);
  }
};

/**
 * Translates an Event Bus failure by its classified reason.
 *
 * @returns `DeadLetterNotFound` (404) for a missing dead letter with a known ID;
 * `ServiceUnavailable` or `OutcomeUnknown` (503) for persistence or subscriber outages;
 * `StoredDataInvalid` or `InvalidServiceResponse` (500) for invalid data; and `ServiceFailed` (500)
 * otherwise.
 */
export const eventBusHttpFailure = (
  error: EventBusError,
  access: HttpServiceAccess,
): HttpBoundaryError => {
  switch (error.reason) {
    case "persistence_unavailable":
    case "transport_unavailable":
    case "alarm_unavailable":
    case "subscriber_unavailable":
      return unavailableHttpService("eventBus", access);
    case "stored_row_invalid":
    case "stored_event_invalid":
      return invalidHttpStoredData("eventBus");
    case "invalid_response":
      return invalidHttpServiceResult("eventBus");
    case "event_not_found":
      return Option.match(error.eventId, {
        onNone: () => failedHttpService("eventBus", error.reason),
        onSome: (eventId) =>
          new HttpBoundaryError({
            operation: "callService",
            status: 404,
            failure: {
              code: "DeadLetterNotFound",
              message: `Dead letter not found: the Event Bus has no dead letter with ID ${eventId}. Check the ID with GET /api/admin/dlq and try again.`,
              details: { eventId },
              retryable: false,
            },
          }),
      });
    case "event_invalid":
    case "subscriber_rejected":
    case "subscription_not_found":
      return failedHttpService("eventBus", error.reason);
  }
};

/**
 * Translates a Stream Lifecycle failure by its classified reason.
 *
 * @returns `StreamEffectsPending` (409, retryable) while a previous transition's effects run;
 * `ServiceUnavailable` or `OutcomeUnknown` (503) for persistence or provider outages; and
 * `StoredDataInvalid` or `InvalidServiceResponse` (500) for invalid data.
 */
export const streamLifecycleHttpFailure = (
  error: StreamLifecycleError,
  access: HttpServiceAccess,
): HttpBoundaryError => {
  switch (error.reason) {
    case "persistence_unavailable":
    case "provider_unavailable":
    case "transport_unavailable":
      return unavailableHttpService("streamLifecycle", access);
    case "stored_state_invalid":
      return invalidHttpStoredData("streamLifecycle");
    case "invalid_response":
      return invalidHttpServiceResult("streamLifecycle");
    case "effects_pending":
      return new HttpBoundaryError({
        operation: "callService",
        status: 409,
        failure: {
          code: "StreamEffectsPending",
          message:
            "Stream effects pending: the previous stream transition is still applying its side effects. Retry the request after a few seconds.",
          details: {},
          retryable: true,
        },
      });
  }
};

/**
 * Translates an OAuth state failure by its classified reason.
 *
 * @returns `ServiceUnavailable` or `OutcomeUnknown` (503) for persistence, transport or randomness
 * outages; `InvalidServiceResponse` (500) for an invalid state-store response; and `ServiceFailed`
 * (500) for rejected internal input.
 */
export const oauthStateHttpFailure = (
  error: OAuthError,
  access: HttpServiceAccess,
): HttpBoundaryError => {
  switch (error.reason) {
    case "persistence":
    case "transport":
    case "randomness":
      return unavailableHttpService("oauthState", access);
    case "invalid-response":
      return invalidHttpServiceResult("oauthState");
    case "attempt-window-invalid":
    case "attempt-already-exists":
      return failedHttpService("oauthState", error.reason);
  }
};

/**
 * Returns per-tag handlers that translate every Chat Commands registry failure.
 *
 * **Details**
 *
 * Name, alias and definition conflicts keep their historical public codes. Use with
 * `Effect.catchTags` so a new registry failure is a type error until its policy is chosen.
 *
 * @returns Handlers that each fail with `HttpBoundaryError`: 404 for a missing command, 409 for name,
 * alias, update-type or write-permission conflicts, 400 for rejected input or definitions, 503 for
 * unavailable storage, and 500 for invalid responses or stored state.
 */
export const commandsHttpFailureHandlers = (access: HttpServiceAccess) => ({
  CommandNotFoundError: (error: CommandNotFoundError) =>
    Effect.fail(
      new HttpBoundaryError({
        operation: "callService",
        status: 404,
        failure: {
          code: "CommandNotFoundError",
          message: `Command not found: no chat command is named ${error.commandName}. Check the name with GET /api/admin/commands and try again.`,
          details: { commandName: error.commandName },
          retryable: false,
        },
      }),
    ),
  CommandAlreadyExistsError: (error: CommandAlreadyExistsError) =>
    Effect.fail(
      new HttpBoundaryError({
        operation: "callService",
        status: 409,
        failure: {
          code: "CommandAlreadyExistsError",
          message: `Command already exists: ${error.commandName} is already a command name or alias. Choose a different name and try again.`,
          details: { commandName: error.commandName },
          retryable: false,
        },
      }),
    ),
  CommandAliasConflictError: (error: CommandAliasConflictError) =>
    Effect.fail(
      new HttpBoundaryError({
        operation: "callService",
        status: 409,
        failure: {
          code: "CommandAliasConflictError",
          message: `Command alias conflict: ${error.alias} is already used by ${error.ownerCommandName}. Choose a different alias and try again.`,
          details: { alias: error.alias, owner: error.ownerCommandName },
          retryable: false,
        },
      }),
    ),
  CommandInputParseError: (_error: CommandInputParseError) =>
    Effect.fail(
      new HttpBoundaryError({
        operation: "callService",
        status: 400,
        failure: {
          code: "CommandInputParseError",
          message:
            "Command input rejected: the registry did not accept the command fields. Fix the request body and send it again.",
          details: {},
          retryable: false,
        },
      }),
    ),
  CommandInvalidDefinitionError: (error: CommandInvalidDefinitionError) =>
    Effect.fail(
      new HttpBoundaryError({
        operation: "callService",
        status: 400,
        failure: {
          code: "CommandInvalidDefinitionError",
          message: `Command definition invalid for ${error.commandName}: ${error.reason}. Fix the command definition and send it again.`,
          details: { commandName: error.commandName, rule: error.reason },
          retryable: false,
        },
      }),
    ),
  CommandNotUpdateableError: (error: CommandNotUpdateableError) =>
    Effect.fail(
      new HttpBoundaryError({
        operation: "callService",
        status: 409,
        failure: {
          code: "CommandNotUpdateableError",
          message: `Command not updateable: ${error.commandName} has a ${error.reason === "static_response" ? "static" : "computed"} response, which does not accept value updates. Change a dynamic command instead.`,
          details: { commandName: error.commandName },
          retryable: false,
        },
      }),
    ),
  CommandUpdatePermissionDeniedError: (error: CommandUpdatePermissionDeniedError) =>
    Effect.fail(
      new HttpBoundaryError({
        operation: "callService",
        status: 409,
        failure: {
          code: "CommandUpdatePermissionDeniedError",
          message: `Command update permission denied for ${error.commandName}: it requires ${error.requiredPermission}. Update the command's write permission first.`,
          details: { commandName: error.commandName },
          retryable: false,
        },
      }),
    ),
  CommandsDbError: (_error: CommandsDbError) =>
    Effect.fail(unavailableHttpService("chatCommands", access)),
  CommandsInvalidResponseError: (_error: CommandsInvalidResponseError) =>
    Effect.fail(invalidHttpServiceResult("chatCommands")),
  CommandsStateParseError: (_error: CommandsStateParseError) =>
    Effect.fail(invalidHttpStoredData("chatCommands")),
});

/**
 * Translates an EventSub receipt store failure by its classified reason.
 *
 * **Details**
 *
 * Acceptance is idempotent by message ID, so an unavailable store is safe to redeliver.
 *
 * @returns `EventSubAcceptanceFailed` (503, retryable) for storage, scheduling, dispatch or
 * transport outages; `StoredDataInvalid` or `InvalidServiceResponse` (500) for corrupt or invalid
 * receipt data; and `ServiceFailed` (500) for rejected receipt input.
 */
export const eventSubReceiptHttpFailure = (
  error: EventSubReceiptError,
  messageId: string,
): HttpBoundaryError => {
  switch (error.reason) {
    case "storage":
    case "schedule":
    case "dispatch":
    case "transport":
      return eventSubAcceptanceFailed(messageId);
    case "corrupt":
    case "legacy_state":
      return invalidHttpStoredData("eventSubReceipts");
    case "invalid_response":
      return invalidHttpServiceResult("eventSubReceipts");
    case "invalid":
      return failedHttpService("eventSubReceipts", error.reason);
  }
};

/**
 * Builds the failure for an EventSub notification whose receipt could not be stored durably.
 *
 * @returns `EventSubAcceptanceFailed` (503, retryable): redelivering the same message is idempotent.
 */
export const eventSubAcceptanceFailed = (messageId: string): HttpBoundaryError =>
  new HttpBoundaryError({
    operation: "acceptWebhook",
    status: 503,
    failure: {
      code: "EventSubAcceptanceFailed",
      message: `EventSub acceptance failed for message ${messageId}: the receipt could not be stored durably. Redeliver the same message; acceptance is idempotent by message ID.`,
      details: { messageId },
      retryable: true,
    },
  });

/** Twitch request whose provider failure is being translated, which selects request-specific codes. */
export type TwitchHttpRequestKind = "listSubscriptions" | "deleteSubscription" | "getStreamInfo";

const twitchRequestRejected = (
  error: ProviderError,
  request: TwitchHttpRequestKind,
): HttpBoundaryError => {
  switch (request) {
    case "listSubscriptions":
      return new HttpBoundaryError({
        operation: "callService",
        status: 500,
        failure: {
          code: "TwitchSubscriptionRequestError",
          message: `Twitch subscription request rejected (${error.reason}) while listing EventSub subscriptions. Contact support with the request ID in this response.`,
          details: { provider: "twitch", failure: error.reason },
          retryable: false,
        },
      });
    case "deleteSubscription":
      return new HttpBoundaryError({
        operation: "callService",
        status: 500,
        failure: {
          code: "TwitchSubscriptionDeleteError",
          message: `Twitch subscription deletion rejected (${error.reason}). Check the subscription with GET /eventsub/list before retrying.`,
          details: { provider: "twitch", failure: error.reason },
          retryable: false,
        },
      });
    case "getStreamInfo":
      return failedHttpService("twitch", error.reason);
  }
};

/**
 * Translates a Twitch provider failure for EventSub management or stream reconciliation.
 *
 * **Details**
 *
 * Every translated request is safe to repeat: listing and stream lookup are reads, and deleting a
 * subscription twice reports `TwitchSubscriptionNotFound`.
 *
 * @returns `TwitchParseError` (500) for an invalid Twitch response; `TwitchNetworkError` (503,
 * retryable) when Twitch is unreachable, rate limited or unconfirmed; `ServiceUnavailable` (503)
 * when Twitch credentials are unusable; `TwitchSubscriptionNotFound` (404) when a deleted ID is
 * unknown; and a request-specific 500 failure when Twitch rejects the request.
 */
export const twitchProviderHttpFailure = (
  error: ProviderError,
  request: TwitchHttpRequestKind,
  subscriptionId: Option.Option<string>,
): HttpBoundaryError => {
  switch (error.reason) {
    case "invalid-response":
      return new HttpBoundaryError({
        operation: "callService",
        status: 500,
        failure: {
          code: "TwitchParseError",
          message:
            "Twitch response invalid: Twitch returned data outside its documented format. Contact support with the request ID in this response.",
          details: { provider: "twitch" },
          retryable: false,
        },
      });
    case "network":
    case "rate-limited":
    case "outcome-unknown":
      return new HttpBoundaryError({
        operation: "callService",
        status: 503,
        failure: {
          code: "TwitchNetworkError",
          message: `Twitch request failed (${error.reason}): Twitch was unreachable, rate limited, or did not confirm the result. Retry the request in a few seconds.`,
          details: { provider: "twitch", failure: error.reason },
          retryable: true,
        },
      });
    case "unauthorized":
    case "persistence":
    case "stored-state-invalid":
      return new HttpBoundaryError({
        operation: "callService",
        status: 503,
        failure: {
          code: "ServiceUnavailable",
          message: `Service temporarily unavailable: Twitch credentials could not be used (${error.reason}). Retry the request in a few seconds.`,
          details: { service: "twitch" },
          retryable: true,
        },
      });
    case "reauthorization-required":
    case "not-configured":
    case "offline":
      return new HttpBoundaryError({
        operation: "callService",
        status: 503,
        failure: {
          code: "ServiceUnavailable",
          message: `Service temporarily unavailable: Twitch credentials are not ready (${error.reason}). Complete Twitch authorization at /oauth/twitch/authorize, then retry.`,
          details: { service: "twitch" },
          retryable: false,
        },
      });
    case "not-found":
      return request === "deleteSubscription" && Option.isSome(subscriptionId)
        ? new HttpBoundaryError({
            operation: "callService",
            status: 404,
            failure: {
              code: "TwitchSubscriptionNotFound",
              message: `Twitch subscription not found: no EventSub subscription has ID ${subscriptionId.value}. Check the ID with GET /eventsub/list and try again.`,
              details: { subscriptionId: subscriptionId.value },
              retryable: false,
            },
          })
        : twitchRequestRejected(error, request);
    case "rejected":
    case "invalid-input":
    case "no-active-device":
    case "chat-dropped":
    case "randomness":
      return twitchRequestRejected(error, request);
  }
};

/** Returns the historical public code for an invalid token response from `provider`. */
const tokenResponseInvalidCode = (provider: OAuthProvider) =>
  provider === "spotify" ? ("SpotifyParseError" as const) : ("TwitchParseError" as const);

/** Returns the historical public code for a failed token exchange with `provider`. */
const tokenExchangeFailedCode = (provider: OAuthProvider) =>
  provider === "spotify"
    ? ("SpotifyTokenExchangeError" as const)
    : ("TwitchTokenExchangeError" as const);

/**
 * Translates a provider failure during OAuth authorization-code exchange.
 *
 * **Details**
 *
 * Authorization codes are one-use, so no exchange failure is retryable; each message directs the
 * caller to start authorization again. Codes keep their historical provider-specific names.
 *
 * @returns The provider's parse error (500) for an invalid token response,
 * `ProviderAccessTokenError` (503) when tokens could not be stored, and the provider's token
 * exchange error: 503 when the provider was unreachable, 400 when it rejected the authorization
 * code, and 500 when this server could not complete the exchange, including rejected client
 * credentials.
 */
export const oauthExchangeHttpFailure = (
  error: ProviderError,
  provider: OAuthProvider,
): HttpBoundaryError => {
  const providerName = provider === "spotify" ? "Spotify" : "Twitch";
  const restart = `Start authorization again at /oauth/${provider}/authorize.`;

  switch (error.reason) {
    case "invalid-response":
      return new HttpBoundaryError({
        operation: "callService",
        status: 500,
        failure: {
          code: tokenResponseInvalidCode(provider),
          message: `Token response invalid: ${providerName} returned an authorization-code response outside its documented format. ${restart}`,
          details: { provider },
          retryable: false,
        },
      });
    case "persistence":
    case "stored-state-invalid":
      return new HttpBoundaryError({
        operation: "callService",
        status: 503,
        failure: {
          code: "ProviderAccessTokenError",
          message: `Token storage unavailable: ${providerName} issued tokens, but they could not be stored durably. ${restart}`,
          details: { provider },
          retryable: false,
        },
      });
    case "network":
    case "rate-limited":
    case "outcome-unknown":
    case "offline":
      return new HttpBoundaryError({
        operation: "callService",
        status: 503,
        failure: {
          code: tokenExchangeFailedCode(provider),
          message: `Token exchange failed (${error.reason}): ${providerName} was unreachable or did not confirm the exchange. ${restart}`,
          details: { provider, failure: error.reason },
          retryable: false,
        },
      });
    case "rejected":
    case "invalid-input":
      return new HttpBoundaryError({
        operation: "callService",
        status: 400,
        failure: {
          code: tokenExchangeFailedCode(provider),
          message: `Token exchange rejected (${error.reason}): ${providerName} did not accept the authorization code. ${restart}`,
          details: { provider, failure: error.reason },
          retryable: false,
        },
      });
    case "unauthorized":
    case "not-found":
    case "not-configured":
    case "reauthorization-required":
    case "no-active-device":
    case "chat-dropped":
    case "randomness":
      return new HttpBoundaryError({
        operation: "callService",
        status: 500,
        failure: {
          code: tokenExchangeFailedCode(provider),
          message: `Token exchange failed (${error.reason}): the ${providerName} exchange could not be completed by this server. Contact support with the request ID in this response.`,
          details: { provider, failure: error.reason },
          retryable: false,
        },
      });
  }
};
