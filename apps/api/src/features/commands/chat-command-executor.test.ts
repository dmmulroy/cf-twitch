import { SqliteClient } from "@effect/sql-sqlite-node";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Context, Effect, Layer, Option, Ref, Schema } from "effect";
import { FastCheck, TestClock } from "effect/testing";
import {
  AchievementDefinition,
  AchievementError,
  UnlockedAchievement,
} from "@cf-twitch/contracts/achievement";
import {
  ChatCommandInput,
  ChatCommandName,
  CreateChatCommandInput,
  type ChatCommandPermission,
} from "@cf-twitch/contracts/chat-command";
import { RaffleError, RaffleLeaderboardEntry } from "@cf-twitch/contracts/raffle";
import { NowPlaying, QueuedTrack, SongQueueError } from "@cf-twitch/contracts/song-queue";
import { TwitchAnalytics, type ChatCommandMetric } from "../../runtime/twitch-analytics.ts";
import { SongQueue } from "../song-queue/song-queue.ts";
import { Achievements } from "../achievements/achievements-service.ts";
import { Raffle } from "../raffle/raffle-service.ts";
import { Commands } from "./commands.ts";
import { ChatCommandExecutor, executorLayerWithoutDependencies } from "./chat-command-executor.ts";
import { computedChatCommandsLayerWithoutDependencies } from "./computed-chat-commands.ts";
import { commandsDatabaseLayerWithoutDependencies } from "./commands-database.ts";
import { getChatCommandPermission, hasCommandPermission } from "./command-permissions.ts";

const parseInput = Schema.decodeUnknownSync(ChatCommandInput);
const name = (value: string) => ChatCommandName.make(value);
const input = (
  text: string,
  permission: ChatCommandPermission = "everyone",
  messageId = "message-1",
): ChatCommandInput =>
  parseInput({
    text,
    messageId,
    receivedAt: "2026-01-01T00:00:00.000Z",
    viewer: { userId: "viewer-1", displayName: "Viewer", permission },
  });
