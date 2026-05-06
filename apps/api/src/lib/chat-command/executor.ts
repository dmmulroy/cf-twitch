import { Result } from "better-result";

import { parseCommandWithArg } from "../commands";
import { CommandNotFoundError } from "../errors";
import { hasPermission } from "../permissions";
import { applyOutputTemplate, renderStoredValueTemplate } from "./render";
import { chatTextResponse } from "./types";

import type { Command } from "../../durable-objects/commands-do";
import type { Clock } from "../clock";
import type { Logger } from "../logging";
import type { ChatCommandError } from "./errors";
import type {
	ChatCommandExecution,
	ChatCommandExecutor,
	ChatCommandInput,
	ChatCommandMetrics,
	ChatCommandResponse,
	ChatSender,
	CommandCatalog,
	ComputedCommandHandlers,
} from "./types";

function ignored(
	reason: "not_command" | "unknown_command" | "disabled" | "permission_denied",
	commandName?: string,
): ChatCommandExecution {
	if (commandName === undefined) {
		return { _tag: "ChatCommandIgnored", reason };
	}
	return { _tag: "ChatCommandIgnored", reason, commandName };
}

/**
 * Chat command executor that owns parsing, lookup, permission checks, rendering, sending, metrics, and logs.
 *
 * @param catalog - Catalog used to resolve command metadata and stored values.
 * @param sender - Chat sender used for rendered text responses.
 * @param metrics - Metric sink used to record parsed command outcomes.
 * @param handlers - Computed command handler registry.
 * @param clock - Clock used for duration measurement.
 * @param logger - Logger used for command lifecycle events.
 * @returns A chat command executor instance.
 */
export class ChatCommandEngine implements ChatCommandExecutor {
	constructor(
		private readonly catalog: CommandCatalog,
		private readonly sender: ChatSender,
		private readonly metrics: ChatCommandMetrics,
		private readonly handlers: ComputedCommandHandlers,
		private readonly clock: Clock,
		private readonly logger: Logger,
	) {}

	async execute(input: ChatCommandInput): Promise<Result<ChatCommandExecution, ChatCommandError>> {
		const startedAt = this.clock.now().getTime();
		const parsed = parseCommandWithArg(input.text);
		if (parsed === null) {
			return Result.ok(ignored("not_command"));
		}

		const commandName = parsed.command;
		const commandResult = await this.catalog.getCommand(commandName);
		if (commandResult.status === "error") {
			if (CommandNotFoundError.is(commandResult.error)) {
				this.writeMetric(input, commandName, "ignored", startedAt);
				return Result.ok(ignored("unknown_command", commandName));
			}
			this.writeMetric(input, commandName, "error", startedAt, commandResult.error.message);
			return Result.err(commandResult.error);
		}

		const command = commandResult.value;
		if (!command.enabled) {
			this.writeMetric(input, command.name, "ignored", startedAt);
			return Result.ok(ignored("disabled", command.name));
		}

		if (!hasPermission(input.viewer.permission, command.permission)) {
			this.writeMetric(input, command.name, "ignored", startedAt);
			return Result.ok(ignored("permission_denied", command.name));
		}

		const renderResult = await this.renderResponse(input, command, parsed.arg);
		if (renderResult.status === "error") {
			this.writeMetric(input, command.name, "error", startedAt, renderResult.error.message);
			return Result.err(renderResult.error);
		}

		const responseSent = renderResult.value._tag === "ChatCommandTextResponse";
		if (responseSent) {
			const sendResult = await this.sender.send(renderResult.value.message);
			if (sendResult.status === "error") {
				this.logger.warn("Failed to send chat command response", {
					event: "chat_command.response.send_failed",
					message_id: input.messageId,
					command: command.name,
					error_tag: sendResult.error._tag,
					error_message: sendResult.error.message,
				});
				this.writeMetric(input, command.name, "error", startedAt, sendResult.error.message);
				return Result.err(sendResult.error);
			}
		}

		this.logger.info("Chat command completed", {
			event: "chat_command.completed",
			message_id: input.messageId,
			command: command.name,
		});
		this.writeMetric(input, command.name, "success", startedAt);
		return Result.ok({
			_tag: "ChatCommandCompleted",
			commandName: command.name,
			responseSent,
		});
	}

	private async renderResponse(
		input: ChatCommandInput,
		command: Command,
		arg: string | null,
	): Promise<Result<ChatCommandResponse, ChatCommandError>> {
		if (command.responseType === "computed") {
			const handlerKey = command.handlerKey;
			const handler = handlerKey ? this.handlers[handlerKey] : undefined;
			if (handler === undefined) {
				return Result.ok(
					chatTextResponse(`!${command.name} is configured but has no live handler.`),
				);
			}

			return handler.handle({
				arg,
				command,
				viewer: input.viewer,
			});
		}

		const valueResult = await this.catalog.getCommandValue(command.name);
		if (valueResult.status === "error") {
			return Result.err(valueResult.error);
		}

		const value = valueResult.value;
		if (value === null || value.length === 0) {
			return Result.ok(
				chatTextResponse(command.emptyResponse ?? `${command.name} info is not available.`),
			);
		}

		return Result.ok(
			chatTextResponse(
				applyOutputTemplate(
					command.outputTemplate,
					renderStoredValueTemplate(value, input.viewer.displayName),
				),
			),
		);
	}

	private writeMetric(
		input: ChatCommandInput,
		command: string,
		status: "success" | "ignored" | "error",
		startedAt: number,
		error?: string,
	): void {
		this.metrics.write({
			command,
			userId: input.viewer.userId,
			userName: input.viewer.displayName,
			status,
			durationMs: Math.max(0, this.clock.now().getTime() - startedAt),
			error,
		});
	}
}
