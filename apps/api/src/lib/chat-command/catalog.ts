import { getStub } from "../durable-objects";

import type { Permission } from "../permissions";
import type { CommandCatalog, CommandCounterStore } from "./types";

/**
 * Commands Durable Object backed catalog adapter.
 *
 * @param name - Command or value name to read or mutate.
 * @param value - Stored command value to persist.
 * @param updatedBy - Display name of the viewer updating a command.
 * @param permission - Viewer permission used to filter available commands.
 * @returns Result-wrapped values from CommandsDO RPC methods.
 */
export class CommandsDOCommandCatalog implements CommandCatalog {
	async getCommand(name: string) {
		return getStub("COMMANDS_DO").getCommand(name);
	}

	async getCommandValue(name: string) {
		return getStub("COMMANDS_DO").getCommandValue(name);
	}

	async setCommandValue(name: string, value: string, updatedBy: string) {
		return getStub("COMMANDS_DO").setCommandValue(name, value, updatedBy);
	}

	async getCommandsByPermission(permission: Permission) {
		return getStub("COMMANDS_DO").getCommandsByPermission(permission);
	}
}

/**
 * Commands Durable Object backed counter store adapter.
 *
 * @param name - Counter name to increment.
 * @returns A Result containing the updated counter value.
 */
export class CommandsDOCommandCounterStore implements CommandCounterStore {
	async incrementCounter(name: string) {
		return getStub("COMMANDS_DO").incrementCommandCounter(name);
	}
}
