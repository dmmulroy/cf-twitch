import { Clock, Context, Effect, Layer, Match, Option, Result } from "effect";
import {
  ChatCommandExecutionError,
  ChatCommandName,
  parseChatCommandName,
  type ChatCommandDefinition,
  type ChatCommandInput,
  type ChatCommandPermission,
  type CommandsError,
} from "@cf-twitch/contracts/chat-command";
import { PageSize } from "@cf-twitch/contracts/identity";
import type { RaffleLeaderboardEntry } from "@cf-twitch/contracts/raffle";
import { SongQueueLimit } from "@cf-twitch/contracts/song-queue";
import { Commands, commandsTestLayer } from "./commands.ts";
import { commandsClientLayer } from "./commands-client.ts";
import { SongQueue } from "../song-queue/song-queue.ts";
import { songQueueLayer } from "../song-queue/song-queue.ts";
import { Achievements } from "../achievements/achievements-service.ts";
import { achievementsClientLayer } from "../achievements/achievements-client.ts";
import { Raffle } from "../raffle/raffle-service.ts";
import { raffleClientLayer } from "../raffle/raffle-client.ts";

/** Invocation a computed command renders a response for. */
export interface ComputedChatCommandContext {
  /** Computed command definition whose handler key selects the renderer. */
  readonly command: Extract<ChatCommandDefinition, { readonly responseType: "computed" }>;
  /** Verified chat input that invoked the command. */
  readonly input: ChatCommandInput;
  /** Text after the command name, or `Option.none()` when the viewer gave no argument. */
  readonly arg: Option.Option<string>;
}

/** Computed chat responses that read music, raffle, achievement, and registry state without sending chat. */
export interface IComputedChatCommands {
  /**
   * Renders the chat response for a computed command, selected by its handler key.
   *
   * **Details**
   *
   * Most provider failures become a fallback response that explains the failure to the viewer.
   * An unknown handler key renders a configuration message instead of failing.
   *
   * @returns The response text, or fails with `ChatCommandExecutionError` when `stats` cannot read
   * song request counts or raffle results.
   */
  readonly render: (
    context: ComputedChatCommandContext,
  ) => Effect.Effect<string, ChatCommandExecutionError>;
}

/** Service for computed chat command responses, dispatched by handler key rather than invocation name. */
export class ComputedChatCommands extends Context.Service<
  ComputedChatCommands,
  IComputedChatCommands
>()("@cf-twitch/ComputedChatCommands") {}

const easternTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
  timeZoneName: "short",
});

const viewerHasNoStatistics = (
  self: boolean,
  songCount: number,
  achievementsAvailable: boolean,
  unlockedAchievementCount: number,
  raffleStats: Option.Option<RaffleLeaderboardEntry>,
): boolean =>
  !self &&
  songCount === 0 &&
  achievementsAvailable &&
  unlockedAchievementCount === 0 &&
  Option.isNone(raffleStats);

const raffleStatsMessage = (stats: Option.Option<RaffleLeaderboardEntry>): string =>
  Option.match(stats, {
    onNone: () => "0 rolls",
    onSome: (entry) => {
      const extras = [
        ...Option.toArray(Option.map(entry.closestDistance, (distance) => `closest: ${distance}`)),
        ...(entry.totalWins > 0
          ? [`${entry.totalWins} win${entry.totalWins > 1 ? "s" : ""}!`]
          : []),
      ];

      return `${entry.totalRolls} rolls${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`;
    },
  });

const writePermissionMessage = (required: ChatCommandPermission, commandName: string): string => {
  switch (required) {
    case "everyone":
      return `!${commandName} can be updated by anyone.`;
    case "vip":
      return `Only VIPs and moderators can update !${commandName}. Ask a VIP or moderator to update it.`;
    case "moderator":
      return `Only moderators can update !${commandName}. Ask a moderator to update it.`;
    case "broadcaster":
      return `Only the broadcaster can update !${commandName}. Ask the broadcaster to update it.`;
  }
};

