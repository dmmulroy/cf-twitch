import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Data,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  PlatformError,
  Predicate,
  Schema,
} from "effect";
import { Digest } from "effect/crypto";
import { EventId, IsoTimestamp, StreamId } from "@cf-twitch/contracts/identity";
import {
  acceptOfflineTransition,
  acceptOnlineTransition,
  clearCompletedTransition,
  completeTransitionEffect,
  decodePersistedStreamState,
  deriveStreamLifecycleEventId,
  initialStreamState,
  OfflineStreamState,
  type PersistedStreamState,
} from "./stream-state.ts";

const eventId = Schema.decodeUnknownSync(EventId)("550e8400-e29b-41d4-a716-446655440002");

const offlineEventId = Schema.decodeUnknownSync(EventId)("550e8400-e29b-41d4-a716-446655440003");

const streamId = Schema.decodeUnknownSync(StreamId)("stream-123");

const at = (value: string) => Schema.decodeUnknownSync(IsoTimestamp)(value);

const startedAt = at("2026-01-30T11:55:00.000Z");

const endedAt = at("2026-01-30T14:00:00.000Z");

type TestSystemErrorReason = Data.TaggedEnum<{
  readonly Unknown: { readonly module: string; readonly method: string };
}>;

const TestSystemErrorReason = Data.taggedEnum<TestSystemErrorReason>();

type TestLegacyTransitionIntent = Data.TaggedEnum<{
  readonly StreamOnlineIntent: {
    readonly eventId: EventId;
    readonly streamSessionId: StreamId;
    readonly transitionAt: IsoTimestamp;
    readonly viewerPollScheduleId: string | null;
    readonly spotifyTokenNotified: boolean;
    readonly twitchTokenNotified: boolean;
    readonly lifecycleEventPublished: boolean;
    readonly viewerPollingUpdated: boolean;
  };
}>;

const TestLegacyTransitionIntent = Data.taggedEnum<TestLegacyTransitionIntent>();

type TestLegacyStreamState = Data.TaggedEnum<{
  readonly OfflineStream: {
    readonly lastStartedAt: IsoTimestamp;
    readonly endedAt: IsoTimestamp;
    readonly peakViewerCount: number;
    readonly transitionIntent: TestLegacyTransitionIntent;
  };
  readonly LiveStream: {
    readonly streamSessionId: StreamId;
    readonly startedAt: IsoTimestamp;
    readonly peakViewerCount: number;
    readonly viewerPollScheduleId: string | null;
    readonly transitionIntent: TestLegacyTransitionIntent;
  };
}>;

const TestLegacyStreamState = Data.taggedEnum<TestLegacyStreamState>();

