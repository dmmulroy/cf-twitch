import * as Cloudflare from "alchemy/Cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Effect, Layer, Schema } from "effect";
import type { HttpClientError } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import {
  CommandsDbError,
  CommandsInvalidResponseError,
  type CommandsError,
} from "@cf-twitch/contracts/chat-command";
import { Commands } from "./commands.ts";
import { CommandsHttpApi } from "./commands-http-api.ts";
import commandsServerLayer, { CommandsServer } from "./commands-server.ts";

const translateCommandsClientErrors = <A, R>(
  request: Effect.Effect<
    A,
    CommandsError | HttpClientError.HttpClientError | Schema.SchemaError,
    R
  >,
  operation: string,
): Effect.Effect<A, CommandsError, R> =>
  request.pipe(
    Effect.catchTags({
      HttpClientError: () => Effect.fail(new CommandsDbError({ operation })),
      SchemaError: () => Effect.fail(new CommandsInvalidResponseError({ operation })),
    }),
  );

/** Build invocation-scoped HTTP clients for the retained commands singleton, never caching DO stubs. */
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
      return yield* translateCommandsClientErrors(
        (yield* httpClient).commands.getCommand({ payload: input }),
        "getCommand",
      );
    }),
    getAllCommands: Effect.fn("CommandsClient.getAllCommands")(function* () {
      return yield* translateCommandsClientErrors(
        (yield* httpClient).commands.getAllCommands(),
        "getAllCommands",
      );
    }),
    getEnabledCommandsByPermission: Effect.fn("CommandsClient.getEnabledCommandsByPermission")(
      function* (input) {
        return yield* translateCommandsClientErrors(
          (yield* httpClient).commands.getEnabledCommandsByPermission({ payload: input }),
          "getEnabledCommandsByPermission",
        );
      },
    ),
    getCommandValue: Effect.fn("CommandsClient.getCommandValue")(function* (input) {
      return yield* translateCommandsClientErrors(
        (yield* httpClient).commands.getCommandValue({ payload: input }),
        "getCommandValue",
      );
    }),
    getCommandWithValue: Effect.fn("CommandsClient.getCommandWithValue")(function* (input) {
      return yield* translateCommandsClientErrors(
        (yield* httpClient).commands.getCommandWithValue({ payload: input }),
        "getCommandWithValue",
      );
    }),
    getEnabledCommandsWithValues: Effect.fn("CommandsClient.getEnabledCommandsWithValues")(
      function* () {
        return yield* translateCommandsClientErrors(
          (yield* httpClient).commands.getEnabledCommandsWithValues(),
          "getEnabledCommandsWithValues",
        );
      },
    ),
    createCommand: Effect.fn("CommandsClient.createCommand")(function* (input) {
      const client = (yield* httpClient).commands;

      // The generated client exposes one overload per union member, so discriminate before calling.
      const request =
        input.responseType === "static"
          ? client.createCommand({ payload: input })
          : input.responseType === "dynamic"
            ? client.createCommand({ payload: input })
            : client.createCommand({ payload: input });

      return yield* translateCommandsClientErrors(request, "createCommand");
    }),
    updateCommand: Effect.fn("CommandsClient.updateCommand")(function* (input) {
      return yield* translateCommandsClientErrors(
        (yield* httpClient).commands.updateCommand({ payload: input }),
        "updateCommand",
      );
    }),
    deleteCommand: Effect.fn("CommandsClient.deleteCommand")(function* (input) {
      return yield* translateCommandsClientErrors(
        (yield* httpClient).commands.deleteCommand({ payload: input }),
        "deleteCommand",
      );
    }),
    updateCommandValue: Effect.fn("CommandsClient.updateCommandValue")(function* (input) {
      return yield* translateCommandsClientErrors(
        (yield* httpClient).commands.updateCommandValue({ payload: input }),
        "updateCommandValue",
      );
    }),
    getCommandCounter: Effect.fn("CommandsClient.getCommandCounter")(function* (input) {
      return yield* translateCommandsClientErrors(
        (yield* httpClient).commands.getCommandCounter({ payload: input }),
        "getCommandCounter",
      );
    }),
    incrementCommandCounter: Effect.fn("CommandsClient.incrementCommandCounter")(function* (input) {
      return yield* translateCommandsClientErrors(
        (yield* httpClient).commands.incrementCommandCounter({ payload: input }),
        "incrementCommandCounter",
      );
    }),
    getDebugSnapshot: Effect.fn("CommandsClient.getDebugSnapshot")(function* () {
      return yield* translateCommandsClientErrors(
        (yield* httpClient).commands.getDebugSnapshot(),
        "getDebugSnapshot",
      );
    }),
  });
});

/** Commands HTTP client with explicit namespace and Alchemy execution requirements. */
export const commandsClientLayerWithoutDependencies = Layer.effect(Commands, makeCommandsClient);

/** Ready commands client registers the matching physical Durable Object during planning. */
export const commandsClientLayer = commandsClientLayerWithoutDependencies.pipe(
  Layer.provide(commandsServerLayer),
);
