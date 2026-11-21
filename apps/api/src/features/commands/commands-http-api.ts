import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  ChatCommandDebugSnapshot,
  ChatCommandDefinition,
  ChatCommandPermission,
  ChatCommandSelector,
  ChatCommandValue,
  ChatCommandWithValue,
  chatCommandInputParseOptions,
  CommandsError,
  CreateChatCommandInput,
  IncrementChatCommandCounter,
  UpdateChatCommandRequest,
  UpdateChatCommandValue,
} from "@cf-twitch/contracts/chat-command";
import { NonNegativeInt } from "@cf-twitch/contracts/identity";

/** Endpoint group for the versioned command registry operations; administrator authentication belongs to the Worker edge. */
export class CommandsHttpApiGroup extends HttpApiGroup.make("commands")
  .add(
    HttpApiEndpoint.get("getAllCommands", "/commands", {
      success: Schema.Array(ChatCommandDefinition),
      error: CommandsError,
    }),
  )
  .add(
    HttpApiEndpoint.post("getCommand", "/commands/lookup", {
      payload: ChatCommandSelector,
      success: ChatCommandDefinition,
      error: CommandsError,
    }),
  )
  .add(
    HttpApiEndpoint.post("getEnabledCommandsByPermission", "/commands/available", {
      payload: Schema.Struct({ permission: ChatCommandPermission }),
      success: Schema.Array(ChatCommandDefinition),
      error: CommandsError,
    }),
  )
  .add(
    HttpApiEndpoint.post("getCommandValue", "/commands/value", {
      payload: ChatCommandSelector,
      success: Schema.OptionFromNullOr(ChatCommandValue),
      error: CommandsError,
    }),
  )
  .add(
    HttpApiEndpoint.post("getCommandWithValue", "/commands/with-value", {
      payload: ChatCommandSelector,
      success: ChatCommandWithValue,
      error: CommandsError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getEnabledCommandsWithValues", "/commands/enabled", {
      success: Schema.Array(ChatCommandWithValue),
      error: CommandsError,
    }),
  )
  .add(
    HttpApiEndpoint.post("createCommand", "/commands", {
      payload: CreateChatCommandInput,
      success: ChatCommandDefinition,
      error: CommandsError,
    }).annotate(HttpApi.PayloadParseOptions, chatCommandInputParseOptions),
  )
  .add(
    HttpApiEndpoint.patch("updateCommand", "/commands", {
      payload: UpdateChatCommandRequest,
      success: ChatCommandDefinition,
      error: CommandsError,
    }).annotate(HttpApi.PayloadParseOptions, chatCommandInputParseOptions),
  )
  .add(
    HttpApiEndpoint.post("deleteCommand", "/commands/delete", {
      payload: ChatCommandSelector,
      success: Schema.Void,
      error: CommandsError,
    }),
  )
  .add(
    HttpApiEndpoint.post("updateCommandValue", "/commands/value/update", {
      payload: UpdateChatCommandValue,
      success: Schema.Void,
      error: CommandsError,
    }),
  )
  .add(
    HttpApiEndpoint.post("getCommandCounter", "/commands/counter", {
      payload: ChatCommandSelector,
      success: NonNegativeInt,
      error: CommandsError,
    }),
  )
  .add(
    HttpApiEndpoint.post("incrementCommandCounter", "/commands/counter/increment", {
      payload: IncrementChatCommandCounter,
      success: NonNegativeInt,
      error: CommandsError,
    }),
  )
  .add(
    HttpApiEndpoint.get("getDebugSnapshot", "/commands/debug", {
      success: ChatCommandDebugSnapshot,
      error: CommandsError,
    }),
  ) {}

/** Internal HTTP contract shared by the `CommandsDO` singleton server and its generated client. */
export class CommandsHttpApi extends HttpApi.make("CommandsHttpApi")
  .add(CommandsHttpApiGroup)
  .prefix("/v1") {}
