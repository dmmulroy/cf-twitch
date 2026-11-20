import { Effect, Option, Schema } from "effect";
import { isOpenApiPattern } from "./schema-pattern.ts";
import { EventSubMessageId, IsoTimestamp, NonNegativeInt, ViewerId } from "./identity.ts";

/** Canonical chat command name; aliases obey the same lowercase syntax. */
export const ChatCommandName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(50),
  isOpenApiPattern(/^[a-z0-9-]+$/),
).pipe(Schema.brand("ChatCommandName"));

/** Parsed canonical chat command name. */
export type ChatCommandName = typeof ChatCommandName.Type;

/** Chat permission hierarchy, independent of subscription badges. */
export const ChatCommandPermission = Schema.Literals([
  "everyone",
  "vip",
  "moderator",
  "broadcaster",
]);

/** Parsed chat permission tier. */
export type ChatCommandPermission = typeof ChatCommandPermission.Type;

/** Presentation category used by command administration. */
export const ChatCommandCategory = Schema.Literals(["info", "stats", "meta", "music"]);

/** Persisted command value; rendered output has a separate 500 code point limit. */
export const ChatCommandValue = Schema.String.check(Schema.isMaxLength(2000));

const CommandTemplate = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2000));

const CommandDescription = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

const CommandHandlerKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));

const CommandAliases = Schema.Array(ChatCommandName).check(Schema.isMaxLength(20));

const definitionBase = {
  name: ChatCommandName,
  description: CommandDescription,
  category: ChatCommandCategory,
  permission: ChatCommandPermission,
  enabled: Schema.Boolean,
  createdAt: IsoTimestamp,
  aliases: CommandAliases,
};

const storedFields = {
  /** Command whose shared stored value this command renders; aliases share a value through it. */
  valueSourceName: ChatCommandName,
  counterSourceName: Schema.Null,
  handlerKey: Schema.Null,
  /** Response template; `{value}` is replaced by the stored value after placeholder expansion. */
  outputTemplate: CommandTemplate,
  /** Response sent when no value is stored or the stored value is empty. */
  emptyResponse: CommandTemplate,
};

/** Response-specific command definition; null fields preserve the administrative wire protocol. */
export const ChatCommandDefinition = Schema.Union([
  Schema.Struct({
    ...definitionBase,
    responseType: Schema.Literal("static"),
    ...storedFields,
    writePermission: Schema.Null,
  }),
  Schema.Struct({
    ...definitionBase,
    responseType: Schema.Literal("dynamic"),
    ...storedFields,
    /** Lowest tier allowed to update the stored value from chat. */
    writePermission: ChatCommandPermission,
  }),
  Schema.Struct({
    ...definitionBase,
    responseType: Schema.Literal("computed"),
    valueSourceName: Schema.Null,
    /** Command whose counter this command reads, or `Option.none()` to use its own name. */
    counterSourceName: Schema.OptionFromNullOr(ChatCommandName),
    /** Runtime renderer key, such as `time` or `stats`; unknown keys render a configuration message. */
    handlerKey: CommandHandlerKey,
    outputTemplate: Schema.Null,
    emptyResponse: Schema.Null,
    writePermission: Schema.Null,
  }),
]);

/** Parsed response-specific command definition. */
export type ChatCommandDefinition = typeof ChatCommandDefinition.Type;

const createBase = {
  name: ChatCommandName,
  description: CommandDescription,
  category: ChatCommandCategory,
  permission: ChatCommandPermission,
  enabled: Schema.OptionFromOptionalKey(Schema.Boolean),
  aliases: Schema.OptionFromOptionalKey(CommandAliases),
  createdAt: Schema.OptionFromOptionalKey(IsoTimestamp),
};

const createStored = {
  valueSourceName: Schema.OptionFromOptionalKey(ChatCommandName),
  outputTemplate: Schema.OptionFromOptionalKey(CommandTemplate),
  emptyResponse: Schema.OptionFromOptionalKey(CommandTemplate),
  initialValue: Schema.OptionFromOptionalKey(ChatCommandValue),
};

