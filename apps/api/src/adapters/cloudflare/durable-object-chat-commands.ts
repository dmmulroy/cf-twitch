import { Result } from "better-result";

import {
	CreateChatCommandResultCodec,
	DeleteChatCommandResultCodec,
	GetAllChatCommandsResultCodec,
	GetChatCommandDebugSnapshotResultCodec,
	GetChatCommandResultCodec,
	GetChatCommandValueResultCodec,
	GetEnabledChatCommandsResultCodec,
	IncrementChatCommandCounterResultCodec,
	UpdateChatCommandResultCodec,
	UpdateChatCommandValueResultCodec,
} from "../../lib/commands-rpc-result-codecs";
import { CommandsDbError, type CommandsError } from "../../lib/errors";
import { initializeDurableObjectAgentStub } from "./durable-object-agent-stub";

import type {
	ChatCommandAdministration,
	ChatCommandDebugSnapshot,
} from "../../capabilities/chat-command-administration";
import type { Tracer } from "../../capabilities/tracer";
import type {
	ChatCommandDefinition,
	CreateChatCommandInput,
	UpdateChatCommandInput,
} from "../../domain/chat-command-definition";
import type { CommandCatalog, CommandCounterStore } from "../../lib/chat-command/types";
import type { Permission } from "../../lib/permissions";
import type { Result as ResultType } from "better-result";

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

/** Durable Object adapter for validated Chat Command execution and administration RPC. */
export class DurableObjectChatCommands
	implements CommandCatalog, CommandCounterStore, ChatCommandAdministration
{
	constructor(
		private readonly namespace: Cloudflare.Env["COMMANDS_DO"],
		private readonly tracer: Tracer,
	) {}

	getCommand(name: string): Promise<ResultType<ChatCommandDefinition, CommandsError>> {
		return this.call(
			"getCommand",
			(stub) => stub.getCommand(name),
			(value) => GetChatCommandResultCodec.deserializeUnsafe(value),
		);
	}

	getCommandValue(name: string): Promise<ResultType<string | null, CommandsError>> {
		return this.call(
			"getCommandValue",
			(stub) => stub.getCommandValue(name),
			(value) => GetChatCommandValueResultCodec.deserializeUnsafe(value),
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
			(value) => UpdateChatCommandValueResultCodec.deserializeUnsafe(value),
		);
	}

	getEnabledCommandsByPermission(
		permission: Permission,
	): Promise<ResultType<ChatCommandDefinition[], CommandsError>> {
		return this.call(
			"getEnabledCommandsByPermission",
			(stub) => stub.getEnabledCommandsByPermission(permission),
			(value) => GetEnabledChatCommandsResultCodec.deserializeUnsafe(value),
		);
	}

	incrementCounter(name: string, operationId: string): Promise<ResultType<number, CommandsError>> {
		return this.call(
			"incrementCommandCounter",
			(stub) => stub.incrementCommandCounter(name, 1, operationId),
			(value) => IncrementChatCommandCounterResultCodec.deserializeUnsafe(value),
		);
	}

	getAllCommands(): Promise<ResultType<readonly ChatCommandDefinition[], CommandsError>> {
		return this.call(
			"getAllCommands",
			(stub) => stub.getAllCommands(),
			(value) => GetAllChatCommandsResultCodec.deserializeUnsafe(value),
		);
	}

	createCommand(
		input: CreateChatCommandInput,
	): Promise<ResultType<ChatCommandDefinition, CommandsError>> {
		return this.call(
			"createCommand",
			(stub) => stub.createCommand(input),
			(value) => CreateChatCommandResultCodec.deserializeUnsafe(value),
		);
	}

	updateCommand(
		name: string,
		patch: UpdateChatCommandInput,
	): Promise<ResultType<ChatCommandDefinition, CommandsError>> {
		return this.call(
			"updateCommand",
			(stub) => stub.updateCommand(name, patch),
			(value) => UpdateChatCommandResultCodec.deserializeUnsafe(value),
		);
	}

	deleteCommand(name: string): Promise<ResultType<void, CommandsError>> {
		return this.call(
			"deleteCommand",
			(stub) => stub.deleteCommand(name),
			(value) => DeleteChatCommandResultCodec.deserializeUnsafe(value),
		);
	}

	getDebugSnapshot(): Promise<ResultType<ChatCommandDebugSnapshot, CommandsError>> {
		return this.call(
			"getDebugSnapshot",
			(stub) => stub.getDebugSnapshot(),
			(value) => GetChatCommandDebugSnapshotResultCodec.deserializeUnsafe(value),
		);
	}

	private call<T>(
		operation: CommandsOperation,
		invoke: (
			stub: Awaited<ReturnType<DurableObjectChatCommands["acquireStub"]>>,
		) => Promise<unknown>,
		deserializeUnsafe: (
			value: unknown,
		) => ResultType<T, CommandsError> | Promise<ResultType<T, CommandsError>>,
	): Promise<ResultType<T, CommandsError>> {
		return this.tracer.span(`durable_object.commands.${operation}`, { operation }, async () => {
			let rawResult: unknown;
			try {
				rawResult = await invoke(await this.acquireStub());
			} catch (cause) {
				return Result.err(new CommandsDbError({ operation, cause }));
			}
			return await deserializeUnsafe(rawResult);
		});
	}

	private acquireStub() {
		return initializeDurableObjectAgentStub(this.namespace.getByName("commands"), "commands");
	}
}
