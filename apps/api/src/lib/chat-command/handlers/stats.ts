import { Result } from "better-result";

import { RaffleViewerNotFoundError } from "../../../capabilities/raffle-statistics";
import { ChatCommandExecutionError } from "../errors";
import { chatTextResponse } from "../types";

import type { AchievementReader } from "../../../capabilities/http-state-readers";
import type { RaffleStatistics } from "../../../capabilities/raffle-statistics";
import type { SongRequestStatistics } from "../../../capabilities/song-queue";
import type { ComputedCommandContext, ComputedCommandHandler } from "../types";

function formatRaffleStats(entry: {
	totalRolls: number;
	totalWins: number;
	closestDistance: number | null;
}): string {
	const base = `${entry.totalRolls} rolls`;
	const extras: string[] = [];
	if (entry.closestDistance !== null) {
		extras.push(`closest: ${entry.closestDistance}`);
	}
	if (entry.totalWins > 0) {
		extras.push(`${entry.totalWins} win${entry.totalWins > 1 ? "s" : ""}!`);
	}
	return extras.length > 0 ? `${base} (${extras.join(", ")})` : base;
}

/**
 * Computed chat command handler for combined viewer stats.
 */
export class StatsCommandHandler implements ComputedCommandHandler {
	constructor(
		private readonly achievements: AchievementReader,
		private readonly songRequests: SongRequestStatistics,
		private readonly raffles: RaffleStatistics,
	) {}

	/**
	 * Aggregate song request, achievement, and raffle stats for a viewer or target user.
	 *
	 * @param context - Command invocation context containing viewer identity and optional target user.
	 * @returns A Result containing a chat response with combined viewer stats.
	 */
	async handle(context: ComputedCommandContext) {
		const isSelf = context.arg === null;
		const targetUser = context.arg ?? context.viewer.displayName;
		const [unlockedResult, definitionsResult] = await Promise.all([
			this.achievements.getViewerUnlockedAchievements(targetUser),
			this.achievements.getDefinitions(),
		]);

		let achievementStats = "?/?";
		let unlockedCount: number | null = null;
		let totalAchievementCount: number | null = null;
		if (unlockedResult.status === "ok" && definitionsResult.status === "ok") {
			unlockedCount = unlockedResult.value.length;
			totalAchievementCount = definitionsResult.value.length;
			achievementStats = `${unlockedCount}/${totalAchievementCount}`;
		}

		const [songResult, raffleResult] = await Promise.all([
			isSelf
				? this.songRequests.getViewerRequestCount(context.viewer.userId)
				: this.songRequests.getViewerRequestCountByDisplayName(targetUser),
			isSelf
				? this.raffles.getViewerStats(context.viewer.userId)
				: this.raffles.getViewerStatsByDisplayName(targetUser),
		]);

		if (songResult.status === "error") {
			return Result.err(
				new ChatCommandExecutionError({
					commandName: "stats",
					cause: songResult.error,
					message: "Viewer stats unavailable: Song Queue lookup failed",
				}),
			);
		}
		if (raffleResult.status === "error" && !RaffleViewerNotFoundError.is(raffleResult.error)) {
			return Result.err(
				new ChatCommandExecutionError({
					commandName: "stats",
					cause: raffleResult.error,
					message: "Viewer stats unavailable: Keyboard Raffle lookup failed",
				}),
			);
		}
		const songCount = songResult.value;
		const raffleStats =
			raffleResult.status === "ok" ? formatRaffleStats(raffleResult.value) : "0 rolls";
		const noStatsForTargetUser =
			!isSelf &&
			songResult.status === "ok" &&
			songResult.value === 0 &&
			unlockedCount === 0 &&
			totalAchievementCount !== null &&
			raffleResult.status === "error" &&
			RaffleViewerNotFoundError.is(raffleResult.error);

		if (noStatsForTargetUser) {
			return Result.ok(
				chatTextResponse(
					`No records found for @${targetUser} yet — no songs, achievements, or raffle stats.`,
				),
			);
		}

		return Result.ok(
			chatTextResponse(
				`@${targetUser} — Songs: ${songCount} | Achievements: ${achievementStats} | Raffles: ${raffleStats}`,
			),
		);
	}
}