/**
 * Strict create input; omitted fields decode to `Option.none()` and are defaulted once by command construction.
 *
 * Decoders must pass `chatCommandInputParseOptions`: Effect 4.1 no longer applies `parseOptions` annotations.
 */
export const CreateChatCommandInput = Schema.Union([
  Schema.Struct({ ...createBase, responseType: Schema.Literal("static"), ...createStored }),
  Schema.Struct({
    ...createBase,
    responseType: Schema.Literal("dynamic"),
    ...createStored,
    writePermission: Schema.OptionFromOptionalKey(ChatCommandPermission),
  }),
  Schema.Struct({
    ...createBase,
    responseType: Schema.Literal("computed"),
    handlerKey: CommandHandlerKey,
    counterSourceName: Schema.OptionFromOptionalKey(ChatCommandName),
    initialCounter: Schema.OptionFromOptionalKey(NonNegativeInt),
  }),
]);

/** Parsed command create input. */
export type CreateChatCommandInput = typeof CreateChatCommandInput.Type;

/**
 * Nonempty definition patch; response transitions must supply all contradictory field changes.
 *
 * Decoders must pass `chatCommandInputParseOptions` to reject unmodeled fields.
 */
export const UpdateChatCommandInput = Schema.Struct({
  description: Schema.optionalKey(CommandDescription),
  category: Schema.optionalKey(ChatCommandCategory),
  responseType: Schema.optionalKey(Schema.Literals(["static", "dynamic", "computed"])),
  permission: Schema.optionalKey(ChatCommandPermission),
  enabled: Schema.optionalKey(Schema.Boolean),
  aliases: Schema.optionalKey(CommandAliases),
  valueSourceName: Schema.optionalKey(Schema.NullOr(ChatCommandName)),
  counterSourceName: Schema.optionalKey(Schema.NullOr(ChatCommandName)),
  handlerKey: Schema.optionalKey(Schema.NullOr(CommandHandlerKey)),
  outputTemplate: Schema.optionalKey(Schema.NullOr(CommandTemplate)),
  emptyResponse: Schema.optionalKey(Schema.NullOr(CommandTemplate)),
  writePermission: Schema.optionalKey(Schema.NullOr(ChatCommandPermission)),
}).check(
  Schema.makeFilter((patch) => Object.keys(patch).length > 0 || "Command patch must not be empty"),
);

/** Parsed nonempty command patch. */
export type UpdateChatCommandInput = typeof UpdateChatCommandInput.Type;

/** Command name selector shared by HTTP and application operations. */
export const ChatCommandSelector = Schema.Struct({ name: ChatCommandName });

/** Atomic command patch operation. */
export const UpdateChatCommandRequest = Schema.Struct({
  name: ChatCommandName,
  patch: UpdateChatCommandInput,
});

/** Authenticated chat actor; permission is checked inside the mutation transaction. */
export const ChatCommandActor = Schema.Struct({
  displayName: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  permission: ChatCommandPermission,
});

/** Atomic stored-value update, optionally deduplicated by EventSub message identity. */
export const UpdateChatCommandValue = Schema.Struct({
  name: ChatCommandName,
  value: ChatCommandValue,
  /** Viewer making the change; their permission is checked against the current write tier. */
  actor: ChatCommandActor,
  /** EventSub message ID that deduplicates redelivery, or `Option.none()` for an undeduplicated change. */
  operationId: Schema.OptionFromNullOr(EventSubMessageId),
});

/** Atomic counter increment, bounded to 1–100 per invocation. */
export const IncrementChatCommandCounter = Schema.Struct({
  name: ChatCommandName,
  increment: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  /** EventSub message ID that keyed the mutation, or `Option.none()` when the caller supplied none. */
  operationId: Schema.OptionFromNullOr(EventSubMessageId),
});

/** Command definition with its shared stored value resolved. */
export const ChatCommandWithValue = Schema.Struct({
  command: ChatCommandDefinition,
  /** Shared stored value, or `Option.none()` for computed commands and unset values. */
  value: Schema.OptionFromNullOr(ChatCommandValue),
});

