import { Result } from "better-result";

import { chatTextResponse } from "../types";

import type { RaffleStatistics } from "../../../capabilities/raffle-statistics";
import type { ComputedCommandHandler } from "../types";

/**
 * Computed chat command handler for keyboard raffle leaderboard lookups.
 */
export class RaffleLeaderboardCommandHandler implements ComputedCommandHandler {
	constructor(private readonly raffles: RaffleStatistics) {}

	/**
	 * Display recent keyboard raffle winners ordered by win count.
	 *
	 * @returns A Result containing a chat response with raffle leaderboard information.
	 */
	async handle() {
		const result = await this.raffles.getLeaderboard({ sortBy: "wins", limit: 5 });
		if (result.status === "error") {
			return Result.ok(chatTextResponse("Sorry, couldn't retrieve the raffle leaderboard."));
		}

		const entries = result.value;
		if (entries.length === 0) {
			return Result.ok(chatTextResponse("No raffle rolls recorded yet."));
		}

		const winners = entries.filter((entry) => entry.totalWins > 0);
		if (winners.length === 0) {
			return Result.ok(chatTextResponse("No raffle winners yet — be the first!"));
		}

		const leaderboard = winners
			.map((entry, idx) => `${idx + 1}. @${entry.displayName} (${entry.totalWins})`)
			.join(" ");

		return Result.ok(chatTextResponse(`Raffle wins: ${leaderboard}`));
	}
}
