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
 * `summary` is the historical short `error` text of the endpoint. A `change` names, in `reconcile`, the
 * read that shows whether the change was applied, phrased as a complete sentence.
 */
export type HttpServiceAccess =
  | { readonly kind: "repeatable"; readonly summary: string }
  | { readonly kind: "change"; readonly summary: string; readonly reconcile: string };

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
          error: "Service temporarily unavailable",
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
          error: access.summary,
          message: `Outcome unknown: ${serviceLabels[service]} became unavailable before confirming the change. ${access.reconcile}`,
          details: { service },
          retryable: false,
        },
      });

/** Builds the failure for a service whose internal response violated its contract. */
export const invalidHttpServiceResult = (
  service: TwitchHttpService,
  access: HttpServiceAccess,
): HttpBoundaryError =>
  new HttpBoundaryError({
    operation: "callService",
    status: 500,
    failure: {
      code: "InvalidServiceResponse",
      error: access.summary,
      message: `Invalid service response: ${serviceLabels[service]} returned a response outside its internal contract. Contact support with the request ID in this response.`,
      details: { service },
      retryable: false,
    },
  });

/** Builds the failure for durable service data that failed validation when read. */
export const invalidHttpStoredData = (
  service: TwitchHttpService,
  access: HttpServiceAccess,
): HttpBoundaryError =>
  new HttpBoundaryError({
    operation: "callService",
    status: 500,
    failure: {
      code: "StoredDataInvalid",
      error: access.summary,
      message: `Stored data invalid: ${serviceLabels[service]} found stored records that failed validation. Contact support with the request ID in this response.`,
      details: { service },
      retryable: false,
    },
  });

/** Builds the failure for a service that rejected a request the HTTP boundary had already validated. */
export const failedHttpService = (
  service: TwitchHttpService,
  access: HttpServiceAccess,
  reason: string,
): HttpBoundaryError =>
  new HttpBoundaryError({
    operation: "callService",
    status: 500,
    failure: {
      code: "ServiceFailed",
      error: access.summary,
      message: `Service failed: ${serviceLabels[service]} rejected an internal request (${reason}). Contact support with the request ID in this response.`,
      details: { service },
      retryable: false,
    },
  });

/** Translates a Song Queue failure by its classified reason. */
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
      return invalidHttpStoredData("songQueue", access);
    case "invalid_response":
      return invalidHttpServiceResult("songQueue", access);
    case "invalid_input":
      return failedHttpService("songQueue", access, error.reason);
  }
};

/** Translates a Keyboard Raffle failure by its classified reason. */
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
      return invalidHttpStoredData("keyboardRaffle", access);
    case "invalid_response":
      return invalidHttpServiceResult("keyboardRaffle", access);
    case "invalid_input":
    case "idempotency_conflict":
    case "compensated":
      return failedHttpService("keyboardRaffle", access, error.reason);
  }
};

/** Translates an Achievements failure by its classified reason. */
export const achievementHttpFailure = (
  error: AchievementError,
  access: HttpServiceAccess,
): HttpBoundaryError => {
  switch (error.reason) {
    case "persistence_unavailable":
    case "transport_unavailable":
      return unavailableHttpService("achievements", access);
    case "invalid_stored_data":
      return invalidHttpStoredData("achievements", access);
    case "invalid_response":
      return invalidHttpServiceResult("achievements", access);
    case "invalid_input":
      return failedHttpService("achievements", access, error.reason);
  }
};

/** Translates an Event Bus failure by its classified reason; a missing dead letter becomes a 404. */
export const eventBusHttpFailure = (
  error: EventBusError,
  access: HttpServiceAccess,
): HttpBoundaryError => {
  switch (error.reason) {
    case "persistence_unavailable":
    case "subscriber_unavailable":
      return unavailableHttpService("eventBus", access);
    case "stored_event_invalid":
      return invalidHttpStoredData("eventBus", access);
    case "invalid_response":
      return invalidHttpServiceResult("eventBus", access);
    case "event_not_found":
      return Option.match(error.eventId, {
        onNone: () => failedHttpService("eventBus", access, error.reason),
        onSome: (eventId) =>
          new HttpBoundaryError({
            operation: "callService",
            status: 404,
            failure: {
              code: "DeadLetterNotFound",
              error: `DLQ item not found: ${eventId}`,
              message: `Dead letter not found: the Event Bus has no dead letter with ID ${eventId}. Check the ID with GET /api/admin/dlq and try again.`,
              details: { eventId },
              retryable: false,
            },
          }),
      });
    case "subscription_not_found":
    case "subscription_conflict":
      return failedHttpService("eventBus", access, error.reason);
  }
};

