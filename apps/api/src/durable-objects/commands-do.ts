/**
 * CommandsDO - Chat command registry and dynamic values
 *
 * Manages command definitions and updateable values. Default commands are
 * seeded via Drizzle migration. Supports static, dynamic, and computed types.
 */

import { Result } from "better-result";
import { DurableObject } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import migrations from "../../drizzle/commands-do/migrations";
import { rpc, withRpcSerialization } from "../lib/durable-objects";
import { CommandsDbError, CommandNotFoundError, CommandNotUpdateableError } from "../lib/errors";
import { logger } from "../lib/logger";
import * as schema from "./schemas/commands-do.schema";
import {
	type Command,
	type Permission,
	commandCounters,
	commands,
	commandValues,
} from "./schemas/commands-do.schema";

import type { Env } from "../index";

// =============================================================================
// Input Validation Schemas
// =============================================================================

const CommandNameSchema = z
	.string()
	.min(1)
	.max(50)
	.regex(/^[a-z0-9-]+$/);
const PermissionSchema = z.enum(["everyone", "vip", "moderator", "broadcaster"]);
const CommandValueSchema = z.string().min(0).max(2000);
const CounterIncrementSchema = z.number().int().min(1).max(100);

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
	 * - "vip" sees "everyone" and "vip" commands
	 * - "moderator" sees "everyone", "vip", and "moderator" commands
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
						case "vip":
							return ["everyone", "vip"];
						case "moderator":
							return ["everyone", "vip", "moderator"];
						case "broadcaster":
							return ["everyone", "vip", "moderator", "broadcaster"];
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
	 * Get current counter value for a command.
	 *
	 * Returns 0 if no counter exists yet.
	 */
	@rpc
	async getCommandCounter(
		name: string,
	): Promise<Result<number, CommandsDbError | CommandNotFoundError>> {
		const parseResult = CommandNameSchema.safeParse(name);
		if (!parseResult.success) {
			return Result.err(
				new CommandsDbError({
					operation: "getCommandCounter",
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

				const counter = await this.db.query.commandCounters.findFirst({
					where: eq(commandCounters.commandName, name),
				});

				return counter?.count ?? 0;
			},
			catch: (cause) => {
				if (CommandNotFoundError.is(cause)) {
					return cause;
				}
				return new CommandsDbError({ operation: "getCommandCounter", cause });
			},
		});
	}

	/**
	 * Increment a command counter and return the new value.
	 */
	@rpc
	async incrementCommandCounter(
		name: string,
		increment = 1,
	): Promise<Result<number, CommandsDbError | CommandNotFoundError>> {
		const nameResult = CommandNameSchema.safeParse(name);
		if (!nameResult.success) {
			return Result.err(
				new CommandsDbError({
					operation: "incrementCommandCounter",
					cause: new Error(`Invalid command name: ${nameResult.error.message}`),
				}),
			);
		}

		const incrementResult = CounterIncrementSchema.safeParse(increment);
		if (!incrementResult.success) {
			return Result.err(
				new CommandsDbError({
					operation: "incrementCommandCounter",
					cause: new Error(`Invalid increment value: ${incrementResult.error.message}`),
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

				const currentCounter = await this.db.query.commandCounters.findFirst({
					where: eq(commandCounters.commandName, name),
				});

				const nextCount = (currentCounter?.count ?? 0) + increment;
				const now = new Date().toISOString();

				await this.db
					.insert(commandCounters)
					.values({
						commandName: name,
						count: nextCount,
						updatedAt: now,
					})
					.onConflictDoUpdate({
						target: commandCounters.commandName,
						set: {
							count: nextCount,
							updatedAt: now,
						},
					});

				logger.info("Incremented command counter", {
					command: name,
					count: nextCount,
				});

				return nextCount;
			},
			catch: (cause) => {
				if (CommandNotFoundError.is(cause)) {
					return cause;
				}
				return new CommandsDbError({ operation: "incrementCommandCounter", cause });
			},
		});
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
	 * Get full commands debug snapshot (definitions + values + counters).
	 */
	@rpc
	async getDebugSnapshot(): Promise<
		Result<
			{
				commands: Array<
					Command & {
						value: string | null;
						counter: number | null;
					}
				>;
				totals: {
					total: number;
					enabled: number;
					static: number;
					dynamic: number;
					computed: number;
				};
			},
			CommandsDbError
		>
	> {
		return Result.tryPromise({
			try: async () => {
				const allCommands = await this.db.query.commands.findMany();
				const allValues = await this.db.query.commandValues.findMany();
				const allCounters = await this.db.query.commandCounters.findMany();

				const valueMap = new Map(
					allValues.map((valueRow) => [valueRow.commandName, valueRow.value]),
				);
				const counterMap = new Map(
					allCounters.map((counterRow) => [counterRow.commandName, counterRow.count]),
				);

				const commandsWithState = allCommands.map((command) => {
					const lookupName = command.name === "project" ? "today" : command.name;
					const value =
						command.responseType === "computed" ? null : (valueMap.get(lookupName) ?? null);
					const counter =
						command.responseType === "computed" ? (counterMap.get(command.name) ?? null) : null;

					return {
						...command,
						value,
						counter,
					};
				});

				return {
					commands: commandsWithState,
					totals: {
						total: allCommands.length,
						enabled: allCommands.filter((command) => command.enabled).length,
						static: allCommands.filter((command) => command.responseType === "static").length,
						dynamic: allCommands.filter((command) => command.responseType === "dynamic").length,
						computed: allCommands.filter((command) => command.responseType === "computed").length,
					},
				};
			},
			catch: (cause) => new CommandsDbError({ operation: "getDebugSnapshot", cause }),
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
}

export const CommandsDO = withRpcSerialization(_CommandsDO);
