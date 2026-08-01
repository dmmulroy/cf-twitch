import { Result } from "better-result";
import { z } from "zod";

import { SongQueueCoordinationError, SongQueueParseError } from "../capabilities/song-queue";
import {
	RequestHistoryResultSchema,
	SpotifyQueueResultSchema,
	TopRequestedTrackSchema,
	TopSongRequesterSchema,
} from "../domain/song-request";
import { NowPlayingSchema } from "../domain/spotify-queue";
import { SongQueueDbError, SongRequestNotFoundError } from "./errors";

type SongQueueRpcError = SongQueueDbError | SongQueueParseError | SongQueueCoordinationError;

const SongQueueWireErrorSchema = z.discriminatedUnion("_tag", [
	z.object({
		_tag: z.literal("SongQueueDbError"),
		operation: z.string(),
		message: z.string(),
		name: z.literal("SongQueueDbError"),
		cause: z.unknown().optional(),
	}),
	z.object({
		_tag: z.literal("SongQueueParseError"),
		boundary: z.enum(["rpc-input", "persistence", "rpc-result"]),
		operation: z.string(),
		parseError: z.string(),
		message: z.string(),
	}),
	z.object({
		_tag: z.literal("SongQueueCoordinationError"),
		operation: z.string(),
		message: z.string(),
		cause: z.unknown().optional(),
	}),
]);

/** Clone-safe wire representation of an expected Song Queue failure. */
export type SongQueueWireError = z.infer<typeof SongQueueWireErrorSchema>;

const SongQueueErrorToWireSchema = z
	.custom<SongQueueRpcError>(
		(value) =>
			typeof value === "object" &&
			value !== null &&
			"_tag" in value &&
			(value._tag === "SongQueueDbError" ||
				value._tag === "SongQueueParseError" ||
				value._tag === "SongQueueCoordinationError"),
	)
	.transform((error): SongQueueWireError => {
		switch (error._tag) {
			case "SongQueueDbError":
				return {
					_tag: error._tag,
					operation: error.operation,
					message: error.message,
					name: "SongQueueDbError",
					cause: error.cause,
				};
			case "SongQueueParseError":
				return {
					_tag: error._tag,
					boundary: error.boundary,
					operation: error.operation,
					parseError: error.parseError,
					message: error.message,
				};
			case "SongQueueCoordinationError":
				return {
					_tag: error._tag,
					operation: error.operation,
					message: error.message,
					cause: error.cause,
				};
			default:
				throw new Error("Song Queue RPC codec received an unsupported failure");
		}
	})
	.pipe(SongQueueWireErrorSchema);

const SongQueueErrorFromWireSchema = SongQueueWireErrorSchema.transform(
	(error): SongQueueRpcError => {
		switch (error._tag) {
			case "SongQueueDbError":
				return new SongQueueDbError({ operation: error.operation, cause: error.cause });
			case "SongQueueParseError":
				return new SongQueueParseError({
					boundary: error.boundary,
					operation: error.operation,
					parseError: error.parseError,
				});
			case "SongQueueCoordinationError":
				return new SongQueueCoordinationError({ operation: error.operation, cause: error.cause });
		}
	},
);

function createSongQueueResultCodec<T>(okSchema: z.ZodType<T>) {
	return Result.codec({
		serialize: { ok: okSchema, err: SongQueueErrorToWireSchema },
		deserialize: { ok: okSchema, err: SongQueueErrorFromWireSchema },
	});
}

const SongRequestNotFoundWireSchema = z.object({
	_tag: z.literal("SongRequestNotFoundError"),
	eventId: z.string(),
	message: z.string(),
});
const SongRequestNotFoundToWireSchema = z
	.custom<SongRequestNotFoundError>((value) => SongRequestNotFoundError.is(value))
	.transform((error) => ({ _tag: error._tag, eventId: error.eventId, message: error.message }))
	.pipe(SongRequestNotFoundWireSchema);
const SongRequestNotFoundFromWireSchema = SongRequestNotFoundWireSchema.transform(
	(error) => new SongRequestNotFoundError({ eventId: error.eventId }),
);

function createSongQueueHistoryResultCodec<T>(okSchema: z.ZodType<T>) {
	return Result.codec({
		serialize: {
			ok: okSchema,
			err: z.union([SongQueueErrorToWireSchema, SongRequestNotFoundToWireSchema]),
		},
		deserialize: {
			ok: okSchema,
			err: z.union([SongQueueErrorFromWireSchema, SongRequestNotFoundFromWireSchema]),
		},
	});
}

/** RPC codec for persisting one pending Song Request. */
export const PersistSongRequestResultCodec = createSongQueueResultCodec(z.undefined());
/** RPC codec for deleting one pending Song Request. */
export const DeleteSongRequestResultCodec = createSongQueueResultCodec(z.undefined());
/** RPC codec for deleting one Song Request History record. */
export const DeleteSongRequestHistoryResultCodec = createSongQueueResultCodec(z.undefined());
/** RPC codec for atomically writing one Song Request History record. */
export const WriteSongRequestHistoryResultCodec = createSongQueueHistoryResultCodec(z.undefined());
/** RPC codec for reading the bounded Spotify Queue. */
export const GetSongQueueResultCodec = createSongQueueResultCodec(SpotifyQueueResultSchema);
/** RPC codec for reading the currently playing Spotify Track. */
export const GetCurrentlyPlayingResultCodec = createSongQueueResultCodec(NowPlayingSchema);
/** RPC codec for reading bounded Song Request History. */
export const GetRequestHistoryResultCodec = createSongQueueResultCodec(RequestHistoryResultSchema);
/** RPC codec for counting Song Requests in one Stream Session. */
export const GetSessionRequestCountResultCodec = createSongQueueResultCodec(
	z.number().int().nonnegative(),
);
/** RPC codec for reading a Viewer's Song Request count by identity. */
export const GetUserRequestCountResultCodec = createSongQueueResultCodec(
	z.number().int().nonnegative(),
);
/** RPC codec for reading a Viewer's Song Request count by display name. */
export const GetDisplayNameRequestCountResultCodec = createSongQueueResultCodec(
	z.number().int().nonnegative(),
);
/** RPC codec for reading the most-requested Spotify Tracks. */
export const GetTopTracksResultCodec = createSongQueueResultCodec(
	z.array(TopRequestedTrackSchema).max(100),
);
/** RPC codec for reading one Viewer's most-requested Spotify Tracks. */
export const GetUserTopTracksResultCodec = createSongQueueResultCodec(
	z.array(TopRequestedTrackSchema).max(100),
);
/** RPC codec for reading Viewers ranked by Song Request count. */
export const GetTopRequestersResultCodec = createSongQueueResultCodec(
	z.array(TopSongRequesterSchema).max(100),
);
/** RPC codec for checking a recent duplicate Song Request. */
export const CheckDuplicateSongRequestResultCodec = createSongQueueResultCodec(z.boolean());
