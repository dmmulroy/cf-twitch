import { Effect, Schema } from "effect";
import { EventSubMessageId, IsoTimestamp, NonNegativeInt, ViewerId } from "./identity.ts";

/** Canonical chat command name; aliases obey the same lowercase syntax. */
export const ChatCommandName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(50),
  Schema.isPattern(/^[a-z0-9-]+$/),
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
  valueSourceName: ChatCommandName,
  counterSourceName: Schema.Null,
  handlerKey: Schema.Null,
  outputTemplate: CommandTemplate,
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
    writePermission: ChatCommandPermission,
  }),
  Schema.Struct({
    ...definitionBase,
    responseType: Schema.Literal("computed"),
    valueSourceName: Schema.Null,
    counterSourceName: Schema.OptionFromNullOr(ChatCommandName),
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
  enabled: Schema.optionalKey(Schema.Boolean),
  aliases: Schema.optionalKey(CommandAliases),
  createdAt: Schema.optionalKey(IsoTimestamp),
};

const createStored = {
  valueSourceName: Schema.optionalKey(ChatCommandName),
  outputTemplate: Schema.optionalKey(CommandTemplate),
  emptyResponse: Schema.optionalKey(CommandTemplate),
  initialValue: Schema.optionalKey(ChatCommandValue),
};

/** Strict create input; absent fields are defaulted once by command construction. */
export const CreateChatCommandInput = Schema.Union([
  Schema.Struct({ ...createBase, responseType: Schema.Literal("static"), ...createStored }),
  Schema.Struct({
    ...createBase,
    responseType: Schema.Literal("dynamic"),
    ...createStored,
    writePermission: Schema.optionalKey(ChatCommandPermission),
  }),
  Schema.Struct({
    ...createBase,
    responseType: Schema.Literal("computed"),
    handlerKey: CommandHandlerKey,
    counterSourceName: Schema.optionalKey(ChatCommandName),
    initialCounter: Schema.optionalKey(NonNegativeInt),
  }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });

/** Parsed command create input. */
export type CreateChatCommandInput = typeof CreateChatCommandInput.Type;

/** Nonempty definition patch; response transitions must supply all contradictory field changes. */
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
})
  .check(
    Schema.makeFilter(
      (patch) => Object.keys(patch).length > 0 || "Command patch must not be empty",
    ),
  )
  .annotate({ parseOptions: { onExcessProperty: "error" } });

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
  actor: ChatCommandActor,
  operationId: Schema.OptionFromNullOr(EventSubMessageId),
});

/** Atomic counter increment, bounded to 1–100 per invocation. */
export const IncrementChatCommandCounter = Schema.Struct({
  name: ChatCommandName,
  increment: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  operationId: Schema.OptionFromNullOr(EventSubMessageId),
});

/** Command definition with its shared stored value resolved. */
export const ChatCommandWithValue = Schema.Struct({
  command: ChatCommandDefinition,
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
  revision: NonNegativeInt,
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
    reason: Schema.Literals(["not_command", "unknown_command", "disabled", "permission_denied"]),
    commandName: Schema.OptionFromNullOr(ChatCommandName),
  }),
  Schema.TaggedStruct("ChatCommandPrepared", {
    commandName: ChatCommandName,
    message: Schema.OptionFromNullOr(Schema.String),
  }),
]);

/** Parsed preparation result for durable delivery. */
export type ChatCommandPreparation = typeof ChatCommandPreparation.Type;

/** Registry input was invalid or operation identity was reused with different input. */
export class CommandInputParseError extends Schema.TaggedError<CommandInputParseError>()(
  "CommandInputParseError",
  { operation: Schema.String },
) {
  /** Stable command-input failure excludes untrusted input and parser rendering. */
  override get message(): string {
    return `Command input rejected during ${this.operation}`;
  }
}

/** Required command was not found; administrative mutations require canonical names. */
export class CommandNotFoundError extends Schema.TaggedError<CommandNotFoundError>()(
  "CommandNotFoundError",
  { commandName: Schema.String },
) {
  /** Preserve the public administrator error message after HTTP decoding. */
  override get message(): string {
    return `Command not found: ${this.commandName}`;
  }
}

/** Command creation collided with a canonical name or alias. */
export class CommandAlreadyExistsError extends Schema.TaggedError<CommandAlreadyExistsError>()(
  "CommandAlreadyExistsError",
  { commandName: Schema.String },
) {
  /** Canonical name and alias conflicts share the historical creation error. */
  override get message(): string {
    return `Command already exists: ${this.commandName}`;
  }
}

