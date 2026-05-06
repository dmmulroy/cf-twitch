import { TaggedError } from "better-result";

import type { CommandsError } from "../errors";

/**
 * Catalog-layer errors that can occur while resolving command metadata.
 *
 * @param error - Underlying command registry error.
 * @returns A command catalog error union.
 */
export type ChatCommandCatalogError = CommandsError;

/**
 * Error raised when a command response cannot be rendered.
 *
 * @param args - Command name, optional cause, and optional message for the render failure.
 * @returns A tagged chat command render error instance.
 */
export class ChatCommandRenderError extends TaggedError("ChatCommandRenderError")<{
	commandName: string;
	message: string;
	cause?: unknown;
}>() {
	constructor(args: { commandName: string; cause?: unknown; message?: string }) {
		super({
			commandName: args.commandName,
			cause: args.cause,
			message: args.message ?? `Failed to render chat command: ${args.commandName}`,
		});
	}
}

/**
 * Error raised when Twitch chat send fails.
 *
 * @param args - Optional cause and message describing the send failure.
 * @returns A tagged chat command send error instance.
 */
export class ChatCommandSendError extends TaggedError("ChatCommandSendError")<{
	message: string;
	cause?: unknown;
}>() {
	constructor(args: { cause?: unknown; message?: string }) {
		super({
			cause: args.cause,
			message: args.message ?? "Failed to send chat command response",
		});
	}
}

/**
 * Error raised when computed command execution fails.
 *
 * @param args - Command name, optional cause, and optional message for the execution failure.
 * @returns A tagged chat command execution error instance.
 */
export class ChatCommandExecutionError extends TaggedError("ChatCommandExecutionError")<{
	commandName: string;
	message: string;
	cause?: unknown;
}>() {
	constructor(args: { commandName: string; cause?: unknown; message?: string }) {
		super({
			commandName: args.commandName,
			cause: args.cause,
			message: args.message ?? `Failed to execute chat command: ${args.commandName}`,
		});
	}
}

/**
 * All errors surfaced by the chat command executor.
 *
 * @param error - Catalog, render, send, or execution error value.
 * @returns A chat command error union.
 */
export type ChatCommandError =
	| ChatCommandCatalogError
	| ChatCommandRenderError
	| ChatCommandSendError
	| ChatCommandExecutionError;
