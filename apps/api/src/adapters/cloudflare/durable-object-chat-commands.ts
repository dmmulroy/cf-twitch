import { Result } from "better-result";
import { z } from "zod";

import {
	ChatCommandDebugSnapshotSchema,
	type ChatCommandAdministration,
	type ChatCommandDebugSnapshot,
} from "../../capabilities/chat-command-administration";
import {
	ChatCommandDefinitionSchema,
	type ChatCommandDefinition,
	type CreateChatCommandInput,
	type UpdateChatCommandInput,
} from "../../domain/chat-command-definition";
import {
	CommandAliasConflictError,
	CommandAlreadyExistsError,
	CommandInputParseError,
	CommandInvalidDefinitionError,
	CommandNotFoundError,
	CommandNotUpdateableError,
	CommandUpdatePermissionDeniedError,
	CommandsDbError,
	CommandsStateParseError,
	InvalidCommandNameError,
	type CommandsError,
} from "../../lib/errors";
import { DurableObjectError } from "../../lib/errors";
import { fromRpcResult, type RpcPayloadParser } from "../../lib/rpc-result";
import { initializeDurableObjectAgentStub } from "./durable-object-agent-stub";

import type { Tracer } from "../../capabilities/tracer";
import type { CommandCatalog, CommandCounterStore } from "../../lib/chat-command/types";
import type { Permission } from "../../lib/permissions";
import type { Result as ResultType } from "better-result";

