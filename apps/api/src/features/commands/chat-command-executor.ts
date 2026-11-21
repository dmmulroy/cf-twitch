import { Clock, Context, Effect, Layer, Option, Predicate, Random } from "effect";
import { TwitchAnalytics } from "../../runtime/twitch-analytics.ts";
import {
  ChatCommandInput,
  ChatCommandRenderError,
  type ChatCommandDefinition,
  CommandInputParseError,
  parseChatCommandName,
  type ChatCommandError,
  ChatCommandPreparation,
} from "@cf-twitch/contracts/chat-command";
import { Commands, commandsTestLayer } from "./commands.ts";
import {
  ComputedChatCommands,
  computedChatCommandsLayer,
  computedChatCommandsTestLayer,
} from "./computed-chat-commands.ts";
import { commandsClientLayer } from "./commands-client.ts";
import { hasCommandPermission } from "./command-permissions.ts";

/** Chat command preparation: parse, authorize, and render a response without sending it. */
export interface IChatCommandExecutor {
  /**
   * Prepares the chat response for verified chat input, or reports why it is ignored.
   *
   * **Details**
   *
   * Value and counter mutations are keyed by the EventSub message ID, so preparing the same message
   * again replays them. Only the EventSub receipt owner sends the prepared message to Twitch, after
   * saving it durably. Ignored invocations and failures are recorded as chat command metrics.
   *
   * @returns The ignored or prepared result, or fails with `CommandInputParseError` when the command
   * name is invalid, `ChatCommandRenderError` when the response exceeds 500 Unicode code points,
   * `ChatCommandExecutionError` when `stats` cannot read its providers, and a registry error when
   * commands cannot be read or a mutation fails.
   */
  readonly prepare: (
    input: ChatCommandInput,
  ) => Effect.Effect<ChatCommandPreparation, ChatCommandError>;
}

/** Service that parses, authorizes, renders, and enforces the Twitch response limit for chat commands. */
export class ChatCommandExecutor extends Context.Service<
  ChatCommandExecutor,
  IChatCommandExecutor
>()("@cf-twitch/ChatCommandExecutor") {}

const commandEmotes = ["PogChamp", "Kappa", "LUL", "SeemsGood", "HeyGuys"] as const;

const maximumChatResponseCodePoints = 500;

// Metrics label failures with the command they concern; failures before name resolution use "invalid".
const failedCommandMetricName = (error: ChatCommandError): string => {
  if (!("commandName" in error)) return "invalid";
  const commandName = error.commandName;

  return Option.isOption(commandName)
    ? Option.getOrElse(commandName, () => "invalid")
    : commandName;
};

/**
 * Creates the executor without a chat sender; prepared output must be durably saved before delivery.
 *
 * @returns The executor service; constructing it does not fail.
 */
