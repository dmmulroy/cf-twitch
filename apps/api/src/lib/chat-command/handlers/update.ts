import { Result } from "better-result";

import { CommandNotUpdateableError } from "../../errors";
import { hasPermission, type Permission } from "../../permissions";
import { chatTextResponse } from "../types";

import type { CommandCatalog, ComputedCommandContext, ComputedCommandHandler } from "../types";

function getInsufficientWritePermissionMessage(
	requiredPermission: Permission,
	commandName: string,
): string {
	switch (requiredPermission) {
		case "everyone":
			return `!${commandName} can be updated by anyone.`;
		case "vip":
			return `Only VIPs and moderators can update !${commandName}.`;
		case "moderator":
			return `Only moderators can update !${commandName}.`;
		case "broadcaster":
			return `Only the broadcaster can update !${commandName}.`;
	}
}

/**
 * Computed chat command handler for stored command updates.
 */
export class UpdateCommandHandler implements ComputedCommandHandler {
	constructor(private readonly catalog: CommandCatalog) {}

	/**
	 * Validate update arguments and persist a new stored command value when permitted.
	 *
	 * @param context - Command invocation context containing update arguments and viewer permission.
	 * @returns A Result containing a chat response describing the update outcome.
	 */
	async handle(context: ComputedCommandContext) {
		const arg = context.arg;
		if (!arg) {
			return Result.ok(chatTextResponse("Usage: !update <command> <value>"));
		}

		const parts = arg.split(/\s+/);
		const targetCommandRaw = parts[0];
		if (!targetCommandRaw) {
			return Result.ok(chatTextResponse("Usage: !update <command> <value>"));
		}

		const targetCommand = targetCommandRaw.toLowerCase();
		const newValue = arg.slice(targetCommandRaw.length).trim();
		if (newValue.length === 0) {
			return Result.ok(chatTextResponse(`Usage: !update ${targetCommand} <value>`));
		}

		const commandResult = await this.catalog.getCommand(targetCommand);
		if (commandResult.status === "error") {
			return Result.ok(chatTextResponse("Sorry, couldn't update the command."));
		}

		const command = commandResult.value;
		if (command.writePermission === null) {
			return Result.ok(chatTextResponse(`!${targetCommand} is not updateable.`));
		}

		if (!hasPermission(context.viewer.permission, command.writePermission)) {
			return Result.ok(
				chatTextResponse(
					getInsufficientWritePermissionMessage(command.writePermission, targetCommand),
				),
			);
		}

		const result = await this.catalog.setCommandValue(
			targetCommand,
			newValue,
			context.viewer.displayName,
		);
		if (result.status === "error") {
			if (CommandNotUpdateableError.is(result.error)) {
				return Result.ok(chatTextResponse(`!${targetCommand} is not updateable.`));
			}
			return Result.ok(chatTextResponse("Sorry, couldn't update the command."));
		}

		return Result.ok(chatTextResponse(`Updated !${targetCommand}`));
	}
}
