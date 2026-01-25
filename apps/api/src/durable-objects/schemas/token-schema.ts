/**
 * Drizzle schema for token management DOs (SpotifyTokenDO, TwitchTokenDO)
 */

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Token set table (singleton pattern)
 * Stores OAuth tokens with expiration tracking
 */
export const tokenSet = sqliteTable("token_set", {
	id: integer("id")
		.primaryKey()
		.$default(() => 1),
	accessToken: text("access_token").notNull(),
	refreshToken: text("refresh_token").notNull(),
	tokenType: text("token_type").notNull(),
	expiresIn: integer("expires_in").notNull(),
	expiresAt: text("expires_at").notNull(), // ISO8601 timestamp
	isStreamLive: integer("is_stream_live", { mode: "boolean" }).notNull().default(false),
});

export type TokenSet = typeof tokenSet.$inferSelect;
export type NewTokenSet = typeof tokenSet.$inferInsert;
