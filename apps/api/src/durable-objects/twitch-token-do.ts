/** Twitch OAuth token lifecycle with durable refresh scheduling. */

import { Agent, type AgentContext } from "agents";
import { Result } from "better-result";
import { z } from "zod";

import { rpc, withRpcSerialization } from "../lib/durable-objects";
import {
	NoRefreshTokenError,
	TokenAuthorizationRevokedError,
	TokenConfigurationError,
	TokenInputParseError,
	TokenNotConfiguredError,
	TokenRefreshNetworkError,
	TokenRefreshParseError,
	TokenStatePersistenceError,
	TokenUnavailableWhileStreamOfflineError,
	type StreamLifecycleHandler,
	type TokenError,
} from "../lib/errors";
import { logger } from "../lib/logger";
import { redactValue, revealRedactedValue, type Redacted } from "../lib/redacted";

import type { Env } from "../index";

const MAX_TOKEN_EXPIRY_SECONDS = 31_536_000;

/** Parsed Twitch token response accepted by the token Durable Object RPC boundary. */
export const TwitchTokenResponseSchema = z.object({
	access_token: z.string().trim().min(1),
	token_type: z.string().trim().min(1),
	expires_in: z.number().finite().positive().max(MAX_TOKEN_EXPIRY_SECONDS),
	refresh_token: z.string().trim().min(1).optional(),
	scope: z.array(z.string()).optional(),
});

/** Twitch token response whose credential and expiry invariants have been parsed. */
export type TwitchTokenResponse = z.infer<typeof TwitchTokenResponseSchema>;

const TwitchOAuthErrorResponseSchema = z.union([
	z.object({ error: z.string(), error_description: z.string().optional() }),
	z.object({ status: z.number().optional(), message: z.string() }),
]);

const TwitchTokenConfigSchema = z.object({
	clientId: z.string().trim().min(1),
	clientSecret: z.string().trim().min(1),
});

const TwitchPersistedTokenSchema = z.object({
	accessToken: z.string().min(1),
	refreshToken: z.string().min(1),
	tokenType: z.string().min(1),
	expiresIn: z.number().finite().positive().max(MAX_TOKEN_EXPIRY_SECONDS),
	expiresAt: z.string().datetime({ offset: true }),
});

const TwitchPersistedStateV1Schema = z.object({
	version: z.literal(1),
	token: TwitchPersistedTokenSchema.nullable(),
	isStreamLive: z.boolean(),
	authorizationStatus: z.enum(["not-configured", "authorized", "reauthorization-required"]),
	refreshScheduleId: z.string().min(1).nullable(),
	refreshRetryCount: z.number().int().nonnegative(),
});

const TwitchLegacyPersistedStateSchema = z.object({
	token: TwitchPersistedTokenSchema.nullable(),
	isStreamLive: z.boolean(),
	refreshScheduleId: z.string().min(1).nullable(),
	refreshRetryCount: z.number().int().nonnegative(),
});

type TwitchPersistedState = z.infer<typeof TwitchPersistedStateV1Schema>;
type TwitchAuthorizationStatus = TwitchPersistedState["authorizationStatus"];

interface TwitchRuntimeToken {
	readonly accessToken: Redacted<string>;
	readonly refreshToken: Redacted<string>;
	readonly tokenType: string;
	readonly expiresIn: number;
	readonly expiresAt: string;
}

interface TwitchRuntimeState {
	readonly token: TwitchRuntimeToken | null;
	readonly isStreamLive: boolean;
	readonly authorizationStatus: TwitchAuthorizationStatus;
	readonly refreshScheduleId: string | null;
	readonly refreshRetryCount: number;
}

interface TwitchTokenConfig {
	readonly clientId: string;
	readonly clientSecret: Redacted<string>;
}