/** Parsed command and stored value. */
export type ChatCommandWithValue = typeof ChatCommandWithValue.Type;

/** Registry diagnostic snapshot preserves revision and aggregate counts. */
export const ChatCommandDebugSnapshot = Schema.Struct({
  commands: Schema.Array(
    Schema.Struct({
      command: ChatCommandDefinition,
      value: Schema.OptionFromNullOr(ChatCommandValue),
      counter: Schema.OptionFromNullOr(NonNegativeInt),
    }),
  ),
  totals: Schema.Struct({
    total: NonNegativeInt,
    enabled: NonNegativeInt,
    static: NonNegativeInt,
    dynamic: NonNegativeInt,
    computed: NonNegativeInt,
  }),
  /** Count of committed registry changes, including imported history. */
  revision: NonNegativeInt,
  /** Whether defaults were ever bootstrapped; stays true after every command is deleted. */
  initialized: Schema.Boolean,
});

/** Parsed diagnostic snapshot. */
export type ChatCommandDebugSnapshot = typeof ChatCommandDebugSnapshot.Type;

/** Verified EventSub chat input; message identity also deduplicates command mutations. */
export const ChatCommandInput = Schema.Struct({
  messageId: EventSubMessageId,
  text: Schema.String,
  receivedAt: IsoTimestamp,
  viewer: Schema.Struct({ userId: ViewerId, ...ChatCommandActor.fields }),
});

/** Parsed verified chat input. */
export type ChatCommandInput = typeof ChatCommandInput.Type;

/** Prepared response does not imply delivery; receipt owner checkpoints before sending. */
export const ChatCommandPreparation = Schema.Union([
  Schema.TaggedStruct("ChatCommandIgnored", {
    /** Why nothing is sent: not a command, unknown, disabled, or below the command's read permission. */
    reason: Schema.Literals(["not_command", "unknown_command", "disabled", "permission_denied"]),
    /** Command the text named, or `Option.none()` when the text is not a command. */
    commandName: Schema.OptionFromNullOr(ChatCommandName),
  }),
  Schema.TaggedStruct("ChatCommandPrepared", {
    /** Canonical name of the command that produced the response. */
    commandName: ChatCommandName,
    /** Response to send, or `Option.none()` when the command prepares nothing to send. */
    message: Schema.OptionFromNullOr(Schema.String),
  }),
]);

/** Parsed preparation result for durable delivery. */
export type ChatCommandPreparation = typeof ChatCommandPreparation.Type;

/** Schema for the chat command registry and preparation operations named by typed command errors. */
export const ChatCommandOperation = Schema.Literals([
  "getCommand",
  "getAllCommands",
  "getEnabledCommandsByPermission",
  "getCommandValue",
  "getCommandWithValue",
  "getEnabledCommandsWithValues",
  "createCommand",
  "updateCommand",
  "deleteCommand",
  "updateCommandValue",
  "getCommandCounter",
  "incrementCommandCounter",
  "getDebugSnapshot",
  "initializeRegistry",
  "prepareChatCommand",
]);

/** Chat command operation that failed. */
export type ChatCommandOperation = typeof ChatCommandOperation.Type;

const chatCommandOperationDescriptions: Record<ChatCommandOperation, string> = {
  getCommand: "command lookup",
  getAllCommands: "command listing",
  getEnabledCommandsByPermission: "available command listing",
  getCommandValue: "command value lookup",
  getCommandWithValue: "command lookup",
  getEnabledCommandsWithValues: "enabled command listing",
  createCommand: "command creation",
  updateCommand: "command update",
  deleteCommand: "command deletion",
  updateCommandValue: "command value update",
  getCommandCounter: "command counter lookup",
  incrementCommandCounter: "command counter increment",
  getDebugSnapshot: "command diagnostics",
  initializeRegistry: "command registry startup",
  prepareChatCommand: "chat command preparation",
};

