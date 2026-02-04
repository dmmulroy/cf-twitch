/**
 * CommandsDO - Chat command registry and dynamic values
 *
 * Manages command definitions and updateable values. Seeded on first access
 * with default commands. Supports static, dynamic, and computed command types.
 */

import { Result } from "better-result";
import { DurableObject } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import migrations from "../../drizzle/commands-do/migrations";
import { rpc, withRpcSerialization } from "../lib/durable-objects";
import {
	CommandsDbError,
	CommandNotFoundError,
	CommandNotUpdateableError,
} from "../lib/errors";
import { logger } from "../lib/logger";
import * as schema from "./schemas/commands-do.schema";
import {
	type Command,
	type Permission,
	commands,
	commandValues,
} from "./schemas/commands-do.schema";

import type { Env } from "../index";

// =============================================================================
// Input Validation Schemas
// =============================================================================

const CommandNameSchema = z.string().min(1).max(50).regex(/^[a-z0-9-]+$/);
const PermissionSchema = z.enum(["everyone", "moderator", "broadcaster"]);
const CommandValueSchema = z.string().min(0).max(2000);

// =============================================================================
// Seed Data
// =============================================================================

/**
 * Default commands to seed on first access
 * Uses INSERT OR IGNORE for idempotency
 */
const SEED_COMMANDS: Array<{
	name: string;
	description: string;
	category: string;
	responseType: string;
	permission: Permission;
	value?: string;
}> = [
	{
		name: "keyboard",
		description: "Shows keyboard info and build video",
		category: "info",
		responseType: "static",
		permission: "everyone",
		value: "SA Voyager with Choc White switches: https://youtube.com/watch?v=WfIfxaXC_Q4",
	},
	{
		name: "socials",
		description: "Shows social media links",
		category: "info",
		responseType: "static",
		permission: "everyone",
		value: "GitHub: github.com/dmmulroy | X: x.com/dillon_mulroy",
	},
	{
		name: "dotfiles",
		description: "Shows dotfiles repository link",
		category: "info",
		responseType: "static",
		permission: "everyone",
		value: "https://github.com/dmmulroy/.dotfiles",
	},
	{
		name: "today",
		description: "Shows what's being worked on today",
		category: "info",
		responseType: "dynamic",
		permission: "everyone",
		value: "",
	},
	{
		name: "project",
		description: "Shows current project (alias for today)",
		category: "info",
		responseType: "dynamic",
		permission: "everyone",
		// Note: project reads from "today" key - no separate value
	},
	{
		name: "achievements",
		description: "Shows user's unlocked achievements",
		category: "stats",
		responseType: "computed",
		permission: "everyone",
	},
	{
		name: "stats",
		description: "Shows user's song/achievement/raffle stats",
		category: "stats",
		responseType: "computed",
		permission: "everyone",
	},
	{
		name: "raffle-leaderboard",
		description: "Shows top raffle winners",
		category: "stats",
		responseType: "computed",
		permission: "everyone",
	},
	{
		name: "commands",
		description: "Lists available commands",
		category: "meta",
		responseType: "computed",
		permission: "everyone",
	},
	{
		name: "update",
		description: "Updates dynamic command values",
		category: "meta",
		responseType: "computed",
		permission: "moderator",
	},
	{
		name: "song",
		description: "Request a song via Spotify URL",
		category: "music",
		responseType: "computed",
		permission: "everyone",
	},
	{
		name: "queue",
		description: "Shows current song queue",
		category: "music",
		responseType: "computed",
		permission: "everyone",
	},
];

// =============================================================================
// CommandsDO Implementation
// =============================================================================

/**
 * CommandsDO - Durable Object for command registry management
 */
class _CommandsDO extends DurableObject<Env> {
	private db: ReturnType<typeof drizzle<typeof schema>>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.db = drizzle(this.ctx.storage, { schema });