export const makeChatCommandExecutor = Effect.gen(function* () {
  const commands = yield* Commands;
  const computed = yield* ComputedChatCommands;
  const analytics = yield* TwitchAnalytics;

  const renderCommandResponse = Effect.fn("ChatCommandExecutor.renderCommandResponse")(function* (
    command: ChatCommandDefinition,
    input: ChatCommandInput,
    arg: Option.Option<string>,
  ) {
    if (command.responseType === "computed") return yield* computed.render({ command, input, arg });
    const value = yield* commands.getCommandValue({ name: command.name });

    if (Option.isNone(value) || value.value.length === 0) return command.emptyResponse;
    const emote = yield* Random.choice(commandEmotes);

    const rendered = value.value
      .replaceAll("${user}", input.viewer.displayName)
      .replaceAll("${random.emote}", emote);

    return command.outputTemplate.replaceAll("{value}", rendered);
  });

  const prepareResponse: IChatCommandExecutor["prepare"] = Effect.fn(
    "ChatCommandExecutor.prepareResponse",
  )(function* (input) {
    const [first, ...args] = input.text.trim().split(/\s+/);

    if (first === undefined || !first.startsWith("!") || first.length === 1)
      return ChatCommandPreparation.members[0].make({
        reason: "not_command",
        commandName: Option.none(),
      });

    const name = yield* parseChatCommandName(first.slice(1).toLowerCase()).pipe(
      Effect.mapError(
        () =>
          new CommandInputParseError({
            operation: "prepareChatCommand",
            reason: "invalid_command_name",
            commandName: Option.none(),
            operationId: Option.some(input.messageId),
          }),
      ),
    );

    const found = yield* commands.getCommand({ name }).pipe(
      Effect.map(Option.some),
      Effect.catchTag("CommandNotFoundError", () => Effect.succeed(Option.none())),
    );

    if (Option.isNone(found))
      return ChatCommandPreparation.members[0].make({
        reason: "unknown_command",
        commandName: Option.some(name),
      });
    const command = found.value;

    if (!command.enabled)
      return ChatCommandPreparation.members[0].make({
        reason: "disabled",
        commandName: Option.some(command.name),
      });

    if (!hasCommandPermission(input.viewer.permission, command.permission))
      return ChatCommandPreparation.members[0].make({
        reason: "permission_denied",
        commandName: Option.some(command.name),
      });
    const arg = args.length === 0 ? Option.none<string>() : Option.some(args.join(" "));
    const message = yield* renderCommandResponse(command, input, arg);

    const renderedCodePoints = Array.from(message).length;

    if (renderedCodePoints > maximumChatResponseCodePoints)
      return yield* new ChatCommandRenderError({
        operation: "prepareChatCommand",
        reason: "response_too_long",
        commandName: command.name,
        renderedCodePoints,
        maximumCodePoints: maximumChatResponseCodePoints,
      });
    yield* Effect.logInfo("Chat command response prepared").pipe(
      Effect.annotateLogs({
        event: "chat_command.prepared",
        message_id: input.messageId,
        command: command.name,
      }),
    );

    return ChatCommandPreparation.members[1].make({
      commandName: command.name,
      message: Option.some(message),
    });
  });

  const prepare: IChatCommandExecutor["prepare"] = Effect.fn("ChatCommandExecutor.prepare")(
    function* (input) {
      const startedAt = yield* Clock.currentTimeMillis;

      // The durable receipt owner records success or send failure only after provider I/O.
      return yield* prepareResponse(input).pipe(
        Effect.tapError((error) => {
          const command = failedCommandMetricName(error);

          return Effect.gen(function* () {
            yield* analytics.writeChatCommandMetric({
              command,
              userId: input.viewer.userId,
              userName: input.viewer.displayName,
              status: "error",
              durationMs: Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
              error: Option.some(error._tag),
            });
          });
        }),
        Effect.tap((preparation) =>
          Predicate.isTagged(preparation, "ChatCommandIgnored") &&
          preparation.reason !== "not_command"
            ? Effect.gen(function* () {
                yield* analytics.writeChatCommandMetric({
                  command: Option.getOrElse(preparation.commandName, () => "unknown"),
                  userId: input.viewer.userId,
                  userName: input.viewer.displayName,
                  status: "ignored",
                  durationMs: Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
                  error: Option.none(),
                });
              })
            : Effect.void,
        ),
      );
    },
  );

  return ChatCommandExecutor.of({ prepare });
});

/** Layer that provides the executor and keeps the registry, computed-response, and analytics requirements visible. */
export const chatCommandExecutorLayerWithoutDependencies = Layer.effect(
  ChatCommandExecutor,
  makeChatCommandExecutor,
);

/** Production executor Layer; resolves every provider namespace during Alchemy initialization and leaves analytics to the composition root. */
export const chatCommandExecutorLayer = chatCommandExecutorLayerWithoutDependencies.pipe(
  Layer.provide([computedChatCommandsLayer, commandsClientLayer]),
);

/**
 * Layer that provides the executor over the in-memory registry and computed responses.
 *
 * **Gotchas**
 *
 * Analytics, song queue, achievement, and raffle requirements stay visible until those
 * capabilities export their own test Layers; tests provide controlled implementations of them.
 */
export const chatCommandExecutorTestLayer = chatCommandExecutorLayerWithoutDependencies.pipe(
  Layer.provide([computedChatCommandsTestLayer, commandsTestLayer]),
);
