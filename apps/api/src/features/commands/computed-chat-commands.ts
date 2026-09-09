import { Clock, Context, Effect, Layer, Option, Result } from "effect";
import {
  ChatCommandExecutionError,
  ChatCommandName,
  parseChatCommandName,
  type ChatCommandDefinition,
  type ChatCommandError,
  type ChatCommandInput,
  type ChatCommandPermission,
} from "@cf-twitch/contracts/chat-command";
import { PageSize } from "@cf-twitch/contracts/identity";
import { SongQueueLimit } from "@cf-twitch/contracts/song-queue";
import { Commands } from "./commands.ts";
import { SongQueue } from "../song-queue/song-queue.ts";
import { Achievements } from "../achievements/achievements-service.ts";
import { Raffle } from "../raffle/raffle-service.ts";

interface ComputedCommandContext {
  readonly command: ChatCommandDefinition;
  readonly input: ChatCommandInput;
  readonly arg: Option.Option<string>;
}

/** Computed chat responses coordinate real music and reward capabilities without sending chat. */
export interface IComputedChatCommands {
  readonly render: (context: ComputedCommandContext) => Effect.Effect<string, ChatCommandError>;
}

/** Computed command behavior uses handler keys rather than hard-coded invocation names. */
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

const writePermissionMessage = (required: ChatCommandPermission, commandName: string): string => {
  switch (required) {
    case "everyone":
      return `!${commandName} can be updated by anyone.`;
    case "vip":
      return `Only VIPs and moderators can update !${commandName}.`;
    case "moderator":
      return `Only moderators can update !${commandName}.`;
    case "broadcaster":
      return `Only the broadcaster can update !${commandName}.`;
  }
};

