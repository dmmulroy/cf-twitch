import { Result } from "better-result";

import { getStub } from "../../durable-objects";
import { getSongQueue } from "../../song-queue-client";
import { ChatCommandExecutionError } from "../errors";
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
		let songQueue: Awaited<ReturnType<typeof getSongQueue>>;
		try {
			songQueue = await getSongQueue();
		} catch (cause) {
			return Result.err(
				new ChatCommandExecutionError({
					commandName: "stats",
					cause,
					message: "Viewer stats unavailable: Song Queue connection failed",
				}),
			);
		}
		using disposableSongQueue = songQueue;
		const [songResult, raffleResult] = await Promise.all([
			isSelf
				? disposableSongQueue.getUserRequestCount(context.viewer.userId)
				: disposableSongQueue.getUserRequestCountByDisplayName(targetUser),
			isSelf
				? raffleStub.getUserStats(context.viewer.userId)
				: raffleStub.getUserStatsByDisplayName(targetUser),
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
		if (raffleResult.status === "error" && raffleResult.error._tag !== "UserStatsNotFoundError") {
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
			raffleResult.error._tag === "UserStatsNotFoundError";

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
