/**
 * CommandsDO - Chat command registry and dynamic values
 *
 * Agent state owns command definitions, values, and counters.
 */

import { Agent, type AgentContext } from "agents";
import { Result } from "better-result";
import { z } from "zod";

import { rpc, withRpcSerialization } from "../lib/durable-objects";
import { CommandsDbError, CommandNotFoundError, CommandNotUpdateableError } from "../lib/errors";
import { logger } from "../lib/logger";

import type { Env } from "../index";
import type { Permission } from "../lib/permissions";

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

export interface CommandsAgentState {
	revision: number;
	commandsByName: Record<string, Command>;
	valuesByName: Record<string, z.infer<typeof CommandValueStateSchema>>;
	countersByName: Record<string, z.infer<typeof CommandCounterStateSchema>>;
	appliedMigrations?: string[];
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

function createPlanCommandInput(now: string): CreateCommandInput {
	return {
		name: "plan",
		description: "Shows Plannotator link",
		category: "info",
		responseType: "static",
		permission: "everyone",
		initialValue: "Plannotator: https://plannotator.ai",
		createdAt: now,
	};
}

function createHerdrCommandInput(now: string): CreateCommandInput {
	return {
		name: "herdr",
		description: "Shows Herdr link",
		category: "info",
		responseType: "static",
		permission: "everyone",
		initialValue: "Herdr: https://herdr.dev/",
		createdAt: now,
	};
}

const DefaultCommandMigrations = [
	{
		id: "2026-05-27-add-plan-command",
		kind: "create",
		createInput: createPlanCommandInput,
	},
	{
		id: "2026-05-27-add-df-dotfiles-alias",
		kind: "add-alias",
		commandName: "dotfiles",
		alias: "df",
	},
	{
		id: "2026-06-25-add-herdr-command",
		kind: "create",
		createInput: createHerdrCommandInput,
	},
] as const;

const DefaultCommandMigrationIds = DefaultCommandMigrations.map((migration) => migration.id);

function createDefaultCommandInputs(now: string): CreateCommandInput[] {
	return [
		{
			name: "keyboard",
			description: "Shows keyboard info and build video",
			category: "info",
			responseType: "static",
			permission: "everyone",
			initialValue:
				"ZSA Voyager with Choc White switches: https://www.youtube.com/watch?v=WfIfxaXC_Q4",
			createdAt: now,
		},
		{
			name: "socials",
			description: "Shows social media links",
			category: "info",
			responseType: "static",
			permission: "everyone",
			initialValue: "GitHub: github.com/dmmulroy | X: x.com/dillon_mulroy",
			createdAt: now,
		},
		{
			name: "github",
			description: "Shows GitHub link",
			category: "info",
			responseType: "static",
			permission: "everyone",
			initialValue: "Follow me on GitHub! -> https://github.com/dmmulroy",
			createdAt: now,
		},
		{
			name: "twitter",
			description: "Shows Twitter/X link",
			category: "info",
			responseType: "static",
			permission: "everyone",
			initialValue: "Follow me on Twitter (X)! -> https://twitter.com/dillon_mulroy",
			createdAt: now,
		},
		{
			name: "schedule",
			description: "Shows stream schedule",
			category: "info",
			responseType: "static",
			permission: "everyone",
			initialValue: "My stream schedule -> https://www.twitch.tv/dmmulroy/schedule",
			createdAt: now,
		},
		{
			name: "font",
			description: "Shows preferred coding font",
			category: "info",
			responseType: "static",
			permission: "everyone",
			initialValue: "MonoLisa - https://www.monolisa.dev",
			createdAt: now,
		},
		{
			name: "dotfiles",
			description: "Shows dotfiles repository link",
			category: "info",
			responseType: "static",
			permission: "everyone",
			aliases: ["df"],
			initialValue:
				"My dotfiles can be found here: https://github.com/dmmulroy/.dotfiles !neovim for a youtube walkthrough of my neovim config.",
			createdAt: now,
		},
		{
			name: "today",
			description: "Shows what's being worked on today",
			category: "info",
			responseType: "dynamic",
			permission: "everyone",
			outputTemplate: DynamicCommandOutputTemplate,
			emptyResponse: DynamicCommandEmptyResponse,
			writePermission: "moderator",
			initialValue: "",
			createdAt: now,
		},
		{
			name: "project",
			description: "Shows current project (alias for today)",
			category: "info",
			responseType: "dynamic",
			permission: "everyone",
			valueSourceName: "today",
			outputTemplate: DynamicCommandOutputTemplate,
			emptyResponse: DynamicCommandEmptyResponse,
			writePermission: "moderator",
			createdAt: now,
		},
		createPlanCommandInput(now),
		createHerdrCommandInput(now),
		{
			name: "achievements",
			description: "Shows user's unlocked achievements",
			category: "stats",
			responseType: "computed",
			permission: "everyone",
			handlerKey: "achievements",
			createdAt: now,
		},
		{
			name: "stats",
			description: "Shows user's song/achievement/raffle stats",
			category: "stats",
			responseType: "computed",
			permission: "everyone",
			handlerKey: "stats",
			createdAt: now,
		},
		{
			name: "raffle-leaderboard",
			description: "Shows top raffle winners",
			category: "stats",
			responseType: "computed",
			permission: "everyone",
			handlerKey: "raffle-leaderboard",
			createdAt: now,
		},
		{
			name: "commands",
			description: "Lists available commands",
			category: "meta",
			responseType: "computed",
			permission: "everyone",
			handlerKey: "commands",
			createdAt: now,
		},
		{
			name: "update",
			description: "Updates dynamic command values",
			category: "meta",
			responseType: "computed",
			permission: "vip",
			handlerKey: "update",
			createdAt: now,
		},
		{
			name: "song",
			description: "Request a song via Spotify URL",
			category: "music",
			responseType: "computed",
			permission: "everyone",
			handlerKey: "song",
			createdAt: now,
		},
		{
			name: "queue",
			description: "Shows current song queue",
			category: "music",
			responseType: "computed",
			permission: "everyone",
			handlerKey: "queue",
			createdAt: now,
		},
		{
			name: "functor",
			description: "A fun one-liner response",
			category: "meta",
			responseType: "static",
			permission: "everyone",
			initialValue: "Functor? I hardly know her!",
			createdAt: now,
		},
		{
			name: "location",
			description: "Shows streamer timezone",
			category: "info",
			responseType: "static",
			permission: "everyone",
			initialValue: "I am in Eastern Standard Time!",
			createdAt: now,
		},
		{
			name: "ocaml",
			description: "OCaml command response",
			category: "meta",
			responseType: "static",
			permission: "everyone",
			initialValue: "dmmulrOCaml",
			createdAt: now,
		},
		{
			name: "lurk",
			description: "Lurk acknowledgement command",
			category: "meta",
			responseType: "static",
			permission: "everyone",
			initialValue: "${user} is here but they are Lurking! Thank you for watching! ${random.emote}",
			createdAt: now,
		},
		{
			name: "youtube",
			description: "Shows YouTube channel link",
			category: "info",
			responseType: "static",
			permission: "everyone",
			initialValue: "Check out my youtube! https://www.youtube.com/@dmmulroy",
			createdAt: now,
		},
		{
			name: "unlurk",
			description: "Unlurk acknowledgement command",
			category: "meta",
			responseType: "static",
			permission: "everyone",
			initialValue: "${user} is back on the saddle! Thanks for coming back! ${random.emote}",
			createdAt: now,
		},
		{
			name: "errors",
			description: "Error meme link",
			category: "meta",
			responseType: "static",
			permission: "everyone",
			initialValue: "https://twitter.com/vitalyf/status/1582270207229251585",
			createdAt: now,
		},
		{
			name: "vibes",
			description: "Vibes check command",
			category: "meta",
			responseType: "static",
			permission: "everyone",
			initialValue: "Immaculate",
			createdAt: now,
		},
		{
			name: "neovim",
			description: "Neovim config walkthrough link",
			category: "info",
			responseType: "static",
			permission: "everyone",
			initialValue:
				"Here is a youtube video walkthrough of my neovim config: https://youtu.be/oo_I5lAmdi0",
			createdAt: now,
		},
		{
			name: "dict",
			description: "Clip command",
			category: "meta",
			responseType: "static",
			permission: "everyone",
			initialValue: "https://clips.twitch.tv/SlipperySarcasticMosquitoTwitchRPG-9V43D-1B4NjpX1B0",
			createdAt: now,
		},
		{
			name: "beam",
			description: "BEAM slogan command",
			category: "meta",
			responseType: "static",
			permission: "everyone",
			initialValue: "BEAM WORK MAKES THE DREAM WORK",
			createdAt: now,
		},
		{
			name: "linux",
			description: "GNU/Linux copypasta command",
			category: "meta",
			responseType: "static",
			permission: "everyone",
			initialValue:
				"I'd just like to interject for a moment. What you're refering to as Linux, is in fact, GNU/Linux, or as I've recently taken to calling it, GNU plus Linux. Linux is not an operating system unto itself, but rather another free component of a fully functioning GNU system made useful by the GNU corelibs, shell utilities and vital system components comprising a full OS as defined by POSIX.",
			createdAt: now,
		},
		{
			name: "time",
			description: "Shows current Eastern time",
			category: "info",
			responseType: "computed",
			permission: "everyone",
			handlerKey: "time",
			createdAt: now,
		},
		{
			name: "leak",
			description: "Security leak meme command",
			category: "meta",
			responseType: "dynamic",
			permission: "everyone",
			writePermission: "vip",
			initialValue:
				"Dillon last leaked his keys on 23 Jan 2026 (before on 09 Dec 2025 ), admin secret on 16 Feb 2026",
			createdAt: now,
		},
		{
			name: "skillissue",
			description: "Increments and shows skill issue count",
			category: "stats",
			responseType: "computed",
			permission: "vip",
			handlerKey: "skillissue",
			counterSourceName: "skillissue",
			initialCounter: 0,
			createdAt: now,
		},
		{
			name: "truth",
			description: "Truth clip command",
			category: "meta",
			responseType: "static",
			permission: "everyone",
			initialValue:
				"https://www.twitch.tv/dmmulroy/clip/RichObedientWalletKeyboardCat-UiKKTpgvCKHVyFHd",
			createdAt: now,
		},
		{
			name: "job",
			description: "Shows current job",
			category: "info",
			responseType: "static",
			permission: "everyone",
			initialValue:
				"I am Principal Engineer and Rockstar TypeScript Developer at Cloudflare 1.1.1.1",
			createdAt: now,
		},
		{
			name: "browser",
			description: "Shows browser recommendation link",
			category: "info",
			responseType: "static",
			permission: "everyone",
			initialValue: "Helium Browser: https://helium.computer",
			createdAt: now,
		},
		{
			name: "hex",
			description: "Shows Hex link",
			category: "info",
			responseType: "static",
			permission: "everyone",
			initialValue: "I am using Hex by Kit Langton: https://hex.kitlangton.com/",
			createdAt: now,
		},
	];
}

class _CommandsDO extends Agent<Env, CommandsAgentState> {
	initialState: CommandsAgentState = {
		revision: 0,
		commandsByName: {},
		valuesByName: {},
		countersByName: {},
		appliedMigrations: [],
	};