const chatCommandMutations: ReadonlySet<ChatCommandOperation> = new Set([
  "createCommand",
  "updateCommand",
  "deleteCommand",
  "updateCommandValue",
  "incrementCommandCounter",
]);

// A failed registry mutation may have committed before its response was lost, so callers reconcile first.
const unavailableRegistryWayForward = (operation: ChatCommandOperation): string =>
  chatCommandMutations.has(operation)
    ? "The change may already be saved; read the command to confirm before retrying."
    : "Retry the request in a moment.";

/** Registry input was invalid or a mutation operation ID was reused with different input. */
export class CommandInputParseError extends Schema.TaggedError<CommandInputParseError>()(
  "CommandInputParseError",
  {
    /** Registry or preparation operation that failed. */
    operation: ChatCommandOperation,
    /** Classified cause; the message wording depends on it. */
    reason: Schema.Literals(["invalid_command_name", "operation_id_reused"]),
    /** Command the operation concerned, or `Option.none()` when no name was resolved. */
    commandName: Schema.OptionFromNullOr(ChatCommandName),
    /** EventSub message ID that keyed the mutation, or `Option.none()` when the caller supplied none. */
    operationId: Schema.OptionFromNullOr(EventSubMessageId),
  },
) {
  /** Describes the rejected input without echoing untrusted text or parser output. */
  override get message(): string {
    const operation = chatCommandOperationDescriptions[this.operation];

    switch (this.reason) {
      case "invalid_command_name":
        return `Chat command name is invalid for ${operation}. Use 1 to 50 lowercase letters, digits, or hyphens and send the command again.`;
      case "operation_id_reused":
        return `Chat command operation ID was already used with different input for ${operation}. Send the change with a new operation ID.`;
    }
  }
}

/** Required command was not found, or an alias was given where a canonical name is required. */
export class CommandNotFoundError extends Schema.TaggedError<CommandNotFoundError>()(
  "CommandNotFoundError",
  {
    /** Registry or preparation operation that failed. */
    operation: ChatCommandOperation,
    /** Classified cause; the message wording depends on it. */
    reason: Schema.Literals(["unknown_command_name", "canonical_name_required"]),
    /** Command name the caller gave, which may be an alias. */
    commandName: ChatCommandName,
  },
) {
  /** Names the missing command so administrators can correct the request. */
  override get message(): string {
    const operation = chatCommandOperationDescriptions[this.operation];

    switch (this.reason) {
      case "unknown_command_name":
        return `Chat command not found for ${operation}: no command or alias is named ${this.commandName}. Check the command name and try again.`;
      case "canonical_name_required":
        return `Chat command alias not accepted for ${operation}: ${this.commandName} is an alias, and this change needs the canonical command name. Retry with the canonical name.`;
    }
  }
}

/** Command creation collided with an existing canonical name or alias. */
export class CommandAlreadyExistsError extends Schema.TaggedError<CommandAlreadyExistsError>()(
  "CommandAlreadyExistsError",
  {
    /** Registry or preparation operation that failed. */
    operation: ChatCommandOperation,
    /** Classified cause; the message wording depends on it. */
    reason: Schema.Literals(["command_name_taken", "alias_name_taken"]),
    /** Name requested for the new command. */
    commandName: ChatCommandName,
    /** Canonical command that already owns the requested name. */
    existingCommandName: ChatCommandName,
  },
) {
  /** Names the existing owner of the requested name. */
  override get message(): string {
    const operation = chatCommandOperationDescriptions[this.operation];

    switch (this.reason) {
      case "command_name_taken":
        return `Chat command already exists for ${operation}: ${this.commandName} is already a command name. Choose a different name and try again.`;
      case "alias_name_taken":
        return `Chat command name already used as an alias for ${operation}: ${this.commandName} is an alias of ${this.existingCommandName}. Choose a different name and try again.`;
    }
  }
}