/** Translates a Stream Lifecycle failure by its classified reason. */
export const streamLifecycleHttpFailure = (
  error: StreamLifecycleError,
  access: HttpServiceAccess,
): HttpBoundaryError => {
  switch (error.reason) {
    case "persistence_unavailable":
    case "provider_unavailable":
      return unavailableHttpService("streamLifecycle", access);
    case "stored_state_invalid":
      return invalidHttpStoredData("streamLifecycle", access);
    case "invalid_response":
      return invalidHttpServiceResult("streamLifecycle", access);
    case "effects_pending":
      return new HttpBoundaryError({
        operation: "callService",
        status: 409,
        failure: {
          code: "StreamEffectsPending",
          error: access.summary,
          message:
            "Stream effects pending: the previous stream transition is still applying its side effects. Retry the request after a few seconds.",
          details: {},
          retryable: true,
        },
      });
  }
};

/** Translates an OAuth state failure by its classified reason. */
export const oauthStateHttpFailure = (
  error: OAuthError,
  access: HttpServiceAccess,
): HttpBoundaryError => {
  switch (error.reason) {
    case "persistence":
    case "transport":
    case "randomness":
      return unavailableHttpService("oauthState", access);
    case "invalid_response":
      return invalidHttpServiceResult("oauthState", access);
    case "invalid-input":
      return failedHttpService("oauthState", access, error.reason);
  }
};

/**
 * Returns per-tag handlers that translate every Chat Commands registry failure.
 *
 * **Details**
 *
 * Name, alias and definition conflicts keep their historical public codes. Use with
 * `Effect.catchTags` so a new registry failure is a type error until its policy is chosen.
 */
export const commandsHttpFailureHandlers = (access: HttpServiceAccess) => ({
  CommandNotFoundError: (error: CommandNotFoundError) =>
    Effect.fail(
      new HttpBoundaryError({
        operation: "callService",
        status: 404,
        failure: {
          code: "CommandNotFoundError",
          error: error.message,
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
          error: error.message,
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
          error: error.message,
          message: `Command alias conflict: ${error.alias} is already used by ${error.owner}. Choose a different alias and try again.`,
          details: { alias: error.alias, owner: error.owner },
          retryable: false,
        },
      }),
    ),
  CommandInputParseError: (error: CommandInputParseError) =>
    Effect.fail(
      new HttpBoundaryError({
        operation: "callService",
        status: 400,
        failure: {
          code: "CommandInputParseError",
          error: error.message,
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
          error: error.message,
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
          error: error.message,
          message: `Command not updateable: ${error.commandName} has response type ${error.responseType}, which does not accept value updates. Change a dynamic command instead.`,
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
          error: error.message,
          message: `Command update permission denied for ${error.commandName}: it requires ${error.requiredPermission}. Update the command's write permission first.`,
          details: { commandName: error.commandName },
          retryable: false,
        },
      }),
    ),
  CommandsDbError: (_error: CommandsDbError) =>
    Effect.fail(unavailableHttpService("chatCommands", access)),
  CommandsInvalidResponseError: (_error: CommandsInvalidResponseError) =>
    Effect.fail(invalidHttpServiceResult("chatCommands", access)),
  CommandsStateParseError: (_error: CommandsStateParseError) =>
    Effect.fail(invalidHttpStoredData("chatCommands", access)),
});

/** Twitch request whose provider failure is being translated. */
export type TwitchHttpRequestKind = "listSubscriptions" | "deleteSubscription" | "getStreamInfo";

const twitchRequestRejected = (
  error: ProviderError,
  request: TwitchHttpRequestKind,
  access: HttpServiceAccess,
): HttpBoundaryError => {
  switch (request) {
    case "listSubscriptions":
      return new HttpBoundaryError({
        operation: "callService",
        status: 500,
        failure: {
          code: "TwitchSubscriptionRequestError",
          error: access.summary,
          message: `Twitch subscription request rejected (${error.kind}) while listing EventSub subscriptions. Contact support with the request ID in this response.`,
          details: { provider: "twitch", failure: error.kind },
          retryable: false,
        },
      });
    case "deleteSubscription":
      return new HttpBoundaryError({
        operation: "callService",
        status: 500,
        failure: {
          code: "TwitchSubscriptionDeleteError",
          error: access.summary,
          message: `Twitch subscription deletion rejected (${error.kind}). Check the subscription with GET /eventsub/list before retrying.`,
          details: { provider: "twitch", failure: error.kind },
          retryable: false,
        },
      });
    case "getStreamInfo":
      return failedHttpService("twitch", access, error.kind);
  }
};

