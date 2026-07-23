/**
 * Granular error types for cf-twitch-api
 *
 * All errors extend TaggedError from better-result for discriminated union support.
 * Errors are specific and context-rich to enable precise error handling.
 */

import { TaggedError } from "better-result";

// =============================================================================
// Token Errors (used by TokenDOs)
// =============================================================================

export class NoRefreshTokenError extends TaggedError("NoRefreshTokenError")<{
	message: string;
}>() {
	constructor() {
		super({ message: "No refresh token available" });
	}
}

export class StreamOfflineNoTokenError extends TaggedError("StreamOfflineNoTokenError")<{
	message: string;
}>() {
	constructor() {
		super({ message: "No token available and stream is offline" });
	}
}

export class TokenRefreshNetworkError extends TaggedError("TokenRefreshNetworkError")<{
	status: number;
	provider: "spotify" | "twitch";
	message: string;
}>() {
	constructor(args: { status: number; provider: "spotify" | "twitch"; message?: string }) {
		super({
			status: args.status,
			provider: args.provider,
			message: args.message ?? `${args.provider} token refresh failed with status ${args.status}`,
		});
	}
}

export class TokenRefreshParseError extends TaggedError("TokenRefreshParseError")<{
	provider: "spotify" | "twitch";
	parseError: string;
	message: string;
}>() {
	constructor(args: { provider: "spotify" | "twitch"; parseError: string }) {
		super({
			...args,
			message: `Invalid ${args.provider} token response format: ${args.parseError}`,
		});
	}
}

/** Expected failure when a provider revokes authorization and interactive OAuth is required. */
export class TokenAuthorizationRevokedError extends TaggedError("TokenAuthorizationRevokedError")<{
	provider: "spotify" | "twitch";
	message: string;
}>() {
	constructor(args: { provider: "spotify" | "twitch" }) {
		super({
			...args,
			message: `${args.provider} authorization was revoked; reauthorization is required`,
		});
	}
}

/** Union of all token-related errors */
export type TokenError =
	| NoRefreshTokenError
	| StreamOfflineNoTokenError
	| TokenAuthorizationRevokedError
	| TokenRefreshNetworkError
	| TokenRefreshParseError;

// =============================================================================
// Spotify Errors
// =============================================================================

export class SpotifyRateLimitError extends TaggedError("SpotifyRateLimitError")<{
	retryAfterMs: number;
	message: string;
}>() {
	constructor(args: { retryAfterMs: number }) {
		super({
			...args,
			message: `Rate limited by Spotify API, retry after ${args.retryAfterMs}ms`,
		});
	}
}

export class SpotifyUnauthorizedError extends TaggedError("SpotifyUnauthorizedError")<{
	message: string;
}>() {
	constructor() {
		super({ message: "Spotify token unauthorized or expired" });
	}
}

export class SpotifyTrackNotFoundError extends TaggedError("SpotifyTrackNotFoundError")<{
	trackId: string;
	message: string;
}>() {
	constructor(args: { trackId: string }) {
		super({ ...args, message: `Spotify track not found: ${args.trackId}` });
	}
}

export class SpotifyNoActiveDeviceError extends TaggedError("SpotifyNoActiveDeviceError")<{
	message: string;
}>() {
	constructor() {
		super({ message: "No active Spotify device found" });
	}
}

export class SpotifyNetworkError extends TaggedError("SpotifyNetworkError")<{
	status: number;
	context: string;
	message: string;
}>() {
	constructor(args: { status: number; context: string }) {
		super({
			...args,
			message: `Spotify API error (${args.status}) during ${args.context}`,
		});
	}
}

export class SpotifyParseError extends TaggedError("SpotifyParseError")<{
	context: string;
	parseError: string;
	message: string;
}>() {
	constructor(args: { context: string; parseError: string }) {
		super({
			...args,
			message: `Failed to parse Spotify ${args.context} response: ${args.parseError}`,
		});
	}
}

export class SpotifyTokenExchangeError extends TaggedError("SpotifyTokenExchangeError")<{
	status: number;
	message: string;
}>() {
	constructor(args: { status: number; message?: string }) {
		super({
			status: args.status,
			message: args.message ?? `Spotify token exchange failed with status ${args.status}`,
		});
	}
}

