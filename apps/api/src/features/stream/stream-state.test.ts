import { describe, expect, it } from "vite-plus/test";
import { Effect, Schema } from "effect";
import { EventId, IsoTimestamp, StreamId } from "@cf-twitch/contracts/identity";
import { deriveLifecycleEventId } from "./stream.ts";
import {
  acceptOfflineTransition,
  acceptOnlineTransition,
  clearCompletedTransition,
  completeTransitionEffect,
  decodePersistedStreamState,
  initialStreamState,
} from "./stream-state.ts";

const eventId = Schema.decodeUnknownSync(EventId)("550e8400-e29b-41d4-a716-446655440002");
const streamId = Schema.decodeUnknownSync(StreamId)("stream-123");
const at = (value: string) => Schema.decodeUnknownSync(IsoTimestamp)(value);
const startedAt = at("2026-01-30T11:55:00.000Z");
const endedAt = at("2026-01-30T14:00:00.000Z");

describe("Stream Lifecycle state", () => {
  it("derives one stable lifecycle event identity from transition evidence", async () => {
    const input = { transition: "online" as const, streamId, transitionAt: startedAt };
    const first = await Effect.runPromise(deriveLifecycleEventId(input));
    const replay = await Effect.runPromise(deriveLifecycleEventId(input));

    expect(replay).toBe(first);
    expect(() => Schema.decodeUnknownSync(EventId)(first)).not.toThrow();
  });

  it("accepts authoritative online source time with all four checkpoints incomplete", () => {
    const state = acceptOnlineTransition(initialStreamState(), { eventId, streamId, startedAt });

    expect(state).toMatchObject({
      _tag: "LiveStream",
      streamId,
      startedAt,
      transitionCheckpoint: {
        eventId,
        streamId,
        transition: "online",
        transitionAt: startedAt,
        spotifyTokenNotified: false,
        twitchTokenNotified: false,
        lifecycleEventPublished: false,
        viewerPollingUpdated: false,
      },
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
    if (online._tag !== "LiveStream") throw new Error("expected live state");
    const withSchedule = { ...online, viewerPollScheduleId: "viewer-poll-1" };
    const offlineEventId = Schema.decodeUnknownSync(EventId)(
      "550e8400-e29b-41d4-a716-446655440003",
    );

    const offline = acceptOfflineTransition(withSchedule, { eventId: offlineEventId, endedAt });

    expect(offline).toMatchObject({
      _tag: "OfflineStream",
      lastStartedAt: startedAt,
      endedAt,
      transitionCheckpoint: {
        eventId: offlineEventId,
        streamId,
        transition: "offline",
        viewerPollScheduleId: "viewer-poll-1",
      },
    });
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

    expect(clearCompletedTransition(completed).transitionCheckpoint).toBeNull();
  });

  it("decodes historical tagged Agent state without losing a partial intent", async () => {
    const decoded = await Effect.runPromise(
      decodePersistedStreamState({
        _tag: "LiveStream",
        streamSessionId: streamId,
        startedAt,
        peakViewerCount: 41,
        viewerPollScheduleId: "viewer-poll-1",
        transitionIntent: {
          _tag: "StreamOnlineIntent",
          eventId,
          streamSessionId: streamId,
          transitionAt: startedAt,
          viewerPollScheduleId: null,
          spotifyTokenNotified: true,
          twitchTokenNotified: false,
          lifecycleEventPublished: false,
          viewerPollingUpdated: false,
        },
      }),
    );

    expect(decoded.transitionCheckpoint).toMatchObject({
      eventId,
      spotifyTokenNotified: true,
      twitchTokenNotified: false,
    });
  });

  it("fails closed on corrupt historical Agent state", async () => {
    const result = await Effect.runPromiseExit(
      decodePersistedStreamState({ isLive: true, startedAt: null, streamSessionId: null }),
    );

    expect(result._tag).toBe("Failure");
  });
});
