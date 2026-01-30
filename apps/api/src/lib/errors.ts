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

/** Union of all token-related errors */
export type TokenError =
	| NoRefreshTokenError
	| StreamOfflineNoTokenError
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

/** Union of all achievement-related errors */
export type AchievementError = AchievementDbError | AchievementNotFoundError;

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

/** Union of all event bus errors */
export type EventBusError = EventBusRoutingError | EventBusHandlerError | EventBusValidationError;

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

export class SagaStepError extends TaggedError("SagaStepError")<{
	stepName: string;
	sagaId: string;
	error: string;
	message: string;
}>() {
	constructor(args: { stepName: string; sagaId: string; error: string }) {
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
