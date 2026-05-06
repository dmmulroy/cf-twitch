import { CommandsDOCommandCounterStore } from "../catalog";
import { AchievementsCommandHandler } from "./achievements";
import { CommandsCommandHandler } from "./commands";
import { RaffleLeaderboardCommandHandler } from "./raffle-leaderboard";
import { SkillIssueCommandHandler } from "./skillissue";
import { QueueCommandHandler, SongCommandHandler } from "./song";
import { StatsCommandHandler } from "./stats";
import { TimeCommandHandler } from "./time";
import { UpdateCommandHandler } from "./update";

import type { Clock } from "../../clock";
import type { CommandCatalog, CommandCounterStore, ComputedCommandHandlers } from "../types";

/**
 * Build the computed command handler registry with explicit handler dependencies.
 *
 * @param dependencies - Shared catalog, clock, and optional counter store dependencies.
 * @returns A handler registry keyed by command handler key.
 */
export function makeComputedCommandHandlers(dependencies: {
	catalog: CommandCatalog;
	clock: Clock;
	counters?: CommandCounterStore;
}): ComputedCommandHandlers {
	const counters = dependencies.counters ?? new CommandsDOCommandCounterStore();
	return {
		achievements: new AchievementsCommandHandler(),
		commands: new CommandsCommandHandler(dependencies.catalog),
		queue: new QueueCommandHandler(),
		"raffle-leaderboard": new RaffleLeaderboardCommandHandler(),
		skillissue: new SkillIssueCommandHandler(counters),
		song: new SongCommandHandler(),
		stats: new StatsCommandHandler(),
		time: new TimeCommandHandler(dependencies.clock),
		update: new UpdateCommandHandler(dependencies.catalog),
	};
}

/**
 * Re-export the achievements command handler.
 *
 * @returns AchievementsCommandHandler constructor from the handler module.
 */
export { AchievementsCommandHandler } from "./achievements";
/**
 * Re-export the commands list command handler.
 *
 * @returns CommandsCommandHandler constructor from the handler module.
 */
export { CommandsCommandHandler } from "./commands";
/**
 * Re-export the raffle leaderboard command handler.
 *
 * @returns RaffleLeaderboardCommandHandler constructor from the handler module.
 */
export { RaffleLeaderboardCommandHandler } from "./raffle-leaderboard";
/**
 * Re-export song-related command handlers.
 *
 * @returns QueueCommandHandler and SongCommandHandler constructors from the handler module.
 */
export { QueueCommandHandler, SongCommandHandler } from "./song";
/**
 * Re-export the stats command handler.
 *
 * @returns StatsCommandHandler constructor from the handler module.
 */
export { StatsCommandHandler } from "./stats";
/**
 * Re-export the skill issue command handler.
 *
 * @returns SkillIssueCommandHandler constructor from the handler module.
 */
export { SkillIssueCommandHandler } from "./skillissue";
/**
 * Re-export the time command handler.
 *
 * @returns TimeCommandHandler constructor from the handler module.
 */
export { TimeCommandHandler } from "./time";
/**
 * Re-export the update command handler.
 *
 * @returns UpdateCommandHandler constructor from the handler module.
 */
export { UpdateCommandHandler } from "./update";