// Registry failures after a value update was sent may hide a saved change, so viewers check before resending.
const updateFailureMessage = (failure: CommandsError, target: string): string => {
  const unconfirmed = `Couldn't confirm the update to !${target} because commands are unavailable right now. Check !${target} before sending it again.`;

  return Match.valueTags(failure, {
    CommandNotFoundError: () =>
      `Couldn't update !${target} because it is not a command. Check the command name and try again.`,
    CommandNotUpdateableError: () =>
      `Couldn't update !${target} because its response is not editable. Choose a command with an editable value.`,
    CommandUpdatePermissionDeniedError: (denied) =>
      writePermissionMessage(denied.requiredPermission, target),
    CommandInputParseError: () =>
      `Couldn't update !${target} because this chat message was already used for a different update. Send the update in a new message.`,
    CommandAlreadyExistsError: () => unconfirmed,
    CommandAliasConflictError: () => unconfirmed,
    CommandInvalidDefinitionError: () => unconfirmed,
    CommandsDbError: () => unconfirmed,
    CommandsInvalidResponseError: () => unconfirmed,
    CommandsStateParseError: () => unconfirmed,
  });
};

// A failed increment may still have been counted; a new chat message would count it again.
const skillIssueFailureMessage = (failure: CommandsError): string => {
  const unconfirmed =
    "Couldn't confirm that skill issue was counted because commands are unavailable right now. It may already be counted, so there's no need to send it again.";

  return Match.valueTags(failure, {
    CommandNotFoundError: () =>
      "Couldn't count that skill issue because the !skillissue counter is missing. Ask a moderator to restore !skillissue.",
    CommandInputParseError: () => unconfirmed,
    CommandAlreadyExistsError: () => unconfirmed,
    CommandAliasConflictError: () => unconfirmed,
    CommandInvalidDefinitionError: () => unconfirmed,
    CommandNotUpdateableError: () => unconfirmed,
    CommandUpdatePermissionDeniedError: () => unconfirmed,
    CommandsDbError: () => unconfirmed,
    CommandsInvalidResponseError: () => unconfirmed,
    CommandsStateParseError: () => unconfirmed,
  });
};

/**
 * Creates computed command renderers over the registry and music, raffle, and achievement services.
 *
 * @returns The computed response service; constructing it does not fail.
 */
