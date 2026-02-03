/**
 * TwitchTokenDO - Manages OAuth tokens for Twitch API with automatic refresh
 *
 * Implements proactive token refresh:
 * - Schedules alarm 5 mins before token expiry when stream is live
 * - Cancels alarm when stream goes offline
 * - Uses alarm-based retry with exponential backoff on failure (non-blocking)
 *
 * All public RPC methods return Result types for type-safe error handling.
 */

import { Result } from "better-result";
import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import migrations from "../../drizzle/token-do/migrations";
import { rpc, withRpcSerialization } from "../lib/durable-objects";
import {
	NoRefreshTokenError,
	StreamOfflineNoTokenError,
	TokenRefreshNetworkError,
	TokenRefreshParseError,
	type StreamLifecycleHandler,
	type TokenError,
} from "../lib/errors";
import { logger } from "../lib/logger";
import { type TokenSet, tokenSet } from "./schemas/token-schema";

import type { Env } from "../index";

/**
 * Zod schema for Twitch token API responses
 */
export const TwitchTokenResponseSchema = z.object({
	access_token: z.string(),
	token_type: z.string(),
	expires_in: z.number(),
	refresh_token: z.string().optional(),
	scope: z.array(z.string()).optional(),
});

export type TwitchTokenResponse = z.infer<typeof TwitchTokenResponseSchema>;

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry

