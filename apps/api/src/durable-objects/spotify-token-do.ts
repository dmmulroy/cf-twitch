/**
 * SpotifyTokenDO - Manages OAuth tokens for Spotify API with automatic refresh
 *
 * Agent state owns the current token state. Legacy SQLite storage is only used
 * once during startup to migrate old token_set rows from the DurableObject era.
 *
 * All public RPC methods return Result types for type-safe error handling.
 */

import { Agent, type AgentContext } from "agents";
import { Result } from "better-result";
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
import * as tokenSchema from "./schemas/token-schema";

import type { Env } from "../index";
import type { TokenSet } from "./schemas/token-schema";

/**
 * Zod schema for Spotify token API responses
 */
export const SpotifyTokenResponseSchema = z.object({
	access_token: z.string(),
	token_type: z.string(),
	expires_in: z.number(),
	refresh_token: z.string().optional(),
	scope: z.string().optional(),
});

export type SpotifyTokenResponse = z.infer<typeof SpotifyTokenResponseSchema>;

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 minutes before expiry
const MAX_REFRESH_RETRIES = 3;
const REFRESH_RETRY_BASE_DELAY_MS = 60_000; // 60 seconds
const REFRESH_FALLBACK_DELAY_MS = 10 * 60 * 1000; // 10 minutes

interface SpotifyTokenState {
	accessToken: string;
	refreshToken: string;
	tokenType: string;
	expiresIn: number;
	expiresAt: string;
}

interface SpotifyTokenAgentState {
	token: SpotifyTokenState | null;
	isStreamLive: boolean;
	refreshScheduleId: string | null;
	refreshRetryCount: number;
}