/** Alias is already owned, repeated, or collides with a canonical command name. */
export class CommandAliasConflictError extends Schema.TaggedError<CommandAliasConflictError>()(
  "CommandAliasConflictError",
  {
    /** Registry or preparation operation that failed. */
    operation: ChatCommandOperation,
    /** Classified cause; the message wording depends on it. */
    reason: Schema.Literals([
      "alias_owned_by_another_command",
      "alias_repeated",
      "alias_matches_command_name",
    ]),
    /** Command whose definition claims the alias. */
    commandName: ChatCommandName,
    /** Alias that conflicts. */
    alias: ChatCommandName,
    /** Command that already owns the alias; equals the alias when it collides with a canonical name. */
    ownerCommandName: ChatCommandName,
  },
) {
  /** Identifies the conflicting alias owner without exposing stored values. */
  override get message(): string {
    const operation = chatCommandOperationDescriptions[this.operation];

    switch (this.reason) {
      case "alias_owned_by_another_command":
        return `Chat command alias already in use for ${operation}: ${this.alias} already belongs to ${this.ownerCommandName}, so ${this.commandName} cannot use it. Choose a different alias and try again.`;
      case "alias_repeated":
        return `Chat command alias is repeated for ${operation}: ${this.commandName} lists ${this.alias} more than once. Remove the duplicate alias and try again.`;
      case "alias_matches_command_name":
        return `Chat command alias matches a command name for ${operation}: ${this.alias} is already a command name, so ${this.commandName} cannot use it. Choose a different alias and try again.`;
    }
  }
}

/** Definition change or reference would leave the command registry invalid. */
export class CommandInvalidDefinitionError extends Schema.TaggedError<CommandInvalidDefinitionError>()(
  "CommandInvalidDefinitionError",
  {
    /** Registry or preparation operation that failed. */
    operation: ChatCommandOperation,
    /** Classified cause; the message wording depends on it. */
    reason: Schema.Literals(["missing_source_command", "incomplete_response_transition"]),
    /** Command name the caller gave, which may be an alias. */
    commandName: ChatCommandName,
    /** Missing source command, or `Option.none()` when the failure is not about a source. */
    sourceCommandName: Schema.OptionFromNullOr(ChatCommandName),
  },
) {
  /** Describes the rejected definition invariant, not the stored command value. */
  override get message(): string {
    const operation = chatCommandOperationDescriptions[this.operation];

    switch (this.reason) {
      case "missing_source_command":
        return `Chat command definition is invalid for ${operation}: ${this.commandName} reads its value or counter from ${Option.getOrElse(this.sourceCommandName, () => "a command")} that does not exist. Create the source command first or choose an existing one.`;
      case "incomplete_response_transition":
        return `Chat command definition is invalid for ${operation}: changing ${this.commandName} to another response type needs every field that type requires. Send the complete set of response fields and try again.`;
    }
  }
}

/** Only dynamic commands accept chat value updates. */
export class CommandNotUpdateableError extends Schema.TaggedError<CommandNotUpdateableError>()(
  "CommandNotUpdateableError",
  {
    /** Registry or preparation operation that failed. */
    operation: ChatCommandOperation,
    /** Classified cause; the message wording depends on it. */
    reason: Schema.Literals(["static_response", "computed_response"]),
    /** Command name the caller gave, which may be an alias. */
    commandName: ChatCommandName,
  },
) {
  /** Explains why the command's response type rejects value updates. */
  override get message(): string {
    const operation = chatCommandOperationDescriptions[this.operation];

    switch (this.reason) {
      case "static_response":
        return `Chat command value cannot be updated for ${operation}: ${this.commandName} has a fixed response. Choose a command whose value can be updated.`;
      case "computed_response":
        return `Chat command value cannot be updated for ${operation}: ${this.commandName} computes its response. Choose a command whose value can be updated.`;
    }
  }
}