describe("Stream Lifecycle state", () => {
  it.effect("derives the stable lifecycle event identity from transition evidence", () =>
    Effect.gen(function* () {
      const input = { transition: "online" as const, streamId, transitionAt: startedAt };
      const first = yield* deriveStreamLifecycleEventId(input);
      const replay = yield* deriveStreamLifecycleEventId(input);

      expect(first).toBe("06176228-d63d-5885-8eef-7f0e1be5c6dc");
      expect(replay).toBe(first);
      expect(() => Schema.decodeUnknownSync(EventId)(first)).not.toThrow();
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("keeps digest failures as defects and digest work interruptible", () =>
    Effect.gen(function* () {
      const input = { transition: "online" as const, streamId, transitionAt: startedAt };

      const cryptoFailure = PlatformError.systemError(
        TestSystemErrorReason.Unknown({
          module: "TestCrypto",
          method: "digest",
        }),
      );

      const failingDigest = Layer.succeed(
        Digest.Digest,
        Digest.Digest.of({
          digest: () => Effect.die(cryptoFailure),
          digestHex: () => Effect.die(cryptoFailure),
        }),
      );

      const failed = yield* deriveStreamLifecycleEventId(input).pipe(
        Effect.provide(failingDigest),
        Effect.exit,
      );

      expect(Exit.isFailure(failed)).toBe(true);

      if (Exit.isFailure(failed)) {
        expect(Cause.hasDies(failed.cause)).toBe(true);
      }

      const suspendedDigest = Layer.succeed(
        Digest.Digest,
        Digest.Digest.of({
          digest: () => Effect.never,
          digestHex: () => Effect.never,
        }),
      );

      const fiber = yield* Effect.forkChild(
        deriveStreamLifecycleEventId(input).pipe(Effect.provide(suspendedDigest)),
      );

      yield* Fiber.interrupt(fiber);

      const interrupted = yield* Fiber.await(fiber);

      expect(Exit.isFailure(interrupted)).toBe(true);

      if (Exit.isFailure(interrupted)) {
        expect(Cause.hasInterrupts(interrupted.cause)).toBe(true);
      }
    }),
  );

  it("accepts authoritative online source time with all four checkpoints incomplete", () => {
    const state = acceptOnlineTransition(initialStreamState(), { eventId, streamId, startedAt });

    expect(state._tag).toBe("LiveStream");
    expect(state).toMatchObject({ streamId, startedAt });
    expect(Option.getOrThrow(state.transitionCheckpoint)).toMatchObject({
      eventId,
      streamId,
      transition: "online",
      transitionAt: startedAt,
      spotifyTokenNotified: false,
      twitchTokenNotified: false,
      lifecycleEventPublished: false,
      viewerPollingUpdated: false,
    });
  });

  it("ignores duplicate and stale online evidence without replacing pending checkpoints", () => {
    const accepted = acceptOnlineTransition(initialStreamState(), { eventId, streamId, startedAt });

    expect(acceptOnlineTransition(accepted, { eventId, streamId, startedAt })).toBe(accepted);
    expect(
      acceptOnlineTransition(accepted, {
        eventId,
        streamId,
        startedAt: at("2026-01-30T11:54:59.999Z"),
      }),
    ).toBe(accepted);
  });

  it("carries session and polling evidence into one offline transition checkpoint", () => {
    const online = acceptOnlineTransition(initialStreamState(), { eventId, streamId, startedAt });

    if (!Predicate.isTagged("LiveStream")(online)) throw new Error("expected live state");
    const withSchedule = { ...online, viewerPollScheduleId: Option.some("viewer-poll-1") };

    const offline = acceptOfflineTransition(withSchedule, { eventId: offlineEventId, endedAt });

    expect(offline._tag).toBe("OfflineStream");
    expect(offline).toMatchObject({
      lastStartedAt: Option.some(startedAt),
      endedAt: Option.some(endedAt),
    });
    expect(Option.getOrThrow(offline.transitionCheckpoint)).toMatchObject({
      eventId: offlineEventId,
      streamId,
      transition: "offline",
      viewerPollScheduleId: Option.some("viewer-poll-1"),
    });
  });

  it("orders lifecycle evidence by instant while retaining source timestamp strings", () => {
    const offsetStartedAt = at("2026-01-30T12:00:00+02:00");

    const laterEndedAt = at("2026-01-30T11:00:00Z");

    const online = acceptOnlineTransition(initialStreamState(), {
      eventId,
      streamId,
      startedAt: offsetStartedAt,
    });

    const offline = acceptOfflineTransition(online, {
      eventId: offlineEventId,
      endedAt: laterEndedAt,
    });

    expect(offline._tag).toBe("OfflineStream");
    expect(offline).toMatchObject({
      lastStartedAt: Option.some(offsetStartedAt),
      endedAt: Option.some(laterEndedAt),
    });
    expect(Option.getOrThrow(offline.transitionCheckpoint)).toMatchObject({
      transitionAt: laterEndedAt,
    });
  });

  it("orders different fractional-second precision by instant", () => {
    const earlier = at("2026-01-30T12:00:00.10Z");

    const later = at("2026-01-30T12:00:00.9Z");

    const online = acceptOnlineTransition(initialStreamState(), {
      eventId,
      streamId,
      startedAt: earlier,
    });

    const offline = acceptOfflineTransition(online, { eventId: offlineEventId, endedAt: later });

    expect(offline._tag).toBe("OfflineStream");
    expect(offline).toMatchObject({ endedAt: Option.some(later) });
  });

  it("orders arbitrary sub-millisecond fractions without normalizing source timestamps", () => {
    const earlier = at("2026-01-30T10:00:00.1234Z");
    const later = at("2026-01-30T10:00:00.1235Z");

    const earlierOnline = acceptOnlineTransition(initialStreamState(), {
      eventId,
      streamId,
      startedAt: earlier,
    });

    const offline = acceptOfflineTransition(earlierOnline, {
      eventId: offlineEventId,
      endedAt: later,
    });

    expect(offline._tag).toBe("OfflineStream");
    expect(offline).toMatchObject({ endedAt: Option.some(later) });

    const laterOnline = acceptOnlineTransition(initialStreamState(), {
      eventId,
      streamId,
      startedAt: later,
    });

    expect(
      acceptOfflineTransition(laterOnline, { eventId: offlineEventId, endedAt: earlier }),
    ).toBe(laterOnline);
  });

  it("preserves distinct online and offline equality policies across offsets", () => {
    const offsetStartedAt = at("2026-01-30T12:00:00.123500+02:00");

    const sameInstantAtUtc = at("2026-01-30T10:00:00.1235Z");

    const online = acceptOnlineTransition(initialStreamState(), {
      eventId,
      streamId,
      startedAt: offsetStartedAt,
    });

    expect(
      acceptOnlineTransition(online, {
        eventId: offlineEventId,
        streamId,
        startedAt: sameInstantAtUtc,
      }),
    ).toBe(online);

    const offline = acceptOfflineTransition(online, {
      eventId: offlineEventId,
      endedAt: sameInstantAtUtc,
    });

    expect(offline._tag).toBe("OfflineStream");
    expect(offline).toMatchObject({ endedAt: Option.some(sameInstantAtUtc) });
  });

  it("uses either exact offline watermark when fractions share one millisecond", () => {
    const candidate = at("2026-01-30T10:00:00.12345Z");

    const laterStart: PersistedStreamState = OfflineStreamState.make({
      peakViewerCount: 0,
      transitionCheckpoint: Option.none(),
      lastStartedAt: Option.some(at("2026-01-30T10:00:00.1235Z")),
      endedAt: Option.some(at("2026-01-30T10:00:00.1234Z")),
    });

    const laterEnd: PersistedStreamState = OfflineStreamState.make({
      peakViewerCount: 0,
      transitionCheckpoint: Option.none(),
      lastStartedAt: Option.some(at("2026-01-30T10:00:00.1234Z")),
      endedAt: Option.some(at("2026-01-30T10:00:00.1235Z")),
    });

    expect(acceptOnlineTransition(laterStart, { eventId, streamId, startedAt: candidate })).toBe(
      laterStart,
    );
    expect(acceptOnlineTransition(laterEnd, { eventId, streamId, startedAt: candidate })).toBe(
      laterEnd,
    );
  });

  it("uses the latest offline watermark across timestamp representations", () => {
    const online = acceptOnlineTransition(initialStreamState(), {
      eventId,
      streamId,
      startedAt: at("2026-01-30T12:00:00+02:00"),
    });

    const offline = acceptOfflineTransition(online, {
      eventId: offlineEventId,
      endedAt: at("2026-01-30T10:30:00Z"),
    });

    expect(
      acceptOnlineTransition(offline, {
        eventId,
        streamId,
        startedAt: at("2026-01-30T12:15:00+02:00"),
      }),
    ).toBe(offline);
  });

  it("does not clear partial effect evidence", () => {
    const accepted = acceptOnlineTransition(initialStreamState(), { eventId, streamId, startedAt });
    const partial = completeTransitionEffect(accepted, eventId, "spotifyTokenNotified");

    expect(clearCompletedTransition(partial)).toBe(partial);
  });

  it("clears effect evidence only after all four checkpoints complete", () => {
    const accepted = acceptOnlineTransition(initialStreamState(), { eventId, streamId, startedAt });

    const effects: ReadonlyArray<Parameters<typeof completeTransitionEffect>[2]> = [
      "spotifyTokenNotified",
      "twitchTokenNotified",
      "lifecycleEventPublished",
      "viewerPollingUpdated",
    ];

    const completed = effects.reduce(
      (state, effect) => completeTransitionEffect(state, eventId, effect),
      accepted,
    );

    expect(Option.isNone(clearCompletedTransition(completed).transitionCheckpoint)).toBe(true);
  });

  it.effect("decodes historical tagged Agent state without losing a partial intent", () =>
    Effect.gen(function* () {
      const decoded = yield* decodePersistedStreamState(
        TestLegacyStreamState.LiveStream({
          streamSessionId: streamId,
          startedAt,
          peakViewerCount: 41,
          viewerPollScheduleId: "viewer-poll-1",
          transitionIntent: TestLegacyTransitionIntent.StreamOnlineIntent({
            eventId,
            streamSessionId: streamId,
            transitionAt: startedAt,
            viewerPollScheduleId: null,
            spotifyTokenNotified: true,
            twitchTokenNotified: false,
            lifecycleEventPublished: false,
            viewerPollingUpdated: false,
          }),
        }),
      );

      expect(Option.getOrThrow(decoded.transitionCheckpoint)).toMatchObject({
        eventId,
        spotifyTokenNotified: true,
        twitchTokenNotified: false,
      });
    }),
  );

  it.effect("fails closed on corrupt historical Agent state", () =>
    Effect.gen(function* () {
      const result = yield* decodePersistedStreamState({
        isLive: true,
        startedAt: null,
        streamSessionId: null,
      }).pipe(Effect.result);

      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("rejects a historical online intent stored on an offline state", () =>
    Effect.gen(function* () {
      const result = yield* decodePersistedStreamState(
        TestLegacyStreamState.OfflineStream({
          lastStartedAt: startedAt,
          endedAt,
          peakViewerCount: 3,
          transitionIntent: TestLegacyTransitionIntent.StreamOnlineIntent({
            eventId,
            streamSessionId: streamId,
            transitionAt: startedAt,
            viewerPollScheduleId: null,
            spotifyTokenNotified: false,
            twitchTokenNotified: false,
            lifecycleEventPublished: false,
            viewerPollingUpdated: false,
          }),
        }),
      ).pipe(Effect.flip);

      expect({ operation: result.operation, reason: result.reason }).toEqual({
        operation: "migrateLegacyState",
        reason: "stored_state_invalid",
      });
    }),
  );
});