class _TwitchTokenDO
	extends DurableObject<Env>
	implements StreamLifecycleHandler<TokenError>
{
	private db;
	private tokenCache: TokenSet | null = null;
	private refreshPromise: Promise<Result<string, TokenError>> | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema: { tokenSet } });

		// Initialize schema using blockConcurrencyWhile for safe initialization
		// Intentionally not awaited - blockConcurrencyWhile handles async in DO constructors
		void this.ctx.blockConcurrencyWhile(async () => {
			// Run drizzle migrations (idempotent, tracks via __drizzle_migrations table)
			await migrate(this.db, migrations);

			// Load token into cache if exists
			const token = await this.db.query.tokenSet.findFirst({
				where: eq(tokenSet.id, 1),
			});

			if (token) {
				this.tokenCache = token;

				// Proactive refresh on init if stream is live and token expiring
				if (token.isStreamLive && !this.isTokenValid(token)) {
					const refreshResult = await this.refreshToken();
					if (refreshResult.status === "error") {
						logger.error("Failed proactive token refresh on init", {
							error: refreshResult.error.message,
						});
					}
				}

				// Reschedule alarm if stream is live
				if (token.isStreamLive) {
					await this.scheduleProactiveRefresh();
				}
			}
		});
	}

	// =========================================================================
	// StreamLifecycleHandler implementation
	// =========================================================================

	/**
	 * Called when stream goes online. Refresh token if needed, schedule proactive refresh.
	 */
	@rpc
	async onStreamOnline(): Promise<Result<void, TokenError>> {
		logger.info("TwitchTokenDO: stream online");

		// Persist stream live state
		await this.db.update(tokenSet).set({ isStreamLive: true }).where(eq(tokenSet.id, 1));

		if (this.tokenCache) {
			this.tokenCache = { ...this.tokenCache, isStreamLive: true };
		}

		// If token is expired/expiring, refresh immediately
		if (this.tokenCache && !this.isTokenValid(this.tokenCache)) {
			const refreshResult = await this.refreshToken();
			if (refreshResult.status === "error") {
				logger.error("Failed to refresh token on stream online", {
					error: refreshResult.error.message,
				});
				return Result.err(refreshResult.error);
			}
		}

		// Schedule proactive refresh alarm
		await this.scheduleProactiveRefresh();

		return Result.ok();
	}

	/**
	 * Called when stream goes offline. Cancel proactive refresh alarm.
	 */
	@rpc
	async onStreamOffline(): Promise<Result<void, TokenError>> {
		logger.info("TwitchTokenDO: stream offline");

		return Result.tryPromise({
			try: async () => {
				// Persist stream live state
				await this.db.update(tokenSet).set({ isStreamLive: false }).where(eq(tokenSet.id, 1));

				if (this.tokenCache) {
					this.tokenCache = { ...this.tokenCache, isStreamLive: false };
				}

				// Cancel proactive refresh alarm and clear retry state
				await this.ctx.storage.deleteAlarm();
				await this.ctx.storage.delete("alarmRetryCount");
			},
			catch: (cause) =>
				new TokenRefreshNetworkError({
					status: 0,
					provider: "twitch",
					message: `Failed to update stream offline state: ${String(cause)}`,
				}),
		});
	}

	// =========================================================================
	// Alarm handler for proactive refresh
	// =========================================================================

	private static readonly MAX_ALARM_RETRIES = 3;
	private static readonly ALARM_RETRY_BASE_DELAY_MS = 60_000; // 60 seconds
	private static readonly ALARM_FALLBACK_DELAY_MS = 10 * 60 * 1000; // 10 minutes

	/**
	 * DO alarm handler - proactively refresh token before expiry.
	 * Uses alarm-based retry with exponential backoff (non-blocking).
	 * Retry state persisted in storage to survive hibernation.
	 */
	async alarm(): Promise<void> {
		// Load token from DB (not cache - may have hibernated)
		const token = await this.db.query.tokenSet.findFirst({
			where: eq(tokenSet.id, 1),
		});

		if (!token?.isStreamLive) {
			logger.debug("Alarm fired but stream offline, skipping refresh");
			await this.ctx.storage.delete("alarmRetryCount");
			return;
		}

		logger.info("Proactive Twitch token refresh triggered by alarm");

		// Update cache from DB in case we hibernated
		this.tokenCache = token;

		// Single refresh attempt (non-blocking - no in-handler retry loop)
		const result = await this.refreshToken();

		if (result.status === "ok") {
			// Success - clear retry count, next alarm scheduled by setTokens()
			await this.ctx.storage.delete("alarmRetryCount");
			return;
		}

		// Handle failure with alarm-based retry
		const error = result.error;

		// Only retry network errors (transient failures)
		if (!TokenRefreshNetworkError.is(error)) {
			logger.error("Proactive token refresh failed with non-retryable error", {
				error: error.message,
				tag: error._tag,
			});
			// Schedule fallback alarm to try again later
			await this.ctx.storage.setAlarm(Date.now() + TwitchTokenDO.ALARM_FALLBACK_DELAY_MS);
			return;
		}

		// Get current retry count from storage (survives hibernation)
		const retryCount = (await this.ctx.storage.get<number>("alarmRetryCount")) ?? 0;

		if (retryCount < TwitchTokenDO.MAX_ALARM_RETRIES) {
			// Schedule retry with exponential backoff
			const nextRetryCount = retryCount + 1;
			const delayMs = TwitchTokenDO.ALARM_RETRY_BASE_DELAY_MS * Math.pow(2, retryCount);

			await this.ctx.storage.put("alarmRetryCount", nextRetryCount);
			await this.ctx.storage.setAlarm(Date.now() + delayMs);

			logger.warn("Proactive token refresh failed, scheduling retry", {
				error: error.message,
				retryCount: nextRetryCount,
				delayMs,
			});
			return;
		}

		// Exhausted retries - log error and schedule fallback alarm
		logger.error("Proactive token refresh failed after max retries", {
			error: error.message,
			maxRetries: TwitchTokenDO.MAX_ALARM_RETRIES,
		});

		await this.ctx.storage.delete("alarmRetryCount");
		await this.ctx.storage.setAlarm(Date.now() + TwitchTokenDO.ALARM_FALLBACK_DELAY_MS);
	}

	// =========================================================================
	// Public RPC methods
	// =========================================================================

	/**
	 * Get a valid access token, refreshing if necessary
	 *
	 * Always validates token expiry and refreshes when needed.
	 */
	@rpc
	async getValidToken(): Promise<Result<string, TokenError>> {
		// Return cached token if still valid
		if (this.tokenCache && this.isTokenValid(this.tokenCache)) {
			return Result.ok(this.tokenCache.accessToken);
		}

		// No token at all
		if (!this.tokenCache) {
			return Result.err(new StreamOfflineNoTokenError());
		}

		// Token expired + stream offline → error (conserve resources, don't return stale token)
		if (!this.tokenCache.isStreamLive) {
			return Result.err(new StreamOfflineNoTokenError());
		}

		// Token expired + stream online → refresh
		// Coalesce concurrent refresh requests
		if (this.refreshPromise) {
			return this.refreshPromise;
		}

		// Start token refresh
		this.refreshPromise = this.refreshToken();

		try {
			return await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	/**
	 * Store new tokens (called during OAuth flow or after refresh)
	 */
	@rpc
	async setTokens(tokens: TwitchTokenResponse): Promise<Result<void, never>> {
		const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

		const newTokenSet: TokenSet = {
			id: 1,
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token ?? this.tokenCache?.refreshToken ?? "",
			tokenType: tokens.token_type,
			expiresIn: tokens.expires_in,
			expiresAt,
			isStreamLive: this.tokenCache?.isStreamLive ?? false,
		};

		// Persist to SQLite using Drizzle
		await this.db
			.insert(tokenSet)
			.values(newTokenSet)
			.onConflictDoUpdate({
				target: tokenSet.id,
				set: {
					accessToken: newTokenSet.accessToken,
					refreshToken: newTokenSet.refreshToken,
					tokenType: newTokenSet.tokenType,
					expiresIn: newTokenSet.expiresIn,
					expiresAt: newTokenSet.expiresAt,
				},
			});

		// Update cache
		this.tokenCache = newTokenSet;

		logger.info("Twitch tokens updated", { expiresAt });

		// Schedule proactive refresh if stream is live
		if (this.tokenCache.isStreamLive) {
			await this.scheduleProactiveRefresh();
		}

		return Result.ok();
	}

	// =========================================================================
	// Private helpers
	// =========================================================================

	/**
	 * Schedule alarm for 5 minutes before token expiry.
	 * Only schedules if token exists.
	 */
	private async scheduleProactiveRefresh(): Promise<void> {
		if (!this.tokenCache) {
			return;
		}

		const expiresAtMs = new Date(this.tokenCache.expiresAt).getTime();
		const refreshAtMs = expiresAtMs - REFRESH_BUFFER_MS;
		const now = Date.now();

		if (refreshAtMs <= now) {
			// Token already in refresh window, schedule immediate refresh (1s delay for safety)
			await this.ctx.storage.setAlarm(now + 1000);
			logger.debug("Token in refresh window, scheduling immediate refresh");
		} else {
			await this.ctx.storage.setAlarm(refreshAtMs);
			logger.debug("Scheduled proactive refresh", {
				refreshAt: new Date(refreshAtMs).toISOString(),
			});
		}
	}

	/**
	 * Check if token is still valid (not expiring soon)
	 */
	private isTokenValid(token: TokenSet): boolean {
		return Date.now() < new Date(token.expiresAt).getTime() - REFRESH_BUFFER_MS;
	}

	/**
	 * Refresh the access token using the refresh token
	 */
	private async refreshToken(): Promise<Result<string, TokenError>> {
		if (!this.tokenCache) {
			return Result.err(new NoRefreshTokenError());
		}

		logger.info("Refreshing Twitch access token");

		const fetchResult = await Result.tryPromise({
			try: () =>
				fetch("https://id.twitch.tv/oauth2/token", {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams({
						grant_type: "refresh_token",
						refresh_token: this.tokenCache?.refreshToken ?? "",
						client_id: this.env.TWITCH_CLIENT_ID,
						client_secret: this.env.TWITCH_CLIENT_SECRET,
					}),
				}),
			catch: (cause) =>
				new TokenRefreshNetworkError({
					status: 0,
					provider: "twitch",
					message: `Network error: ${String(cause)}`,
				}),
		});

		if (fetchResult.status === "error") {
			logger.error("Network error refreshing Twitch token", { error: fetchResult.error.message });
			return Result.err(fetchResult.error);
		}

		const response = fetchResult.value;

		if (!response.ok) {
			const errorText = await response.text();
			logger.error("Failed to refresh Twitch token", {
				status: response.status,
				error: errorText,
			});
			return Result.err(
				new TokenRefreshNetworkError({ status: response.status, provider: "twitch" }),
			);
		}

		const jsonResult = await Result.tryPromise({
			try: () => response.json(),
			catch: (cause) =>
				new TokenRefreshParseError({ provider: "twitch", parseError: String(cause) }),
		});

		if (jsonResult.status === "error") {
			logger.error("Failed to parse Twitch token refresh JSON", {
				error: jsonResult.error.message,
			});
			return Result.err(jsonResult.error);
		}

		const parseResult = TwitchTokenResponseSchema.safeParse(jsonResult.value);

		if (!parseResult.success) {
			logger.error("Invalid token response from Twitch", {
				error: parseResult.error.message,
			});
			return Result.err(
				new TokenRefreshParseError({
					provider: "twitch",
					parseError: parseResult.error.message,
				}),
			);
		}

		await this.setTokens(parseResult.data);
		return Result.ok(parseResult.data.access_token);
	}
}

export const TwitchTokenDO = withRpcSerialization(_TwitchTokenDO);
