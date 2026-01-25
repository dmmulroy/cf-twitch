/**
 * SongQueueDO schema - manages song request queue and history
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Pending song requests (not yet played)
 * - event_id unique constraint provides idempotency
 * - Deleted once played or canceled
 * - Seen tracking prevents premature reconciliation of new requests
 */
export const pendingRequests = sqliteTable("pending_requests", {
	eventId: text("event_id").primaryKey(),
	trackId: text("track_id").notNull(),
	trackName: text("track_name").notNull(),
	artists: text("artists").notNull(), // JSON array
	album: text("album").notNull(),
	albumCoverUrl: text("album_cover_url"),
	requesterUserId: text("requester_user_id").notNull(),
	requesterDisplayName: text("requester_display_name").notNull(),
	requestedAt: text("requested_at").notNull(), // ISO8601
	// Seen tracking: when request first/last appeared in Spotify queue
	firstSeenInSpotifyAt: text("first_seen_in_spotify_at"), // ISO8601, null = never seen
	lastSeenInSpotifyAt: text("last_seen_in_spotify_at"), // ISO8601, null = never seen
});

export type PendingRequest = typeof pendingRequests.$inferSelect;
export type InsertPendingRequest = typeof pendingRequests.$inferInsert;

/**
 * Source of track in queue
 */
export type TrackSource = "user" | "autoplay";

/**
 * Snapshot of Spotify queue state
 * - position=0: currently playing
 * - position>0: queued tracks
 * - Refreshed on every sync from Spotify API
 * - Attribution links snapshot items to specific pending requests
 */
export const spotifyQueueSnapshot = sqliteTable("spotify_queue_snapshot", {
	position: integer("position").primaryKey(),
	trackId: text("track_id").notNull(),
	trackName: text("track_name").notNull(),
	artists: text("artists").notNull(), // JSON array
	album: text("album").notNull(),
	albumCoverUrl: text("album_cover_url"),
	syncedAt: text("synced_at").notNull(), // ISO8601
	// Attribution: source and linked request
	source: text("source").notNull().default("autoplay"), // 'user' | 'autoplay'
	eventId: text("event_id"), // links to pending_requests.event_id (null = autoplay)
	// Denormalized requester info (avoids join-at-read-time)
	requesterUserId: text("requester_user_id"),
	requesterDisplayName: text("requester_display_name"),
	requestedAt: text("requested_at"), // ISO8601
});

export type SpotifyQueueSnapshotItem = typeof spotifyQueueSnapshot.$inferSelect;
export type InsertSpotifyQueueSnapshotItem = typeof spotifyQueueSnapshot.$inferInsert;

/**
 * Request history (fulfilled requests)
 * - Permanent record of all song requests
 * - Written after track is confirmed played
 */
export const requestHistory = sqliteTable("request_history", {
	eventId: text("event_id").primaryKey(),
	trackId: text("track_id").notNull(),
	trackName: text("track_name").notNull(),
	artists: text("artists").notNull(), // JSON array
	album: text("album").notNull(),
	albumCoverUrl: text("album_cover_url"),
	requesterUserId: text("requester_user_id").notNull(),
	requesterDisplayName: text("requester_display_name").notNull(),
	requestedAt: text("requested_at").notNull(), // ISO8601
	fulfilledAt: text("fulfilled_at").notNull(), // ISO8601
});

export type RequestHistory = typeof requestHistory.$inferSelect;
export type InsertRequestHistory = typeof requestHistory.$inferInsert;
