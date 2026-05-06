import { TwitchService } from "../../services/twitch-service";
import { SystemClock } from "../clock";
import { logger } from "../logger";
import { CommandsDOCommandCatalog } from "./catalog";
import { ChatCommandEngine } from "./executor";
import { makeComputedCommandHandlers } from "./handlers";
import { AnalyticsEngineChatCommandMetrics } from "./metrics";
import { TwitchChatSender } from "./sender";

import type { Env } from "../../index";
import type { ChatCommandExecutor } from "./types";

/**
 * Construct the production chat command executor for the worker environment.
 *
 * @param env - Worker environment containing service bindings and analytics dataset.
 * @returns A configured chat command executor.
 */
export function makeChatCommandExecutor(env: Env): ChatCommandExecutor {
	const catalog = new CommandsDOCommandCatalog();
	const clock = new SystemClock();
	return new ChatCommandEngine(
		catalog,
		new TwitchChatSender(new TwitchService(env)),
		new AnalyticsEngineChatCommandMetrics(env.ANALYTICS),
		makeComputedCommandHandlers({ catalog, clock }),
		clock,
		logger.child({ module: "chat-command" }),
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