/** Union of all Spotify API errors */
export type SpotifyApiError =
	| SpotifyRateLimitError
	| SpotifyUnauthorizedError
	| SpotifyTrackNotFoundError
	| SpotifyNoActiveDeviceError
	| SpotifyNetworkError
	| SpotifyParseError
	| SpotifyTokenExchangeError;

// =============================================================================
// Twitch Errors
// =============================================================================

export class TwitchRateLimitError extends TaggedError("TwitchRateLimitError")<{
	retryAfterMs: number;
	message: string;
}>() {
	constructor(args: { retryAfterMs: number }) {
		super({
			...args,
			message: `Rate limited by Twitch API, retry after ${args.retryAfterMs}ms`,
		});
	}
}

export class TwitchUnauthorizedError extends TaggedError("TwitchUnauthorizedError")<{
	message: string;
}>() {
	constructor() {
		super({ message: "Twitch token unauthorized or expired" });
	}
}

export class TwitchNetworkError extends TaggedError("TwitchNetworkError")<{
	status: number;
	context: string;
	message: string;
}>() {
	constructor(args: { status: number; context: string }) {
		super({
			...args,
			message: `Twitch API error (${args.status}) during ${args.context}`,
		});
	}
}

export class TwitchParseError extends TaggedError("TwitchParseError")<{
	context: string;
	parseError: string;
	message: string;
}>() {
	constructor(args: { context: string; parseError: string }) {
		super({
			...args,
			message: `Failed to parse Twitch ${args.context} response: ${args.parseError}`,
		});
	}
}

export class TwitchNoSubscriptionReturnedError extends TaggedError(
	"TwitchNoSubscriptionReturnedError",
)<{
	subscriptionType: string;
	message: string;
}>() {
	constructor(args: { subscriptionType: string }) {
		super({
			...args,
			message: `No subscription returned when creating EventSub subscription: ${args.subscriptionType}`,
		});
	}
}

export class TwitchSubscriptionCreateError extends TaggedError("TwitchSubscriptionCreateError")<{
	subscriptionType: string;
	status: number;
	errorBody: string;
	message: string;
}>() {
	constructor(args: { subscriptionType: string; status: number; errorBody: string }) {
		super({
			...args,
			message: `Failed to create EventSub subscription ${args.subscriptionType}: ${args.status} - ${args.errorBody}`,
		});
	}
}

export class TwitchSubscriptionDeleteError extends TaggedError("TwitchSubscriptionDeleteError")<{
	subscriptionId: string;
	status: number;
	message: string;
}>() {
	constructor(args: { subscriptionId: string; status: number }) {
		super({
			...args,
			message: `Failed to delete EventSub subscription ${args.subscriptionId}: ${args.status}`,
		});
	}
}

export class TwitchChatSendError extends TaggedError("TwitchChatSendError")<{
	status: number;
	message: string;
}>() {
	constructor(args: { status: number; message?: string }) {
		super({
			status: args.status,
			message: args.message ?? `Failed to send Twitch chat message: ${args.status}`,
		});
	}
}

export class TwitchShoutoutCreateError extends TaggedError("TwitchShoutoutCreateError")<{
	status: number;
	toBroadcasterId: string;
	errorBody: string;
	message: string;
}>() {
	constructor(args: { status: number; toBroadcasterId: string; errorBody: string }) {
		super({
			...args,
			message: `Failed to create Twitch shoutout for ${args.toBroadcasterId}: ${args.status} - ${args.errorBody}`,
		});
	}
}

export class TwitchRedemptionUpdateError extends TaggedError("TwitchRedemptionUpdateError")<{
	rewardId: string;
	redemptionId: string;
	status: number;
	message: string;
}>() {
	constructor(args: { rewardId: string; redemptionId: string; status: number }) {
		super({
			...args,
			message: `Failed to update redemption ${args.redemptionId} for reward ${args.rewardId}: ${args.status}`,
		});
	}
}

export class TwitchTokenExchangeError extends TaggedError("TwitchTokenExchangeError")<{
	status: number;
	message: string;
}>() {
	constructor(args: { status: number; message?: string }) {
		super({
			status: args.status,
			message: args.message ?? `Twitch token exchange failed with status ${args.status}`,
		});
	}
}