const CommandsWireErrorSchema = z.discriminatedUnion("_tag", [
	z.object({ _tag: z.literal("CommandsDbError"), operation: z.string(), message: z.string() }),
	z.object({ _tag: z.literal("CommandsStateParseError"), issues: z.string(), message: z.string() }),
	z.object({
		_tag: z.literal("CommandInputParseError"),
		operation: z.string(),
		issues: z.string(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("InvalidCommandNameError"),
		commandName: z.string(),
		operation: z.string(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("CommandAlreadyExistsError"),
		commandName: z.string(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("CommandAliasConflictError"),
		alias: z.string(),
		owner: z.string(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("CommandInvalidDefinitionError"),
		commandName: z.string(),
		reason: z.string(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("CommandUpdatePermissionDeniedError"),
		commandName: z.string(),
		requiredPermission: z.enum(["everyone", "vip", "moderator", "broadcaster"]),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("CommandNotFoundError"),
		commandName: z.string(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("CommandNotUpdateableError"),
		commandName: z.string(),
		responseType: z.string(),
		message: z.string(),
	}),
]);

type CommandsWireError = z.infer<typeof CommandsWireErrorSchema>;
type CommandsOperation =
	| "getCommand"
	| "getCommandValue"
	| "updateCommandValue"
	| "getEnabledCommandsByPermission"
	| "incrementCommandCounter"
	| "getAllCommands"
	| "createCommand"
	| "updateCommand"
	| "deleteCommand"
	| "getDebugSnapshot";

function parseWithSchema<T>(schema: z.ZodType<T>): RpcPayloadParser<T> {
	return (input) => {
		const parsed = schema.safeParse(input);
		return parsed.success ? Result.ok(parsed.data) : Result.err(parsed.error.message);
	};
}

const parseCommandsWireError = parseWithSchema(CommandsWireErrorSchema);
const parseVoid: RpcPayloadParser<void> = (input) =>
	input === undefined ? Result.ok(undefined) : Result.err("Expected an undefined success value");

function translateCommandsWireError(error: CommandsWireError): CommandsError {
	switch (error._tag) {
		case "CommandsDbError":
			return new CommandsDbError({ operation: error.operation });
		case "CommandsStateParseError":
			return new CommandsStateParseError({ issues: error.issues });
		case "CommandInputParseError":
			return new CommandInputParseError({ operation: error.operation, issues: error.issues });
		case "InvalidCommandNameError":
			return new InvalidCommandNameError({
				commandName: error.commandName,
				operation: error.operation,
			});
		case "CommandAlreadyExistsError":
			return new CommandAlreadyExistsError({ commandName: error.commandName });
		case "CommandAliasConflictError":
			return new CommandAliasConflictError({ alias: error.alias, owner: error.owner });
		case "CommandInvalidDefinitionError":
			return new CommandInvalidDefinitionError({
				commandName: error.commandName,
				reason: error.reason,
			});
		case "CommandUpdatePermissionDeniedError":
			return new CommandUpdatePermissionDeniedError({
				commandName: error.commandName,
				requiredPermission: error.requiredPermission,
			});
		case "CommandNotFoundError":
			return new CommandNotFoundError({ commandName: error.commandName });
		case "CommandNotUpdateableError":
			return new CommandNotUpdateableError({
				commandName: error.commandName,
				responseType: error.responseType,
			});
	}
}

/** Parsed Durable Object adapter for Chat Command execution and administration. */
export class DurableObjectChatCommands
	implements CommandCatalog, CommandCounterStore, ChatCommandAdministration
{
	constructor(
		private readonly namespace: Cloudflare.Env["COMMANDS_DO"],
		private readonly tracer: Tracer,
	) {}

	getCommand(name: string): Promise<ResultType<ChatCommandDefinition, CommandsError>> {
		return this.call("getCommand", (stub) => stub.getCommand(name), ChatCommandDefinitionSchema);
	}

	getCommandValue(name: string): Promise<ResultType<string | null, CommandsError>> {
		return this.call(
			"getCommandValue",
			(stub) => stub.getCommandValue(name),
			z.string().nullable(),
		);
	}

	updateCommandValue(
		name: string,
		value: string,
		actor: { readonly displayName: string; readonly permission: Permission },
		operationId: string,
	): Promise<ResultType<void, CommandsError>> {
		return this.call(
			"updateCommandValue",
			(stub) => stub.updateCommandValue(name, value, actor, operationId),
			parseVoid,
		);
	}

	getEnabledCommandsByPermission(
		permission: Permission,
	): Promise<ResultType<ChatCommandDefinition[], CommandsError>> {
		return this.call(
			"getEnabledCommandsByPermission",
			(stub) => stub.getEnabledCommandsByPermission(permission),
			z.array(ChatCommandDefinitionSchema),
		);
	}

	incrementCounter(name: string, operationId: string): Promise<ResultType<number, CommandsError>> {
		return this.call(
			"incrementCommandCounter",
			(stub) => stub.incrementCommandCounter(name, 1, operationId),
			z.number().int().nonnegative(),
		);
	}

	getAllCommands(): Promise<ResultType<readonly ChatCommandDefinition[], CommandsError>> {
		return this.call(
			"getAllCommands",
			(stub) => stub.getAllCommands(),
			z.array(ChatCommandDefinitionSchema),
		);
	}

	createCommand(
		input: CreateChatCommandInput,
	): Promise<ResultType<ChatCommandDefinition, CommandsError>> {
		return this.call(
			"createCommand",
			(stub) => stub.createCommand(input),
			ChatCommandDefinitionSchema,
		);
	}

	updateCommand(
		name: string,
		patch: UpdateChatCommandInput,
	): Promise<ResultType<ChatCommandDefinition, CommandsError>> {
		return this.call(
			"updateCommand",
			(stub) => stub.updateCommand(name, patch),
			ChatCommandDefinitionSchema,
		);
	}

	deleteCommand(name: string): Promise<ResultType<void, CommandsError>> {
		return this.call("deleteCommand", (stub) => stub.deleteCommand(name), parseVoid);
	}

	getDebugSnapshot(): Promise<ResultType<ChatCommandDebugSnapshot, CommandsError>> {
		return this.call(
			"getDebugSnapshot",
			(stub) => stub.getDebugSnapshot(),
			ChatCommandDebugSnapshotSchema,
		);
	}

	private call<T>(
		operation: CommandsOperation,
		invoke: (
			stub: Awaited<ReturnType<DurableObjectChatCommands["acquireStub"]>>,
		) => Promise<unknown>,
		parser: z.ZodType<T> | RpcPayloadParser<T>,
	): Promise<ResultType<T, CommandsError>> {
		return this.tracer.span(`durable_object.commands.${operation}`, { operation }, async () => {
			let rawResult: unknown;
			try {
				rawResult = await invoke(await this.acquireStub());
			} catch (cause) {
				return Result.err(new CommandsDbError({ operation, cause }));
			}
			const successParser = typeof parser === "function" ? parser : parseWithSchema(parser);
			const parsed = fromRpcResult(rawResult, `CommandsDO.${operation}`, {
				success: successParser,
				error: parseCommandsWireError,
			});
			if (parsed.status === "ok") return Result.ok(parsed.value);
			return Result.err(
				DurableObjectError.is(parsed.error)
					? new CommandsDbError({ operation, cause: parsed.error })
					: translateCommandsWireError(parsed.error),
			);
		});
	}

	private acquireStub() {
		return initializeDurableObjectAgentStub(this.namespace.getByName("commands"), "commands");
	}
}
