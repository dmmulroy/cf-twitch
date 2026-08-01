import { Result, TaggedError } from "better-result";
import { z } from "zod";

import { RedactedValue } from "../lib/redacted";

const WorkerBindingsConfigurationSchema = z.object({
	TWITCH_CLIENT_ID: z.string().trim().min(1),
	TWITCH_CLIENT_SECRET: z.string().min(1),
	TWITCH_BROADCASTER_ID: z.string().trim().min(1),
	TWITCH_BROADCASTER_NAME: z.string().trim().min(1),
	TWITCH_EVENTSUB_SECRET: z.string().min(1),
	SPOTIFY_CLIENT_ID: z.string().trim().min(1),
	SPOTIFY_CLIENT_SECRET: z.string().min(1),
	OAUTH_SETUP_SECRET: z.string().min(1),
	ADMIN_SECRET: z.string().min(1),
	SONG_REQUEST_REWARD_ID: z.string().trim().min(1),
	KEYBOARD_RAFFLE_REWARD_ID: z.string().trim().min(1),
});

/** Parsed Twitch broadcaster identity used by provider and application modules. */
export type TwitchBroadcaster = Readonly<{
	id: string;
	displayName: string;
}>;

/** Parsed Twitch provider credentials and broadcaster identity. */
export type TwitchProviderConfiguration = Readonly<{
	clientId: string;
	clientSecret: RedactedValue<string>;
	broadcaster: TwitchBroadcaster;
}>;

/** Parsed Spotify provider credentials. */
export type SpotifyProviderConfiguration = Readonly<{
	clientId: string;
	clientSecret: RedactedValue<string>;
}>;

/** Parsed reward identities used to route Channel Point Redemptions. */
export type RewardRoutingConfiguration = Readonly<{
	songRequestRewardId: string;
	keyboardRaffleRewardId: string;
}>;

/** Application configuration parsed once at a Worker or Durable Object composition root. */
export type WorkerConfiguration = Readonly<{
	twitch: TwitchProviderConfiguration;
	spotify: SpotifyProviderConfiguration;
	eventSubSecret: RedactedValue<string>;
	oauthSetupSecret: RedactedValue<string>;
	administratorSecret: RedactedValue<string>;
	rewardRouting: RewardRoutingConfiguration;
}>;

/** Expected failure when required Worker configuration cannot be parsed safely. */
export class WorkerConfigurationError extends TaggedError("WorkerConfigurationError")<{
	readonly message: string;
	readonly parseError: string;
}> {
	constructor(parseError: string) {
		super({ message: "Worker configuration parsing failed", parseError });
	}
}

/** Parses raw Worker bindings into typed, redacted application configuration. */
export function parseWorkerConfiguration(
	bindings: unknown,
): Result<WorkerConfiguration, WorkerConfigurationError> {
	const parsed = WorkerBindingsConfigurationSchema.safeParse(bindings);
	if (!parsed.success) return Result.err(new WorkerConfigurationError(parsed.error.message));
	return Result.ok({
		twitch: {
			clientId: parsed.data.TWITCH_CLIENT_ID,
			clientSecret: RedactedValue.fromSensitiveValue(parsed.data.TWITCH_CLIENT_SECRET),
			broadcaster: {
				id: parsed.data.TWITCH_BROADCASTER_ID,
				displayName: parsed.data.TWITCH_BROADCASTER_NAME,
			},
		},
		spotify: {
			clientId: parsed.data.SPOTIFY_CLIENT_ID,
			clientSecret: RedactedValue.fromSensitiveValue(parsed.data.SPOTIFY_CLIENT_SECRET),
		},
		eventSubSecret: RedactedValue.fromSensitiveValue(parsed.data.TWITCH_EVENTSUB_SECRET),
		oauthSetupSecret: RedactedValue.fromSensitiveValue(parsed.data.OAUTH_SETUP_SECRET),
		administratorSecret: RedactedValue.fromSensitiveValue(parsed.data.ADMIN_SECRET),
		rewardRouting: {
			songRequestRewardId: parsed.data.SONG_REQUEST_REWARD_ID,
			keyboardRaffleRewardId: parsed.data.KEYBOARD_RAFFLE_REWARD_ID,
		},
	});
}
