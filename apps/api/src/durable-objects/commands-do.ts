/**
 * CommandsDO - Chat command registry and dynamic values
 *
 * Agent state owns command definitions, values, and counters. Legacy SQLite
 * tables are only used once during startup to import existing command data.
 */

import { Agent, type AgentContext } from "agents";
import { Result } from "better-result";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migrate } from "drizzle-orm/durable-sqlite/migrator";
import { z } from "zod";

import migrations from "../../drizzle/commands-do/migrations";
import { rpc, withRpcSerialization } from "../lib/durable-objects";
import { CommandsDbError, CommandNotFoundError, CommandNotUpdateableError } from "../lib/errors";
import { logger } from "../lib/logger";
import * as schema from "./schemas/commands-do.schema";
import { type Permission } from "./schemas/commands-do.schema";

import type { Env } from "../index";

const CommandNameSchema = z
	.string()
	.min(1)
	.max(50)
	.regex(/^[a-z0-9-]+$/);
const PermissionSchema = z.enum(["everyone", "vip", "moderator", "broadcaster"]);
const ResponseTypeSchema = z.enum(["static", "dynamic", "computed"]);
const CategorySchema = z.enum(["info", "stats", "meta", "music"]);
const CommandValueSchema = z.string().min(0).max(2000);
const CounterIncrementSchema = z.number().int().min(1).max(100);
const IsoTimestampSchema = z.string().min(1).max(100);
const HandlerKeySchema = z.string().min(1).max(100);
const TemplateSchema = z.string().min(1).max(2000);

const DynamicCommandEmptyResponse = "No topic set for today.";
const DynamicCommandOutputTemplate = "Working on: {value}";
const GenericStoredOutputTemplate = "{value}";

const PermissionLevels: Record<Permission, number> = {
	everyone: 0,
	vip: 1,
	moderator: 2,
	broadcaster: 3,
};

export const CommandDefinitionSchema = z.object({
	name: CommandNameSchema,
	description: z.string().min(1).max(200),
	category: CategorySchema,
	responseType: ResponseTypeSchema,
	permission: PermissionSchema,
	enabled: z.boolean(),
	createdAt: IsoTimestampSchema,
	aliases: z.array(CommandNameSchema).max(20),
	valueSourceName: CommandNameSchema.nullable(),
	counterSourceName: CommandNameSchema.nullable(),
	handlerKey: HandlerKeySchema.nullable(),
	outputTemplate: TemplateSchema.nullable(),
	emptyResponse: TemplateSchema.nullable(),
	writePermission: PermissionSchema.nullable(),
});

export type Command = z.infer<typeof CommandDefinitionSchema>;

const CommandValueStateSchema = z.object({
	value: CommandValueSchema,
	updatedAt: IsoTimestampSchema,
	updatedBy: z.string().min(1).max(100).nullable(),
});

const CommandCounterStateSchema = z.object({
	count: z.number().int().min(0),
	updatedAt: IsoTimestampSchema,
});

const LegacyCommandImportSchema = z
	.object({
		name: CommandNameSchema,
		description: z.string().min(1).max(200),
		category: CategorySchema,
		responseType: ResponseTypeSchema,
		permission: PermissionSchema,
		enabled: z.boolean(),
		createdAt: IsoTimestampSchema,
	})
	.transform((command): Command => {
		const base: Command = {
			name: command.name,
			description: command.description,
			category: command.category,
			responseType: command.responseType,
			permission: command.permission,
			enabled: command.enabled,
			createdAt: command.createdAt,
			aliases: [],
			valueSourceName: command.responseType === "computed" ? null : command.name,
			counterSourceName: null,
			handlerKey: command.responseType === "computed" ? command.name : null,
			outputTemplate: command.responseType === "computed" ? null : GenericStoredOutputTemplate,
			emptyResponse:
				command.responseType === "computed" ? null : `${command.name} info is not available.`,
			writePermission: command.responseType === "dynamic" ? "moderator" : null,
		};

		if (command.name === "today" || command.name === "project") {
			return {
				...base,
				valueSourceName: "today",
				outputTemplate: DynamicCommandOutputTemplate,
				emptyResponse: DynamicCommandEmptyResponse,
				writePermission: "moderator",
			};
		}

		if (command.name === "leak" && command.responseType === "dynamic") {
			return {
				...base,
				writePermission: "vip",
			};
		}

		if (command.name === "skillissue") {
			return {
				...base,
				counterSourceName: "skillissue",
			};
		}

		return base;
	});

