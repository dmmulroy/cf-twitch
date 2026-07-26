import { z } from "zod";

const SpotifyQueueDomainIdSchema = z.string().min(1).max(128);
const SpotifyQueueDisplayTextSchema = z.string().min(1).max(512);
const SpotifyQueueInstantSchema = z.iso.datetime({ offset: true });

const SpotifyTrackInfoSchema = z.object({
	id: SpotifyQueueDomainIdSchema,
	name: SpotifyQueueDisplayTextSchema,
	artists: z.array(SpotifyQueueDisplayTextSchema).max(50),
	album: SpotifyQueueDisplayTextSchema,
	albumCoverUrl: z.url().max(2_048).nullable(),
});

/** Runtime parser for a Spotify Queue track with Viewer or autoplay attribution. */
export const QueuedTrackSchema = z.discriminatedUnion("source", [
	SpotifyTrackInfoSchema.extend({
		source: z.literal("user"),
		eventId: SpotifyQueueDomainIdSchema,
		requesterUserId: SpotifyQueueDomainIdSchema,
		requesterDisplayName: SpotifyQueueDisplayTextSchema,
		requestedAt: SpotifyQueueInstantSchema,
	}),
	SpotifyTrackInfoSchema.extend({
		source: z.literal("autoplay"),
		eventId: z.undefined().optional(),
		requesterUserId: z.undefined().optional(),
		requesterDisplayName: z.undefined().optional(),
		requestedAt: z.undefined().optional(),
	}),
]);

/** Spotify Track occurrence with explicit source attribution. */
export type QueuedTrack = z.infer<typeof QueuedTrackSchema>;

/** Runtime parser for the Now Playing application contract. */
export const CurrentlyPlayingResultSchema = z.object({
	track: QueuedTrackSchema.nullable(),
	position: z.literal(0),
});

/** Now Playing application contract. */
export type CurrentlyPlayingResult = z.infer<typeof CurrentlyPlayingResultSchema>;
