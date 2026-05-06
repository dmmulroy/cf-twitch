import { Result } from "better-result";

import { hasPermission, type Permission } from "../../permissions";
import { chatTextResponse } from "../types";

import type { Command } from "../../../durable-objects/commands-do";
import type { CommandCatalog, ComputedCommandContext, ComputedCommandHandler } from "../types";

/**
 * Computed chat command handler for listing available commands.
 */
export class CommandsCommandHandler implements ComputedCommandHandler {
	constructor(private readonly catalog: CommandCatalog) {}

	/**
	 * List commands available to the invoking viewer grouped by permission tier.
	 *
	 * @param context - Command invocation context containing the viewer permission.
	 * @returns A Result containing a chat response with grouped command names.
	 */
	async handle(context: ComputedCommandContext) {
		const result = await this.catalog.getCommandsByPermission(context.viewer.permission);
		if (result.status === "error") {
			return Result.ok(chatTextResponse("Sorry, couldn't retrieve the commands list."));
		}

		const commands = result.value;
		if (commands.length === 0) {
			return Result.ok(chatTextResponse("No commands available."));
		}

		const commandsByPermission: Record<Permission, Command[]> = {
			everyone: [],
			vip: [],
			moderator: [],
			broadcaster: [],
		};
		for (const command of commands) {
			commandsByPermission[command.permission].push(command);
		}

		const sections: string[] = [];
		sections.push(
			`Commands: ${commandsByPermission.everyone.map((command) => `!${command.name}`).join(" ")}`,
		);

		if (commandsByPermission.vip.length > 0 && hasPermission(context.viewer.permission, "vip")) {
			sections.push(
				`VIP: ${commandsByPermission.vip.map((command) => `!${command.name}`).join(" ")}`,
			);
		}

		if (
			commandsByPermission.moderator.length > 0 &&
			hasPermission(context.viewer.permission, "moderator")
		) {
			sections.push(
				`Mod: ${commandsByPermission.moderator.map((command) => `!${command.name}`).join(" ")}`,
			);
		}

		if (
			commandsByPermission.broadcaster.length > 0 &&
			hasPermission(context.viewer.permission, "broadcaster")
		) {
			sections.push(
				`Broadcaster: ${commandsByPermission.broadcaster.map((command) => `!${command.name}`).join(" ")}`,
			);
		}

		return Result.ok(chatTextResponse(sections.join(" | ")));
	}
}
