import { DurableObject } from "cloudflare:workers";
import { z } from "zod";

const OAuthProviderSchema = z.enum(["spotify", "twitch"]);
const OAuthStateValueSchema = z.string().uuid();
const OAuthRedirectUriSchema = z.url();

const OAuthAuthorizationAttemptSchema = z.object({
	state: OAuthStateValueSchema,
	provider: OAuthProviderSchema,
	redirectUri: OAuthRedirectUriSchema,
	createdAtMs: z.number().int().nonnegative(),
	expiresAtMs: z.number().int().positive(),
	consumedAtMs: z.number().int().nonnegative().nullable(),
});

const CreateOAuthAuthorizationAttemptSchema = OAuthAuthorizationAttemptSchema.pick({
	state: true,
	provider: true,
	redirectUri: true,
	createdAtMs: true,
	expiresAtMs: true,
});

const ConsumeOAuthAuthorizationAttemptSchema = z.object({
	state: OAuthStateValueSchema,
	provider: OAuthProviderSchema,
	redirectUri: OAuthRedirectUriSchema,
	consumedAtMs: z.number().int().nonnegative(),
});

type OAuthAuthorizationAttempt = z.infer<typeof OAuthAuthorizationAttemptSchema>;

/** Durable one-time store that atomically validates and consumes an OAuth state value. */
export class OAuthStateDO extends DurableObject {
	/** Persists one expiring provider authorization attempt before redirecting the operator. */
	async createOAuthAuthorizationAttempt(input: unknown): Promise<{ readonly status: "ok" | "invalid" }> {
		const parsed = CreateOAuthAuthorizationAttemptSchema.safeParse(input);
		if (!parsed.success || parsed.data.expiresAtMs <= parsed.data.createdAtMs) {
			return { status: "invalid" };
		}

		const attempt: OAuthAuthorizationAttempt = { ...parsed.data, consumedAtMs: null };
		await this.ctx.storage.put("authorization-attempt", attempt);
		await this.ctx.storage.setAlarm(attempt.expiresAtMs);
		return { status: "ok" };
	}

	/** Consumes matching OAuth state exactly once and rejects malformed, expired, or replayed attempts. */
	async consumeOAuthAuthorizationAttempt(input: unknown): Promise<{
		readonly status: "ok" | "invalid" | "expired" | "consumed" | "mismatch";
	}> {
		const parsedInput = ConsumeOAuthAuthorizationAttemptSchema.safeParse(input);
		if (!parsedInput.success) return { status: "invalid" };

		return this.ctx.storage.transaction(async (transaction) => {
			const stored: unknown = await transaction.get("authorization-attempt");
			const parsedStored = OAuthAuthorizationAttemptSchema.safeParse(stored);
			if (!parsedStored.success) return { status: "invalid" as const };

			const attempt = parsedStored.data;
			if (attempt.consumedAtMs !== null) return { status: "consumed" as const };
			if (parsedInput.data.consumedAtMs > attempt.expiresAtMs) return { status: "expired" as const };
			if (
				attempt.state !== parsedInput.data.state ||
				attempt.provider !== parsedInput.data.provider ||
				attempt.redirectUri !== parsedInput.data.redirectUri
			) return { status: "mismatch" as const };

			await transaction.put("authorization-attempt", {
				...attempt,
				consumedAtMs: parsedInput.data.consumedAtMs,
			});
			return { status: "ok" as const };
		});
	}

	/** Removes expired OAuth state after the callback validation window closes. */
	async alarm(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}