/** Union of all Twitch API errors */
export type TwitchApiError =
	| TwitchRateLimitError
	| TwitchUnauthorizedError
	| TwitchNetworkError
	| TwitchParseError
	| TwitchNoSubscriptionReturnedError
	| TwitchSubscriptionCreateError
	| TwitchSubscriptionDeleteError
	| TwitchChatSendError
	| TwitchShoutoutCreateError
	| TwitchRedemptionUpdateError
	| TwitchTokenExchangeError;

// =============================================================================
// Durable Object Errors
// =============================================================================

export class DurableObjectError extends TaggedError("DurableObjectError")<{
	method: string;
	message: string;
	cause?: unknown;
}>() {
	constructor(args: { method: string; message: string; cause?: unknown }) {
		super({
			method: args.method,
			message: `DO method ${args.method} failed: ${args.message}`,
			cause: args.cause,
		});
	}
}

// =============================================================================
// Validation Errors
// =============================================================================

export class InvalidSpotifyUrlError extends TaggedError("InvalidSpotifyUrlError")<{
	url: string;
	message: string;
}>() {
	constructor(args: { url: string }) {
		super({ ...args, message: `Invalid Spotify URL: ${args.url}` });
	}
}

export class UnknownRewardError extends TaggedError("UnknownRewardError")<{
	redemptionId: string;
	rewardId: string;
	rewardTitle: string;
	message: string;
}>() {
	constructor(args: { redemptionId: string; rewardId: string; rewardTitle: string }) {
		super({
			...args,
			message: `Unknown reward ${args.rewardId} (${args.rewardTitle}) for redemption ${args.redemptionId}`,
		});
	}
}

export class RewardRoutingConfigError extends TaggedError("RewardRoutingConfigError")<{
	configKey: "SONG_REQUEST_REWARD_ID" | "KEYBOARD_RAFFLE_REWARD_ID" | "REWARD_ID_CONFLICT";
	message: string;
}>() {
	constructor(args: {
		configKey: "SONG_REQUEST_REWARD_ID" | "KEYBOARD_RAFFLE_REWARD_ID" | "REWARD_ID_CONFLICT";
	}) {
		super({ ...args, message: `Invalid reward routing config: ${args.configKey}` });
	}
}

// =============================================================================
// Song Queue Errors
// =============================================================================

export class SongQueueDbError extends TaggedError("SongQueueDbError")<{
	operation: string;
	message: string;
	cause?: unknown;
}>() {
	constructor(args: { operation: string; cause?: unknown }) {
		super({
			operation: args.operation,
			message: `Song queue DB error during ${args.operation}`,
			cause: args.cause,
		});
	}
}

export class SongRequestNotFoundError extends TaggedError("SongRequestNotFoundError")<{
	eventId: string;
	message: string;
}>() {
	constructor(args: { eventId: string }) {
		super({ ...args, message: `Song request not found: ${args.eventId}` });
	}
}

// =============================================================================
// Achievement Errors
// =============================================================================

export class AchievementDbError extends TaggedError("AchievementDbError")<{
	operation: string;
	message: string;
	cause?: unknown;
}>() {
	constructor(args: { operation: string; cause?: unknown }) {
		super({
			operation: args.operation,
			message: `Achievement DB error during ${args.operation}`,
			cause: args.cause,
		});
	}
}

export class AchievementNotFoundError extends TaggedError("AchievementNotFoundError")<{
	achievementId: string;
	message: string;
}>() {
	constructor(args: { achievementId: string }) {
		super({ ...args, message: `Achievement not found: ${args.achievementId}` });
	}
}

export class AchievementEventValidationError extends TaggedError(
	"AchievementEventValidationError",
)<{
	parseError: string;
	message: string;
}>() {
	constructor(args: { parseError: string }) {
		super({
			...args,
			message: `Invalid event format: ${args.parseError}`,
		});
	}
}

/** Union of all achievement-related errors */
export type AchievementError =
	| AchievementDbError
	| AchievementNotFoundError
	| AchievementEventValidationError;

// =============================================================================
// Commands Errors
// =============================================================================

export class CommandsDbError extends TaggedError("CommandsDbError")<{
	operation: string;
	message: string;
	cause?: unknown;
}>() {
	constructor(args: { operation: string; cause?: unknown }) {
		super({
			operation: args.operation,
			message: `Commands DB error during ${args.operation}`,
			cause: args.cause,
		});
	}
}

