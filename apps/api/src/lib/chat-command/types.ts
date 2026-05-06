import type { Command } from "../../durable-objects/commands-do";
import type { Permission } from "../permissions";
import type { ChatCommandCatalogError, ChatCommandError } from "./errors";
import type { Result } from "better-result";

/**
 * Input adapted from a verified Twitch chat message for command execution.
 *
 * @param messageId - Twitch EventSub message identifier used for logs and correlation.
 * @param text - Raw chat message text to parse for a command invocation.
 * @param receivedAt - ISO timestamp representing when the message was received.
 * @param viewer - Viewer identity and permission information.
 * @returns A serializable command execution input value.
 */
export interface ChatCommandInput {
	messageId: string;
	text: string;
	receivedAt: string;
	viewer: {
		userId: string;
		displayName: string;
		permission: Permission;
	};
}

/**
 * Public result value describing how a chat command execution finished.
 *
 * @param commandName - Canonical command name when one was parsed or executed.
 * @param reason - Reason an invocation was ignored.
 * @param responseSent - Whether the executor sent a chat response.
 * @returns A discriminated union for ignored and completed executions.
 */
export type ChatCommandExecution =
	| {
			_tag: "ChatCommandIgnored";
			reason: "not_command" | "unknown_command" | "disabled" | "permission_denied";
			commandName?: string;
	  }
	| {
			_tag: "ChatCommandCompleted";
			commandName: string;
			responseSent: boolean;
	  };

/**
 * Route-facing command executor seam.
 *
 * @param input - Adapted Twitch chat message to execute.
 * @returns A Result containing the execution summary or command error.
 */
export interface ChatCommandExecutor {
	execute(input: ChatCommandInput): Promise<Result<ChatCommandExecution, ChatCommandError>>;
}

/**
 * Registry and stored-value seam for command metadata.
 *
 * @param name - Canonical command name to read or mutate.
 * @param value - Stored command value to persist.
 * @param updatedBy - Display name of the viewer updating a command.
 * @param permission - Viewer permission used to filter available commands.
 * @returns Result-wrapped command metadata, values, or mutation completion.
 */
export interface CommandCatalog {
	getCommand(name: string): Promise<Result<Command, ChatCommandCatalogError>>;
	getCommandValue(name: string): Promise<Result<string | null, ChatCommandCatalogError>>;
	setCommandValue(
		name: string,
		value: string,
		updatedBy: string,
	): Promise<Result<void, ChatCommandCatalogError>>;
	getCommandsByPermission(
		permission: Permission,
	): Promise<Result<Command[], ChatCommandCatalogError>>;
}

/**
 * Narrow counter store seam for commands that increment named counters.
 *
 * @param name - Counter name to increment.
 * @returns A Result containing the updated counter value.
 */
export interface CommandCounterStore {
	incrementCounter(name: string): Promise<Result<number, ChatCommandError>>;
}

/**
 * Chat transport seam used by the executor after rendering a response.
 *
 * @param message - Chat message to send to Twitch.
 * @returns A Result indicating whether sending succeeded.
 */
export interface ChatSender {
	send(message: string): Promise<Result<void, ChatCommandError>>;
}

/**
 * Analytics payload emitted for a parsed chat command.
 *
 * @param command - Canonical command name.
 * @param userId - Twitch user identifier.
 * @param userName - Twitch display name.
 * @param status - Execution status bucket.
 * @param durationMs - Executor duration in milliseconds.
 * @param error - Optional error message for failed executions.
 * @returns A serializable analytics payload.
 */
export interface ChatCommandMetric {
	command: string;
	userId: string;
	userName: string;
	status: "success" | "ignored" | "error";
	durationMs: number;
	error?: string;
}

/**
 * Analytics sink seam for chat command metrics.
 *
 * @param metric - Metric payload to write.
 * @returns Nothing.
 */
export interface ChatCommandMetrics {
	write(metric: ChatCommandMetric): void;
}

/**
 * Handler response value that can represent text output or no chat output.
 *
 * @param message - Text response to send when present.
 * @returns A discriminated response union consumed by the executor.
 */
export type ChatCommandResponse =
	| {
			_tag: "ChatCommandTextResponse";
			message: string;
	  }
	| {
			_tag: "ChatCommandNoResponse";
	  };

/**
 * Create a text response for a computed chat command handler.
 *
 * @param message - Text to send to Twitch chat.
 * @returns A text response value.
 */
export function chatTextResponse(message: string): ChatCommandResponse {
	return { _tag: "ChatCommandTextResponse", message };
}

/**
 * Create a no-response value for a computed chat command handler.
 *
 * @returns A response value that suppresses chat output.
 */
export function chatNoResponse(): ChatCommandResponse {
	return { _tag: "ChatCommandNoResponse" };
}

/**
 * Per-invocation context passed to computed command handlers.
 *
 * @param arg - Optional raw argument text after the command name.
 * @param command - Command metadata resolved by the executor.
 * @param viewer - Viewer identity and permission information.
 * @returns Handler context for one command invocation.
 */
export interface ComputedCommandContext {
	arg: string | null;
	command: Command;
	viewer: {
		userId: string;
		displayName: string;
		permission: Permission;
	};
}

/**
 * Computed command handler seam.
 *
 * @param context - Invocation context for the command.
 * @returns A Result containing a handler response or command error.
 */
export interface ComputedCommandHandler {
	handle(context: ComputedCommandContext): Promise<Result<ChatCommandResponse, ChatCommandError>>;
}

/**
 * Registry of computed command handlers keyed by command handler key.
 *
 * @param key - Command handler key from command metadata.
 * @returns A handler lookup table used by the executor.
 */
export type ComputedCommandHandlers = Record<string, ComputedCommandHandler>;
