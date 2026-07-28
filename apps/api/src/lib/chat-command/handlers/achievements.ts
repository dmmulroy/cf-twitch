import { Result } from "better-result";

import { chatTextResponse } from "../types";

import type { AchievementReader } from "../../../capabilities/http-state-readers";
import type { ComputedCommandContext, ComputedCommandHandler } from "../types";

/**
 * Computed chat command handler for achievement lookups.
 */
export class AchievementsCommandHandler implements ComputedCommandHandler {
	constructor(private readonly achievements: AchievementReader) {}

	/**
	 * List unlocked achievements for the requested target user, defaulting to the invoking viewer.
	 *
	 * @param context - Command invocation context containing the optional target user argument.
	 * @returns A Result containing a chat response with achievement details.
	 */
	async handle(context: ComputedCommandContext) {
		const targetUser = context.arg ?? context.viewer.displayName;
		const result = await this.achievements.getViewerUnlockedAchievements(targetUser);
		if (result.status === "error") {
			return Result.ok(
				chatTextResponse(`Sorry, couldn't retrieve achievements for @${targetUser}.`),
			);
		}

		const achievements = result.value;
		if (achievements.length === 0) {
			return Result.ok(chatTextResponse(`@${targetUser} hasn't unlocked any achievements yet.`));
		}

		const names = achievements.map((achievement) => achievement.name).join(", ");
		return Result.ok(
			chatTextResponse(
				`@${targetUser} has unlocked ${achievements.length} achievement${achievements.length === 1 ? "" : "s"}: ${names}`,
			),
		);
	}
}