export const makeComputedChatCommands = Effect.gen(function* () {
  const commands = yield* Commands;
  const songQueue = yield* SongQueue;
  const achievements = yield* Achievements;
  const raffle = yield* Raffle;

  const renderUpdate = Effect.fn("ComputedChatCommands.update")(function* ({
    input,
    arg,
  }: ComputedChatCommandContext) {
    if (Option.isNone(arg) || arg.value.length === 0) return "Usage: !update <command> <value>";
    const targetRaw = arg.value.split(/\s+/)[0];

    if (!targetRaw) return "Usage: !update <command> <value>";
    const target = targetRaw.toLowerCase();
    const value = arg.value.slice(targetRaw.length).trim();

    if (value.length === 0) return `Usage: !update ${target} <value>`;
    const name = yield* parseChatCommandName(target).pipe(Effect.result);

    if (Result.isFailure(name))
      return `Couldn't update !${target} because it is not a valid command name. Use letters, digits, or hyphens and try again.`;

    const result = yield* commands
      .updateCommandValue({
        name: name.success,
        value,
        actor: { displayName: input.viewer.displayName, permission: input.viewer.permission },
        operationId: Option.some(input.messageId),
      })
      .pipe(Effect.result);

    if (Result.isSuccess(result)) return `Updated !${target}`;

    return updateFailureMessage(result.failure, target);
  });

  const renderSong = Effect.fn("ComputedChatCommands.song")(function* () {
    const result = yield* songQueue.getCurrentlyPlaying().pipe(Effect.result);

    if (Result.isFailure(result))
      return "Couldn't get the current song because the song queue is unavailable. Try !song again in a moment.";

    if (Option.isNone(result.success.track)) return "No track currently playing.";
    const track = result.success.track.value;

    const attribution =
      track.source === "autoplay" ? "" : ` - requested by @${track.requesterDisplayName}`;

    return `Now playing: "${track.name}" by ${track.artists.join(", ")}${attribution}`;
  });

  const renderQueue = Effect.fn("ComputedChatCommands.queue")(function* () {
    const result = yield* songQueue
      .getSongQueue({ limit: SongQueueLimit.make(4) })
      .pipe(Effect.result);

    if (Result.isFailure(result))
      return "Couldn't get the song queue because it is unavailable right now. Try !queue again in a moment.";

    if (result.success.tracks.length === 0) return "Queue is empty.";

    return `Next up: ${result.success.tracks.map((track, index) => `${index + 1}. "${track.name}" by ${track.artists.join(", ")}${track.source === "autoplay" ? "" : ` (@${track.requesterDisplayName})`}`).join(" | ")}`;
  });

  const renderAchievements = Effect.fn("ComputedChatCommands.achievements")(function* ({
    input,
    arg,
  }: ComputedChatCommandContext) {
    const target = Option.getOrElse(arg, () => input.viewer.displayName);

    const result = yield* achievements
      .getUnlockedAchievements({ userDisplayName: target })
      .pipe(Effect.result);

    if (Result.isFailure(result))
      return `Couldn't retrieve achievements for @${target} because achievements are unavailable right now. Try again in a moment.`;

    if (result.success.length === 0) return `@${target} hasn't unlocked any achievements yet.`;

    return `@${target} has unlocked ${result.success.length} achievement${result.success.length === 1 ? "" : "s"}: ${result.success.map((entry) => entry.name).join(", ")}`;
  });

  const renderRaffleLeaderboard = Effect.fn("ComputedChatCommands.raffleLeaderboard")(function* () {
    const result = yield* raffle
      .getLeaderboard({ sortBy: "wins", limit: Option.some(PageSize.make(5)) })
      .pipe(Effect.result);

    if (Result.isFailure(result))
      return "Couldn't retrieve the raffle leaderboard because raffle results are unavailable. Try !raffle-leaderboard again in a moment.";

    if (result.success.length === 0) return "No raffle rolls recorded yet.";
    const winners = result.success.filter((entry) => entry.totalWins > 0);

    if (winners.length === 0) return "No raffle winners yet — be the first!";

    return `Raffle wins: ${winners.map((entry, index) => `${index + 1}. @${entry.displayName} (${entry.totalWins})`).join(" ")}`;
  });

  const renderStats = Effect.fn("ComputedChatCommands.stats")(function* ({
    command,
    input,
    arg,
  }: ComputedChatCommandContext) {
    const self = Option.isNone(arg);
    const target = Option.getOrElse(arg, () => input.viewer.displayName);

    const [unlocked, definitions] = yield* Effect.all(
      [
        achievements.getUnlockedAchievements({ userDisplayName: target }).pipe(Effect.result),
        achievements.getDefinitions().pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    );

    const achievementsAvailable = Result.isSuccess(unlocked) && Result.isSuccess(definitions);

    const achievementStats = achievementsAvailable
      ? `${unlocked.success.length}/${definitions.success.length}`
      : "?/?";

    const [songs, raffleStats] = yield* Effect.all(
      [
        (self
          ? songQueue.getUserRequestCount({ userId: input.viewer.userId })
          : songQueue.getUserRequestCountByDisplayName({ displayName: target })
        ).pipe(Effect.result),
        (self
          ? raffle.getUserStats({ userId: input.viewer.userId })
          : raffle.getUserStatsByDisplayName({ displayName: target })
        ).pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    );

    if (Result.isFailure(songs))
      return yield* new ChatCommandExecutionError({
        operation: "prepareChatCommand",
        reason: "song_queue_unavailable",
        commandName: command.name,
      });

    if (Result.isFailure(raffleStats))
      return yield* new ChatCommandExecutionError({
        operation: "prepareChatCommand",
        reason: "raffle_unavailable",
        commandName: command.name,
      });

    const unlockedAchievementCount = Result.isSuccess(unlocked) ? unlocked.success.length : 0;

    if (
      viewerHasNoStatistics(
        self,
        songs.success,
        achievementsAvailable,
        unlockedAchievementCount,
        raffleStats.success,
      )
    )
      return `No records found for @${target} yet — no songs, achievements, or raffle stats.`;

    const rolls = raffleStatsMessage(raffleStats.success);

    return `@${target} — Songs: ${songs.success} | Achievements: ${achievementStats} | Raffles: ${rolls}`;
  });

  const renderCommands = Effect.fn("ComputedChatCommands.commands")(function* ({
    input,
  }: ComputedChatCommandContext) {
    const result = yield* commands
      .getEnabledCommandsByPermission({ permission: input.viewer.permission })
      .pipe(Effect.result);

    if (Result.isFailure(result))
      return "Couldn't retrieve the commands list because commands are unavailable right now. Try !commands again in a moment.";

    if (result.success.length === 0) return "No commands available.";

    const grouped = (permission: ChatCommandPermission) =>
      result.success
        .filter((command) => command.permission === permission)
        .map((command) => `!${command.name}`)
        .join(" ");

    const sections = [`Commands: ${grouped("everyone")}`];

    for (const [permission, label] of [
      ["vip", "VIP"],
      ["moderator", "Mod"],
      ["broadcaster", "Broadcaster"],
    ] as const) {
      const names = grouped(permission);

      if (names.length > 0) sections.push(`${label}: ${names}`);
    }

    return sections.join(" | ");
  });

  const renderTime = Effect.fn("ComputedChatCommands.time")(function* () {
    return `Current time is: ${easternTimeFormatter.format(new Date(yield* Clock.currentTimeMillis))}`;
  });

  const renderSkillIssue = Effect.fn("ComputedChatCommands.skillIssue")(function* (
    context: ComputedChatCommandContext,
  ) {
    const result = yield* commands
      .incrementCommandCounter({
        name: ChatCommandName.make("skillissue"),
        increment: 1,
        operationId: Option.some(context.input.messageId),
      })
      .pipe(Effect.result);

    return Result.isSuccess(result)
      ? `@dillon has ${result.success} SkillIssue so far`
      : skillIssueFailureMessage(result.failure);
  });

  const computedCommandRenderers = new Map<string, IComputedChatCommands["render"]>([
    ["update", renderUpdate],
    ["song", renderSong],
    ["queue", renderQueue],
    ["achievements", renderAchievements],
    ["raffle-leaderboard", renderRaffleLeaderboard],
    ["stats", renderStats],
    ["commands", renderCommands],
    ["time", renderTime],
    ["skillissue", renderSkillIssue],
  ]);

  const render: IComputedChatCommands["render"] = Effect.fn("ComputedChatCommands.render")(
    function* (context) {
      const renderer = Option.fromNullishOr(
        computedCommandRenderers.get(context.command.handlerKey),
      );

      return Option.isNone(renderer)
        ? `No live handler is configured for !${context.command.name}. Ask a moderator to fix the command's handler.`
        : yield* renderer.value(context);
    },
  );

  return ComputedChatCommands.of({ render });
});

/** Layer that provides computed responses and keeps the registry, song queue, achievement, and raffle requirements visible. */
export const computedChatCommandsLayerWithoutDependencies = Layer.effect(
  ComputedChatCommands,
  makeComputedChatCommands,
);

/** Production computed-response Layer selecting the Durable Object HTTP clients for each capability. */
export const computedChatCommandsLayer = computedChatCommandsLayerWithoutDependencies.pipe(
  Layer.provide([commandsClientLayer, songQueueLayer, raffleClientLayer, achievementsClientLayer]),
);

/**
 * Layer that provides computed responses over the in-memory registry.
 *
 * **Gotchas**
 *
 * Song queue, achievement, and raffle requirements stay visible until those capabilities export
 * their own test Layers; tests provide controlled implementations of them.
 */
export const computedChatCommandsTestLayer = computedChatCommandsLayerWithoutDependencies.pipe(
  Layer.provide(commandsTestLayer),
);
