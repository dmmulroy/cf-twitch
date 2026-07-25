import { Result } from "better-result";

import { chatTextResponse } from "../types";

import type { Permission } from "../../permissions";
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

		const result = await this.catalog.updateCommandValue(
			targetCommand,
			newValue,
			{
				displayName: context.viewer.displayName,
				permission: context.viewer.permission,
			},
			context.operationId,
		);
		if (result.status === "error") {
			switch (result.error._tag) {
				case "CommandNotUpdateableError":
					return Result.ok(chatTextResponse(`!${targetCommand} is not updateable.`));
				case "CommandUpdatePermissionDeniedError":
					return Result.ok(
						chatTextResponse(
							getInsufficientWritePermissionMessage(result.error.requiredPermission, targetCommand),
						),
					);
				default:
					return Result.ok(chatTextResponse("Sorry, couldn't update the command."));
			}
		}

		return Result.ok(chatTextResponse(`Updated !${targetCommand}`));
	}
}