const INITIAL_TWITCH_STATE: TwitchPersistedState = {
	version: 1,
	token: null,
	isStreamLive: false,
	authorizationStatus: "not-configured",
	refreshScheduleId: null,
	refreshRetryCount: 0,
};

const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MAX_REFRESH_RETRIES = 3;
const REFRESH_RETRY_BASE_DELAY_MS = 60_000;
const REFRESH_FALLBACK_DELAY_MS = 10 * 60 * 1000;

class _TwitchTokenDO
	extends Agent<Env, TwitchPersistedState>
	implements StreamLifecycleHandler<TokenError>
{
	private runtimeState: TwitchRuntimeState = toTwitchRuntimeState(INITIAL_TWITCH_STATE);
	private refreshPromise: Promise<Result<string, TokenError>> | null = null;
	private readonly tokenConfig: TwitchTokenConfig | TokenConfigurationError;

	/** Initial versioned persistence representation for a Twitch token lifecycle. */
	initialState: TwitchPersistedState = INITIAL_TWITCH_STATE;

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		const configResult = TwitchTokenConfigSchema.safeParse({
			clientId: env.TWITCH_CLIENT_ID,
			clientSecret: env.TWITCH_CLIENT_SECRET,
		});
		this.tokenConfig = configResult.success
			? {
					clientId: configResult.data.clientId,
					clientSecret: redactValue(configResult.data.clientSecret),
				}
			: new TokenConfigurationError({
					provider: "twitch",
					parseError: configResult.error.message,
				});
	}

	/** Parse or migrate persisted token state before restoring durable refresh work. */
	async onStart(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			const parsedState = parseTwitchPersistedState(this.state);
			if (parsedState.status === "error") {
				logger.error("Twitch token persisted state was reset after parse failure", {
					event: "twitch.token.state.parse_failed",
					error_tag: parsedState.error._tag,
				});
				this.setState(INITIAL_TWITCH_STATE);
				this.runtimeState = toTwitchRuntimeState(INITIAL_TWITCH_STATE);
				return;
			}

			this.persistRuntimeState(toTwitchRuntimeState(parsedState.value));
			const restoreResult = await this.restoreOrRecomputeRefreshSchedule();
			if (restoreResult.status === "error") {
				logger.error("Twitch token refresh schedule restoration failed", {
					event: "twitch.token.schedule.restore_failed",
					error_tag: restoreResult.error._tag,
				});
			}
		});
	}

	/** Mark the Stream Session online and durably retry transient token refresh failures. */
	@rpc
	async onStreamOnline(): Promise<Result<void, TokenError>> {
		const persistResult = this.tryPersistRuntimeState({ ...this.runtimeState, isStreamLive: true });
		if (persistResult.status === "error") return persistResult;

		if (this.runtimeState.token !== null && !this.isTokenValid(this.runtimeState.token)) {
			const refreshResult = await this.refreshLiveToken();
			return refreshResult.status === "error" ? Result.err(refreshResult.error) : Result.ok();
		}

		return this.restoreOrRecomputeRefreshSchedule();
	}

	/** Mark the Stream Session offline and cancel proactive refresh work. */
	@rpc
	async onStreamOffline(): Promise<Result<void, TokenError>> {
		const persistResult = this.tryPersistRuntimeState({
			...this.runtimeState,
			isStreamLive: false,
			refreshRetryCount: 0,
		});
		if (persistResult.status === "error") return persistResult;
		return this.tryCancelRefreshSchedule();
	}

	/** Execute one durable Twitch refresh callback. */
	async refreshTokenTick(): Promise<void> {
		if (this.runtimeState.refreshScheduleId !== null) {
			const persistResult = this.tryPersistRuntimeState({
				...this.runtimeState,
				refreshScheduleId: null,
			});
			if (persistResult.status === "error") return;
		}
		if (!this.runtimeState.isStreamLive || this.runtimeState.token === null) {
			this.tryPersistRuntimeState({ ...this.runtimeState, refreshRetryCount: 0 });
			return;
		}
		await this.refreshLiveToken();
	}

	/** Return a valid Twitch access token or a truthful lifecycle error. */
	@rpc
	async getValidToken(): Promise<Result<string, TokenError>> {
		if (this.runtimeState.authorizationStatus === "reauthorization-required") {
			return Result.err(new TokenAuthorizationRevokedError({ provider: "twitch" }));
		}
		if (this.runtimeState.token === null) {
			return Result.err(new TokenNotConfiguredError({ provider: "twitch" }));
		}
		if (this.isTokenValid(this.runtimeState.token)) {
			return Result.ok(revealRedactedValue(this.runtimeState.token.accessToken));
		}
		if (!this.runtimeState.isStreamLive) {
			return Result.err(new TokenUnavailableWhileStreamOfflineError({ provider: "twitch" }));
		}
		return this.refreshLiveToken();
	}

	/** Parse and durably accept Twitch OAuth tokens at the public RPC boundary. */
	@rpc
	async setTokens(tokens: TwitchTokenResponse): Promise<Result<void, TokenError>> {
		const parseResult = TwitchTokenResponseSchema.safeParse(tokens);
		if (!parseResult.success) {
			return Result.err(
				new TokenInputParseError({ provider: "twitch", parseError: parseResult.error.message }),
			);
		}

		const refreshToken =
			parseResult.data.refresh_token ??
			(this.runtimeState.token === null
				? undefined
				: revealRedactedValue(this.runtimeState.token.refreshToken));
		if (refreshToken === undefined) return Result.err(new NoRefreshTokenError());

		const nextToken: TwitchRuntimeToken = {
			accessToken: redactValue(parseResult.data.access_token),
			refreshToken: redactValue(refreshToken),
			tokenType: parseResult.data.token_type,
			expiresIn: parseResult.data.expires_in,
			expiresAt: new Date(Date.now() + parseResult.data.expires_in * 1000).toISOString(),
		};
		const persistResult = this.tryPersistRuntimeState({
			...this.runtimeState,
			token: nextToken,
			authorizationStatus: "authorized",
			refreshRetryCount: 0,
		});
		if (persistResult.status === "error") return persistResult;

		logger.info("Twitch tokens updated", { expiresAt: nextToken.expiresAt });
		return this.runtimeState.isStreamLive
			? this.scheduleProactiveRefresh(nextToken)
			: this.tryCancelRefreshSchedule();
	}

	private tryPersistRuntimeState(nextState: TwitchRuntimeState): Result<void, TokenStatePersistenceError> {
		try {
			this.persistRuntimeState(nextState);
			return Result.ok();
		} catch (cause) {
			return Result.err(
				new TokenStatePersistenceError({ provider: "twitch", operation: "persist", cause }),
			);
		}
	}

	private persistRuntimeState(nextState: TwitchRuntimeState): void {
		this.setState(toTwitchPersistedState(nextState));
		this.runtimeState = nextState;
	}

	private async restoreOrRecomputeRefreshSchedule(): Promise<Result<void, TokenError>> {
		if (!this.runtimeState.isStreamLive || this.runtimeState.token === null) {
			const cancelResult = await this.tryCancelRefreshSchedule();
			if (cancelResult.status === "error") return cancelResult;
			return this.tryPersistRuntimeState({ ...this.runtimeState, refreshRetryCount: 0 });
		}
		if (
			this.runtimeState.refreshScheduleId !== null &&
			this.getSchedule(this.runtimeState.refreshScheduleId) !== undefined
		) return Result.ok();
		if (!this.isTokenValid(this.runtimeState.token)) {
			const result = await this.refreshLiveToken();
			return result.status === "error" ? Result.err(result.error) : Result.ok();
		}
		return this.scheduleProactiveRefresh(this.runtimeState.token);
	}

	private async scheduleProactiveRefresh(token: TwitchRuntimeToken): Promise<Result<void, TokenStatePersistenceError>> {
		if (!this.runtimeState.isStreamLive) return this.tryCancelRefreshSchedule();
		const refreshAtMs = Date.parse(token.expiresAt) - REFRESH_BUFFER_MS;
		return refreshAtMs <= Date.now()
			? this.scheduleRefreshIn(1000)
			: this.scheduleRefreshAt(new Date(refreshAtMs));
	}

	private async scheduleRefreshAt(when: Date): Promise<Result<void, TokenStatePersistenceError>> {
		const cancelResult = await this.tryCancelRefreshSchedule();
		if (cancelResult.status === "error") return cancelResult;
		try {
			const schedule = await this.schedule(when, "refreshTokenTick");
			return this.tryPersistRuntimeState({ ...this.runtimeState, refreshScheduleId: schedule.id });
		} catch (cause) {
			return Result.err(new TokenStatePersistenceError({ provider: "twitch", operation: "schedule", cause }));
		}
	}

	private async scheduleRefreshIn(delayMs: number): Promise<Result<void, TokenStatePersistenceError>> {
		const cancelResult = await this.tryCancelRefreshSchedule();
		if (cancelResult.status === "error") return cancelResult;
		try {
			const schedule = await this.schedule(Math.max(1, Math.ceil(delayMs / 1000)), "refreshTokenTick");
			return this.tryPersistRuntimeState({ ...this.runtimeState, refreshScheduleId: schedule.id });
		} catch (cause) {
			return Result.err(new TokenStatePersistenceError({ provider: "twitch", operation: "schedule", cause }));
		}
	}

	private async tryCancelRefreshSchedule(): Promise<Result<void, TokenStatePersistenceError>> {
		if (this.runtimeState.refreshScheduleId === null) return Result.ok();
		try {
			await this.cancelSchedule(this.runtimeState.refreshScheduleId);
			return this.tryPersistRuntimeState({ ...this.runtimeState, refreshScheduleId: null });
		} catch (cause) {
			return Result.err(new TokenStatePersistenceError({ provider: "twitch", operation: "cancel-schedule", cause }));
		}
	}

	private isTokenValid(token: TwitchRuntimeToken): boolean {
		return Date.now() < Date.parse(token.expiresAt) - REFRESH_BUFFER_MS;
	}

	private async refreshLiveToken(): Promise<Result<string, TokenError>> {
		if (this.refreshPromise !== null) return this.refreshPromise;
		this.refreshPromise = this.refreshTokenAndApplyRetryPolicy();
		try {
			return await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	private async refreshTokenAndApplyRetryPolicy(): Promise<Result<string, TokenError>> {
		const result = await this.refreshToken();
		if (result.status === "ok") return result;

		if (TokenAuthorizationRevokedError.is(result.error) || NoRefreshTokenError.is(result.error)) {
			const persistResult = this.tryPersistRuntimeState({
				...this.runtimeState,
				authorizationStatus: "reauthorization-required",
				refreshRetryCount: 0,
			});
			if (persistResult.status === "error") return persistResult;
			const cancelResult = await this.tryCancelRefreshSchedule();
			return cancelResult.status === "error" ? cancelResult : result;
		}

		const retryCount = this.runtimeState.refreshRetryCount;
		const isShortRetry = TokenRefreshNetworkError.is(result.error) && retryCount < MAX_REFRESH_RETRIES;
		const nextRetryCount = isShortRetry ? retryCount + 1 : 0;
		const delayMs = isShortRetry
			? REFRESH_RETRY_BASE_DELAY_MS * Math.pow(2, retryCount)
			: REFRESH_FALLBACK_DELAY_MS;
		const persistResult = this.tryPersistRuntimeState({ ...this.runtimeState, refreshRetryCount: nextRetryCount });
		if (persistResult.status === "error") return persistResult;
		const scheduleResult = await this.scheduleRefreshIn(delayMs);
		if (scheduleResult.status === "error") return scheduleResult;
		logger.warn("Twitch token refresh failed and durable retry was scheduled", {
			error_tag: result.error._tag,
			retry_count: nextRetryCount,
			delay_ms: delayMs,
		});
		return result;
	}

	private async refreshToken(): Promise<Result<string, TokenError>> {
		const token = this.runtimeState.token;
		if (token === null) return Result.err(new NoRefreshTokenError());
		const tokenConfig = this.tokenConfig;
		if (!("clientId" in tokenConfig)) return Result.err(tokenConfig);

		const responseResult = await Result.tryPromise({
			try: () => fetch("https://id.twitch.tv/oauth2/token", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: revealRedactedValue(token.refreshToken),
					client_id: tokenConfig.clientId,
					client_secret: revealRedactedValue(tokenConfig.clientSecret),
				}),
			}),
			catch: (cause) => new TokenRefreshNetworkError({ status: 0, provider: "twitch", message: `Twitch token refresh network request failed: ${String(cause)}` }),
		});
		if (responseResult.status === "error") return responseResult;

		const response = responseResult.value;
		if (!response.ok) {
			const bodyResult = await Result.tryPromise({ try: () => response.json(), catch: () => undefined });
			const oauthError = bodyResult.status === "ok" ? TwitchOAuthErrorResponseSchema.safeParse(bodyResult.value) : undefined;
			const hasParsedOAuthError = oauthError?.success === true;
			if (
				(hasParsedOAuthError && response.status >= 400 && response.status < 500 && response.status !== 429) ||
				(response.status >= 400 && response.status < 500 && response.status !== 429)
			) {
				return Result.err(new TokenAuthorizationRevokedError({ provider: "twitch" }));
			}
			return Result.err(new TokenRefreshNetworkError({ status: response.status, provider: "twitch" }));
		}

		const jsonResult = await Result.tryPromise({
			try: () => response.json(),
			catch: (cause) => new TokenRefreshParseError({ provider: "twitch", parseError: String(cause) }),
		});
		if (jsonResult.status === "error") return jsonResult;
		const parseResult = TwitchTokenResponseSchema.safeParse(jsonResult.value);
		if (!parseResult.success) return Result.err(new TokenRefreshParseError({ provider: "twitch", parseError: parseResult.error.message }));
		const setResult = await this.setTokens(parseResult.data);
		return setResult.status === "error" ? setResult : Result.ok(parseResult.data.access_token);
	}
}