/**
 * Translates a Twitch provider failure for EventSub management or stream reconciliation.
 *
 * **Details**
 *
 * Every translated request is safe to repeat: listing and stream lookup are reads, and deleting a
 * subscription twice reports `TwitchSubscriptionNotFound`.
 */
export const twitchProviderHttpFailure = (
  error: ProviderError,
  request: TwitchHttpRequestKind,
  subscriptionId: Option.Option<string>,
  access: HttpServiceAccess,
): HttpBoundaryError => {
  switch (error.kind) {
    case "invalid-response":
      return new HttpBoundaryError({
        operation: "callService",
        status: 500,
        failure: {
          code: "TwitchParseError",
          error: access.summary,
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
          error: access.summary,
          message: `Twitch request failed (${error.kind}): Twitch was unreachable, rate limited, or did not confirm the result. Retry the request in a few seconds.`,
          details: { provider: "twitch", failure: error.kind },
          retryable: true,
        },
      });
    case "unauthorized":
    case "persistence":
      return new HttpBoundaryError({
        operation: "callService",
        status: 503,
        failure: {
          code: "ServiceUnavailable",
          error: access.summary,
          message: `Service temporarily unavailable: Twitch credentials could not be used (${error.kind}). Retry the request in a few seconds.`,
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
          error: access.summary,
          message: `Service temporarily unavailable: Twitch credentials are not ready (${error.kind}). Complete Twitch authorization at /oauth/twitch/authorize, then retry.`,
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
              error: access.summary,
              message: `Twitch subscription not found: no EventSub subscription has ID ${subscriptionId.value}. Check the ID with GET /eventsub/list and try again.`,
              details: { subscriptionId: subscriptionId.value },
              retryable: false,
            },
          })
        : twitchRequestRejected(error, request, access);
    case "rejected":
    case "invalid-input":
    case "no-active-device":
    case "chat-dropped":
    case "randomness":
      return twitchRequestRejected(error, request, access);
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
 */
export const oauthExchangeHttpFailure = (
  error: ProviderError,
  provider: OAuthProvider,
): HttpBoundaryError => {
  const providerName = provider === "spotify" ? "Spotify" : "Twitch";
  const restart = `Start authorization again at /oauth/${provider}/authorize.`;

  switch (error.kind) {
    case "invalid-response":
      return new HttpBoundaryError({
        operation: "callService",
        status: 500,
        failure: {
          code: tokenResponseInvalidCode(provider),
          error: `Token response invalid from ${providerName}`,
          message: `Token response invalid: ${providerName} returned an authorization-code response outside its documented format. ${restart}`,
          details: { provider },
          retryable: false,
        },
      });
    case "persistence":
      return new HttpBoundaryError({
        operation: "callService",
        status: 503,
        failure: {
          code: "ProviderAccessTokenError",
          error: `Token storage failed for ${providerName}`,
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
          error: `Token exchange failed with ${providerName}`,
          message: `Token exchange failed (${error.kind}): ${providerName} was unreachable or did not confirm the exchange. ${restart}`,
          details: { provider, failure: error.kind },
          retryable: false,
        },
      });
    case "rejected":
    case "unauthorized":
    case "invalid-input":
    case "not-found":
      return new HttpBoundaryError({
        operation: "callService",
        status: 400,
        failure: {
          code: tokenExchangeFailedCode(provider),
          error: `Token exchange failed with ${providerName}`,
          message: `Token exchange rejected (${error.kind}): ${providerName} did not accept the authorization code. ${restart}`,
          details: { provider, failure: error.kind },
          retryable: false,
        },
      });
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
          error: `Token exchange failed with ${providerName}`,
          message: `Token exchange failed (${error.kind}): the ${providerName} exchange could not be completed by this server. Contact support with the request ID in this response.`,
          details: { provider, failure: error.kind },
          retryable: false,
        },
      });
  }
};