		void this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.db, migrations);
			await this.seedCommandsInternal();
		});
	}

	/**
	 * Get a command definition by name
	 *
	 * Returns CommandNotFoundError if command doesn't exist.
	 */
	@rpc
	async getCommand(name: string): Promise<Result<Command, CommandsDbError | CommandNotFoundError>> {
		// Validate input
		const parseResult = CommandNameSchema.safeParse(name);
		if (!parseResult.success) {
			return Result.err(
				new CommandsDbError({
					operation: "getCommand",
					cause: new Error(`Invalid command name: ${parseResult.error.message}`),
				}),
			);
		}

		return Result.tryPromise({
			try: async () => {
				const command = await this.db.query.commands.findFirst({
					where: eq(commands.name, name),
				});
				if (!command) {
					throw new CommandNotFoundError({ commandName: name });
				}
				return command;
			},
			catch: (cause) => {
				if (CommandNotFoundError.is(cause)) {
					return cause;
				}
				return new CommandsDbError({ operation: "getCommand", cause });
			},
		});
	}

	/**
	 * Get all command definitions
	 */
	@rpc
	async getAllCommands(): Promise<Result<Command[], CommandsDbError>> {
		return Result.tryPromise({
			try: async () => {
				return this.db.query.commands.findMany();
			},
			catch: (cause) => new CommandsDbError({ operation: "getAllCommands", cause }),
		});
	}

	/**
	 * Get commands filtered by maximum permission level
	 *
	 * Returns all commands that the given permission level can access.
	 * - "everyone" only sees "everyone" commands
	 * - "moderator" sees "everyone" and "moderator" commands
	 * - "broadcaster" sees all commands
	 */
	@rpc
	async getCommandsByPermission(maxPerm: Permission): Promise<Result<Command[], CommandsDbError>> {
		// Validate input
		const parseResult = PermissionSchema.safeParse(maxPerm);
		if (!parseResult.success) {
			return Result.err(
				new CommandsDbError({
					operation: "getCommandsByPermission",
					cause: new Error(`Invalid permission: ${parseResult.error.message}`),
				}),
			);
		}

		return Result.tryPromise({
			try: async () => {
				const allowedPermissions: Permission[] = (() => {
					switch (maxPerm) {
						case "everyone":
							return ["everyone"];
						case "moderator":
							return ["everyone", "moderator"];
						case "broadcaster":
							return ["everyone", "moderator", "broadcaster"];
					}
				})();

				return this.db.query.commands.findMany({
					where: inArray(commands.permission, allowedPermissions),
				});
			},
			catch: (cause) => new CommandsDbError({ operation: "getCommandsByPermission", cause }),
		});
	}

	/**
	 * Get the value for a command
	 *
	 * For static/dynamic commands, returns the stored value.
	 * For "project", returns the "today" value (aliased).
	 * Returns null if no value exists or command is computed.
	 */
	@rpc
	async getCommandValue(name: string): Promise<Result<string | null, CommandsDbError>> {
		// Validate input
		const parseResult = CommandNameSchema.safeParse(name);
		if (!parseResult.success) {
			return Result.err(
				new CommandsDbError({
					operation: "getCommandValue",
					cause: new Error(`Invalid command name: ${parseResult.error.message}`),
				}),
			);
		}

		return Result.tryPromise({
			try: async () => {
				// Handle project -> today alias
				const lookupName = name === "project" ? "today" : name;

				const value = await this.db.query.commandValues.findFirst({
					where: eq(commandValues.commandName, lookupName),
				});

				return value?.value ?? null;
			},
			catch: (cause) => new CommandsDbError({ operation: "getCommandValue", cause }),
		});
	}

	/**
	 * Set the value for a dynamic command
	 *
	 * Fails if the command doesn't exist or is not dynamic.
	 * For "project", updates the "today" value (aliased).
	 */
	@rpc
	async setCommandValue(
		name: string,
		value: string,
		updatedBy: string,
	): Promise<Result<void, CommandsDbError | CommandNotFoundError | CommandNotUpdateableError>> {
		// Validate inputs
		const nameResult = CommandNameSchema.safeParse(name);
		if (!nameResult.success) {
			return Result.err(
				new CommandsDbError({
					operation: "setCommandValue",
					cause: new Error(`Invalid command name: ${nameResult.error.message}`),
				}),
			);
		}

		const valueResult = CommandValueSchema.safeParse(value);
		if (!valueResult.success) {
			return Result.err(
				new CommandsDbError({
					operation: "setCommandValue",
					cause: new Error(`Invalid command value: ${valueResult.error.message}`),
				}),
			);
		}

		return Result.tryPromise({
			try: async () => {
				// Handle project -> today alias
				const lookupName = name === "project" ? "today" : name;

				// Verify command exists and is updateable
				const command = await this.db.query.commands.findFirst({
					where: eq(commands.name, lookupName),
				});

				if (!command) {
					throw new CommandNotFoundError({ commandName: name });
				}

				if (command.responseType !== "dynamic") {
					throw new CommandNotUpdateableError({
						commandName: name,
						responseType: command.responseType,
					});
				}

				const now = new Date().toISOString();

				// Upsert the value
				await this.db
					.insert(commandValues)
					.values({
						commandName: lookupName,
						value,
						updatedAt: now,
						updatedBy,
					})
					.onConflictDoUpdate({
						target: commandValues.commandName,
						set: {
							value,
							updatedAt: now,
							updatedBy,
						},
					});

				logger.info("Updated command value", {
					command: lookupName,
					updatedBy,
				});
			},
			catch: (cause) => {
				if (CommandNotFoundError.is(cause) || CommandNotUpdateableError.is(cause)) {
					return cause;
				}
				return new CommandsDbError({ operation: "setCommandValue", cause });
			},
		});
	}

	/**
	 * Seed default commands (public method for testing/admin)
	 *
	 * Idempotent via INSERT OR IGNORE.
	 */
	@rpc
	async seedCommands(): Promise<Result<void, CommandsDbError>> {
		return this.seedCommandsInternal();
	}

	/**
	 * Get a command with its value (convenience method)
	 *
	 * Returns CommandNotFoundError if command doesn't exist.
	 */
	@rpc
	async getCommandWithValue(
		name: string,
	): Promise<
		Result<{ command: Command; value: string | null }, CommandsDbError | CommandNotFoundError>
	> {
		return Result.tryPromise({
			try: async () => {
				const command = await this.db.query.commands.findFirst({
					where: eq(commands.name, name),
				});

				if (!command) {
					throw new CommandNotFoundError({ commandName: name });
				}

				// Get value if static/dynamic
				let value: string | null = null;
				if (command.responseType === "static" || command.responseType === "dynamic") {
					// Handle project -> today alias
					const lookupName = name === "project" ? "today" : name;
					const valueRow = await this.db.query.commandValues.findFirst({
						where: eq(commandValues.commandName, lookupName),
					});
					value = valueRow?.value ?? null;
				}

				return { command, value };
			},
			catch: (cause) => {
				if (CommandNotFoundError.is(cause)) {
					return cause;
				}
				return new CommandsDbError({ operation: "getCommandWithValue", cause });
			},
		});
	}

	/**
	 * Get all enabled commands with their values
	 */
	@rpc
	async getEnabledCommandsWithValues(): Promise<
		Result<Array<{ command: Command; value: string | null }>, CommandsDbError>
	> {
		return Result.tryPromise({
			try: async () => {
				const enabledCommands = await this.db.query.commands.findMany({
					where: eq(commands.enabled, true),
				});

				const allValues = await this.db.query.commandValues.findMany();
				const valueMap = new Map(allValues.map((v) => [v.commandName, v.value]));

				return enabledCommands.map((command) => {
					// Handle project -> today alias
					const lookupName = command.name === "project" ? "today" : command.name;
					const value =
						command.responseType === "computed" ? null : (valueMap.get(lookupName) ?? null);

					return { command, value };
				});
			},
			catch: (cause) => new CommandsDbError({ operation: "getEnabledCommandsWithValues", cause }),
		});
	}

	// =============================================================================
	// Private Methods
	// =============================================================================

	/**
	 * Internal seed method
	 *
	 * Idempotent: onConflictDoNothing() handles duplicate seeding across DO evictions.
	 * Uses batch inserts to minimize DB round-trips.
	 */
	private async seedCommandsInternal(): Promise<Result<void, CommandsDbError>> {
		return Result.tryPromise({
			try: async () => {
				const now = new Date().toISOString();

				// Prepare batch inserts
				const commandInserts = SEED_COMMANDS.map((cmd) => ({
					name: cmd.name,
					description: cmd.description,
					category: cmd.category,
					responseType: cmd.responseType,
					permission: cmd.permission,
					enabled: true,
					createdAt: now,
				}));

				const valueInserts = SEED_COMMANDS.filter((cmd) => cmd.value !== undefined).map((cmd) => {
					if (cmd.value === undefined) {
						throw new Error("Unexpected undefined value after filter");
					}
					return {
						commandName: cmd.name,
						value: cmd.value,
						updatedAt: now,
						updatedBy: null as string | null,
					};
				});

				// Batch insert commands
				if (commandInserts.length > 0) {
					await this.db.insert(commands).values(commandInserts).onConflictDoNothing();
				}

				// Batch insert values
				if (valueInserts.length > 0) {
					await this.db.insert(commandValues).values(valueInserts).onConflictDoNothing();
				}

				logger.info("CommandsDO: Seeded default commands", {
					count: SEED_COMMANDS.length,
				});
			},
			catch: (cause) => new CommandsDbError({ operation: "seedCommands", cause }),
		});
	}
}

export const CommandsDO = withRpcSerialization(_CommandsDO);
