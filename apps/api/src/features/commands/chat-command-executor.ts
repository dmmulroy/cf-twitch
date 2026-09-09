import { Clock, Context, Effect, Layer, Option, Random, Result } from "effect";
import { TwitchAnalytics } from "../../runtime/twitch-analytics.ts";
import {
  ChatCommandInput,
  ChatCommandRenderError,
  CommandInputParseError,
  parseChatCommandName,
  type ChatCommandError,
  type ChatCommandPreparation,
} from "@cf-twitch/contracts/chat-command";
import { Commands } from "./commands.ts";
import {
  ComputedChatCommands,
  computedChatCommandsLayerWithoutDependencies,
} from "./computed-chat-commands.ts";
import { commandsClientLayer } from "./commands-client.ts";
import { songQueueClientLayer } from "../song-queue/song-queue-client.ts";
import { raffleClientLayer } from "../raffle/raffle-client.ts";
import { achievementsClientLayer } from "../achievements/achievements-client.ts";
import { hasCommandPermission } from "./command-permissions.ts";

/** Prepare is replayable via message-keyed mutations; the receipt owner alone sends to Twitch. */
export interface IChatCommandExecutor {
  readonly prepare: (
    input: ChatCommandInput,
  ) => Effect.Effect<ChatCommandPreparation, ChatCommandError>;
}

/** Chat command execution parses, authorizes, renders, and enforces the Twitch response limit. */
export class ChatCommandExecutor extends Context.Service<
  ChatCommandExecutor,
  IChatCommandExecutor
>()("@cf-twitch/ChatCommandExecutor") {}

const commandEmotes = ["PogChamp", "Kappa", "LUL", "SeemsGood", "HeyGuys"] as const;

/** Construct the executor without a sender; prepared output must be durably saved before delivery. */
export const makeChatCommandExecutor = Effect.gen(function* () {
  const commands = yield* Commands;
  const computed = yield* ComputedChatCommands;
  const analytics = yield* TwitchAnalytics;

  const prepareResponse: IChatCommandExecutor["prepare"] = Effect.fn(
    "ChatCommandExecutor.prepareResponse",
  )(function* (input) {
    const [first, ...args] = input.text.trim().split(/\s+/);

    if (first === undefined || !first.startsWith("!") || first.length === 1)
      return { _tag: "ChatCommandIgnored", reason: "not_command", commandName: Option.none() };

    const name = yield* parseChatCommandName(first.slice(1).toLowerCase()).pipe(
      Effect.mapError(
        () =>
          new CommandInputParseError({
            operation: "prepare",
          }),
      ),
    );

    const found = yield* commands.getCommand({ name }).pipe(
      Effect.map(Option.some),
      Effect.catchTag("CommandNotFoundError", () => Effect.succeed(Option.none())),
    );

    if (Option.isNone(found))
      return {
        _tag: "ChatCommandIgnored",
        reason: "unknown_command",
        commandName: Option.some(name),
      };
    const command = found.value;

    if (!command.enabled)
      return {
        _tag: "ChatCommandIgnored",
        reason: "disabled",
        commandName: Option.some(command.name),
      };

    if (!hasCommandPermission(input.viewer.permission, command.permission))
      return {
        _tag: "ChatCommandIgnored",
        reason: "permission_denied",
        commandName: Option.some(command.name),
      };
    const arg = args.length === 0 ? Option.none<string>() : Option.some(args.join(" "));
    let message: string;

    if (command.responseType === "computed")
      message = yield* computed.render({ command, input, arg });
    else {
      const value = yield* commands.getCommandValue({ name: command.name });

      if (Option.isNone(value) || value.value.length === 0) message = command.emptyResponse;
      else {
        const emote = yield* Random.choice(commandEmotes);

        const rendered = value.value
          .replaceAll("${user}", input.viewer.displayName)
          .replaceAll("${random.emote}", emote);

        message = command.outputTemplate.replaceAll("{value}", rendered);
      }
    }

    if (Array.from(message).length > 500)
      return yield* new ChatCommandRenderError({
        commandName: command.name,
      });
    yield* Effect.logInfo("Chat command response prepared").pipe(
      Effect.annotateLogs({
        event: "chat_command.prepared",
        message_id: input.messageId,
        command: command.name,
      }),
    );

    return {
      _tag: "ChatCommandPrepared",
      commandName: command.name,
      message: Option.some(message),
    };
  });

  const prepare: IChatCommandExecutor["prepare"] = Effect.fn("ChatCommandExecutor.prepare")(
    function* (input) {
      const startedAt = yield* Clock.currentTimeMillis;
      const result = yield* prepareResponse(input).pipe(Effect.result);

      if (Result.isFailure(result)) {
        const command = "commandName" in result.failure ? result.failure.commandName : "invalid";
        yield* analytics.writeChatCommandMetric({
          command,
          userId: input.viewer.userId,
          userName: input.viewer.displayName,
          status: "error",
          durationMs: Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
          error: Option.some(result.failure._tag),
        });

        return yield* result.failure;
      }

      if (result.success._tag === "ChatCommandIgnored" && result.success.reason !== "not_command") {
        yield* analytics.writeChatCommandMetric({
          command: Option.getOrElse(result.success.commandName, () => "unknown"),
          userId: input.viewer.userId,
          userName: input.viewer.displayName,
          status: "ignored",
          durationMs: Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
          error: Option.none(),
        });
      }

      // The durable receipt owner records success or send failure only after provider I/O.
      return result.success;
    },
  );

  return ChatCommandExecutor.of({ prepare });
});

/** Executor layer retains command registry and computed-provider capability requirements. */
export const executorLayerWithoutDependencies = Layer.effect(
  ChatCommandExecutor,
  makeChatCommandExecutor,
);

/** Ready executor resolves all real provider namespaces during Alchemy initialization. */
export const executorLayer = executorLayerWithoutDependencies.pipe(
  Layer.provide(computedChatCommandsLayerWithoutDependencies),
  Layer.provide([
    commandsClientLayer,
    songQueueClientLayer,
    raffleClientLayer,
    achievementsClientLayer,
  ]),
);