const track = Schema.decodeUnknownSync(QueuedTrack)({
  id: "Track1",
  name: "A Song",
  artists: ["Artist", "Guest"],
  album: "Album",
  albumCoverUrl: null,
  source: "user",
  eventId: "request1",
  requesterUserId: "viewer-1",
  requesterDisplayName: "Requester",
  requestedAt: "2026-01-01T00:00:00.000Z",
});
const autoplay = Schema.decodeUnknownSync(QueuedTrack)({
  id: "Track2",
  name: "Autoplay",
  artists: ["Artist"],
  album: "Album",
  albumCoverUrl: null,
  source: "autoplay",
});
const unlocked = Schema.decodeUnknownSync(UnlockedAchievement)({
  id: "first-song",
  name: "First Song",
  description: "First song",
  icon: "music",
  category: "song_request",
  unlockedAt: "2026-01-01T00:00:00.000Z",
});
const definition = Schema.decodeUnknownSync(AchievementDefinition)({
  id: "first-song",
  name: "First Song",
  description: "First song",
  icon: "music",
  category: "song_request",
  threshold: null,
  triggerEvent: "song_request",
  scope: "cumulative",
});
const raffleWinner = Schema.decodeUnknownSync(RaffleLeaderboardEntry)({
  userId: "viewer-1",
  displayName: "Viewer",
  totalRolls: 10,
  totalWins: 2,
  closestDistance: 3,
  closestRoll: 100,
  closestWinningNumber: 103,
  lastRolledAt: "2026-01-01T00:00:00.000Z",
});
interface TestObservations {
  readonly playback: Ref.Ref<NowPlaying>;
  readonly tracks: Ref.Ref<readonly QueuedTrack[]>;
  readonly unlocks: Ref.Ref<readonly UnlockedAchievement[]>;
  readonly raffleEntries: Ref.Ref<readonly RaffleLeaderboardEntry[]>;
  readonly songCount: Ref.Ref<number>;
  readonly failedProviders: Ref.Ref<readonly ("song" | "raffle" | "achievements")[]>;
  readonly metrics: Ref.Ref<readonly ChatCommandMetric[]>;
  readonly lookups: Ref.Ref<readonly string[]>;
}
class CommandTestObservations extends Context.Service<CommandTestObservations, TestObservations>()(
  "CommandTestObservations",
) {}
// Local provider read implementations exercise the real service interfaces. Unused writes fail loudly.
const providerTestLayer = Layer.unwrap(
  Effect.gen(function* () {
    const playback = yield* Ref.make<NowPlaying>({ track: Option.none(), position: 0 });
    const tracks = yield* Ref.make<readonly QueuedTrack[]>([]);
    const unlocks = yield* Ref.make<readonly UnlockedAchievement[]>([]);
    const raffleEntries = yield* Ref.make<readonly RaffleLeaderboardEntry[]>([]);
    const songCount = yield* Ref.make(0);
    const failedProviders = yield* Ref.make<readonly ("song" | "raffle" | "achievements")[]>([]);
    const metrics = yield* Ref.make<readonly ChatCommandMetric[]>([]);
    const lookups = yield* Ref.make<readonly string[]>([]);
    const songFailure = Effect.gen(function* () {
      if ((yield* Ref.get(failedProviders)).includes("song"))
        return yield* new SongQueueError({
          operation: "command lookup",
          reason: "provider_unavailable",
        });
    });
    const raffleFailure = Effect.gen(function* () {
      if ((yield* Ref.get(failedProviders)).includes("raffle"))
        return yield* new RaffleError({
          operation: "command lookup",
          reason: "transport_unavailable",
        });
    });
    const achievementFailure = Effect.gen(function* () {
      if ((yield* Ref.get(failedProviders)).includes("achievements"))
        return yield* new AchievementError({
          operation: "command lookup",
          reason: "transport_unavailable",
        });
    });
    return Layer.mergeAll(
      Layer.succeed(CommandTestObservations, {
        playback,
        tracks,
        unlocks,
        raffleEntries,
        songCount,
        failedProviders,
        metrics,
        lookups,
      }),
      Layer.mock(TwitchAnalytics, {
        writeChatCommandMetric: (metric) => Ref.update(metrics, (items) => [...items, metric]),
      }),
      Layer.mock(SongQueue, {
        getCurrentlyPlaying: () => songFailure.pipe(Effect.andThen(Ref.get(playback))),
        getSongQueue: ({ limit }) =>
          songFailure.pipe(
            Effect.andThen(Ref.get(tracks)),
            Effect.map((items) => ({ tracks: items.slice(0, limit), totalCount: items.length })),
          ),
        getUserRequestCount: ({ userId }) =>
          songFailure.pipe(
            Effect.andThen(Ref.update(lookups, (items) => [...items, `song-id:${userId}`])),
            Effect.andThen(Ref.get(songCount)),
          ),
        getUserRequestCountByDisplayName: ({ displayName }) =>
          songFailure.pipe(
            Effect.andThen(Ref.update(lookups, (items) => [...items, `song-name:${displayName}`])),
            Effect.andThen(Ref.get(songCount)),
          ),
      }),
      Layer.mock(Achievements, {
        getDefinitions: () => achievementFailure.pipe(Effect.as([definition])),
        getUnlockedAchievements: ({ userDisplayName }) =>
          achievementFailure.pipe(
            Effect.andThen(
              Ref.update(lookups, (items) => [...items, `achievements:${userDisplayName}`]),
            ),
            Effect.andThen(Ref.get(unlocks)),
          ),
      }),
      Layer.mock(Raffle, {
        getLeaderboard: ({ limit }) =>
          raffleFailure.pipe(
            Effect.andThen(Ref.get(raffleEntries)),
            Effect.map((items) =>
              items.slice(
                0,
                Option.getOrElse(limit, () => 10),
              ),
            ),
          ),
        getUserStats: ({ userId }) =>
          raffleFailure.pipe(
            Effect.andThen(Ref.update(lookups, (items) => [...items, `raffle-id:${userId}`])),
            Effect.andThen(Ref.get(raffleEntries)),
            Effect.map((items) => Option.fromNullishOr(items[0])),
          ),
        getUserStatsByDisplayName: ({ displayName }) =>
          raffleFailure.pipe(
            Effect.andThen(
              Ref.update(lookups, (items) => [...items, `raffle-name:${displayName}`]),
            ),
            Effect.andThen(Ref.get(raffleEntries)),
            Effect.map((items) => Option.fromNullishOr(items[0])),
          ),
      }),
    );
  }),
);
const testLayer = executorLayerWithoutDependencies.pipe(
  Layer.provideMerge(computedChatCommandsLayerWithoutDependencies),
  Layer.provideMerge(
    commandsDatabaseLayerWithoutDependencies.pipe(
      Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
  ),
  Layer.provideMerge(providerTestLayer),
);
const response = Effect.fn("CommandTest.response")(function* (
  text: string,
  permission: ChatCommandPermission = "everyone",
  messageId = "message-1",
) {
  const executor = yield* ChatCommandExecutor;
  const result = yield* executor.prepare(input(text, permission, messageId));
  expect(result._tag).toBe("ChatCommandPrepared");
  return result._tag === "ChatCommandPrepared"
    ? Option.getOrElse(result.message, () => "")
    : "ignored";
});

describe("Chat command preparation through real registry and executor", () => {
  it.effect(
    "ignores noncommands, unknown, disabled and unauthorized commands without preparing output",
    () =>
      Effect.gen(function* () {
        const executor = yield* ChatCommandExecutor;
        const commands = yield* Commands;
        const observations = yield* CommandTestObservations;
        expect(yield* executor.prepare(input("hello"))).toMatchObject({
          _tag: "ChatCommandIgnored",
          reason: "not_command",
        });
        expect(yield* executor.prepare(input("!"))).toMatchObject({ reason: "not_command" });
        expect(yield* executor.prepare(input("!unknown"))).toMatchObject({
          reason: "unknown_command",
        });
        yield* commands.updateCommand({ name: name("time"), patch: { enabled: false } });
        expect(yield* executor.prepare(input("!time"))).toMatchObject({ reason: "disabled" });
        expect(yield* executor.prepare(input("!skillissue"))).toMatchObject({
          reason: "permission_denied",
        });
        expect((yield* Ref.get(observations.metrics)).map((metric) => metric.status)).toEqual([
          "ignored",
          "ignored",
          "ignored",
        ]);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "preserves case-insensitive parsing, aliases, shared values, templates and empty response behavior",
    () =>
      Effect.gen(function* () {
        expect(yield* response("  !DF  ")).toContain("My dotfiles can be found here:");
        expect(yield* response("!today")).toBe("No topic set for today.");
        expect(yield* response("!update TODAY Writing   Effect code", "moderator")).toBe(
          "Updated !today",
        );
        expect(yield* response("!project")).toBe("Working on: Writing Effect code");
        expect(yield* response("!functor")).toBe("Functor? I hardly know her!");
        expect(yield* response("!lurk")).toMatch(
          /^Viewer is here but they are Lurking! Thank you for watching! (PogChamp|Kappa|LUL|SeemsGood|HeyGuys)$/,
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "preserves dynamic update usage, privilege tiers and idempotent mutation responses",
    () =>
      Effect.gen(function* () {
        expect(yield* response("!update", "vip")).toBe("Usage: !update <command> <value>");
        expect(yield* response("!update today", "vip")).toBe("Usage: !update today <value>");
        expect(yield* response("!update today nope", "vip")).toBe(
          "Only moderators can update !today.",
        );
        expect(yield* response("!update keyboard nope", "moderator")).toBe(
          "!keyboard is not updateable.",
        );
        expect(yield* response("!update leak new", "vip")).toBe("Updated !leak");
        expect(yield* response("!update leak new", "vip")).toBe("Updated !leak");
        expect(yield* response("!update leak different", "vip")).toBe(
          "Sorry, couldn't update the command.",
        );
        const commands = yield* Commands;
        yield* commands.updateCommand({
          name: name("today"),
          patch: { writePermission: "broadcaster" },
        });
        expect(yield* response("!update today blocked", "moderator", "new-id")).toBe(
          "Only the broadcaster can update !today.",
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "deduplicates skill issue responses by message identity and counts distinct messages",
    () =>
      Effect.gen(function* () {
        expect(yield* response("!skillissue", "vip")).toBe("@dillon has 1 SkillIssue so far");
        expect(yield* response("!skillissue", "vip")).toBe("@dillon has 1 SkillIssue so far");
        expect(yield* response("!skillissue", "broadcaster", "message-2")).toBe(
          "@dillon has 2 SkillIssue so far",
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "uses runtime handler definitions and missing-handler fallback, not invocation-name dispatch",
    () =>
      Effect.gen(function* () {
        const commands = yield* Commands;
        yield* commands.createCommand(
          Schema.decodeUnknownSync(CreateChatCommandInput)({
            name: "custom-time",
            description: "Runtime time",
            category: "info",
            permission: "everyone",
            responseType: "computed",
            handlerKey: "time",
          }),
        );
        yield* TestClock.setTime(Date.parse("2026-01-01T05:00:00Z"));
        expect(yield* response("!custom-time")).toBe("Current time is: 12:00:00 AM EST");
        yield* TestClock.setTime(Date.parse("2026-07-01T04:00:00Z"));
        expect(yield* response("!time")).toBe("Current time is: 12:00:00 AM EDT");
        yield* commands.updateCommand({
          name: name("custom-time"),
          patch: { handlerKey: "unregistered" },
        });
        expect(yield* response("!custom-time")).toBe(
          "!custom-time is configured but has no live handler.",
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "lists enabled commands in original permission groups and excludes alias duplicates",
    () =>
      Effect.gen(function* () {
        const everyone = yield* response("!commands");
        expect(everyone).toContain("Commands: !keyboard !socials");
        expect(everyone).not.toContain("!df");
        expect(everyone).not.toContain("!skillissue");
        expect(yield* response("!commands", "vip")).toContain("VIP: !update !skillissue");
        const commands = yield* Commands;
        yield* commands.updateCommand({ name: name("keyboard"), patch: { enabled: false } });
        expect(yield* response("!commands")).not.toContain("!keyboard");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "reports current song attribution, autoplay, empty playback and provider fallback",
    () =>
      Effect.gen(function* () {
        const observations = yield* CommandTestObservations;
        expect(yield* response("!song https://open.spotify.com/track/Track1")).toBe(
          "No track currently playing.",
        );
        yield* Ref.set(observations.playback, {
          track: Option.some(track),
          position: 0,
        } satisfies NowPlaying);
        expect(yield* response("!song")).toBe(
          'Now playing: "A Song" by Artist, Guest - requested by @Requester',
        );
        yield* Ref.set(observations.playback, {
          track: Option.some(autoplay),
          position: 0,
        } satisfies NowPlaying);
        expect(yield* response("!song")).toBe('Now playing: "Autoplay" by Artist');
        yield* Ref.set(observations.failedProviders, ["song"]);
        expect(yield* response("!song")).toBe("Sorry, couldn't get the current song info.");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "limits queue to four with requester attribution and never requests a Spotify mutation",
    () =>
      Effect.gen(function* () {
        const observations = yield* CommandTestObservations;
        expect(yield* response("!queue")).toBe("Queue is empty.");
        yield* Ref.set(observations.tracks, [track, autoplay, autoplay, autoplay, track]);
        const message = yield* response("!queue");
        expect(message).toContain('1. "A Song" by Artist, Guest (@Requester)');
        expect(message).toContain('4. "Autoplay" by Artist');
        expect(message).not.toContain("5.");
        yield* Ref.set(observations.failedProviders, ["song"]);
        expect(yield* response("!queue")).toBe("Sorry, couldn't get the queue info.");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "renders achievement singular/plural, empty lookup, target selection and provider fallback",
    () =>
      Effect.gen(function* () {
        const observations = yield* CommandTestObservations;
        expect(yield* response("!achievements")).toBe(
          "@Viewer hasn't unlocked any achievements yet.",
        );
        yield* Ref.set(observations.unlocks, [unlocked]);
        expect(yield* response("!achievements OtherUser")).toBe(
          "@OtherUser has unlocked 1 achievement: First Song",
        );
        yield* Ref.set(observations.unlocks, [unlocked, { ...unlocked, name: "Second Song" }]);
        expect(yield* response("!achievements")).toContain(
          "2 achievements: First Song, Second Song",
        );
        yield* Ref.set(observations.failedProviders, ["achievements"]);
        expect(yield* response("!achievements OtherUser")).toBe(
          "Sorry, couldn't retrieve achievements for @OtherUser.",
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("renders combined stats with ID-based self lookup and name-based target lookup", () =>
    Effect.gen(function* () {
      const observations = yield* CommandTestObservations;
      expect(yield* response("!stats")).toBe(
        "@Viewer — Songs: 0 | Achievements: 0/1 | Raffles: 0 rolls",
      );
      expect(yield* response("!stats Unknown")).toBe(
        "No records found for @Unknown yet — no songs, achievements, or raffle stats.",
      );
      yield* Ref.set(observations.songCount, 12);
      yield* Ref.set(observations.unlocks, [unlocked]);
      yield* Ref.set(observations.raffleEntries, [raffleWinner]);
      expect(yield* response("!stats")).toBe(
        "@Viewer — Songs: 12 | Achievements: 1/1 | Raffles: 10 rolls (closest: 3, 2 wins!)",
      );
      expect(yield* Ref.get(observations.lookups)).toContain("song-id:viewer-1");
      expect(yield* Ref.get(observations.lookups)).toContain("raffle-name:Unknown");
      yield* Ref.set(observations.failedProviders, ["achievements"]);
      expect(yield* response("!stats")).toContain("Achievements: ?/?");
      const executor = yield* ChatCommandExecutor;
      yield* Ref.set(observations.failedProviders, ["song"]);
      expect(yield* executor.prepare(input("!stats")).pipe(Effect.result)).toMatchObject({
        failure: {
          _tag: "ChatCommandExecutionError",
          commandName: "stats",
        },
      });
      yield* Ref.set(observations.failedProviders, ["raffle"]);
      expect(yield* executor.prepare(input("!stats")).pipe(Effect.result)).toMatchObject({
        failure: {
          _tag: "ChatCommandExecutionError",
          commandName: "stats",
        },
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("distinguishes no raffle rolls, no winners, ranked winners and provider failure", () =>
    Effect.gen(function* () {
      const observations = yield* CommandTestObservations;
      expect(yield* response("!raffle-leaderboard")).toBe("No raffle rolls recorded yet.");
      yield* Ref.set(observations.raffleEntries, [{ ...raffleWinner, totalWins: 0 }]);
      expect(yield* response("!raffle-leaderboard")).toBe("No raffle winners yet — be the first!");
      yield* Ref.set(observations.raffleEntries, [
        raffleWinner,
        { ...raffleWinner, displayName: "Other", totalWins: 1 },
      ]);
      expect(yield* response("!raffle-leaderboard")).toBe(
        "Raffle wins: 1. @Viewer (2) 2. @Other (1)",
      );
      yield* Ref.set(observations.failedProviders, ["raffle"]);
      expect(yield* response("!raffle-leaderboard")).toBe(
        "Sorry, couldn't retrieve the raffle leaderboard.",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "accepts exactly 500 Unicode code points, rejects 501 after template expansion, and records only preparation errors",
    () =>
      Effect.gen(function* () {
        const commands = yield* Commands;
        const executor = yield* ChatCommandExecutor;
        const observations = yield* CommandTestObservations;
        yield* commands.createCommand(
          Schema.decodeUnknownSync(CreateChatCommandInput)({
            name: "unicode",
            description: "Unicode",
            category: "meta",
            permission: "everyone",
            responseType: "dynamic",
            initialValue: "😀".repeat(500),
          }),
        );
        expect(Array.from(yield* response("!unicode")).length).toBe(500);
        yield* commands.updateCommand({
          name: name("unicode"),
          patch: { outputTemplate: "x{value}" },
        });
        expect(yield* executor.prepare(input("!unicode")).pipe(Effect.result)).toMatchObject({
          failure: { _tag: "ChatCommandRenderError" },
        });
        expect((yield* Ref.get(observations.metrics)).map((metric) => metric.status)).toEqual([
          "error",
        ]);
        yield* Ref.set(observations.playback, {
          track: Option.some({ ...track, name: "x".repeat(501) }),
          position: 0,
        } satisfies NowPlaying);
        expect(yield* executor.prepare(input("!song")).pipe(Effect.result)).toMatchObject({
          failure: { _tag: "ChatCommandRenderError" },
        });
        // Successful preparation has no success metric: the receipt owner must first confirm delivery.
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "checks the output length invariant for generated Unicode values through the executor",
    () =>
      Effect.gen(function* () {
        const commands = yield* Commands;
        const executor = yield* ChatCommandExecutor;
        yield* commands.createCommand(
          Schema.decodeUnknownSync(CreateChatCommandInput)({
            name: "generated",
            description: "Generated",
            category: "meta",
            permission: "everyone",
            responseType: "dynamic",
          }),
        );
        const samples = FastCheck.sample(
          FastCheck.tuple(
            FastCheck.constantFrom("a", "😀", "🎉", "é", "中"),
            FastCheck.integer({ min: 495, max: 505 }),
          ),
          { seed: 2026, numRuns: 30 },
        );
        for (const [point, length] of samples) {
          yield* commands.updateCommandValue({
            name: name("generated"),
            value: point.repeat(length),
            actor: { displayName: "Mod", permission: "moderator" },
            operationId: Option.none(),
          });
          const result = yield* executor.prepare(input("!generated")).pipe(Effect.result);
          expect(result._tag).toBe(length > 500 ? "Failure" : "Success");
        }
      }).pipe(Effect.provide(testLayer)),
  );
});

describe("Chat badge permission hierarchy", () => {
  it.effect(
    "selects the maximum tier independent of badge order and ignores subscription badges",
    () =>
      Effect.sync(() => {
        FastCheck.assert(
          FastCheck.property(
            FastCheck.array(
              FastCheck.constantFrom(
                "broadcaster",
                "moderator",
                "vip",
                "subscriber",
                "founder",
                "bits",
              ),
            ),
            (badges) => {
              const expected = badges.includes("broadcaster")
                ? "broadcaster"
                : badges.includes("moderator")
                  ? "moderator"
                  : badges.includes("vip")
                    ? "vip"
                    : "everyone";
              expect(getChatCommandPermission(badges.map((set_id) => ({ set_id })))).toBe(expected);
              expect(
                getChatCommandPermission([...badges].reverse().map((set_id) => ({ set_id }))),
              ).toBe(expected);
              expect(hasCommandPermission(expected, "everyone")).toBe(true);
            },
          ),
        );
        expect(hasCommandPermission("vip", "moderator")).toBe(false);
        expect(hasCommandPermission("broadcaster", "moderator")).toBe(true);
      }),
  );
});
