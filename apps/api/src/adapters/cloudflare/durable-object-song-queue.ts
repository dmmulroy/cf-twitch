import { Result } from "better-result";
import { z } from "zod";

import {
	SongQueueCoordinationError,
	SongQueueParseError,
	SongQueueUnavailableError,
	type SongQueue,
	type SongQueueFailure,
	type SongQueueOperation,
} from "../../capabilities/song-queue";
import {
	RequestHistoryResultSchema,
	SpotifyQueueResultSchema,
	TopRequestedTrackSchema,
	TopSongRequesterSchema,
	type PendingRequestInput,
	type RequestHistoryResult,
	type SpotifyQueueResult,
	type TopRequestedTrack,
	type TopSongRequester,
} from "../../domain/song-request";
import { NowPlayingSchema } from "../../domain/spotify-queue";
import { SONG_QUEUE_DO_NAME } from "../../durable-objects/song-queue-do";
import { DurableObjectError, SongQueueDbError } from "../../lib/errors";
import { fromRpcResult, type RpcPayloadParser, type RpcResultParsers } from "../../lib/rpc-result";

import type { Tracer } from "../../capabilities/tracer";
import type { NowPlaying } from "../../domain/spotify-queue";
import type { Result as ResultType } from "better-result";

const SerializedSongQueueErrorSchema = z.discriminatedUnion("_tag", [
	z.object({
		_tag: z.literal("SongQueueDbError"),
		operation: z.string(),
		message: z.string(),
		cause: z.unknown().optional(),
	}),
	z.object({
		_tag: z.literal("SongQueueParseError"),
		boundary: z.enum(["rpc-input", "persistence"]),
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

type SongQueueWireError = z.infer<typeof SerializedSongQueueErrorSchema>;

const SongQueueSpanNames: Readonly<Record<SongQueueOperation, string>> = {
	persistPendingRequest: "durable_object.song_queue.persist_pending_request",
	deletePendingRequest: "durable_object.song_queue.delete_pending_request",
	getSpotifyQueue: "durable_object.song_queue.get_spotify_queue",
	getNowPlaying: "durable_object.song_queue.get_now_playing",
	getRequestHistory: "durable_object.song_queue.get_request_history",
	getViewerRequestCount: "durable_object.song_queue.get_viewer_request_count",
	getViewerRequestCountByDisplayName:
		"durable_object.song_queue.get_viewer_request_count_by_display_name",
	getTopTracks: "durable_object.song_queue.get_top_tracks",
	getViewerTopTracks: "durable_object.song_queue.get_viewer_top_tracks",
	getTopRequesters: "durable_object.song_queue.get_top_requesters",
};

interface SongQueueRpcHandle {
	persistRequest(request: PendingRequestInput): Promise<unknown>;
	deleteRequest(eventId: string): Promise<unknown>;
	getSongQueue(limit: number): Promise<unknown>;
	getCurrentlyPlaying(): Promise<unknown>;
	getRequestHistory(
		limit: number,
		offset: number,
		since?: string,
		until?: string,
	): Promise<unknown>;
	getUserRequestCount(userId: string): Promise<unknown>;
	getUserRequestCountByDisplayName(displayName: string): Promise<unknown>;
	getTopTracks(limit: number): Promise<unknown>;
	getTopTracksByUser(userId: string, limit: number): Promise<unknown>;
	getTopRequesters(limit: number): Promise<unknown>;
	[Symbol.dispose]?(): void;
}

function parseZodPayload<T>(schema: z.ZodType<T>): RpcPayloadParser<T> {
	return (input) => {
		const parsed = schema.safeParse(input);
		return parsed.success ? Result.ok(parsed.data) : Result.err(parsed.error.message);
	};
}

const parseSongQueueWireError: RpcPayloadParser<SongQueueFailure> = (input) => {
	const parsed = SerializedSongQueueErrorSchema.safeParse(input);
	if (!parsed.success) return Result.err(parsed.error.message);
	return Result.ok(translateSongQueueWireError(parsed.data));
};

function translateSongQueueWireError(error: SongQueueWireError): SongQueueFailure {
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
}

function songQueueRpcParsers<T>(schema: z.ZodType<T>): RpcResultParsers<T, SongQueueFailure> {
	return { success: parseZodPayload(schema), error: parseSongQueueWireError };
}

/** Durable Object adapter that owns Song Queue acquisition, RPC transport, parsing, and translation. */
export class DurableObjectSongQueue implements SongQueue {
	constructor(
		private readonly namespace: Cloudflare.Env["SONG_QUEUE_DO"],
		private readonly tracer: Tracer,
	) {}

	/** Persists a Pending Request through the runtime-validated Song Queue RPC contract. */
	persistPendingRequest(request: PendingRequestInput): Promise<ResultType<void, SongQueueFailure>> {
		return this.call(
			"persistPendingRequest",
			"persistRequest",
			(handle) => handle.persistRequest(request),
			songQueueRpcParsers(z.undefined()),
		);
	}

	/** Deletes a Pending Request through the runtime-validated Song Queue RPC contract. */
	deletePendingRequest(eventId: string): Promise<ResultType<void, SongQueueFailure>> {
		return this.call(
			"deletePendingRequest",
			"deleteRequest",
			(handle) => handle.deleteRequest(eventId),
			songQueueRpcParsers(z.undefined()),
		);
	}

	/** Reads and runtime-validates the complete Now Playing RPC result. */
	getNowPlaying(): Promise<ResultType<NowPlaying, SongQueueFailure>> {
		return this.call(
			"getNowPlaying",
			"getCurrentlyPlaying",
			(handle) => handle.getCurrentlyPlaying(),
			songQueueRpcParsers(NowPlayingSchema),
		);
	}

	/** Reads and runtime-validates a bounded upcoming Spotify Queue snapshot. */
	getSpotifyQueue(limit: number): Promise<ResultType<SpotifyQueueResult, SongQueueFailure>> {
		return this.call(
			"getSpotifyQueue",
			"getSongQueue",
			(handle) => handle.getSongQueue(limit),
			songQueueRpcParsers(SpotifyQueueResultSchema),
		);
	}

	/** Reads and runtime-validates a bounded Request History page. */
	getRequestHistory(
		limit: number,
		offset = 0,
		since?: string,
		until?: string,
	): Promise<ResultType<RequestHistoryResult, SongQueueFailure>> {
		return this.call(
			"getRequestHistory",
			"getRequestHistory",
			(handle) => handle.getRequestHistory(limit, offset, since, until),
			songQueueRpcParsers(RequestHistoryResultSchema),
		);
	}

	/** Counts fulfilled Song Requests for one stable Viewer ID. */
	getViewerRequestCount(userId: string): Promise<ResultType<number, SongQueueFailure>> {
		return this.call(
			"getViewerRequestCount",
			"getUserRequestCount",
			(handle) => handle.getUserRequestCount(userId),
			songQueueRpcParsers(z.number().int().nonnegative()),
		);
	}

	/** Counts fulfilled Song Requests for one historical Viewer display name. */
	getViewerRequestCountByDisplayName(
		displayName: string,
	): Promise<ResultType<number, SongQueueFailure>> {
		return this.call(
			"getViewerRequestCountByDisplayName",
			"getUserRequestCountByDisplayName",
			(handle) => handle.getUserRequestCountByDisplayName(displayName),
			songQueueRpcParsers(z.number().int().nonnegative()),
		);
	}

	/** Aggregates Spotify Tracks across fulfilled Song Requests. */
	getTopTracks(limit: number): Promise<ResultType<TopRequestedTrack[], SongQueueFailure>> {
		return this.call(
			"getTopTracks",
			"getTopTracks",
			(handle) => handle.getTopTracks(limit),
			songQueueRpcParsers(z.array(TopRequestedTrackSchema).max(100)),
		);
	}

	/** Aggregates one Viewer's requested Spotify Tracks. */
	getViewerTopTracks(
		userId: string,
		limit: number,
	): Promise<ResultType<TopRequestedTrack[], SongQueueFailure>> {
		return this.call(
			"getViewerTopTracks",
			"getTopTracksByUser",
			(handle) => handle.getTopTracksByUser(userId, limit),
			songQueueRpcParsers(z.array(TopRequestedTrackSchema).max(100)),
		);
	}

	/** Aggregates Viewers by fulfilled Song Request count. */
	getTopRequesters(limit: number): Promise<ResultType<TopSongRequester[], SongQueueFailure>> {
		return this.call(
			"getTopRequesters",
			"getTopRequesters",
			(handle) => handle.getTopRequesters(limit),
			songQueueRpcParsers(z.array(TopSongRequesterSchema).max(100)),
		);
	}

	private call<T>(
		operation: SongQueueOperation,
		rpcMethod: string,
		invoke: (handle: SongQueueRpcHandle) => Promise<unknown>,
		parsers: RpcResultParsers<T, SongQueueFailure>,
	): Promise<ResultType<T, SongQueueFailure>> {
		return this.tracer.span(
			SongQueueSpanNames[operation],
			{ operation, rpc_method: rpcMethod },
			async () => {
				let stub: ReturnType<Cloudflare.Env["SONG_QUEUE_DO"]["get"]>;
				try {
					stub = this.namespace.get(this.namespace.idFromName(SONG_QUEUE_DO_NAME));
				} catch (cause) {
					return Result.err(
						new SongQueueUnavailableError({ operation, failure: "acquire-stub", cause }),
					);
				}

				let handle: SongQueueRpcHandle;
				try {
					handle = await stub.connectRpc();
				} catch (cause) {
					return Result.err(
						new SongQueueUnavailableError({ operation, failure: "connect-rpc", cause }),
					);
				}

				let rawResult: unknown;
				try {
					rawResult = await invoke(handle);
				} catch (cause) {
					return Result.err(
						new SongQueueUnavailableError({ operation, failure: "invoke-rpc", cause }),
					);
				} finally {
					handle[Symbol.dispose]?.();
				}

				const parsed = fromRpcResult(rawResult, `SongQueueDO.${rpcMethod}`, parsers);
				if (parsed.status === "ok") return Result.ok(parsed.value);
				if (!DurableObjectError.is(parsed.error)) return Result.err(parsed.error);
				return Result.err(
					new SongQueueParseError({
						boundary: "rpc-result",
						operation: rpcMethod,
						parseError: parsed.error.message,
					}),
				);
			},
		);
	}
}
