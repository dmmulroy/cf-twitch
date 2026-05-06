import { Result } from "better-result";

import { getStub } from "../../durable-objects";
import { chatTextResponse } from "../types";

import type { UnlockedAchievement } from "../../../durable-objects/achievements-do";
import type { ComputedCommandContext, ComputedCommandHandler } from "../types";

/**
 * Computed chat command handler for achievement lookups.
 */
export class AchievementsCommandHandler implements ComputedCommandHandler {
	/**
	 * List unlocked achievements for the requested target user, defaulting to the invoking viewer.
	 *
	 * @param context - Command invocation context containing the optional target user argument.
	 * @returns A Result containing a chat response with achievement details.
	 */
	async handle(context: ComputedCommandContext) {
		const targetUser = context.arg ?? context.viewer.displayName;
		const result = await getStub("ACHIEVEMENTS_DO").getUnlockedAchievements(targetUser);
		if (result.status === "error") {
			return Result.ok(
				chatTextResponse(`Sorry, couldn't retrieve achievements for @${targetUser}.`),
			);
		}

		const achievements: UnlockedAchievement[] = result.value;
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