class _SpotifyTokenDO
	extends Agent<Env, SpotifyTokenAgentState>
	implements StreamLifecycleHandler<TokenError>
{
	private legacyDb: ReturnType<typeof drizzle<typeof tokenSchema>>;
	private refreshPromise: Promise<Result<string, TokenError>> | null = null;

	initialState: SpotifyTokenAgentState = {
		token: null,
		isStreamLive: false,
		refreshScheduleId: null,
		refreshRetryCount: 0,
	};

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.legacyDb = drizzle(this.ctx.storage, { schema: tokenSchema });
	}

	async onStart(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.legacyDb, migrations);
			await this.migrateLegacyStateOnce();
			await this.clearLegacyAlarmState();
			await this.restoreOrRecomputeRefreshSchedule();
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
		logger.info("SpotifyTokenDO: stream online");
		this.updateState({ isStreamLive: true });

		if (this.state.token && !this.isTokenValid(this.state.token)) {
			const refreshResult = await this.refreshTokenWithCoalescing();
			if (refreshResult.status === "error") {
				logger.error("Failed to refresh token on stream online", {
					error: refreshResult.error.message,
				});
				return Result.err(refreshResult.error);
			}
		} else {
			await this.restoreOrRecomputeRefreshSchedule();
		}

		return Result.ok();
	}

	/**
	 * Called when stream goes offline. Cancel proactive refresh schedule.
	 */
	@rpc
	async onStreamOffline(): Promise<Result<void, TokenError>> {
		logger.info("SpotifyTokenDO: stream offline");

		return Result.tryPromise({
			try: async () => {
				this.updateState({ isStreamLive: false, refreshRetryCount: 0 });
				await this.cancelRefreshSchedule();
			},
			catch: (cause) =>
				new TokenRefreshNetworkError({
					status: 0,
					provider: "spotify",
					message: `Failed to update stream offline state: ${String(cause)}`,
				}),
		});
	}

	// =========================================================================
	// Scheduled refresh callback
	// =========================================================================

	/**
	 * Scheduled callback - proactively refresh token before expiry.
	 * Uses Agent scheduling with exponential backoff for retryable failures.
	 */
	async refreshTokenTick(): Promise<void> {
		if (this.state.refreshScheduleId !== null) {
			this.updateState({ refreshScheduleId: null });
		}

		if (!this.state.isStreamLive || this.state.token === null) {
			this.updateState({ refreshRetryCount: 0 });
			return;
		}

		logger.info("Proactive Spotify token refresh triggered by schedule");

		const result = await this.refreshTokenWithCoalescing();
		if (result.status === "ok") {
			this.updateState({ refreshRetryCount: 0 });
			return;
		}

		const error = result.error;
		if (!TokenRefreshNetworkError.is(error)) {
			logger.error("Proactive token refresh failed with non-retryable error", {
				error: error.message,
				tag: error._tag,
			});
			this.updateState({ refreshRetryCount: 0 });
			await this.scheduleRefreshIn(REFRESH_FALLBACK_DELAY_MS);
			return;
		}

		const retryCount = this.state.refreshRetryCount;
		if (retryCount < MAX_REFRESH_RETRIES) {
			const nextRetryCount = retryCount + 1;
			const delayMs = REFRESH_RETRY_BASE_DELAY_MS * Math.pow(2, retryCount);

			this.updateState({ refreshRetryCount: nextRetryCount });
			await this.scheduleRefreshIn(delayMs);

			logger.warn("Proactive token refresh failed, scheduling retry", {
				error: error.message,
				retryCount: nextRetryCount,
				delayMs,
			});
			return;
		}

		logger.error("Proactive token refresh failed after max retries", {
			error: error.message,
			maxRetries: MAX_REFRESH_RETRIES,
		});

		this.updateState({ refreshRetryCount: 0 });
		await this.scheduleRefreshIn(REFRESH_FALLBACK_DELAY_MS);
	}

	// =========================================================================
	// Public RPC methods
	// =========================================================================

	/**
	 * Get a valid access token, refreshing if necessary.
	 */
	@rpc
	async getValidToken(): Promise<Result<string, TokenError>> {
		if (this.state.token && this.isTokenValid(this.state.token)) {
			return Result.ok(this.state.token.accessToken);
		}

		if (this.state.token === null) {
			return Result.err(new StreamOfflineNoTokenError());
		}

		if (!this.state.isStreamLive) {
			return Result.err(new StreamOfflineNoTokenError());
		}

		return this.refreshTokenWithCoalescing();
	}

	/**
	 * Store new tokens (called during OAuth flow or after refresh).
	 */
	@rpc
	async setTokens(tokens: SpotifyTokenResponse): Promise<Result<void, never>> {
		const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
		const nextToken: SpotifyTokenState = {
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token ?? this.state.token?.refreshToken ?? "",
			tokenType: tokens.token_type,
			expiresIn: tokens.expires_in,
			expiresAt,
		};

		this.updateState({ token: nextToken, refreshRetryCount: 0 });

		logger.info("Spotify tokens updated", { expiresAt });

		if (this.state.isStreamLive) {
			await this.scheduleProactiveRefresh(nextToken);
		} else {
			await this.cancelRefreshSchedule();
		}

		return Result.ok();
	}

	// =========================================================================
	// Private helpers
	// =========================================================================

	private updateState(partial: Partial<SpotifyTokenAgentState>): SpotifyTokenAgentState {
		const nextState = { ...this.state, ...partial };
		this.setState(nextState);
		return nextState;
	}

	private async migrateLegacyStateOnce(): Promise<void> {
		const legacyToken = await this.legacyDb.query.tokenSet.findFirst({
			where: eq(tokenSchema.tokenSet.id, 1),
		});

		if (!legacyToken) {
			return;
		}

		if (this.isAgentStateUninitialized()) {
			this.setState({
				token: this.toAgentTokenState(legacyToken),
				isStreamLive: legacyToken.isStreamLive,
				refreshScheduleId: null,
				refreshRetryCount: 0,
			});
		}

		await this.legacyDb.delete(tokenSchema.tokenSet).where(eq(tokenSchema.tokenSet.id, 1));
	}

	private isAgentStateUninitialized(): boolean {
		return (
			this.state.token === null &&
			this.state.isStreamLive === false &&
			this.state.refreshScheduleId === null &&
			this.state.refreshRetryCount === 0
		);
	}

	private toAgentTokenState(token: TokenSet): SpotifyTokenState {
		return {
			accessToken: token.accessToken,
			refreshToken: token.refreshToken,
			tokenType: token.tokenType,
			expiresIn: token.expiresIn,
			expiresAt: token.expiresAt,
		};
	}

	private async clearLegacyAlarmState(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.delete("alarmRetryCount");
	}

	private async restoreOrRecomputeRefreshSchedule(): Promise<void> {
		if (!this.state.isStreamLive || this.state.token === null) {
			await this.cancelRefreshSchedule();
			if (this.state.refreshRetryCount !== 0) {
				this.updateState({ refreshRetryCount: 0 });
			}
			return;
		}

		if (
			this.state.refreshScheduleId !== null &&
			this.getSchedule(this.state.refreshScheduleId) !== undefined
		) {
			return;
		}

		if (!this.isTokenValid(this.state.token)) {
			await this.refreshTokenTick();
			return;
		}

		await this.scheduleProactiveRefresh(this.state.token);
	}

	private async scheduleProactiveRefresh(token: SpotifyTokenState): Promise<void> {
		if (!this.state.isStreamLive) {
			await this.cancelRefreshSchedule();
			return;
		}

		const expiresAtMs = new Date(token.expiresAt).getTime();
		const refreshAtMs = expiresAtMs - REFRESH_BUFFER_MS;

		if (refreshAtMs <= Date.now()) {
			await this.scheduleRefreshIn(1000);
			logger.debug("Token in refresh window, scheduling immediate refresh");
			return;
		}

		await this.scheduleRefreshAt(new Date(refreshAtMs));
		logger.debug("Scheduled proactive refresh", {
			refreshAt: new Date(refreshAtMs).toISOString(),
		});
	}

	private async scheduleRefreshAt(when: Date): Promise<void> {
		await this.cancelRefreshSchedule();
		const schedule = await this.schedule(when, "refreshTokenTick");
		this.updateState({ refreshScheduleId: schedule.id });
	}

	private async scheduleRefreshIn(delayMs: number): Promise<void> {
		await this.cancelRefreshSchedule();
		const delayInSeconds = Math.max(1, Math.ceil(delayMs / 1000));
		const schedule = await this.schedule(delayInSeconds, "refreshTokenTick");
		this.updateState({ refreshScheduleId: schedule.id });
	}

	private async cancelRefreshSchedule(): Promise<void> {
		if (this.state.refreshScheduleId === null) {
			return;
		}

		await this.cancelSchedule(this.state.refreshScheduleId);
		this.updateState({ refreshScheduleId: null });
	}

	private isTokenValid(token: SpotifyTokenState): boolean {
		return Date.now() < new Date(token.expiresAt).getTime() - REFRESH_BUFFER_MS;
	}

	private async refreshTokenWithCoalescing(): Promise<Result<string, TokenError>> {
		if (this.refreshPromise) {
			return this.refreshPromise;
		}

		this.refreshPromise = this.refreshToken();

		try {
			return await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	/**
	 * Refresh the access token using the refresh token.
	 */
	private async refreshToken(): Promise<Result<string, TokenError>> {
		if (this.state.token === null || this.state.token.refreshToken.length === 0) {
			return Result.err(new NoRefreshTokenError());
		}

		logger.info("Refreshing Spotify access token");

		const refreshToken = this.state.token.refreshToken;
		const fetchResult = await Result.tryPromise({
			try: () =>
				fetch("https://accounts.spotify.com/api/token", {
					method: "POST",
					headers: {
						"Content-Type": "application/x-www-form-urlencoded",
						Authorization: `Basic ${btoa(`${this.env.SPOTIFY_CLIENT_ID}:${this.env.SPOTIFY_CLIENT_SECRET}`)}`,
					},
					body: new URLSearchParams({
						grant_type: "refresh_token",
						refresh_token: refreshToken,
					}),
				}),
			catch: (cause) =>
				new TokenRefreshNetworkError({
					status: 0,
					provider: "spotify",
					message: `Network error: ${String(cause)}`,
				}),
		});

		if (fetchResult.status === "error") {
			logger.error("Network error refreshing Spotify token", { error: fetchResult.error.message });
			return Result.err(fetchResult.error);
		}

		const response = fetchResult.value;
		if (!response.ok) {
			const errorText = await response.text();
			logger.error("Failed to refresh Spotify token", {
				status: response.status,
				error: errorText,
			});
			return Result.err(
				new TokenRefreshNetworkError({ status: response.status, provider: "spotify" }),
			);
		}

		const jsonResult = await Result.tryPromise({
			try: () => response.json(),
			catch: (cause) =>
				new TokenRefreshParseError({ provider: "spotify", parseError: String(cause) }),
		});

		if (jsonResult.status === "error") {
			logger.error("Failed to parse Spotify token refresh JSON", {
				error: jsonResult.error.message,
			});
			return Result.err(jsonResult.error);
		}

		const parseResult = SpotifyTokenResponseSchema.safeParse(jsonResult.value);
		if (!parseResult.success) {
			logger.error("Invalid token response from Spotify", {
				error: parseResult.error.message,
			});
			return Result.err(
				new TokenRefreshParseError({
					provider: "spotify",
					parseError: parseResult.error.message,
				}),
			);
		}

		await this.setTokens(parseResult.data);
		return Result.ok(parseResult.data.access_token);
	}
}

export const SpotifyTokenDO = withRpcSerialization(_SpotifyTokenDO);