function parseTwitchPersistedState(input: unknown): Result<TwitchPersistedState, TokenStatePersistenceError> {
	const current = TwitchPersistedStateV1Schema.safeParse(input);
	if (current.success) return Result.ok(current.data);
	const legacy = TwitchLegacyPersistedStateSchema.safeParse(input);
	if (legacy.success) {
		return Result.ok({
			version: 1,
			...legacy.data,
			authorizationStatus: legacy.data.token === null ? "not-configured" : "authorized",
		});
	}
	return Result.err(new TokenStatePersistenceError({ provider: "twitch", operation: "parse" }));
}

function toTwitchRuntimeState(state: TwitchPersistedState): TwitchRuntimeState {
	return {
		...state,
		token: state.token === null ? null : {
			...state.token,
			accessToken: redactValue(state.token.accessToken),
			refreshToken: redactValue(state.token.refreshToken),
		},
	};
}

function toTwitchPersistedState(state: TwitchRuntimeState): TwitchPersistedState {
	return {
		version: 1,
		...state,
		token: state.token === null ? null : {
			...state.token,
			accessToken: revealRedactedValue(state.token.accessToken),
			refreshToken: revealRedactedValue(state.token.refreshToken),
		},
	};
}

/** Cloudflare Durable Object export for the Twitch token lifecycle. */
export const TwitchTokenDO = withRpcSerialization(_TwitchTokenDO);
