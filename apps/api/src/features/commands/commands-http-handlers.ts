import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { Commands } from "./commands.ts";
import { CommandsHttpApi } from "./commands-http-api.ts";

/** HTTP handlers delegate to the same atomic command service used by SQL integration tests. */
export const commandsHttpHandlersLayerWithoutDependencies = HttpApiBuilder.group(
  CommandsHttpApi,
  "commands",
  (handlers) =>
    Effect.gen(function* () {
      const commands = yield* Commands;

      return handlers
        .handle("getAllCommands", () => commands.getAllCommands())
        .handle("getCommand", ({ payload }) => commands.getCommand(payload))
        .handle("getEnabledCommandsByPermission", ({ payload }) =>
          commands.getEnabledCommandsByPermission(payload),
        )
        .handle("getCommandValue", ({ payload }) => commands.getCommandValue(payload))
        .handle("getCommandWithValue", ({ payload }) => commands.getCommandWithValue(payload))
        .handle("getEnabledCommandsWithValues", () => commands.getEnabledCommandsWithValues())
        .handle("createCommand", ({ payload }) => commands.createCommand(payload))
        .handle("updateCommand", ({ payload }) => commands.updateCommand(payload))
        .handle("deleteCommand", ({ payload }) => commands.deleteCommand(payload))
        .handle("updateCommandValue", ({ payload }) => commands.updateCommandValue(payload))
        .handle("getCommandCounter", ({ payload }) => commands.getCommandCounter(payload))
        .handle("incrementCommandCounter", ({ payload }) =>
          commands.incrementCommandCounter(payload),
        )
        .handle("getDebugSnapshot", () => commands.getDebugSnapshot());
    }),
);
