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
  acceptSupersedingSession,
  clearCompletedTransition,
  completeTransitionEffect,
  decodePersistedStreamState,
  deriveStreamLifecycleEventId,
  initialStreamState,
  LiveStreamState,
  OfflineStreamState,
  PersistedStreamState,
} from "./stream-state.ts";

const eventId = Schema.decodeUnknownSync(EventId)("550e8400-e29b-41d4-a716-446655440002");

const offlineEventId = Schema.decodeUnknownSync(EventId)("550e8400-e29b-41d4-a716-446655440003");

const streamId = Schema.decodeUnknownSync(StreamId)("stream-123");

const nextStreamId = Schema.decodeUnknownSync(StreamId)("stream-456");

const transitionEffects = [
  "spotifyTokenNotified",
  "twitchTokenNotified",
  "lifecycleEventPublished",
  "viewerPollingUpdated",
] as const;

/** Completes and clears the pending checkpoint, as the lifecycle does after running its effects. */
const clearCompletedTransitionForTest = (state: PersistedStreamState): PersistedStreamState =>
  Option.match(state.transitionCheckpoint, {
    onNone: () => state,
    onSome: (checkpoint) =>
      clearCompletedTransition(
        transitionEffects.reduce(
          (current, effect) => completeTransitionEffect(current, checkpoint.eventId, effect),
          state,
        ),
      ),
  });

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

  it("orders online evidence by the previous session start at sub-millisecond precision", () => {
    const candidate = at("2026-01-30T10:00:00.12345Z");

    const laterStart: PersistedStreamState = OfflineStreamState.make({
      peakViewerCount: 0,
      transitionCheckpoint: Option.none(),
      lastStartedAt: Option.some(at("2026-01-30T10:00:00.1235Z")),
      endedAt: Option.some(at("2026-01-30T10:00:00.1234Z")),
      supersedingStreamId: Option.none(),
    });

    const earlierStart: PersistedStreamState = OfflineStreamState.make({
      peakViewerCount: 0,
      transitionCheckpoint: Option.none(),
      lastStartedAt: Option.some(at("2026-01-30T10:00:00.1234Z")),
      endedAt: Option.some(at("2026-01-30T10:00:00.1235Z")),
      supersedingStreamId: Option.none(),
    });

    expect(acceptOnlineTransition(laterStart, { eventId, streamId, startedAt: candidate })).toBe(
      laterStart,
    );

    const accepted = acceptOnlineTransition(earlierStart, {
      eventId,
      streamId,
      startedAt: candidate,
    });

    expect(accepted._tag).toBe("LiveStream");
    expect(accepted).toMatchObject({ startedAt: candidate });
  });

  it("falls back to the offline time when no session start was recorded", () => {
    const legacy: PersistedStreamState = OfflineStreamState.make({
      peakViewerCount: 0,
      transitionCheckpoint: Option.none(),
      lastStartedAt: Option.none(),
      endedAt: Option.some(at("2026-01-30T10:30:00Z")),
      supersedingStreamId: Option.none(),
    });

    expect(
      acceptOnlineTransition(legacy, { eventId, streamId, startedAt: at("2026-01-30T10:15:00Z") }),
    ).toBe(legacy);
  });

  it("accepts a broadcast that started before the previous offline notification arrived", () => {
    const online = acceptOnlineTransition(initialStreamState(), {
      eventId,
      streamId,
      startedAt: at("2026-01-30T12:00:00+02:00"),
    });

    const offline = clearCompletedTransitionForTest(
      acceptOfflineTransition(clearCompletedTransitionForTest(online), {
        eventId: offlineEventId,
        endedAt: at("2026-01-30T10:30:00Z"),
      }),
    );

    const restarted = acceptOnlineTransition(offline, {
      eventId,
      streamId: nextStreamId,
      startedAt: at("2026-01-30T12:15:00+02:00"),
    });

    expect(restarted._tag).toBe("LiveStream");
    expect(restarted).toMatchObject({
      streamId: nextStreamId,
      startedAt: at("2026-01-30T12:15:00+02:00"),
      supersededStartedAt: Option.none(),
    });
    expect(
      acceptOnlineTransition(offline, {
        eventId,
        streamId,
        startedAt: at("2026-01-30T12:00:00+02:00"),
      }),
    ).toBe(offline);
  });

  it("ends a live session superseded by a newer stream and ignores its late offline notification", () => {
    const first = clearCompletedTransitionForTest(
      acceptOnlineTransition(initialStreamState(), { eventId, streamId, startedAt }),
    );

    const restartedAt = at("2026-01-30T13:07:21Z");
    const supersede = { eventId: offlineEventId, streamId: nextStreamId, startedAt: restartedAt };

    expect(acceptSupersedingSession(first, { ...supersede, streamId })).toBe(first);
    expect(acceptSupersedingSession(first, { ...supersede, startedAt })).toBe(first);

    const ended = acceptSupersedingSession(first, supersede);

    expect(ended._tag).toBe("OfflineStream");
    expect(ended).toMatchObject({
      lastStartedAt: Option.some(startedAt),
      endedAt: Option.some(restartedAt),
      supersedingStreamId: Option.some(nextStreamId),
    });
    expect(Option.getOrThrow(ended.transitionCheckpoint)).toMatchObject({
      eventId: offlineEventId,
      streamId,
      transition: "offline",
      transitionAt: restartedAt,
    });

    const live = clearCompletedTransitionForTest(
      acceptOnlineTransition(clearCompletedTransitionForTest(ended), {
        eventId,
        streamId: nextStreamId,
        startedAt: restartedAt,
      }),
    );

    expect(live._tag).toBe("LiveStream");
    expect(live).toMatchObject({
      streamId: nextStreamId,
      startedAt: restartedAt,
      supersededStartedAt: Option.some(startedAt),
    });

    const lateOffline = acceptOfflineTransition(live, {
      eventId: offlineEventId,
      endedAt: at("2026-01-30T13:07:37.83537036Z"),
    });

    expect(lateOffline._tag).toBe("LiveStream");
    expect(lateOffline).toMatchObject({
      streamId: nextStreamId,
      supersededStartedAt: Option.none(),
      transitionCheckpoint: Option.none(),
    });

    const realOffline = acceptOfflineTransition(lateOffline, {
      eventId: offlineEventId,
      endedAt: at("2026-01-30T13:08:00Z"),
    });

    expect(realOffline._tag).toBe("OfflineStream");
    expect(realOffline).toMatchObject({
      lastStartedAt: Option.some(restartedAt),
      supersedingStreamId: Option.none(),
    });
  });

  it("applies an offline notification outside the superseded window to the live session", () => {
    const restartedAt = at("2026-01-30T13:07:21Z");

    const live = LiveStreamState.make({
      streamId: nextStreamId,
      startedAt: restartedAt,
      peakViewerCount: 0,
      viewerPollScheduleId: Option.none(),
      transitionCheckpoint: Option.none(),
      supersededStartedAt: Option.some(startedAt),
    });

    const withinWindow = acceptOfflineTransition(live, {
      eventId: offlineEventId,
      endedAt: at("2026-01-30T13:17:21Z"),
    });

    expect(withinWindow._tag).toBe("LiveStream");
    expect(withinWindow).toMatchObject({ supersededStartedAt: Option.none() });

    const afterWindow = acceptOfflineTransition(live, {
      eventId: offlineEventId,
      endedAt: at("2026-01-30T13:17:21.001Z"),
    });

    expect(afterWindow._tag).toBe("OfflineStream");
    expect(afterWindow).toMatchObject({ endedAt: Option.some(at("2026-01-30T13:17:21.001Z")) });
  });

  it.effect("decodes stored rows written before supersession was recorded", () =>
    Effect.gen(function* () {
      const encoded = Schema.encodeSync(Schema.toCodecJson(PersistedStreamState))(
        LiveStreamState.make({
          streamId,
          startedAt,
          peakViewerCount: 3,
          viewerPollScheduleId: Option.none(),
          transitionCheckpoint: Option.none(),
          supersededStartedAt: Option.none(),
        }),
      );

      expect(encoded).not.toHaveProperty("supersededStartedAt");

      const decoded = yield* decodePersistedStreamState(encoded);

      expect(decoded._tag).toBe("LiveStream");
      expect(decoded).toMatchObject({ supersededStartedAt: Option.none() });
    }),
  );

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
