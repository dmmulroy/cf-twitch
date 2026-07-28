import { Result } from "better-result";
import { z } from "zod";

import { OAuthAuthorizationStateError } from "../../capabilities/oauth-authorization-state";

import type {
	OAuthAuthorizationStateStore,
	OAuthProvider,
} from "../../capabilities/oauth-authorization-state";
import type { Result as ResultType } from "better-result";

const CreateOAuthStateResultSchema = z.object({ status: z.enum(["ok", "invalid"]) }).strict();
const ConsumeOAuthStateResultSchema = z
	.object({ status: z.enum(["ok", "invalid", "expired", "consumed", "mismatch"]) })
	.strict();

interface OAuthAuthorizationStateRpcStub {
	createOAuthAuthorizationAttempt(input: {
		readonly state: string;
		readonly provider: OAuthProvider;
		readonly redirectUri: string;
		readonly createdAtMs: number;
		readonly expiresAtMs: number;
	}): Promise<unknown>;
	consumeOAuthAuthorizationAttempt(input: {
		readonly state: string;
		readonly provider: OAuthProvider;
		readonly redirectUri: string;
		readonly consumedAtMs: number;
	}): Promise<unknown>;
}

/** Durable Object adapter for expiring, one-time OAuth authorization state. */
export class DurableObjectOAuthAuthorizationState implements OAuthAuthorizationStateStore {
	constructor(
		private readonly namespace: Cloudflare.Env["OAUTH_STATE_DO"],
		private readonly nowMilliseconds: () => number,
		private readonly createStateValue: () => string,
		private readonly lifetimeMilliseconds: number,
	) {}

	/** Creates one runtime-validated state value bound to a provider and redirect URI. */
	async create(
		provider: OAuthProvider,
		redirectUri: string,
	): Promise<ResultType<string, OAuthAuthorizationStateError>> {
		const state = this.createStateValue();
		const createdAtMs = this.nowMilliseconds();
		try {
			const raw: unknown = await this.acquireStateStub(state).createOAuthAuthorizationAttempt({
				state,
				provider,
				redirectUri,
				createdAtMs,
				expiresAtMs: createdAtMs + this.lifetimeMilliseconds,
			});
			const parsed = CreateOAuthStateResultSchema.safeParse(raw);
			if (!parsed.success || parsed.data.status !== "ok") {
				return Result.err(
					new OAuthAuthorizationStateError({
						operation: "create",
						failure: "protocol",
						cause: parsed.success ? undefined : parsed.error,
					}),
				);
			}
			return Result.ok(state);
		} catch (cause) {
			return Result.err(
				new OAuthAuthorizationStateError({ operation: "create", failure: "transport", cause }),
			);
		}
	}

	/** Consumes and parses one matching OAuth state value exactly once. */
	async consume(
		provider: OAuthProvider,
		redirectUri: string,
		state: string,
	): Promise<
		ResultType<"ok" | "invalid" | "expired" | "consumed" | "mismatch", OAuthAuthorizationStateError>
	> {
		try {
			const raw: unknown = await this.acquireStateStub(state).consumeOAuthAuthorizationAttempt({
				state,
				provider,
				redirectUri,
				consumedAtMs: this.nowMilliseconds(),
			});
			const parsed = ConsumeOAuthStateResultSchema.safeParse(raw);
			return parsed.success
				? Result.ok(parsed.data.status)
				: Result.err(
						new OAuthAuthorizationStateError({
							operation: "consume",
							failure: "protocol",
							cause: parsed.error,
						}),
					);
		} catch (cause) {
			return Result.err(
				new OAuthAuthorizationStateError({ operation: "consume", failure: "transport", cause }),
			);
		}
	}

	private acquireStateStub(state: string): OAuthAuthorizationStateRpcStub {
		return this.namespace.getByName(state);
	}
}
