import { Result } from "better-result";

import { UserStatsNotFoundError } from "../../../durable-objects/keyboard-raffle-do";
import { getStub } from "../../durable-objects";
import { getSongQueue } from "../../song-queue-client";
import { chatTextResponse } from "../types";

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
	/**
	 * Aggregate song request, achievement, and raffle stats for a viewer or target user.
	 *
	 * @param context - Command invocation context containing viewer identity and optional target user.
	 * @returns A Result containing a chat response with combined viewer stats.
	 */
	async handle(context: ComputedCommandContext) {
		const isSelf = context.arg === null;
		const targetUser = context.arg ?? context.viewer.displayName;
		const achievementsStub = getStub("ACHIEVEMENTS_DO");
		const [unlockedResult, definitionsResult] = await Promise.all([
			achievementsStub.getUnlockedAchievements(targetUser),
			achievementsStub.getDefinitions(),
		]);

		let achievementStats = "?/?";
		let unlockedCount: number | null = null;
		let totalAchievementCount: number | null = null;
		if (unlockedResult.status === "ok" && definitionsResult.status === "ok") {
			unlockedCount = unlockedResult.value.length;
			totalAchievementCount = definitionsResult.value.length;
			achievementStats = `${unlockedCount}/${totalAchievementCount}`;
		}

		const raffleStub = getStub("KEYBOARD_RAFFLE_DO");
		using songQueue = await getSongQueue();
		const [songResult, raffleResult] = await Promise.all([
			isSelf
				? songQueue.getUserRequestCount(context.viewer.userId)
				: songQueue.getUserRequestCountByDisplayName(targetUser),
			isSelf
				? raffleStub.getUserStats(context.viewer.userId)
				: raffleStub.getUserStatsByDisplayName(targetUser),
		]);

		const songCount = songResult.status === "ok" ? songResult.value : 0;
		const raffleStats =
			raffleResult.status === "ok" ? formatRaffleStats(raffleResult.value) : "0 rolls";
		const noStatsForTargetUser =
			!isSelf &&
			songResult.status === "ok" &&
			songResult.value === 0 &&
			unlockedCount === 0 &&
			totalAchievementCount !== null &&
			raffleResult.status === "error" &&
			UserStatsNotFoundError.is(raffleResult.error);

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
