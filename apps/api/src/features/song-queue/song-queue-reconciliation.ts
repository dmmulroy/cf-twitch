import { Option } from "effect";
import type { PendingSongRequest, QueuedTrack } from "@cf-twitch/contracts/song-queue";
import type { SpotifyTrack } from "@cf-twitch/contracts/spotify-track";

/** Snapshot positions preserve Spotify order independently of presentation priority. */
export interface SongQueueOccurrence {
  readonly position: number;
  readonly track: QueuedTrack;
}

interface CurrentSongQueueRequestSelection {
  readonly request: PendingSongRequest | undefined;
  readonly promotedEventId: string | undefined;
}

const selectCurrentSongQueueRequest = (
  previousCurrent: QueuedTrack | undefined,
  previousUpcoming: readonly SongQueueOccurrence[],
  pendingById: ReadonlyMap<string, PendingSongRequest>,
  currentlyPlaying: Option.Option<SpotifyTrack>,
  upcoming: readonly SpotifyTrack[],
): CurrentSongQueueRequestSelection => {
  if (Option.isNone(currentlyPlaying)) return { request: undefined, promotedEventId: undefined };
  const currentTrack = currentlyPlaying.value;
  const oldCount = previousUpcoming.filter((item) => item.track.id === currentTrack.id).length;
  const newCount = upcoming.filter((track) => track.id === currentTrack.id).length;

  const promotable = previousUpcoming.find(
    (item) => item.track.id === currentTrack.id && item.track.source === "user",
  )?.track;

  if (newCount < oldCount && promotable?.source === "user")
    return {
      request: pendingById.get(promotable.eventId),
      promotedEventId: promotable.eventId,
    };

  return {
    request:
      previousCurrent?.source === "user" && previousCurrent.id === currentTrack.id
        ? pendingById.get(previousCurrent.eventId)
        : undefined,
    promotedEventId: undefined,
  };
};

/** Attribute repeated track occurrences without stealing an already-playing autoplay track. */
export function attributeSongQueueOccurrences(input: {
  readonly previous: readonly SongQueueOccurrence[];
  readonly pending: readonly PendingSongRequest[];
  readonly currentlyPlaying: Option.Option<SpotifyTrack>;
  readonly upcoming: readonly SpotifyTrack[];
}): readonly SongQueueOccurrence[] {
  const { previous, pending, currentlyPlaying, upcoming } = input;
  const previousCurrent = previous.find((item) => item.position === 0)?.track;

  const previousUpcoming = previous
    .filter((item) => item.position > 0)
    .toSorted((a, b) => a.position - b.position);

  const pendingById = new Map(pending.map((request) => [request.eventId, request]));

  const current = selectCurrentSongQueueRequest(
    previousCurrent,
    previousUpcoming,
    pendingById,
    currentlyPlaying,
    upcoming,
  );

  const reusable = previousUpcoming.flatMap(({ track }) => {
    if (track.source !== "user" || track.eventId === current.promotedEventId) return [];
    const request = pendingById.get(track.eventId);

    return request === undefined ? [] : [request];
  });

  const previouslyAttributed = new Set(
    previous.flatMap(({ track }) => (track.source === "user" ? [track.eventId] : [])),
  );

  const unassigned = pending.filter((request) => !previouslyAttributed.has(request.eventId));
  const assigned = new Set(current.request === undefined ? [] : [current.request.eventId]);

  const occurrence = (
    track: SpotifyTrack,
    position: number,
    request: PendingSongRequest | undefined,
  ): SongQueueOccurrence => ({
    position,
    track:
      request === undefined
        ? { ...track, source: "autoplay" }
        : {
            ...track,
            source: "user",
            eventId: request.eventId,
            requesterUserId: request.requesterUserId,
            requesterDisplayName: request.requesterDisplayName,
            requestedAt: request.requestedAt,
          },
  });

  const result: SongQueueOccurrence[] = Option.isSome(currentlyPlaying)
    ? [occurrence(currentlyPlaying.value, 0, current.request)]
    : [];

  for (const [index, track] of upcoming.entries()) {
    const request =
      reusable.find(
        (candidate) => candidate.track.id === track.id && !assigned.has(candidate.eventId),
      ) ??
      unassigned.find(
        (candidate) => candidate.track.id === track.id && !assigned.has(candidate.eventId),
      );

    if (request !== undefined) assigned.add(request.eventId);
    result.push(occurrence(track, index + 1, request));
  }

  return result;
}