const LegacyCommandValueImportSchema = z
	.object({
		commandName: CommandNameSchema,
		value: CommandValueSchema,
		updatedAt: IsoTimestampSchema,
		updatedBy: z.string().min(1).max(100).nullable(),
	})
	.transform((row) => ({
		commandName: row.commandName,
		state: {
			value: row.value,
			updatedAt: row.updatedAt,
			updatedBy: row.updatedBy,
		},
	}));

const LegacyCommandCounterImportSchema = z
	.object({
		commandName: CommandNameSchema,
		count: z.number().int().min(0),
		updatedAt: IsoTimestampSchema,
	})
	.transform((row) => ({
		commandName: row.commandName,
		state: {
			count: row.count,
			updatedAt: row.updatedAt,
		},
	}));

export interface CommandsAgentState {
	revision: number;
	legacyImportCompleted: boolean;
	commandsByName: Record<string, Command>;
	valuesByName: Record<string, z.infer<typeof CommandValueStateSchema>>;
	countersByName: Record<string, z.infer<typeof CommandCounterStateSchema>>;
}

export const CreateCommandInputSchema = z.object({
	name: CommandNameSchema,
	description: z.string().min(1).max(200),
	category: CategorySchema,
	responseType: ResponseTypeSchema,
	permission: PermissionSchema,
	enabled: z.boolean().optional(),
	aliases: z.array(CommandNameSchema).max(20).optional(),
	valueSourceName: CommandNameSchema.nullable().optional(),
	counterSourceName: CommandNameSchema.nullable().optional(),
	handlerKey: HandlerKeySchema.nullable().optional(),
	outputTemplate: TemplateSchema.nullable().optional(),
	emptyResponse: TemplateSchema.nullable().optional(),
	writePermission: PermissionSchema.nullable().optional(),
	initialValue: CommandValueSchema.nullable().optional(),
	initialCounter: z.number().int().min(0).nullable().optional(),
	createdAt: IsoTimestampSchema.optional(),
});

export type CreateCommandInput = z.infer<typeof CreateCommandInputSchema>;

export const UpdateCommandInputSchema = z.object({
	description: z.string().min(1).max(200).optional(),
	category: CategorySchema.optional(),
	responseType: ResponseTypeSchema.optional(),
	permission: PermissionSchema.optional(),
	enabled: z.boolean().optional(),
	aliases: z.array(CommandNameSchema).max(20).optional(),
	valueSourceName: CommandNameSchema.nullable().optional(),
	counterSourceName: CommandNameSchema.nullable().optional(),
	handlerKey: HandlerKeySchema.nullable().optional(),
	outputTemplate: TemplateSchema.nullable().optional(),
	emptyResponse: TemplateSchema.nullable().optional(),
	writePermission: PermissionSchema.nullable().optional(),
});

export type UpdateCommandInput = z.infer<typeof UpdateCommandInputSchema>;

type CommandValueState = z.infer<typeof CommandValueStateSchema>;
type CommandCounterState = z.infer<typeof CommandCounterStateSchema>;

class _CommandsDO extends Agent<Env, CommandsAgentState> {
	private legacyDb: ReturnType<typeof drizzle<typeof schema>>;

