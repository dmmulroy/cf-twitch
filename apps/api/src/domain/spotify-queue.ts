import { z } from "zod";

/** Runtime parser for a Spotify Track identifier in Spotify Queue state. */
export const SpotifyQueueTrackIdSchema = z.string().min(1).max(128).brand<"SpotifyQueueTrackId">();
/** Spotify Track identifier carried by Spotify Queue state. */
export type SpotifyQueueTrackId = z.infer<typeof SpotifyQueueTrackIdSchema>;

/** Runtime parser for a Twitch EventSub message identifier that starts a Song Request. */
export const SongRequestEventIdSchema = z.string().min(1).max(128).brand<"SongRequestEventId">();
/** Event identity used to correlate one Pending Request. */
export type SongRequestEventId = z.infer<typeof SongRequestEventIdSchema>;

/** Runtime parser for a stable Twitch Viewer identifier. */
export const ViewerIdSchema = z.string().min(1).max(128).brand<"ViewerId">();
/** Stable Twitch identity for a Viewer. */
export type ViewerId = z.infer<typeof ViewerIdSchema>;

const SpotifyQueueDisplayTextSchema = z.string().min(1).max(512);
const SpotifyQueueInstantSchema = z.iso.datetime({ offset: true });

/** Runtime parser for Spotify Track metadata returned with queue state. */
export const SpotifyQueueTrackSchema = z.object({
	id: SpotifyQueueTrackIdSchema,
	name: SpotifyQueueDisplayTextSchema,
	artists: z.array(SpotifyQueueDisplayTextSchema).max(50),
	album: SpotifyQueueDisplayTextSchema,
	albumCoverUrl: z.url().max(2_048).nullable(),
});

/** Spotify Track metadata returned with queue state. */
export type SpotifyQueueTrack = z.infer<typeof SpotifyQueueTrackSchema>;

/** Runtime parser for a Spotify Queue track with Viewer or autoplay attribution. */
export const QueuedTrackSchema = z.discriminatedUnion("source", [
	SpotifyQueueTrackSchema.extend({
		source: z.literal("user"),
		eventId: SongRequestEventIdSchema,
		requesterUserId: ViewerIdSchema,
		requesterDisplayName: SpotifyQueueDisplayTextSchema,
		requestedAt: SpotifyQueueInstantSchema,
	}),
	SpotifyQueueTrackSchema.extend({
		source: z.literal("autoplay"),
		eventId: z.undefined().optional(),
		requesterUserId: z.undefined().optional(),
		requesterDisplayName: z.undefined().optional(),
		requestedAt: z.undefined().optional(),
	}),
]);

/** Spotify Track occurrence with explicit Viewer or autoplay attribution. */
export type QueuedTrack = z.infer<typeof QueuedTrackSchema>;

/** Runtime parser for the Now Playing application contract. */
export const NowPlayingSchema = z.object({
	track: QueuedTrackSchema.nullable(),
	position: z.literal(0),
});

/** Now Playing application contract. */
export type NowPlaying = z.infer<typeof NowPlayingSchema>;
