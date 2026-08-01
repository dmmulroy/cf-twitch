import { Result } from "better-result";
import { z } from "zod";

import { ChatCommandDebugSnapshotSchema } from "../capabilities/chat-command-administration";
import { ChatCommandDefinitionSchema } from "../domain/chat-command-definition";
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
} from "./errors";

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

const CommandsErrorToWireSchema = z
	.custom<CommandsError>(
		(value) =>
			typeof value === "object" &&
			value !== null &&
			"_tag" in value &&
			CommandsWireErrorSchema.options.some((schema) => schema.shape._tag.value === value._tag),
	)
	.transform((error): CommandsWireError => ({ ...error, message: error.message }))
	.pipe(CommandsWireErrorSchema);

const CommandsErrorFromWireSchema = CommandsWireErrorSchema.transform((error): CommandsError => {
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
});

function createCommandsResultCodec<T>(okSchema: z.ZodType<T>) {
	return Result.codec({
		serialize: { ok: okSchema, err: CommandsErrorToWireSchema },
		deserialize: { ok: okSchema, err: CommandsErrorFromWireSchema },
	});
}

const CommandListSchema = z.array(ChatCommandDefinitionSchema);
const CommandWithValueSchema = z.object({
	command: ChatCommandDefinitionSchema,
	value: z.string().nullable(),
});

/** RPC codec for reading one Chat Command. */
export const GetChatCommandResultCodec = createCommandsResultCodec(ChatCommandDefinitionSchema);
/** RPC codec for reading all Chat Commands. */
export const GetAllChatCommandsResultCodec = createCommandsResultCodec(CommandListSchema);
/** RPC codec for reading enabled Chat Commands by permission. */
export const GetEnabledChatCommandsResultCodec = createCommandsResultCodec(CommandListSchema);
/** RPC codec for reading one Chat Command value. */
export const GetChatCommandValueResultCodec = createCommandsResultCodec(z.string().nullable());
/** RPC codec for updating one Chat Command value. */
export const UpdateChatCommandValueResultCodec = createCommandsResultCodec(z.undefined());
/** RPC codec for reading one Chat Command counter. */
export const GetChatCommandCounterResultCodec = createCommandsResultCodec(
	z.number().int().nonnegative(),
);
/** RPC codec for incrementing one Chat Command counter. */
export const IncrementChatCommandCounterResultCodec = createCommandsResultCodec(
	z.number().int().nonnegative(),
);
/** RPC codec for reading one Chat Command and its current value. */
export const GetChatCommandWithValueResultCodec = createCommandsResultCodec(CommandWithValueSchema);
/** RPC codec for creating one Chat Command. */
export const CreateChatCommandResultCodec = createCommandsResultCodec(ChatCommandDefinitionSchema);
/** RPC codec for updating one Chat Command definition. */
export const UpdateChatCommandResultCodec = createCommandsResultCodec(ChatCommandDefinitionSchema);
/** RPC codec for deleting one Chat Command. */
export const DeleteChatCommandResultCodec = createCommandsResultCodec(z.undefined());
/** RPC codec for reading the Chat Command debug snapshot. */
export const GetChatCommandDebugSnapshotResultCodec = createCommandsResultCodec(
	ChatCommandDebugSnapshotSchema,
);
/** RPC codec for reading enabled Chat Commands with values. */
export const GetEnabledChatCommandsWithValuesResultCodec = createCommandsResultCodec(
	z.array(CommandWithValueSchema),
);
