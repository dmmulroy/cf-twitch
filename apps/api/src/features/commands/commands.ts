import { Context, type Effect } from "effect";
import type {
  ChatCommandDebugSnapshot,
  ChatCommandDefinition,
  ChatCommandPermission,
  ChatCommandSelector,
  ChatCommandWithValue,
  CommandsError,
  CreateChatCommandInput,
  IncrementChatCommandCounter,
  UpdateChatCommandRequest,
  UpdateChatCommandValue,
} from "@cf-twitch/contracts/chat-command";
import type { Option } from "effect";

/** Durable chat registry owns atomic reference, permission, and mutation receipt handling. */
export interface ICommands {
  readonly getCommand: (
    input: typeof ChatCommandSelector.Type,
  ) => Effect.Effect<ChatCommandDefinition, CommandsError>;
  readonly getAllCommands: () => Effect.Effect<readonly ChatCommandDefinition[], CommandsError>;
  readonly getEnabledCommandsByPermission: (input: {
    readonly permission: ChatCommandPermission;
  }) => Effect.Effect<readonly ChatCommandDefinition[], CommandsError>;
  readonly getCommandValue: (
    input: typeof ChatCommandSelector.Type,
  ) => Effect.Effect<Option.Option<string>, CommandsError>;
  readonly getCommandWithValue: (
    input: typeof ChatCommandSelector.Type,
  ) => Effect.Effect<ChatCommandWithValue, CommandsError>;
  readonly getEnabledCommandsWithValues: () => Effect.Effect<
    readonly ChatCommandWithValue[],
    CommandsError
  >;
  readonly createCommand: (
    input: CreateChatCommandInput,
  ) => Effect.Effect<ChatCommandDefinition, CommandsError>;
  readonly updateCommand: (
    input: typeof UpdateChatCommandRequest.Type,
  ) => Effect.Effect<ChatCommandDefinition, CommandsError>;
  readonly deleteCommand: (
    input: typeof ChatCommandSelector.Type,
  ) => Effect.Effect<void, CommandsError>;
  readonly updateCommandValue: (
    input: typeof UpdateChatCommandValue.Type,
  ) => Effect.Effect<void, CommandsError>;
  readonly getCommandCounter: (
    input: typeof ChatCommandSelector.Type,
  ) => Effect.Effect<number, CommandsError>;
  readonly incrementCommandCounter: (
    input: typeof IncrementChatCommandCounter.Type,
  ) => Effect.Effect<number, CommandsError>;
  readonly getDebugSnapshot: () => Effect.Effect<ChatCommandDebugSnapshot, CommandsError>;
}

/** Shared service tag implemented by SQLite in the DO and HTTP in Worker callers. */
export class Commands extends Context.Service<Commands, ICommands>()("@cf-twitch/Commands") {}
