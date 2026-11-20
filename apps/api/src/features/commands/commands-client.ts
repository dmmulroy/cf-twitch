import * as Cloudflare from "@alchemy.run/cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Effect, Layer, Match, Option, type Schema } from "effect";
import type { HttpClientError } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import {
  CommandsDbError,
  CommandsInvalidResponseError,
  type ChatCommandOperation,
  type CommandsError,
} from "@cf-twitch/contracts/chat-command";
import { Commands } from "./commands.ts";
import { CommandsHttpApi } from "./commands-http-api.ts";
import commandsServerLayer, { CommandsServer } from "./commands-server.ts";

// Registry errors decoded from the Durable Object pass through; transport and contract failures are classified here.
const translateCommandsClientErrors =
  (operation: ChatCommandOperation) =>
  <A, R>(
    request: Effect.Effect<
      A,
      CommandsError | HttpClientError.HttpClientError | Schema.SchemaError,
      R
    >,
  ): Effect.Effect<A, CommandsError, R> =>
    request.pipe(
      Effect.catchTags({
        HttpClientError: () =>
          Effect.fail(
            new CommandsDbError({
              operation,
              reason: "transport_unavailable",
              commandName: Option.none(),
            }),
          ),
        SchemaError: () =>
          Effect.fail(
            new CommandsInvalidResponseError({
              operation,
              reason: "response_schema_mismatch",
              commandName: Option.none(),
            }),
          ),
      }),
    );

/**
 * Creates the registry client for the `commands` Durable Object singleton.
 *
 * **Details**
 *
 * Each invocation builds its own HTTP client inside its scope; Durable Object stubs are never cached
 * across invocations.
 *
 * @returns The registry service. Its operations fail with the registry errors decoded from the
 * Durable Object, `CommandsDbError` when it cannot be reached, and `CommandsInvalidResponseError`
 * when its response breaks the contract.
 */
export const makeCommandsClient = Effect.gen(function* () {
  const namespace = yield* CommandsServer;

  const httpClient = yield* makeExecutionMemo(
    Effect.suspend(() =>
      HttpApiClient.makeWith(CommandsHttpApi, {
        baseUrl: "http://commands.internal",
        httpClient: Cloudflare.toHttpClient(namespace.getByName("commands")),
      }),
    ),
  );

  return Commands.of({
    getCommand: Effect.fn("CommandsClient.getCommand")(function* (input) {
      return yield* (yield* httpClient).commands.getCommand({ payload: input });
    }, translateCommandsClientErrors("getCommand")),
    getAllCommands: Effect.fn("CommandsClient.getAllCommands")(function* () {
      return yield* (yield* httpClient).commands.getAllCommands();
    }, translateCommandsClientErrors("getAllCommands")),
    getEnabledCommandsByPermission: Effect.fn("CommandsClient.getEnabledCommandsByPermission")(
      function* (input) {
        return yield* (yield* httpClient).commands.getEnabledCommandsByPermission({
          payload: input,
        });
      },
      translateCommandsClientErrors("getEnabledCommandsByPermission"),
    ),
    getCommandValue: Effect.fn("CommandsClient.getCommandValue")(function* (input) {
      return yield* (yield* httpClient).commands.getCommandValue({ payload: input });
    }, translateCommandsClientErrors("getCommandValue")),
    getCommandWithValue: Effect.fn("CommandsClient.getCommandWithValue")(function* (input) {
      return yield* (yield* httpClient).commands.getCommandWithValue({ payload: input });
    }, translateCommandsClientErrors("getCommandWithValue")),
    getEnabledCommandsWithValues: Effect.fn("CommandsClient.getEnabledCommandsWithValues")(
      function* () {
        return yield* (yield* httpClient).commands.getEnabledCommandsWithValues();
      },
      translateCommandsClientErrors("getEnabledCommandsWithValues"),
    ),
    createCommand: Effect.fn("CommandsClient.createCommand")(function* (input) {
      const client = (yield* httpClient).commands;

      // The generated client exposes one overload per union member, so discriminate before calling.
      return yield* Match.value(input).pipe(
        Match.when({ responseType: "static" }, (payload) => client.createCommand({ payload })),
        Match.when({ responseType: "dynamic" }, (payload) => client.createCommand({ payload })),
        Match.when({ responseType: "computed" }, (payload) => client.createCommand({ payload })),
        Match.exhaustive,
      );
    }, translateCommandsClientErrors("createCommand")),
    updateCommand: Effect.fn("CommandsClient.updateCommand")(function* (input) {
      return yield* (yield* httpClient).commands.updateCommand({ payload: input });
    }, translateCommandsClientErrors("updateCommand")),
    deleteCommand: Effect.fn("CommandsClient.deleteCommand")(function* (input) {
      return yield* (yield* httpClient).commands.deleteCommand({ payload: input });
    }, translateCommandsClientErrors("deleteCommand")),
    updateCommandValue: Effect.fn("CommandsClient.updateCommandValue")(function* (input) {
      return yield* (yield* httpClient).commands.updateCommandValue({ payload: input });
    }, translateCommandsClientErrors("updateCommandValue")),
    getCommandCounter: Effect.fn("CommandsClient.getCommandCounter")(function* (input) {
      return yield* (yield* httpClient).commands.getCommandCounter({ payload: input });
    }, translateCommandsClientErrors("getCommandCounter")),
    incrementCommandCounter: Effect.fn("CommandsClient.incrementCommandCounter")(function* (input) {
      return yield* (yield* httpClient).commands.incrementCommandCounter({ payload: input });
    }, translateCommandsClientErrors("incrementCommandCounter")),
    getDebugSnapshot: Effect.fn("CommandsClient.getDebugSnapshot")(function* () {
      return yield* (yield* httpClient).commands.getDebugSnapshot();
    }, translateCommandsClientErrors("getDebugSnapshot")),
  });
});

/** Layer that provides the registry HTTP client and keeps its `CommandsServer` namespace and Alchemy execution requirements visible. */
export const commandsClientLayerWithoutDependencies = Layer.effect(Commands, makeCommandsClient);

/** Production registry client Layer; registers the matching `CommandsDO` namespace during planning. */
export const commandsClientLayer = commandsClientLayerWithoutDependencies.pipe(
  Layer.provide(commandsServerLayer),
);