/** Current durable write permission denied a value mutation. */
export class CommandUpdatePermissionDeniedError extends Schema.TaggedError<CommandUpdatePermissionDeniedError>()(
  "CommandUpdatePermissionDeniedError",
  {
    /** Registry or preparation operation that failed. */
    operation: ChatCommandOperation,
    /** Classified cause; the message wording depends on it. */
    reason: Schema.Literals(["write_permission_required"]),
    /** Command name the caller gave, which may be an alias. */
    commandName: ChatCommandName,
    /** Write tier the command currently requires. */
    requiredPermission: ChatCommandPermission,
    /** Tier of the viewer who attempted the update. */
    actorPermission: ChatCommandPermission,
  },
) {
  /** Reports the current durable write tier, not stale caller metadata. */
  override get message(): string {
    return `Chat command update permission denied for ${chatCommandOperationDescriptions[this.operation]}: ${this.commandName} requires ${this.requiredPermission} permission and the viewer has ${this.actorPermission}. Ask a viewer with ${this.requiredPermission} permission to update it.`;
  }
}

/** Durable command storage or its internal transport is unavailable; no internal data is exposed. */
export class CommandsDbError extends Schema.TaggedError<CommandsDbError>()("CommandsDbError", {
  /** Registry or preparation operation that failed. */
  operation: ChatCommandOperation,
  /** Classified cause; the message wording depends on it. */
  reason: Schema.Literals(["storage_unavailable", "transport_unavailable"]),
  /** Command the operation concerned, or `Option.none()` when no name was resolved. */
  commandName: Schema.OptionFromNullOr(ChatCommandName),
}) {
  /** Names the unavailable dependency and whether a mutation may already be saved. */
  override get message(): string {
    const operation = chatCommandOperationDescriptions[this.operation];

    switch (this.reason) {
      case "storage_unavailable":
        return `Chat command registry storage is unavailable for ${operation}. ${unavailableRegistryWayForward(this.operation)}`;
      case "transport_unavailable":
        return `Chat command registry could not be reached for ${operation}. ${unavailableRegistryWayForward(this.operation)}`;
    }
  }
}

/** Durable command response violated the internal HTTP protocol. */
export class CommandsInvalidResponseError extends Schema.TaggedError<CommandsInvalidResponseError>()(
  "CommandsInvalidResponseError",
  {
    /** Registry or preparation operation that failed. */
    operation: ChatCommandOperation,
    /** Classified cause; the message wording depends on it. */
    reason: Schema.Literals(["response_schema_mismatch"]),
    /** Command the operation concerned, or `Option.none()` when no name was resolved. */
    commandName: Schema.OptionFromNullOr(ChatCommandName),
  },
) {
  /** Reports a contract mismatch between the Worker and the commands Durable Object. */
  override get message(): string {
    return `Chat command registry response is invalid for ${chatCommandOperationDescriptions[this.operation]}: it does not match the registry contract. Check that the API and the command registry run the same release; ${unavailableRegistryWayForward(this.operation)}`;
  }
}

/** Durable command data failed rehydration; corrupt state is never reset to defaults. */
export class CommandsStateParseError extends Schema.TaggedError<CommandsStateParseError>()(
  "CommandsStateParseError",
  {
    /** Registry or preparation operation that failed. */
    operation: ChatCommandOperation,
    /** Classified cause; the message wording depends on it. */
    reason: Schema.Literals([
      "snapshot_missing",
      "stored_snapshot_invalid",
      "stored_references_invalid",
      "legacy_snapshot_invalid",
      "snapshot_encoding_failed",
    ]),
  },
) {
  /** Explains that traffic is blocked until operators repair the stored registry. */
  override get message(): string {
    const operation = chatCommandOperationDescriptions[this.operation];

    switch (this.reason) {
      case "snapshot_missing":
        return `Chat command registry snapshot is missing for ${operation}. Restore the stored command registry before retrying.`;
      case "stored_snapshot_invalid":
        return `Chat command registry snapshot is unreadable for ${operation}. Inspect and repair the stored command registry before retrying.`;
      case "stored_references_invalid":
        return `Chat command registry snapshot has invalid command references for ${operation}. Inspect and repair the stored aliases and value sources before retrying.`;
      case "legacy_snapshot_invalid":
        return `Chat command registry import found invalid historical data for ${operation}. Inspect and repair the historical command registry before retrying the import.`;
      case "snapshot_encoding_failed":
        return `Chat command registry snapshot could not be encoded for ${operation}, so no change was saved. Inspect the logs for the rejected change before retrying.`;
    }
  }
}