	initialState: CommandsAgentState = {
		revision: 0,
		legacyImportCompleted: false,
		commandsByName: {},
		valuesByName: {},
		countersByName: {},
	};

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
		this.legacyDb = drizzle(this.ctx.storage, { schema });
	}

	async onStart(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			await migrate(this.legacyDb, migrations);
			const importResult = await this.importLegacyStateOnce();
			if (importResult.status === "error") {
				logger.error("Failed to import legacy commands state", {
					error: importResult.error.message,
					operation: importResult.error.operation,
				});
			}
		});
	}

	onStateChanged(state: CommandsAgentState | undefined): void {
		if (!state) {
			return;
		}

		logger.info("CommandsDO state changed", {
			revision: state.revision,
			legacyImportCompleted: state.legacyImportCompleted,
			commandCount: Object.keys(state.commandsByName).length,
			valueCount: Object.keys(state.valuesByName).length,
			counterCount: Object.keys(state.countersByName).length,
		});
	}

	private validationError(operation: string, message: string): CommandsDbError {
		return new CommandsDbError({ operation, cause: new Error(message) });
	}

	private validateNextState(
		nextState: CommandsAgentState,
		operation: string,
	): Result<void, CommandsDbError> {
		if (!nextState.legacyImportCompleted) {
			return Result.ok();
		}

		if (nextState.revision < 0) {
			return Result.err(this.validationError(operation, "Commands state revision must be >= 0"));
		}

		const aliasOwners = new Map<string, string>();
		for (const [commandName, rawCommand] of Object.entries(nextState.commandsByName)) {
			const parseResult = CommandDefinitionSchema.safeParse(rawCommand);
			if (!parseResult.success) {
				return Result.err(
					this.validationError(
						operation,
						`Invalid command definition for ${commandName}: ${parseResult.error.message}`,
					),
				);
			}

			const command = parseResult.data;
			if (command.name !== commandName) {
				return Result.err(
					this.validationError(operation, `Command key mismatch for ${commandName}`),
				);
			}

			if (command.responseType === "computed" && command.handlerKey === null) {
				return Result.err(
					this.validationError(
						operation,
						`Computed command ${command.name} must declare a handlerKey`,
					),
				);
			}

			if (command.responseType !== "computed" && command.handlerKey !== null) {
				return Result.err(
					this.validationError(
						operation,
						`Stored command ${command.name} must not declare a handlerKey`,
					),
				);
			}

			if (command.responseType === "computed" && command.valueSourceName !== null) {
				return Result.err(
					this.validationError(
						operation,
						`Computed command ${command.name} must not declare a valueSourceName`,
					),
				);
			}

			if (command.responseType !== "computed" && command.valueSourceName === null) {
				return Result.err(
					this.validationError(
						operation,
						`Stored command ${command.name} must declare a valueSourceName`,
					),
				);
			}

			for (const alias of command.aliases) {
				if (alias === command.name) {
					return Result.err(
						this.validationError(operation, `Command ${command.name} cannot alias itself`),
					);
				}

				const existingOwner = aliasOwners.get(alias);
				if (existingOwner !== undefined) {
					return Result.err(
						this.validationError(operation, `Alias ${alias} is already owned by ${existingOwner}`),
					);
				}

				if (nextState.commandsByName[alias] !== undefined) {
					return Result.err(
						this.validationError(
							operation,
							`Alias ${alias} collides with an existing command name`,
						),
					);
				}

				aliasOwners.set(alias, command.name);
			}
		}

		for (const command of Object.values(nextState.commandsByName)) {
			if (
				command.valueSourceName !== null &&
				nextState.commandsByName[command.valueSourceName] === undefined
			) {
				return Result.err(
					this.validationError(
						operation,
						`Command ${command.name} references missing value source ${command.valueSourceName}`,
					),
				);
			}

			if (
				command.counterSourceName !== null &&
				nextState.commandsByName[command.counterSourceName] === undefined
			) {
				return Result.err(
					this.validationError(
						operation,
						`Command ${command.name} references missing counter source ${command.counterSourceName}`,
					),
				);
			}
		}

		for (const [valueName, valueState] of Object.entries(nextState.valuesByName)) {
			const parseResult = CommandValueStateSchema.safeParse(valueState);
			if (!parseResult.success) {
				return Result.err(
					this.validationError(
						operation,
						`Invalid value state for ${valueName}: ${parseResult.error.message}`,
					),
				);
			}

			if (nextState.commandsByName[valueName] === undefined) {
				return Result.err(
					this.validationError(operation, `Value state references missing command ${valueName}`),
				);
			}
		}

		for (const [counterName, counterState] of Object.entries(nextState.countersByName)) {
			const parseResult = CommandCounterStateSchema.safeParse(counterState);
			if (!parseResult.success) {
				return Result.err(
					this.validationError(
						operation,
						`Invalid counter state for ${counterName}: ${parseResult.error.message}`,
					),
				);
			}

			if (nextState.commandsByName[counterName] === undefined) {
				return Result.err(
					this.validationError(
						operation,
						`Counter state references missing command ${counterName}`,
					),
				);
			}
		}

		return Result.ok();
	}

	private persistState(
		nextState: CommandsAgentState,
		operation: string,
	): Result<void, CommandsDbError> {
		const validationResult = this.validateNextState(nextState, operation);
		if (validationResult.status === "error") {
			return validationResult;
		}

		this.setState(nextState);
		return Result.ok();
	}

	@rpc
	async getCommand(name: string): Promise<Result<Command, CommandsDbError | CommandNotFoundError>> {
		const commandNameResult = this.parseCommandName(name, "getCommand");
		if (commandNameResult.status === "error") {
			return commandNameResult;
		}

		const command = this.resolveCommand(commandNameResult.value);
		if (!command) {
			return Result.err(new CommandNotFoundError({ commandName: commandNameResult.value }));
		}

		return Result.ok(command);
	}

	@rpc
	async getAllCommands(): Promise<Result<Command[], CommandsDbError>> {
		return Result.try({
			try: () => Object.values(this.state.commandsByName),
			catch: (cause) => new CommandsDbError({ operation: "getAllCommands", cause }),
		});
	}

	@rpc
	async getCommandsByPermission(maxPerm: Permission): Promise<Result<Command[], CommandsDbError>> {
		const parseResult = PermissionSchema.safeParse(maxPerm);
		if (!parseResult.success) {
			return Result.err(
				new CommandsDbError({
					operation: "getCommandsByPermission",
					cause: new Error(`Invalid permission: ${parseResult.error.message}`),
				}),
			);
		}

		return Result.try({
			try: () => {
				const level = PermissionLevels[parseResult.data];
				return Object.values(this.state.commandsByName).filter(
					(command) => PermissionLevels[command.permission] <= level,
				);
			},
			catch: (cause) => new CommandsDbError({ operation: "getCommandsByPermission", cause }),
		});
	}

	@rpc
	async getCommandValue(name: string): Promise<Result<string | null, CommandsDbError>> {
		const parseResult = CommandNameSchema.safeParse(name);
		if (!parseResult.success) {
			return Result.err(
				new CommandsDbError({
					operation: "getCommandValue",
					cause: new Error(`Invalid command name: ${parseResult.error.message}`),
				}),
			);
		}

		return Result.try({
			try: () => {
				const command = this.resolveCommand(parseResult.data);
				if (!command || command.valueSourceName === null) {
					return null;
				}

				return this.state.valuesByName[command.valueSourceName]?.value ?? null;
			},
			catch: (cause) => new CommandsDbError({ operation: "getCommandValue", cause }),
		});
	}

	@rpc
	async setCommandValue(
		name: string,
		value: string,
		updatedBy: string,
	): Promise<Result<void, CommandsDbError | CommandNotFoundError | CommandNotUpdateableError>> {
		return Result.gen(function* (this: _CommandsDO) {
			const commandName = yield* this.parseCommandName(name, "setCommandValue");
			const valueResult = CommandValueSchema.safeParse(value);
			if (!valueResult.success) {
				return Result.err(
					new CommandsDbError({
						operation: "setCommandValue",
						cause: new Error(`Invalid command value: ${valueResult.error.message}`),
					}),
				);
			}

			const command = this.resolveCommand(commandName);
			if (!command) {
				return Result.err(new CommandNotFoundError({ commandName }));
			}

			if (command.responseType !== "dynamic" || command.valueSourceName === null) {
				return Result.err(
					new CommandNotUpdateableError({
						commandName,
						responseType: command.responseType,
					}),
				);
			}

			const now = new Date().toISOString();
			const nextState: CommandsAgentState = {
				...this.state,
				revision: this.state.revision + 1,
				valuesByName: {
					...this.state.valuesByName,
					[command.valueSourceName]: {
						value: valueResult.data,
						updatedAt: now,
						updatedBy,
					},
				},
			};
			yield* this.persistState(nextState, "setCommandValue");

			logger.info("Updated command value", {
				command: command.name,
				storedAs: command.valueSourceName,
				updatedBy,
			});
			return Result.ok();
		}, this);
	}

	@rpc
	async getCommandCounter(
		name: string,
	): Promise<Result<number, CommandsDbError | CommandNotFoundError>> {
		const commandNameResult = this.parseCommandName(name, "getCommandCounter");
		if (commandNameResult.status === "error") {
			return commandNameResult;
		}

		const command = this.resolveCommand(commandNameResult.value);
		if (!command) {
			return Result.err(new CommandNotFoundError({ commandName: commandNameResult.value }));
		}

		const counterName = this.getCounterStorageName(command);
		return Result.ok(this.state.countersByName[counterName]?.count ?? 0);
	}

	@rpc
	async incrementCommandCounter(
		name: string,
		increment = 1,
	): Promise<Result<number, CommandsDbError | CommandNotFoundError>> {
		return Result.gen(function* (this: _CommandsDO) {
			const commandName = yield* this.parseCommandName(name, "incrementCommandCounter");
			const incrementResult = CounterIncrementSchema.safeParse(increment);
			if (!incrementResult.success) {
				return Result.err(
					new CommandsDbError({
						operation: "incrementCommandCounter",
						cause: new Error(`Invalid increment value: ${incrementResult.error.message}`),
					}),
				);
			}

			const command = this.resolveCommand(commandName);
			if (!command) {
				return Result.err(new CommandNotFoundError({ commandName }));
			}

			const counterName = this.getCounterStorageName(command);
			const currentCount = this.state.countersByName[counterName]?.count ?? 0;
			const nextCount = currentCount + incrementResult.data;
			const now = new Date().toISOString();
			const nextState: CommandsAgentState = {
				...this.state,
				revision: this.state.revision + 1,
				countersByName: {
					...this.state.countersByName,
					[counterName]: {
						count: nextCount,
						updatedAt: now,
					},
				},
			};
			yield* this.persistState(nextState, "incrementCommandCounter");

			logger.info("Incremented command counter", {
				command: command.name,
				storedAs: counterName,
				count: nextCount,
			});

			return Result.ok(nextCount);
		}, this);
	}

	@rpc
	async getCommandWithValue(
		name: string,
	): Promise<
		Result<{ command: Command; value: string | null }, CommandsDbError | CommandNotFoundError>
	> {
		const commandNameResult = this.parseCommandName(name, "getCommandWithValue");
		if (commandNameResult.status === "error") {
			return commandNameResult;
		}

		const command = this.resolveCommand(commandNameResult.value);
		if (!command) {
			return Result.err(new CommandNotFoundError({ commandName: commandNameResult.value }));
		}

		const value =
			command.valueSourceName === null
				? null
				: (this.state.valuesByName[command.valueSourceName]?.value ?? null);
		return Result.ok({ command, value });
	}

	@rpc
	async createCommand(input: unknown): Promise<Result<Command, CommandsDbError>> {
		return Result.gen(function* (this: _CommandsDO) {
			const commandInput = yield* this.parseCreateCommandInput(input);

			if (this.resolveCommand(commandInput.name) !== undefined) {
				return Result.err(
					new CommandsDbError({
						operation: "createCommand",
						cause: new Error(`Command ${commandInput.name} already exists`),
					}),
				);
			}

			const command = this.buildCommandDefinition(commandInput);
			const nextCommandsByName = {
				...this.state.commandsByName,
				[command.name]: command,
			};
			const nextValuesByName = this.buildNextValuesForCreate(
				command,
				commandInput.initialValue ?? null,
			);
			const nextCountersByName = this.buildNextCountersForCreate(
				command,
				commandInput.initialCounter ?? null,
			);

			yield* this.persistState(
				{
					...this.state,
					revision: this.state.revision + 1,
					legacyImportCompleted: true,
					commandsByName: nextCommandsByName,
					valuesByName: this.pruneValues(nextCommandsByName, nextValuesByName),
					countersByName: this.pruneCounters(nextCommandsByName, nextCountersByName),
				},
				"createCommand",
			);

			logger.info("Created command", {
				command: command.name,
				responseType: command.responseType,
			});

			return Result.ok(command);
		}, this);
	}

	@rpc
	async updateCommand(
		name: string,
		patch: unknown,
	): Promise<Result<Command, CommandsDbError | CommandNotFoundError>> {
		return Result.gen(function* (this: _CommandsDO) {
			const commandName = yield* this.parseCommandName(name, "updateCommand");
			const commandPatch = yield* this.parseUpdateCommandPatch(patch);
			const existing = this.state.commandsByName[commandName];
			if (!existing) {
				return Result.err(new CommandNotFoundError({ commandName }));
			}

			const updated: Command = {
				...existing,
				...commandPatch,
			};
			const nextCommandsByName = {
				...this.state.commandsByName,
				[existing.name]: updated,
			};

			yield* this.persistState(
				{
					...this.state,
					revision: this.state.revision + 1,
					commandsByName: nextCommandsByName,
					valuesByName: this.pruneValues(nextCommandsByName, this.state.valuesByName),
					countersByName: this.pruneCounters(nextCommandsByName, this.state.countersByName),
				},
				"updateCommand",
			);

			logger.info("Updated command definition", {
				command: updated.name,
				responseType: updated.responseType,
			});

			return Result.ok(updated);
		}, this);
	}

	@rpc
	async deleteCommand(name: string): Promise<Result<void, CommandsDbError | CommandNotFoundError>> {
		return Result.gen(function* (this: _CommandsDO) {
			const commandName = yield* this.parseCommandName(name, "deleteCommand");
			const existing = this.state.commandsByName[commandName];
			if (!existing) {
				return Result.err(new CommandNotFoundError({ commandName }));
			}

			const namesToDelete = this.collectCommandsToDelete(commandName);
			const nextCommandsByName: Record<string, Command> = {};
			for (const [nextCommandName, command] of Object.entries(this.state.commandsByName)) {
				if (!namesToDelete.has(nextCommandName)) {
					nextCommandsByName[nextCommandName] = command;
				}
			}

			yield* this.persistState(
				{
					...this.state,
					revision: this.state.revision + 1,
					commandsByName: nextCommandsByName,
					valuesByName: this.pruneValues(nextCommandsByName, this.state.valuesByName),
					countersByName: this.pruneCounters(nextCommandsByName, this.state.countersByName),
				},
				"deleteCommand",
			);

			logger.info("Deleted command", {
				command: commandName,
				deletedCount: namesToDelete.size,
			});

			return Result.ok();
		}, this);
	}

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
				revision: number;
				legacyImportCompleted: boolean;
			},
			CommandsDbError
		>
	> {
		return Result.try({
			try: () => {
				const allCommands = Object.values(this.state.commandsByName);
				const commandsWithState = allCommands.map((command) => {
					const value =
						command.valueSourceName === null
							? null
							: (this.state.valuesByName[command.valueSourceName]?.value ?? null);
					const counterName = this.getCounterStorageName(command);
					const counter =
						command.responseType === "computed"
							? (this.state.countersByName[counterName]?.count ?? null)
							: null;

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
					revision: this.state.revision,
					legacyImportCompleted: this.state.legacyImportCompleted,
				};
			},
			catch: (cause) => new CommandsDbError({ operation: "getDebugSnapshot", cause }),
		});
	}

	@rpc
	async getEnabledCommandsWithValues(): Promise<
		Result<Array<{ command: Command; value: string | null }>, CommandsDbError>
	> {
		return Result.try({
			try: () => {
				const enabledCommandsWithValues: Array<{ command: Command; value: string | null }> = [];
				for (const command of Object.values(this.state.commandsByName)) {
					if (!command.enabled) {
						continue;
					}

					enabledCommandsWithValues.push({
						command,
						value:
							command.valueSourceName === null
								? null
								: (this.state.valuesByName[command.valueSourceName]?.value ?? null),
					});
				}

				return enabledCommandsWithValues;
			},
			catch: (cause) => new CommandsDbError({ operation: "getEnabledCommandsWithValues", cause }),
		});
	}

	private async importLegacyStateOnce(): Promise<Result<void, CommandsDbError>> {
		if (this.state.legacyImportCompleted) {
			return Result.ok();
		}

		return Result.gen(async function* (this: _CommandsDO) {
			// Use Promise.all intentionally: legacy import should fail atomically if any
			// table read fails. allSettled() would allow partial startup hydration.
			const legacyRowsResult = yield* Result.await(
				Result.tryPromise({
					try: () =>
						Promise.all([
							this.legacyDb.query.commands.findMany(),
							this.legacyDb.query.commandValues.findMany(),
							this.legacyDb.query.commandCounters.findMany(),
						]),
					catch: (cause) =>
						new CommandsDbError({ operation: "importLegacyStateOnce.readLegacyRows", cause }),
				}),
			);
			const [legacyCommands, legacyValues, legacyCounters] = legacyRowsResult;

			const commandsByName: Record<string, Command> = {};
			for (const legacyCommand of legacyCommands) {
				const importedCommand = yield* this.parseLegacyCommandForImport(legacyCommand);
				commandsByName[importedCommand.name] = importedCommand;
			}

			const importedValues: Record<string, CommandValueState> = {};
			for (const legacyValue of legacyValues) {
				const importedValue = yield* this.parseLegacyValueForImport(legacyValue);
				importedValues[importedValue.commandName] = importedValue.state;
			}

			const importedCounters: Record<string, CommandCounterState> = {};
			for (const legacyCounter of legacyCounters) {
				const importedCounter = yield* this.parseLegacyCounterForImport(legacyCounter);
				importedCounters[importedCounter.commandName] = importedCounter.state;
			}

			yield* this.persistState(
				{
					revision: 1,
					legacyImportCompleted: true,
					commandsByName,
					valuesByName: this.pruneValues(
						commandsByName,
						this.normalizeImportedValues(commandsByName, importedValues),
					),
					countersByName: this.pruneCounters(
						commandsByName,
						this.normalizeImportedCounters(commandsByName, importedCounters),
					),
				},
				"importLegacyStateOnce",
			);

			logger.info("Imported legacy commands into Agent state", {
				commandCount: legacyCommands.length,
				valueCount: legacyValues.length,
				counterCount: legacyCounters.length,
			});
			return Result.ok();
		}, this);
	}

	private parseCommandName(name: string, operation: string): Result<string, CommandsDbError> {
		const parseResult = CommandNameSchema.safeParse(name);
		if (!parseResult.success) {
			return Result.err(
				new CommandsDbError({
					operation,
					cause: new Error(`Invalid command name: ${parseResult.error.message}`),
				}),
			);
		}

		return Result.ok(parseResult.data);
	}

	private parseCreateCommandInput(input: unknown): Result<CreateCommandInput, CommandsDbError> {
		const parseResult = CreateCommandInputSchema.safeParse(input);
		if (!parseResult.success) {
			return Result.err(
				new CommandsDbError({
					operation: "createCommand",
					cause: new Error(`Invalid command input: ${parseResult.error.message}`),
				}),
			);
		}

		return Result.ok(parseResult.data);
	}

	private parseUpdateCommandPatch(patch: unknown): Result<UpdateCommandInput, CommandsDbError> {
		const parseResult = UpdateCommandInputSchema.safeParse(patch);
		if (!parseResult.success) {
			return Result.err(
				new CommandsDbError({
					operation: "updateCommand",
					cause: new Error(`Invalid command patch: ${parseResult.error.message}`),
				}),
			);
		}

		return Result.ok(parseResult.data);
	}

	private parseLegacyCommandForImport(command: unknown): Result<Command, CommandsDbError> {
		const parseResult = LegacyCommandImportSchema.safeParse(command);
		if (!parseResult.success) {
			return Result.err(
				new CommandsDbError({
					operation: "importLegacyStateOnce.parseCommand",
					cause: new Error(parseResult.error.message),
				}),
			);
		}

		return Result.ok(parseResult.data);
	}

	private parseLegacyValueForImport(commandValue: unknown): Result<
		{
			commandName: string;
			state: CommandValueState;
		},
		CommandsDbError
	> {
		const parseResult = LegacyCommandValueImportSchema.safeParse(commandValue);
		if (!parseResult.success) {
			return Result.err(
				new CommandsDbError({
					operation: "importLegacyStateOnce.parseValue",
					cause: new Error(parseResult.error.message),
				}),
			);
		}

		return Result.ok(parseResult.data);
	}

	private parseLegacyCounterForImport(commandCounter: unknown): Result<
		{
			commandName: string;
			state: CommandCounterState;
		},
		CommandsDbError
	> {
		const parseResult = LegacyCommandCounterImportSchema.safeParse(commandCounter);
		if (!parseResult.success) {
			return Result.err(
				new CommandsDbError({
					operation: "importLegacyStateOnce.parseCounter",
					cause: new Error(parseResult.error.message),
				}),
			);
		}

		return Result.ok(parseResult.data);
	}

	private normalizeImportedValues(
		commandsByName: Record<string, Command>,
		importedValues: Record<string, CommandValueState>,
	): Record<string, CommandValueState> {
		const nextValues = { ...importedValues };

		for (const command of Object.values(commandsByName)) {
			if (command.valueSourceName === null || command.valueSourceName === command.name) {
				continue;
			}

			const aliasValue = importedValues[command.name];
			if (aliasValue && nextValues[command.valueSourceName] === undefined) {
				nextValues[command.valueSourceName] = aliasValue;
			}
			delete nextValues[command.name];
		}

		return nextValues;
	}

	private normalizeImportedCounters(
		commandsByName: Record<string, Command>,
		importedCounters: Record<string, CommandCounterState>,
	): Record<string, CommandCounterState> {
		const nextCounters = { ...importedCounters };

		for (const command of Object.values(commandsByName)) {
			const counterName = this.getCounterStorageName(command);
			if (counterName === command.name) {
				continue;
			}

			const aliasCounter = importedCounters[command.name];
			if (aliasCounter && nextCounters[counterName] === undefined) {
				nextCounters[counterName] = aliasCounter;
			}
			delete nextCounters[command.name];
		}

		return nextCounters;
	}

	private resolveCommand(name: string): Command | undefined {
		const direct = this.state.commandsByName[name];
		if (direct !== undefined) {
			return direct;
		}

		for (const command of Object.values(this.state.commandsByName)) {
			if (command.aliases.includes(name)) {
				return command;
			}
		}

		return undefined;
	}

	private getCounterStorageName(command: Command): string {
		return command.counterSourceName ?? command.name;
	}

	private buildCommandDefinition(input: CreateCommandInput): Command {
		const createdAt = input.createdAt ?? new Date().toISOString();
		const isComputed = input.responseType === "computed";
		const valueSourceName = isComputed ? null : (input.valueSourceName ?? input.name);
		const handlerKey = isComputed ? (input.handlerKey ?? input.name) : null;
		const outputTemplate = isComputed
			? null
			: (input.outputTemplate ?? GenericStoredOutputTemplate);
		const emptyResponse = isComputed
			? null
			: (input.emptyResponse ?? `${input.name} info is not available.`);
		const writePermission = isComputed
			? null
			: input.responseType === "dynamic"
				? (input.writePermission ?? "moderator")
				: null;

		return {
			name: input.name,
			description: input.description,
			category: input.category,
			responseType: input.responseType,
			permission: input.permission,
			enabled: input.enabled ?? true,
			createdAt,
			aliases: input.aliases ?? [],
			valueSourceName,
			counterSourceName: input.counterSourceName ?? null,
			handlerKey,
			outputTemplate,
			emptyResponse,
			writePermission,
		};
	}

	private buildNextValuesForCreate(
		command: Command,
		initialValue: string | null,
	): Record<string, CommandValueState> {
		if (command.valueSourceName === null || initialValue === null) {
			return { ...this.state.valuesByName };
		}

		return {
			...this.state.valuesByName,
			[command.valueSourceName]: {
				value: initialValue,
				updatedAt: new Date().toISOString(),
				updatedBy: null,
			},
		};
	}

	private buildNextCountersForCreate(
		command: Command,
		initialCounter: number | null,
	): Record<string, CommandCounterState> {
		const counterSourceName = command.counterSourceName;
		if (counterSourceName === null || initialCounter === null) {
			return { ...this.state.countersByName };
		}

		return {
			...this.state.countersByName,
			[counterSourceName]: {
				count: initialCounter,
				updatedAt: new Date().toISOString(),
			},
		};
	}

	private pruneValues(
		commandsByName: Record<string, Command>,
		valuesByName: Record<string, CommandValueState>,
	): Record<string, CommandValueState> {
		const referencedNames = new Set<string>();
		for (const command of Object.values(commandsByName)) {
			if (command.valueSourceName !== null) {
				referencedNames.add(command.valueSourceName);
			}
		}

		const nextValues: Record<string, CommandValueState> = {};
		for (const [valueName, valueState] of Object.entries(valuesByName)) {
			if (referencedNames.has(valueName)) {
				nextValues[valueName] = valueState;
			}
		}

		return nextValues;
	}

	private pruneCounters(
		commandsByName: Record<string, Command>,
		countersByName: Record<string, CommandCounterState>,
	): Record<string, CommandCounterState> {
		const referencedNames = new Set<string>();
		for (const command of Object.values(commandsByName)) {
			referencedNames.add(this.getCounterStorageName(command));
		}

		const nextCounters: Record<string, CommandCounterState> = {};
		for (const [counterName, counterState] of Object.entries(countersByName)) {
			if (referencedNames.has(counterName)) {
				nextCounters[counterName] = counterState;
			}
		}

		return nextCounters;
	}

	private collectCommandsToDelete(rootName: string): Set<string> {
		const namesToDelete = new Set<string>([rootName]);
		let added = true;

		while (added) {
			added = false;
			for (const command of Object.values(this.state.commandsByName)) {
				if (namesToDelete.has(command.name)) {
					continue;
				}

				if (
					(command.valueSourceName !== null && namesToDelete.has(command.valueSourceName)) ||
					(command.counterSourceName !== null && namesToDelete.has(command.counterSourceName))
				) {
					namesToDelete.add(command.name);
					added = true;
				}
			}
		}

		return namesToDelete;
	}
}

export const CommandsDO = withRpcSerialization(_CommandsDO);
