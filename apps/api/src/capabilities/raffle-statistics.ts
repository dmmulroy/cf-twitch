import { TaggedError } from "better-result";

import type { RaffleLeaderboardEntry, RaffleLeaderboardQuery } from "../domain/keyboard-raffle";
import type { Result } from "better-result";

/** Expected failure when Keyboard Raffle statistics cannot be read or parsed. */
export class RaffleStatisticsReadError extends TaggedError("RaffleStatisticsReadError")<{
	readonly operation: RaffleStatisticsOperation;
	readonly failure: "transport" | "protocol" | "query" | "persistence";
	readonly remoteErrorTag?: string;
	readonly message: string;
	readonly cause?: unknown;
}> {
	constructor(args: {
		operation: RaffleStatisticsOperation;
		failure: "transport" | "protocol" | "query" | "persistence";
		remoteErrorTag?: string;
		cause?: unknown;
	}) {
		super({
			...args,
			message: `Raffle statistics read failed during ${args.operation} (${args.failure})`,
		});
	}
}

/** Expected absence when no Keyboard Raffle statistics exist for a Viewer. */
export class RaffleViewerNotFoundError extends TaggedError("RaffleViewerNotFoundError")<{
	readonly operation: "getViewerStats" | "getViewerStatsByDisplayName";
	readonly viewerReference: string;
	readonly message: string;
}> {
	constructor(args: {
		operation: "getViewerStats" | "getViewerStatsByDisplayName";
		viewerReference: string;
	}) {
		super({
			...args,
			message: `Raffle Viewer statistics not found during ${args.operation}`,
		});
	}
}

/** Keyboard Raffle statistics operations used for typed failure classification. */
export type RaffleStatisticsOperation =
	| "getLeaderboard"
	| "getViewerStats"
	| "getViewerStatsByDisplayName";

/** Expected failures returned by the Keyboard Raffle statistics capability. */
export type RaffleStatisticsError = RaffleStatisticsReadError | RaffleViewerNotFoundError;

/** Reads the Raffle Leaderboard and one Viewer's Keyboard Raffle statistics. */
export interface RaffleStatistics {
	/** Reads a bounded Raffle Leaderboard in the requested order. */
	getLeaderboard(
		options: RaffleLeaderboardQuery,
	): Promise<Result<readonly RaffleLeaderboardEntry[], RaffleStatisticsError>>;
	/** Reads one Viewer's persisted Keyboard Raffle statistics. */
	getViewerStats(viewerId: string): Promise<Result<RaffleLeaderboardEntry, RaffleStatisticsError>>;
	/** Reads one Viewer's statistics by historical display name. */
	getViewerStatsByDisplayName(
		displayName: string,
	): Promise<Result<RaffleLeaderboardEntry, RaffleStatisticsError>>;
}