/** Alias is already owned, repeated, or collides with a canonical name. */
export class CommandAliasConflictError extends Schema.TaggedError<CommandAliasConflictError>()(
  "CommandAliasConflictError",
  { alias: Schema.String, owner: Schema.String },
) {
  /** Identify the conflicting alias owner without exposing stored values. */
  override get message(): string {
    return `Command alias conflict for ${this.alias}: owned by ${this.owner}`;
  }
}

/** Definition transition or reference would leave invalid durable state. */
export class CommandInvalidDefinitionError extends Schema.TaggedError<CommandInvalidDefinitionError>()(
  "CommandInvalidDefinitionError",
  { commandName: Schema.String, reason: Schema.String },
) {
  /** Definition errors describe the rejected invariant, not the stored command value. */
  override get message(): string {
    return `Command definition invalid for ${this.commandName}: ${this.reason}`;
  }
}

/** Only dynamic commands accept chat value updates. */
export class CommandNotUpdateableError extends Schema.TaggedError<CommandNotUpdateableError>()(
  "CommandNotUpdateableError",
  { commandName: Schema.String, responseType: Schema.String },
) {
  /** Only dynamic response types are updateable from chat. */
  override get message(): string {
    return `Command !${this.commandName} is not updateable (type: ${this.responseType})`;
  }
}

/** Current durable write permission denied a value mutation. */
export class CommandUpdatePermissionDeniedError extends Schema.TaggedError<CommandUpdatePermissionDeniedError>()(
  "CommandUpdatePermissionDeniedError",
  { commandName: Schema.String, requiredPermission: ChatCommandPermission },
) {
  /** Report the current durable write tier, not stale caller metadata. */
  override get message(): string {
    return `Command update permission denied for ${this.commandName}: requires ${this.requiredPermission}`;
  }
}

/** Durable command storage or transport is unavailable; no internal data is exposed. */
export class CommandsDbError extends Schema.TaggedError<CommandsDbError>()("CommandsDbError", {
  operation: Schema.String,
}) {
  /** Persistence diagnostics omit SQL and serialized values. */
  override get message(): string {
    return `Commands DB error during ${this.operation}`;
  }
}

/** Durable command response violated the internal HTTP protocol. */
export class CommandsInvalidResponseError extends Schema.TaggedError<CommandsInvalidResponseError>()(
  "CommandsInvalidResponseError",
  { operation: Schema.String },
) {
  /** Generated command client received a response outside its declared contract. */
  override get message(): string {
    return `Commands response invalid during ${this.operation}`;
  }
}

/** Durable command data failed rehydration; never reset corrupt state to defaults. */
export class CommandsStateParseError extends Schema.TaggedError<CommandsStateParseError>()(
  "CommandsStateParseError",
  { operation: Schema.String },
) {
  /** Rehydration failure blocks traffic rather than replacing state with defaults. */
  override get message(): string {
    return `Commands state rehydration failed: ${this.operation}`;
  }
}

/** Rendered chat response exceeds Twitch's Unicode code point limit. */
export class ChatCommandRenderError extends Schema.TaggedError<ChatCommandRenderError>()(
  "ChatCommandRenderError",
  { commandName: Schema.String },
) {
  /** Stable rendering failure identifies the command without rendered output. */
  override get message(): string {
    return `Chat command rendering failed for ${this.commandName}`;
  }
}

/** Required computed-command provider lookup failed. */
export class ChatCommandExecutionError extends Schema.TaggedError<ChatCommandExecutionError>()(
  "ChatCommandExecutionError",
  { commandName: Schema.String },
) {
  /** Stable computed-command failure identifies the command without provider detail. */
  override get message(): string {
    return `Chat command execution failed for ${this.commandName}`;
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

const decodeCreateChatCommandInput = Schema.decodeEffect(CreateChatCommandInput);

/** Parses a string as a canonical chat command name. */
export const parseChatCommandName = (
  input: string,
): Effect.Effect<ChatCommandName, Schema.SchemaError> => decodeChatCommandName(input);

/** Parses a typed create-command representation while enforcing all command invariants. */
export const parseCreateChatCommandInput = (
  input: typeof CreateChatCommandInput.Encoded,
): Effect.Effect<CreateChatCommandInput, Schema.SchemaError> => decodeCreateChatCommandInput(input);
