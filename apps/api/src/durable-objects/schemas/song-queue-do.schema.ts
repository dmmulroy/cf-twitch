import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { z } from "zod";

import {
	PendingRequestInputSchema,
	SongRequestDisplayTextSchema,
	SongRequestDomainIdSchema,
	SongRequestInstantSchema,
} from "../../domain/song-request";

const NonEmptyBoundedTextSchema = SongRequestDisplayTextSchema;
const DomainIdSchema = SongRequestDomainIdSchema;
const IsoInstantSchema = SongRequestInstantSchema;

/** Runtime parser for the JSON-encoded Spotify artist-name list stored in SQLite. */
export const ArtistNamesJsonSchema = z.string().transform((value, context) => {
	try {
		const parsed = z.array(NonEmptyBoundedTextSchema).max(50).safeParse(JSON.parse(value));
		if (parsed.success) return parsed.data;
		context.addIssue({ code: "custom", message: `Invalid artist names: ${parsed.error.message}` });
	} catch (cause) {
		context.addIssue({ code: "custom", message: `Invalid artist names JSON: ${String(cause)}` });
	}
	return z.NEVER;
});

/** Pending Requests, including durable evidence of their observed Spotify Queue occurrence. */
export const pendingRequests = sqliteTable("pending_requests", {
	eventId: text("event_id").primaryKey(),
	trackId: text("track_id").notNull(),
	trackName: text("track_name").notNull(),
	artists: text("artists").notNull(),
	album: text("album").notNull(),
	albumCoverUrl: text("album_cover_url"),
	requesterUserId: text("requester_user_id").notNull(),
	requesterDisplayName: text("requester_display_name").notNull(),
	requestedAt: text("requested_at").notNull(),
	firstSeenInSpotifyAt: text("first_seen_in_spotify_at"),
	lastSeenInSpotifyAt: text("last_seen_in_spotify_at"),
});

/** SQLite representation of a Pending Request. */
export type PendingRequest = typeof pendingRequests.$inferSelect;
/** SQLite insert representation retained for migration and test fixtures. */
export type InsertPendingRequest = typeof pendingRequests.$inferInsert;

/** Runtime parser for persisted Pending Request rows and occurrence-seen timestamps. */
export const PendingRequestRecordSchema = PendingRequestInputSchema.extend({
	firstSeenInSpotifyAt: IsoInstantSchema.nullable(),
	lastSeenInSpotifyAt: IsoInstantSchema.nullable(),
});

/** Source of a Spotify Track occurrence in a queue snapshot. */
export const TrackSourceSchema = z.enum(["user", "autoplay"]);
/** Source of a Spotify Track occurrence in a queue snapshot. */
export type TrackSource = z.infer<typeof TrackSourceSchema>;

/** Durable Spotify Queue occurrence snapshot; position zero is Now Playing. */
export const spotifyQueueSnapshot = sqliteTable("spotify_queue_snapshot", {
	position: integer("position").primaryKey(),
	trackId: text("track_id").notNull(),
	trackName: text("track_name").notNull(),
	artists: text("artists").notNull(),
	album: text("album").notNull(),
	albumCoverUrl: text("album_cover_url"),
	syncedAt: text("synced_at").notNull(),
	source: text("source").notNull().default("autoplay"),
	eventId: text("event_id"),
	requesterUserId: text("requester_user_id"),
	requesterDisplayName: text("requester_display_name"),
	requestedAt: text("requested_at"),
});

/** SQLite representation of one Spotify Queue occurrence. */
export type SpotifyQueueSnapshotItem = typeof spotifyQueueSnapshot.$inferSelect;
/** SQLite insert representation for one Spotify Queue occurrence. */
export type InsertSpotifyQueueSnapshotItem = typeof spotifyQueueSnapshot.$inferInsert;

const SnapshotBaseSchema = z.object({
	position: z.number().int().nonnegative(),
	trackId: DomainIdSchema,
	trackName: NonEmptyBoundedTextSchema,
	artists: z.string().max(8_192),
	album: NonEmptyBoundedTextSchema,
	albumCoverUrl: z.url().max(2_048).nullable(),
	syncedAt: IsoInstantSchema,
});

/** Runtime parser for persisted Spotify Queue occurrence rows. */
export const SpotifyQueueSnapshotRecordSchema = z.discriminatedUnion("source", [
	SnapshotBaseSchema.extend({
		source: z.literal("user"),
		eventId: DomainIdSchema,
		requesterUserId: DomainIdSchema,
		requesterDisplayName: NonEmptyBoundedTextSchema,
		requestedAt: IsoInstantSchema,
	}),
	SnapshotBaseSchema.extend({
		source: z.literal("autoplay"),
		eventId: z.null(),
		requesterUserId: z.null(),
		requesterDisplayName: z.null(),
		requestedAt: z.null(),
	}),
]);
/** Parsed persisted Spotify Queue occurrence with source-dependent attribution. */
export type SpotifyQueueSnapshotRecord = z.infer<typeof SpotifyQueueSnapshotRecordSchema>;

/** Request History containing only Song Requests confirmed as played. */
export const requestHistory = sqliteTable("request_history", {
	eventId: text("event_id").primaryKey(),
	trackId: text("track_id").notNull(),
	trackName: text("track_name").notNull(),
	artists: text("artists").notNull(),
	album: text("album").notNull(),
	albumCoverUrl: text("album_cover_url"),
	requesterUserId: text("requester_user_id").notNull(),
	requesterDisplayName: text("requester_display_name").notNull(),
	requestedAt: text("requested_at").notNull(),
	fulfilledAt: text("fulfilled_at").notNull(),
});

/** SQLite representation of one Request History row. */
export type RequestHistory = typeof requestHistory.$inferSelect;
/** SQLite insert representation for one Request History row. */
export type InsertRequestHistory = typeof requestHistory.$inferInsert;

/** Runtime parser for persisted Request History rows. */
export const RequestHistoryRecordSchema = z.object({
	eventId: DomainIdSchema,
	trackId: DomainIdSchema,
	trackName: NonEmptyBoundedTextSchema,
	artists: z.string().max(8_192),
	album: NonEmptyBoundedTextSchema,
	albumCoverUrl: z.url().max(2_048).nullable(),
	requesterUserId: DomainIdSchema,
	requesterDisplayName: NonEmptyBoundedTextSchema,
	requestedAt: IsoInstantSchema,
	fulfilledAt: IsoInstantSchema,
});

/** Bounded options accepted by the Request History service boundary. */
export const RequestHistoryQuerySchema = z
	.object({
		limit: z.number().int().min(1).max(100),
		offset: z.number().int().min(0).max(10_000),
		since: IsoInstantSchema.optional(),
		until: IsoInstantSchema.optional(),
	})
	.refine(
		(query) => query.since === undefined || query.until === undefined || query.since <= query.until,
		{
			message: "Request History since must not be after until",
		},
	);

/** Parsed, bounded Request History query options. */
export type RequestHistoryQuery = z.infer<typeof RequestHistoryQuerySchema>;
