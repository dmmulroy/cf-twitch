import { ChatCommandEngine } from "./executor";
import { makeComputedCommandHandlers } from "./handlers";

import type { AchievementReader } from "../../capabilities/http-state-readers";
import type { RaffleStatistics } from "../../capabilities/raffle-statistics";
import type { SongQueue } from "../../capabilities/song-queue";
import type { Clock } from "../clock";
import type { Logger } from "../logging";
import type {
	ChatCommandExecutor,
	ChatCommandMetrics,
	ChatCommandSendCheckpoint,
	ChatSender,
	CommandCatalog,
	CommandCounterStore,
} from "./types";

/** Exact dependencies required to compose the production Chat Command engine. */
export type ChatCommandEngineDependencies = Readonly<{
	catalog: CommandCatalog;
	counters: CommandCounterStore;
	sender: ChatSender;
	metrics: ChatCommandMetrics;
	achievements: AchievementReader;
	raffles: RaffleStatistics;
	songQueue: SongQueue;
	clock: Clock;
	logger: Logger;
	sendCheckpoint?: ChatCommandSendCheckpoint;
}>;

/** Constructs the Chat Command engine without Worker bindings or ambient dependencies. */
export function makeChatCommandExecutor(
	dependencies: ChatCommandEngineDependencies,
): ChatCommandExecutor {
	return new ChatCommandEngine(
		dependencies.catalog,
		dependencies.sender,
		dependencies.metrics,
		makeComputedCommandHandlers({
			catalog: dependencies.catalog,
			clock: dependencies.clock,
			counters: dependencies.counters,
			achievements: dependencies.achievements,
			raffles: dependencies.raffles,
			songQueue: dependencies.songQueue,
		}),
		dependencies.clock,
		dependencies.logger,
		dependencies.sendCheckpoint,
	);
}

/**
 * Re-export the shared system clock implementation.
 *
 * @returns SystemClock constructor from the shared clock module.
 */
export { SystemClock } from "../clock";
/**
 * Re-export the chat command engine implementation.
 *
 * @returns ChatCommandEngine constructor from the executor module.
 */
export { ChatCommandEngine } from "./executor";
/**
 * Re-export chat command error constructors.
 *
 * @returns Chat command tagged error constructors from the errors module.
 */
export { ChatCommandSendError, ChatCommandExecutionError, ChatCommandRenderError } from "./errors";
/**
 * Re-export chat command response helpers.
 *
 * @returns Helper functions for constructing chat command responses.
 */
export { chatNoResponse, chatTextResponse } from "./types";
/**
 * Re-export chat command error types.
 *
 * @returns Chat command error type aliases from the errors module.
 */
export type { ChatCommandError, ChatCommandCatalogError } from "./errors";
/**
 * Re-export chat command public types.
 *
 * @returns Public chat command interfaces and type aliases from the types module.
 */
export type {
	ChatCommandExecution,
	ChatCommandExecutor,
	ChatCommandInput,
	ChatCommandMetrics,
	ChatCommandMetric,
	ChatCommandResponse,
	ChatCommandSendCheckpoint,
	ChatSender,
	CommandCatalog,
	ComputedCommandContext,
	ComputedCommandHandler,
	ComputedCommandHandlers,
} from "./types";
/**
 * Re-export the shared clock interface.
 *
 * @returns Clock interface from the shared clock module.
 */
export type { Clock } from "../clock";
/**
 * Re-export the shared logger interface.
 *
 * @returns Logger interface from the shared logging module.
 */
export type { Logger } from "../logging";