/** Rendered chat response exceeds Twitch's Unicode code point limit. */
export class ChatCommandRenderError extends Schema.TaggedError<ChatCommandRenderError>()(
  "ChatCommandRenderError",
  {
    /** Preparation operation that failed. */
    operation: Schema.Literals(["prepareChatCommand"]),
    /** Classified cause; the message wording depends on it. */
    reason: Schema.Literals(["response_too_long"]),
    /** Canonical name of the command being prepared. */
    commandName: ChatCommandName,
    /** Unicode code points in the rendered response. */
    renderedCodePoints: NonNegativeInt,
    /** Unicode code points Twitch chat allows in one message. */
    maximumCodePoints: NonNegativeInt,
  },
) {
  /** Identifies the command and size without including the rendered output. */
  override get message(): string {
    return `Chat command response is too long: ${this.commandName} rendered ${this.renderedCodePoints} Unicode code points, above the ${this.maximumCodePoints} allowed in Twitch chat. Shorten the command value or output template and try again.`;
  }
}

/** Required computed-command provider lookup failed. */
export class ChatCommandExecutionError extends Schema.TaggedError<ChatCommandExecutionError>()(
  "ChatCommandExecutionError",
  {
    /** Preparation operation that failed. */
    operation: Schema.Literals(["prepareChatCommand"]),
    /** Classified cause; the message wording depends on it. */
    reason: Schema.Literals(["song_queue_unavailable", "raffle_unavailable"]),
    /** Canonical name of the command being prepared. */
    commandName: ChatCommandName,
  },
) {
  /** Names the unavailable provider without provider detail; the lookups are read-only. */
  override get message(): string {
    switch (this.reason) {
      case "song_queue_unavailable":
        return `Chat command response unavailable: ${this.commandName} could not read song request counts from the song queue. Run the command again in a moment.`;
      case "raffle_unavailable":
        return `Chat command response unavailable: ${this.commandName} could not read keyboard raffle results. Run the command again in a moment.`;
    }
  }
}

/** Portable registry failure union used by the internal HTTP API. */
export const CommandsError = Schema.Union([
  CommandInputParseError,
  CommandNotFoundError,
  CommandAlreadyExistsError,
  CommandAliasConflictError,
  CommandInvalidDefinitionError,
  CommandNotUpdateableError,
  CommandUpdatePermissionDeniedError,
  CommandsDbError,
  CommandsInvalidResponseError,
  CommandsStateParseError,
]);

/** Expected registry operation failures. */
export type CommandsError = typeof CommandsError.Type;

/** Expected command preparation failures, before any Twitch send. */
export type ChatCommandError = CommandsError | ChatCommandRenderError | ChatCommandExecutionError;

const decodeChatCommandName = Schema.decodeEffect(ChatCommandName);

/** Parse options that keep command create and patch inputs closed to unmodeled fields; HTTP endpoint annotations need them. */
export const chatCommandInputParseOptions = { onExcessProperty: "error" } as const;

const decodeCreateChatCommandInput = Schema.decodeEffect(
  CreateChatCommandInput,
  chatCommandInputParseOptions,
);

/**
 * Parses a string as a canonical chat command name.
 *
 * @returns The command name, or fails with `SchemaError` when the string is empty, longer than 50 characters, or contains characters other than lowercase letters, digits, and hyphens.
 */
export const parseChatCommandName = (
  input: string,
): Effect.Effect<ChatCommandName, Schema.SchemaError> => decodeChatCommandName(input);

/**
 * Parses a typed create-command representation while enforcing all command invariants.
 *
 * @returns The create input, or fails with `SchemaError` when a field violates its bound or the input has unmodeled fields.
 */
export const parseCreateChatCommandInput = (
  input: typeof CreateChatCommandInput.Encoded,
): Effect.Effect<CreateChatCommandInput, Schema.SchemaError> => decodeCreateChatCommandInput(input);