	constructor(ctx: AgentContext, env: Env) {
		super(ctx, env);
	}

	async onStart(): Promise<void> {
		await this.ctx.blockConcurrencyWhile(async () => {
			const bootstrapResult = this.bootstrapDefaultState();
			if (bootstrapResult.status === "error") {
				logger.error("Failed to bootstrap default commands state", {
					error: bootstrapResult.error.message,
					operation: bootstrapResult.error.operation,
				});
				return;
			}

			const migrationResult = this.applyDefaultCommandMigrations();
			if (migrationResult.status === "error") {
				logger.error("Failed to apply default command migrations", {
					error: migrationResult.error.message,
					operation: migrationResult.error.operation,
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
				initialized: boolean;
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
					initialized: this.isInitializedState(),
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

	private isInitializedState(state: CommandsAgentState = this.state): boolean {
		return (
			Object.keys(state.commandsByName).length > 0 ||
			Object.keys(state.valuesByName).length > 0 ||
			Object.keys(state.countersByName).length > 0 ||
			state.revision > 0
		);
	}

	private bootstrapDefaultState(): Result<void, CommandsDbError> {
		if (this.isInitializedState()) {
			return Result.ok();
		}

		const now = new Date().toISOString();
		let nextState: CommandsAgentState = {
			revision: 1,
			commandsByName: {},
			valuesByName: {},
			countersByName: {},
			appliedMigrations: [...DefaultCommandMigrationIds],
		};

		for (const input of createDefaultCommandInputs(now)) {
			nextState = this.addCommandInputToState(nextState, input, now);
		}

		return this.persistState(nextState, "bootstrapDefaultState");
	}

	private applyDefaultCommandMigrations(): Result<void, CommandsDbError> {
		const now = new Date().toISOString();
		let nextState: CommandsAgentState = {
			...this.state,
			appliedMigrations: this.state.appliedMigrations ?? [],
		};
		let changed = this.state.appliedMigrations === undefined;

		for (const migration of DefaultCommandMigrations) {
			if (nextState.appliedMigrations?.includes(migration.id) === true) {
				continue;
			}

			if (migration.kind === "create") {
				const input = migration.createInput(now);
				if (this.resolveCommandInState(nextState, input.name) === undefined) {
					nextState = this.addCommandInputToState(nextState, input, now);
				}
			} else if (migration.kind === "add-alias") {
				const command = this.resolveCommandInState(nextState, migration.commandName);
				if (
					command !== undefined &&
					!command.aliases.includes(migration.alias) &&
					this.resolveCommandInState(nextState, migration.alias) === undefined
				) {
					nextState = this.addCommandAliasToState(nextState, command.name, migration.alias);
				}
			}

			nextState = {
				...nextState,
				appliedMigrations: [...(nextState.appliedMigrations ?? []), migration.id],
			};
			changed = true;
		}

		if (!changed) {
			return Result.ok();
		}

		return this.persistState(
			{
				...nextState,
				revision: this.state.revision + 1,
			},
			"applyDefaultCommandMigrations",
		);
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

	private resolveCommand(name: string): Command | undefined {
		return this.resolveCommandInState(this.state, name);
	}

	private resolveCommandInState(state: CommandsAgentState, name: string): Command | undefined {
		const direct = state.commandsByName[name];
		if (direct !== undefined) {
			return direct;
		}

		for (const command of Object.values(state.commandsByName)) {
			if (command.aliases.includes(name)) {
				return command;
			}
		}

		return undefined;
	}

	private getCounterStorageName(command: Command): string {
		return command.counterSourceName ?? command.name;
	}

	private addCommandInputToState(
		state: CommandsAgentState,
		input: CreateCommandInput,
		now: string,
	): CommandsAgentState {
		const command = this.buildCommandDefinition(input);
		const nextCommandsByName = {
			...state.commandsByName,
			[command.name]: command,
		};
		let nextValuesByName = state.valuesByName;
		if (
			command.valueSourceName !== null &&
			input.initialValue !== null &&
			input.initialValue !== undefined
		) {
			nextValuesByName = {
				...state.valuesByName,
				[command.valueSourceName]: {
					value: input.initialValue,
					updatedAt: now,
					updatedBy: null,
				},
			};
		}

		let nextCountersByName = state.countersByName;
		const counterName = command.counterSourceName;
		if (
			counterName !== null &&
			input.initialCounter !== null &&
			input.initialCounter !== undefined
		) {
			nextCountersByName = {
				...state.countersByName,
				[counterName]: {
					count: input.initialCounter,
					updatedAt: now,
				},
			};
		}

		return {
			...state,
			commandsByName: nextCommandsByName,
			valuesByName: this.pruneValues(nextCommandsByName, nextValuesByName),
			countersByName: this.pruneCounters(nextCommandsByName, nextCountersByName),
		};
	}

	private addCommandAliasToState(
		state: CommandsAgentState,
		commandName: string,
		alias: string,
	): CommandsAgentState {
		const command = state.commandsByName[commandName];
		if (command === undefined) {
			return state;
		}

		return {
			...state,
			commandsByName: {
				...state.commandsByName,
				[command.name]: {
					...command,
					aliases: [...command.aliases, alias],
				},
			},
		};
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
