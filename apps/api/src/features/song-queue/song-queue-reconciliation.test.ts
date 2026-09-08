import { describe, expect, it } from "@effect/vitest";
import {
  IsoTimestamp,
  RedemptionId,
  SpotifyTrackId,
  ViewerId,
} from "@cf-twitch/contracts/identity";
import { PendingSongRequest } from "@cf-twitch/contracts/song-queue";
import type { SpotifyTrack } from "@cf-twitch/contracts/spotify-track";
import { Option } from "effect";
import { FastCheck } from "effect/testing";
import { attributeSongQueueOccurrences } from "./song-queue-reconciliation.ts";

const repeatTrack: SpotifyTrack = {
  id: SpotifyTrackId.make("repeat"),
  name: "Repeat",
  artists: ["Artist"],
  album: "Album",
  albumCoverUrl: Option.none(),
};
const makeRequest = (index: number, track = repeatTrack) =>
  PendingSongRequest.make({
    eventId: RedemptionId.make(`request${index}`),
    track,
    requesterUserId: ViewerId.make(`viewer${index}`),
    requesterDisplayName: `Viewer ${index}`,
    requestedAt: IsoTimestamp.make(new Date(index * 1000).toISOString()),
  });

describe("Song queue occurrence attribution properties", () => {
  it.prop(
    "repeated tracks promote exactly one FIFO occurrence and preserve remaining attribution",
    { count: FastCheck.integer({ min: 1, max: 100 }) },
    ({ count }) => {
      const pending = Array.from({ length: count }, (_, index) => makeRequest(index));
      const upcoming = pending.map((request) => request.track);
      const previous = attributeSongQueueOccurrences({
        previous: [],
        pending,
        currentlyPlaying: Option.some(repeatTrack),
        upcoming,
      });
      expect(previous.find((occurrence) => occurrence.position === 0)?.track.source).toBe(
        "autoplay",
      );
      const result = attributeSongQueueOccurrences({
        previous,
        pending,
        currentlyPlaying: Option.some(repeatTrack),
        upcoming: upcoming.slice(1),
      });
      expect(
        result.map(({ track }) => (track.source === "user" ? track.eventId : "autoplay")),
      ).toEqual(pending.map((request) => request.eventId));
      expect(
        attributeSongQueueOccurrences({
          previous: result,
          pending,
          currentlyPlaying: Option.some(repeatTrack),
          upcoming: upcoming.slice(1),
        }),
      ).toEqual(result);
    },
  );

  it.prop(
    "mixed duplicate tracks never assign one request identity to multiple occurrences",
    {
      trackIds: FastCheck.array(FastCheck.constantFrom("a", "b", "c"), {
        minLength: 0,
        maxLength: 100,
      }),
      requestCount: FastCheck.integer({ min: 0, max: 100 }),
    },
    ({ trackIds, requestCount }) => {
      const upcoming = trackIds.map((id) => ({ ...repeatTrack, id: SpotifyTrackId.make(id) }));
      const pending = upcoming
        .slice(0, requestCount)
        .map((track, index) => makeRequest(index, track));
      const result = attributeSongQueueOccurrences({
        previous: [],
        pending,
        currentlyPlaying: Option.none(),
        upcoming,
      });
      const identities = result.flatMap(({ track }) =>
        track.source === "user" ? [track.eventId] : [],
      );
      expect(new Set(identities).size).toBe(identities.length);
      expect(identities.length).toBe(pending.length);
      expect(result.map(({ track }) => track.id)).toEqual(trackIds);
      expect(
        attributeSongQueueOccurrences({
          previous: result,
          pending,
          currentlyPlaying: Option.none(),
          upcoming,
        }),
      ).toEqual(result);
    },
  );
});
