import { z } from "zod";

import { QueuedTrackSchema } from "./spotify-queue";

/** Runtime parser for bounded Song Request display metadata. */
export const SongRequestDisplayTextSchema = z.string().min(1).max(512);
/** Runtime parser for bounded Song Request, Viewer, and Spotify identifiers. */
export const SongRequestDomainIdSchema = z.string().min(1).max(128);
/** Runtime parser for ISO-8601 instants in Song Request application contracts. */
export const SongRequestInstantSchema = z.iso.datetime({ offset: true });

const ArtistNamesJsonSchema = z.string().transform((value, context) => {
	try {
		const parsed = z.array(SongRequestDisplayTextSchema).max(50).safeParse(JSON.parse(value));
		if (parsed.success) return parsed.data;
		context.addIssue({ code: "custom", message: `Invalid artist names: ${parsed.error.message}` });
	} catch (cause) {
		context.addIssue({ code: "custom", message: `Invalid artist names JSON: ${String(cause)}` });
	}
	return z.NEVER;
});

/** Runtime parser for a Pending Request accepted by the Song Request application. */
export const PendingRequestInputSchema = z.object({
	eventId: SongRequestDomainIdSchema,
	trackId: SongRequestDomainIdSchema,
	trackName: SongRequestDisplayTextSchema,
	artists: z
		.string()
		.max(8_192)
		.pipe(ArtistNamesJsonSchema)
		.transform((artists) => JSON.stringify(artists)),
	album: SongRequestDisplayTextSchema,
	albumCoverUrl: z.url().max(2_048).nullable(),
	requesterUserId: SongRequestDomainIdSchema,
	requesterDisplayName: SongRequestDisplayTextSchema,
	requestedAt: SongRequestInstantSchema,
});

/** Parsed Pending Request accepted before Spotify Queue mutation. */
export type PendingRequestInput = z.infer<typeof PendingRequestInputSchema>;

/** Runtime parser for bounded Song Queue and Song Request statistics limits. */
export const SongRequestLimitSchema = z.number().int().min(1).max(100);

/** Runtime parser for a bounded Spotify Queue application response. */
export const SpotifyQueueResultSchema = z.object({
	tracks: z.array(QueuedTrackSchema).max(100),
	totalCount: z.number().int().nonnegative(),
});

/** Bounded Spotify Queue application response. */
export type SpotifyQueueResult = z.infer<typeof SpotifyQueueResultSchema>;

/** Runtime parser for a fulfilled Request History item. */
export const RequestHistoryItemSchema = z.object({
	eventId: SongRequestDomainIdSchema,
	trackId: SongRequestDomainIdSchema,
	trackName: SongRequestDisplayTextSchema,
	artists: z.array(SongRequestDisplayTextSchema).max(50),
	album: SongRequestDisplayTextSchema,
	albumCoverUrl: z.url().max(2_048).nullable(),
	requesterUserId: SongRequestDomainIdSchema,
	requesterDisplayName: SongRequestDisplayTextSchema,
	requestedAt: SongRequestInstantSchema,
	fulfilledAt: SongRequestInstantSchema,
});

/** Fulfilled Song Request in Request History. */
export type RequestHistoryItem = z.infer<typeof RequestHistoryItemSchema>;

/** Runtime parser for a bounded Request History page. */
export const RequestHistoryResultSchema = z.object({
	requests: z.array(RequestHistoryItemSchema).max(100),
	totalCount: z.number().int().nonnegative(),
});

/** Bounded page of fulfilled Song Requests. */
export type RequestHistoryResult = z.infer<typeof RequestHistoryResultSchema>;

/** Runtime parser for a Spotify Track aggregation in Request History. */
export const TopRequestedTrackSchema = z.object({
	trackId: SongRequestDomainIdSchema,
	trackName: SongRequestDisplayTextSchema,
	artists: z.array(SongRequestDisplayTextSchema).max(50),
	requestCount: z.number().int().nonnegative(),
});

/** Spotify Track aggregation grouped by Spotify Track ID. */
export type TopRequestedTrack = z.infer<typeof TopRequestedTrackSchema>;

/** Runtime parser for a Viewer aggregation in Request History. */
export const TopSongRequesterSchema = z.object({
	userId: SongRequestDomainIdSchema,
	displayName: SongRequestDisplayTextSchema,
	requestCount: z.number().int().nonnegative(),
});

/** Viewer aggregation grouped by stable Viewer ID. */
export type TopSongRequester = z.infer<typeof TopSongRequesterSchema>;
