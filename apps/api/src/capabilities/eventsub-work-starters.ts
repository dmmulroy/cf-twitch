import { TaggedError } from "better-result";

import type { KnownRewardRedemption } from "../lib/channel-point-redemptions";
import type { Result } from "better-result";

/** Parsed raid evidence required to start the durable Raid Shoutout saga. */
export type RaidShoutoutInput = Readonly<{
	messageId: string;
	receivedAt: string;
	raider: Readonly<{ userId: string; login: string; displayName: string }>;
	viewers: number;
}>;

/** Expected failure when EventSub cannot start durable downstream work. */
export class EventSubWorkStartError extends TaggedError("EventSubWorkStartError")<{
	readonly work: "song-request" | "keyboard-raffle" | "raid-shoutout";
	readonly operationId: string;
	readonly failure: "transport" | "protocol" | "remote";
	readonly remoteErrorTag?: string;
	readonly message: string;
	readonly cause?: unknown;
}> {
	constructor(args: {
		work: "song-request" | "keyboard-raffle" | "raid-shoutout";
		operationId: string;
		failure: "transport" | "protocol" | "remote";
		remoteErrorTag?: string;
		cause?: unknown;
	}) {
		super({ ...args, message: `EventSub durable work start failed for ${args.work}` });
	}
}

/** Starts durable Song Request, Keyboard Raffle, and Raid Shoutout work. */
export interface EventSubWorkStarters {
	/** Starts one Song Request saga keyed by Channel Point Redemption ID. */
	startSongRequest(
		redemption: KnownRewardRedemption,
	): Promise<Result<void, EventSubWorkStartError>>;
	/** Starts one Keyboard Raffle saga keyed by Channel Point Redemption ID. */
	startKeyboardRaffle(
		redemption: KnownRewardRedemption,
	): Promise<Result<void, EventSubWorkStartError>>;
	/** Starts one Raid Shoutout saga keyed by Twitch EventSub message ID. */
	startRaidShoutout(input: RaidShoutoutInput): Promise<Result<void, EventSubWorkStartError>>;
}