export class CommandNotFoundError extends TaggedError("CommandNotFoundError")<{
	commandName: string;
	message: string;
}>() {
	constructor(args: { commandName: string }) {
		super({ ...args, message: `Command not found: ${args.commandName}` });
	}
}

export class CommandNotUpdateableError extends TaggedError("CommandNotUpdateableError")<{
	commandName: string;
	responseType: string;
	message: string;
}>() {
	constructor(args: { commandName: string; responseType: string }) {
		super({
			...args,
			message: `Command !${args.commandName} is not updateable (type: ${args.responseType})`,
		});
	}
}

/** Union of all commands-related errors */
export type CommandsError = CommandsDbError | CommandNotFoundError | CommandNotUpdateableError;

// =============================================================================
// Event Bus Errors
// =============================================================================

export class EventBusRoutingError extends TaggedError("EventBusRoutingError")<{
	eventType: string;
	message: string;
}>() {
	constructor(args: { eventType: string }) {
		super({
			...args,
			message: `No handler registered for event type: ${args.eventType}`,
		});
	}
}

export class EventBusHandlerError extends TaggedError("EventBusHandlerError")<{
	eventType: string;
	handlerName: string;
	cause: unknown;
	message: string;
}>() {
	constructor(args: { eventType: string; handlerName: string; cause: unknown }) {
		super({
			...args,
			message: `Handler ${args.handlerName} failed for event type ${args.eventType}`,
		});
	}
}

export class EventBusValidationError extends TaggedError("EventBusValidationError")<{
	parseError: string;
	message: string;
}>() {
	constructor(args: { parseError: string }) {
		super({
			...args,
			message: `Invalid event format: ${args.parseError}`,
		});
	}
}

export class EventBusDbError extends TaggedError("EventBusDbError")<{
	operation: string;
	message: string;
	cause?: unknown;
}>() {
	constructor(args: { operation: string; cause?: unknown }) {
		super({
			operation: args.operation,
			message: `Event bus DB error during ${args.operation}`,
			cause: args.cause,
		});
	}
}

export class DLQItemNotFoundError extends TaggedError("DLQItemNotFoundError")<{
	eventId: string;
	message: string;
}>() {
	constructor(args: { eventId: string }) {
		super({ ...args, message: `DLQ item not found: ${args.eventId}` });
	}
}

/** Union of all event bus errors */
export type EventBusError =
	| EventBusRoutingError
	| EventBusHandlerError
	| EventBusValidationError
	| EventBusDbError
	| DLQItemNotFoundError;

// =============================================================================
// Stream Lifecycle Interface
// =============================================================================

import type { Result } from "better-result";

/**
 * Interface for DOs/services that respond to stream lifecycle events.
 * Generic over error type for onStreamOnline. onStreamOffline uses the same
 * error type for consistency (both can fail due to DB/storage operations).
 */
export interface StreamLifecycleHandler<E = never> {
	onStreamOnline(): Promise<Result<void, E>>;
	onStreamOffline(): Promise<Result<void, E>>;
}

// =============================================================================
// Saga Errors
// =============================================================================

/** The persisted saga field whose serialized value failed at the boundary. */
export type SagaPersistedField = "params" | "step-result" | "step-undo";

/** Expected failure returned when saga input cannot be parsed into canonical parameters. */
export class SagaInputParseError extends TaggedError("SagaInputParseError")<{
	readonly codecName: string;
	readonly parseError: string;
	readonly message: string;
}>() {
	constructor(args: { readonly codecName: string; readonly parseError: string }) {
		super({
			...args,
			message: `Invalid saga input for ${args.codecName}`,
		});
	}
}

/**
 * Expected failure returned when a named saga codec cannot decode or encode a value.
 * `parseError` is Zod's formatted diagnostic and `codecName` is stable context.
 */
export class SagaCodecParseError extends TaggedError("SagaCodecParseError")<{
	readonly codecName: string;
	readonly parseError: string;
	readonly message: string;
}>() {
	constructor(args: { readonly codecName: string; readonly parseError: string }) {
		super({
			...args,
			message: `Invalid ${args.codecName}: ${args.parseError}`,
		});
	}
}

