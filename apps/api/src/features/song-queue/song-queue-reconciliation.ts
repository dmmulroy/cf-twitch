import { Option } from "effect";
import type { RedemptionId } from "@cf-twitch/contracts/identity";
import type { PendingSongRequest, QueuedTrack } from "@cf-twitch/contracts/song-queue";
import type { SpotifyTrack } from "@cf-twitch/contracts/spotify-track";

/** One Queue Occurrence at its Spotify position; positions ignore presentation priority. */
export interface SongQueueOccurrence {
  /** Spotify order: `0` is Now Playing and upcoming occurrences start at `1`. */
  readonly position: number;
  /** The occurrence's track with Viewer attribution, or `autoplay` when unattributed. */
  readonly track: QueuedTrack;
}

/** Request attributed to the current occurrence and the upcoming request it was promoted from. */
interface CurrentSongQueueRequestSelection {
  readonly request: Option.Option<PendingSongRequest>;
  readonly promotedEventId: Option.Option<RedemptionId>;
}

/** Selects which Pending Request, if any, owns the currently playing occurrence. */
const selectCurrentSongQueueRequest = (
  previousCurrent: Option.Option<QueuedTrack>,
  previousUpcoming: readonly SongQueueOccurrence[],
  pendingById: ReadonlyMap<RedemptionId, PendingSongRequest>,
  currentlyPlaying: Option.Option<SpotifyTrack>,
  upcoming: readonly SpotifyTrack[],
): CurrentSongQueueRequestSelection => {
  if (Option.isNone(currentlyPlaying))
    return { request: Option.none(), promotedEventId: Option.none() };
  const currentTrack = currentlyPlaying.value;
  const oldCount = previousUpcoming.filter((item) => item.track.id === currentTrack.id).length;
  const newCount = upcoming.filter((track) => track.id === currentTrack.id).length;

  const promotable = previousUpcoming.find(
    (item) => item.track.id === currentTrack.id && item.track.source === "user",
  )?.track;

  if (newCount < oldCount && promotable?.source === "user")
    return {
      request: Option.fromUndefinedOr(pendingById.get(promotable.eventId)),
      promotedEventId: Option.some(promotable.eventId),
    };

  return {
    request: Option.flatMap(previousCurrent, (track) =>
      track.source === "user" && track.id === currentTrack.id
        ? Option.fromUndefinedOr(pendingById.get(track.eventId))
        : Option.none(),
    ),
    promotedEventId: Option.none(),
  };
};

/**
 * Attributes Spotify occurrences to Pending Requests without stealing an already-playing autoplay
 * track.
 *
 * **Details**
 *
 * When repeated upcoming occurrences decrease, the oldest previously attributed upcoming
 * occurrence is promoted to Now Playing; remaining occurrences keep their identities, and
 * unattributed requests claim matching occurrences in request order.
 *
 * @returns The attributed occurrences, current first, then upcoming in Spotify order.
 */
export function attributeSongQueueOccurrences(input: {
  readonly previous: readonly SongQueueOccurrence[];
  readonly pending: readonly PendingSongRequest[];
  readonly currentlyPlaying: Option.Option<SpotifyTrack>;
  readonly upcoming: readonly SpotifyTrack[];
}): readonly SongQueueOccurrence[] {
  const { previous, pending, currentlyPlaying, upcoming } = input;

  const previousCurrent = Option.fromUndefinedOr(
    previous.find((item) => item.position === 0)?.track,
  );

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
    if (track.source !== "user" || Option.contains(current.promotedEventId, track.eventId))
      return [];
    const request = pendingById.get(track.eventId);

    return request === undefined ? [] : [request];
  });

  const previouslyAttributed = new Set(
    previous.flatMap(({ track }) => (track.source === "user" ? [track.eventId] : [])),
  );

  const unassigned = pending.filter((request) => !previouslyAttributed.has(request.eventId));
  const assigned = new Set(Option.toArray(current.request).map((request) => request.eventId));

  const occurrence = (
    track: SpotifyTrack,
    position: number,
    request: Option.Option<PendingSongRequest>,
  ): SongQueueOccurrence => ({
    position,
    track: Option.match(request, {
      onNone: (): QueuedTrack => ({ ...track, source: "autoplay" }),
      onSome: (owner): QueuedTrack => ({
        ...track,
        source: "user",
        eventId: owner.eventId,
        requesterUserId: owner.requesterUserId,
        requesterDisplayName: owner.requesterDisplayName,
        requestedAt: owner.requestedAt,
      }),
    }),
  });

  const result: SongQueueOccurrence[] = Option.isSome(currentlyPlaying)
    ? [occurrence(currentlyPlaying.value, 0, current.request)]
    : [];

  for (const [index, track] of upcoming.entries()) {
    const claims = (candidate: PendingSongRequest) =>
      candidate.track.id === track.id && !assigned.has(candidate.eventId);

    const request = Option.orElse(Option.fromUndefinedOr(reusable.find(claims)), () =>
      Option.fromUndefinedOr(unassigned.find(claims)),
    );

    if (Option.isSome(request)) assigned.add(request.value.eventId);
    result.push(occurrence(track, index + 1, request));
  }

  return result;
}