/** Construct computed handlers; provider failures retain each command's historical fallback policy. */
export const makeComputedChatCommands = Effect.gen(function* () {
  const commands = yield* Commands;
  const songQueue = yield* SongQueue;
  const achievements = yield* Achievements;
  const raffle = yield* Raffle;

  const renderUpdate = Effect.fn("ComputedChatCommands.update")(function* ({
    input,
    arg,
  }: ComputedCommandContext) {
    if (Option.isNone(arg) || arg.value.length === 0) return "Usage: !update <command> <value>";
    const targetRaw = arg.value.split(/\s+/)[0];

    if (!targetRaw) return "Usage: !update <command> <value>";
    const target = targetRaw.toLowerCase();
    const value = arg.value.slice(targetRaw.length).trim();

    if (value.length === 0) return `Usage: !update ${target} <value>`;
    const name = yield* parseChatCommandName(target).pipe(Effect.result);

    if (Result.isFailure(name)) return "Sorry, couldn't update the command.";

    const result = yield* commands
      .updateCommandValue({
        name: name.success,
        value,
        actor: { displayName: input.viewer.displayName, permission: input.viewer.permission },
        operationId: Option.some(input.messageId),
      })
      .pipe(Effect.result);

    if (Result.isSuccess(result)) return `Updated !${target}`;

    switch (result.failure._tag) {
      case "CommandNotUpdateableError":
        return `!${target} is not updateable.`;
      case "CommandUpdatePermissionDeniedError":
        return writePermissionMessage(result.failure.requiredPermission, target);
      default:
        return "Sorry, couldn't update the command.";
    }
  });

  const renderSong = Effect.fn("ComputedChatCommands.song")(function* () {
    const result = yield* songQueue.getCurrentlyPlaying().pipe(Effect.result);

    if (Result.isFailure(result)) return "Sorry, couldn't get the current song info.";

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

    if (Result.isFailure(result)) return "Sorry, couldn't get the queue info.";

    if (result.success.tracks.length === 0) return "Queue is empty.";

    return `Next up: ${result.success.tracks.map((track, index) => `${index + 1}. "${track.name}" by ${track.artists.join(", ")}${track.source === "autoplay" ? "" : ` (@${track.requesterDisplayName})`}`).join(" | ")}`;
  });

  const renderAchievements = Effect.fn("ComputedChatCommands.achievements")(function* ({
    input,
    arg,
  }: ComputedCommandContext) {
    const target = Option.getOrElse(arg, () => input.viewer.displayName);

    const result = yield* achievements
      .getUnlockedAchievements({ userDisplayName: target })
      .pipe(Effect.result);

    if (Result.isFailure(result)) return `Sorry, couldn't retrieve achievements for @${target}.`;

    if (result.success.length === 0) return `@${target} hasn't unlocked any achievements yet.`;

    return `@${target} has unlocked ${result.success.length} achievement${result.success.length === 1 ? "" : "s"}: ${result.success.map((entry) => entry.name).join(", ")}`;
  });

  const renderRaffleLeaderboard = Effect.fn("ComputedChatCommands.raffleLeaderboard")(function* () {
    const result = yield* raffle
      .getLeaderboard({ sortBy: "wins", limit: Option.some(PageSize.make(5)) })
      .pipe(Effect.result);

    if (Result.isFailure(result)) return "Sorry, couldn't retrieve the raffle leaderboard.";

    if (result.success.length === 0) return "No raffle rolls recorded yet.";
    const winners = result.success.filter((entry) => entry.totalWins > 0);

    if (winners.length === 0) return "No raffle winners yet — be the first!";

    return `Raffle wins: ${winners.map((entry, index) => `${index + 1}. @${entry.displayName} (${entry.totalWins})`).join(" ")}`;
  });

  const renderStats = Effect.fn("ComputedChatCommands.stats")(function* ({
    input,
    arg,
  }: ComputedCommandContext) {
    const self = Option.isNone(arg);
    const target = Option.getOrElse(arg, () => input.viewer.displayName);

    const [unlocked, definitions] = yield* Effect.all(
      [
        achievements.getUnlockedAchievements({ userDisplayName: target }).pipe(Effect.result),
        achievements.getDefinitions().pipe(Effect.result),
      ],
      { concurrency: "unbounded" },
    );

    const achievementStats =
      Result.isSuccess(unlocked) && Result.isSuccess(definitions)
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
        commandName: "stats",
      });

    if (Result.isFailure(raffleStats))
      return yield* new ChatCommandExecutionError({
        commandName: "stats",
      });

    if (
      !self &&
      songs.success === 0 &&
      Result.isSuccess(unlocked) &&
      unlocked.success.length === 0 &&
      Result.isSuccess(definitions) &&
      Option.isNone(raffleStats.success)
    )
      return `No records found for @${target} yet — no songs, achievements, or raffle stats.`;

    const rolls = Option.match(raffleStats.success, {
      onNone: () => "0 rolls",
      onSome: (entry) => {
        const extras = [
          ...Option.toArray(
            Option.map(entry.closestDistance, (distance) => `closest: ${distance}`),
          ),
          ...(entry.totalWins > 0
            ? [`${entry.totalWins} win${entry.totalWins > 1 ? "s" : ""}!`]
            : []),
        ];

        return `${entry.totalRolls} rolls${extras.length > 0 ? ` (${extras.join(", ")})` : ""}`;
      },
    });

    return `@${target} — Songs: ${songs.success} | Achievements: ${achievementStats} | Raffles: ${rolls}`;
  });

  const renderCommands = Effect.fn("ComputedChatCommands.commands")(function* ({
    input,
  }: ComputedCommandContext) {
    const result = yield* commands
      .getEnabledCommandsByPermission({ permission: input.viewer.permission })
      .pipe(Effect.result);

    if (Result.isFailure(result)) return "Sorry, couldn't retrieve the commands list.";

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

  const render: IComputedChatCommands["render"] = Effect.fn("ComputedChatCommands.render")(
    function* (context) {
      switch (context.command.handlerKey) {
        case "update":
          return yield* renderUpdate(context);
        case "song":
          return yield* renderSong();
        case "queue":
          return yield* renderQueue();
        case "achievements":
          return yield* renderAchievements(context);
        case "raffle-leaderboard":
          return yield* renderRaffleLeaderboard();
        case "stats":
          return yield* renderStats(context);
        case "commands":
          return yield* renderCommands(context);
        case "time":
          return `Current time is: ${easternTimeFormatter.format(new Date(yield* Clock.currentTimeMillis))}`;
        case "skillissue": {
          const result = yield* commands
            .incrementCommandCounter({
              name: ChatCommandName.make("skillissue"),
              increment: 1,
              operationId: Option.some(context.input.messageId),
            })
            .pipe(Effect.result);

          return Result.isFailure(result)
            ? "Couldn't count that skill issue right now."
            : `@dillon has ${result.success} SkillIssue so far`;
        }

        default:
          return `!${context.command.name} is configured but has no live handler.`;
      }
    },
  );

  return ComputedChatCommands.of({ render });
});

/** Computed response layer leaves real registry, music, and reward requirements visible. */
export const computedChatCommandsLayerWithoutDependencies = Layer.effect(
  ComputedChatCommands,
  makeComputedChatCommands,
);