/**
 * Safe expected failure for malformed or unencodable saga persistence data.
 *
 * The projection deliberately contains only stable identity and schema context;
 * raw JSON, payloads, environments, tokens, and arbitrary causes are excluded.
 */
export class SagaPersistedDataError extends TaggedError("SagaPersistedDataError")<{
	readonly sagaId: string;
	readonly field: SagaPersistedField;
	readonly stepName?: string;
	readonly codecName: string;
	readonly parseError: string;
	readonly message: string;
}>() {
	constructor(args: {
		readonly sagaId: string;
		readonly field: SagaPersistedField;
		readonly stepName?: string;
		readonly codecName: string;
		readonly parseError: string;
	}) {
		super({
			...args,
			message:
				args.stepName === undefined
					? `Invalid persisted saga ${args.field}`
					: `Invalid persisted ${args.field} for step "${args.stepName}"`,
		});
	}
}

/** Expected failure while coordinating a saga retry with the runtime scheduler. */
export class SagaScheduleError extends TaggedError("SagaScheduleError")<{
	readonly sagaId: string;
	readonly operation: "inspect" | "schedule" | "cancel";
	readonly message: string;
	readonly cause?: unknown;
}>() {
	constructor(args: {
		readonly sagaId: string;
		readonly operation: "inspect" | "schedule" | "cancel";
		readonly message: string;
		readonly cause?: unknown;
	}) {
		super(args);
	}
}

export class SagaStepError extends TaggedError("SagaStepError")<{
	stepName: string;
	sagaId: string;
	causeTag: string;
	error: string;
	message: string;
}>() {
	constructor(args: { stepName: string; sagaId: string; causeTag: string; error: string }) {
		super({
			...args,
			message: `Saga step "${args.stepName}" failed: ${args.error}`,
		});
	}
}

export class SagaStepRetrying extends TaggedError("SagaStepRetrying")<{
	stepName: string;
	sagaId: string;
	attempt: number;
	nextRetryAt: string;
	message: string;
}>() {
	constructor(args: { stepName: string; sagaId: string; attempt: number; nextRetryAt: string }) {
		super({
			...args,
			message: `Saga step "${args.stepName}" scheduled for retry (attempt ${args.attempt}) at ${args.nextRetryAt}`,
		});
	}
}

export class SagaCompensationError extends TaggedError("SagaCompensationError")<{
	stepName: string;
	sagaId: string;
	error: string;
	message: string;
}>() {
	constructor(args: { stepName: string; sagaId: string; error: string }) {
		super({
			...args,
			message: `Saga compensation for step "${args.stepName}" failed: ${args.error}`,
		});
	}
}

export class SagaNotFoundError extends TaggedError("SagaNotFoundError")<{
	sagaId: string;
	message: string;
}>() {
	constructor(args: { sagaId: string }) {
		super({
			...args,
			message: `Saga not found: ${args.sagaId}`,
		});
	}
}

export class SagaAlreadyExistsError extends TaggedError("SagaAlreadyExistsError")<{
	sagaId: string;
	message: string;
}>() {
	constructor(args: { sagaId: string }) {
		super({
			...args,
			message: `Saga already exists: ${args.sagaId}`,
		});
	}
}

/** Union of all saga-related errors */
export type SagaError =
	| SagaInputParseError
	| SagaCodecParseError
	| SagaPersistedDataError
	| SagaScheduleError
	| SagaStepError
	| SagaStepRetrying
	| SagaCompensationError
	| SagaNotFoundError
	| SagaAlreadyExistsError;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Check if an error is retryable (rate limit or transient network issue)
 */
export function isRetryableError(error: unknown): boolean {
	if (SpotifyRateLimitError.is(error) || TwitchRateLimitError.is(error)) {
		return true;
	}
	if (SpotifyNetworkError.is(error) || TwitchNetworkError.is(error)) {
		return error.status >= 500;
	}
	return false;
}

/**
 * Extract retry delay from a rate limit error, or return default
 */
export function getRetryDelayMs(error: unknown, defaultMs = 1000): number {
	if (SpotifyRateLimitError.is(error) || TwitchRateLimitError.is(error)) {
		return error.retryAfterMs;
	}
	return defaultMs;
}
