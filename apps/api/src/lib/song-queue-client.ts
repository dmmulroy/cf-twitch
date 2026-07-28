import { Result } from "better-result";
import { z } from "zod";

import { SongQueueCoordinationError, SongQueueParseError } from "../capabilities/song-queue";
import {
	RequestHistoryResultSchema,
	SpotifyQueueResultSchema as QueueResultSchema,
	TopRequestedTrackSchema as TopTrackSchema,
	TopSongRequesterSchema as TopRequesterSchema,
	type PendingRequestInput,
} from "../domain/song-request";
import { NowPlayingSchema } from "../domain/spotify-queue";
import { DurableObjectError, SongQueueDbError } from "./errors";
import { callRpcResult, type RpcPayloadParser, type RpcResultParsers } from "./rpc-result";

import type {
	RequestHistoryResult,
	SpotifyQueueResult as QueueResult,
	TopRequestedTrack as TopTrack,
	TopSongRequester as TopRequester,
} from "../domain/song-request";
import type { NowPlaying } from "../domain/spotify-queue";
import type { SongQueueRpcHandleStub } from "../durable-objects/song-queue-do";

type SongQueueError = SongQueueDbError | SongQueueParseError | SongQueueCoordinationError;

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

function zodRpcParser<T>(schema: z.ZodType<T>): RpcPayloadParser<T> {
	return (value) => {
		const parsed = schema.safeParse(value);
		return parsed.success ? Result.ok(parsed.data) : Result.err(parsed.error.message);
	};
}

const parseSongQueueError: RpcPayloadParser<SongQueueError> = (value) => {
	const parsed = SerializedSongQueueErrorSchema.safeParse(value);
	if (!parsed.success) return Result.err(parsed.error.message);
	switch (parsed.data._tag) {
		case "SongQueueDbError":
			return Result.ok(
				new SongQueueDbError({ operation: parsed.data.operation, cause: parsed.data.cause }),
			);
		case "SongQueueParseError":
			return Result.ok(new SongQueueParseError(parsed.data));
		case "SongQueueCoordinationError":
			return Result.ok(new SongQueueCoordinationError(parsed.data));
	}
};

function rpcParsers<T>(schema: z.ZodType<T>): RpcResultParsers<T, SongQueueError> {
	return { success: zodRpcParser(schema), error: parseSongQueueError };
}

const VoidRpcParsers = rpcParsers(z.undefined());
const NumberRpcParsers = rpcParsers(z.number());
const TopTracksRpcParsers = rpcParsers(z.array(TopTrackSchema).max(100));
const TopRequestersRpcParsers = rpcParsers(z.array(TopRequesterSchema).max(100));

type SongQueueHandleAcquisition = Promise<Result<SongQueueRpcHandleStub, DurableObjectError>>;

/** Typed Song Queue facade that owns Durable Object acquisition, transport, and payload parsing failures. */
export class SongQueueClient {
	private constructor(private readonly handleAcquisition: SongQueueHandleAcquisition) {}

	/** Build a client around one classified Durable Object handle acquisition. */
	static fromHandleAcquisition(handleAcquisition: SongQueueHandleAcquisition): SongQueueClient {
		return new SongQueueClient(handleAcquisition);
	}

	/** Release an acquired RPC handle without allowing disposal failures to escape. */
	[Symbol.dispose](): void {
		void this.handleAcquisition.then((result) => {
			if (result.status === "ok") result.value[Symbol.dispose]?.();
		});
	}

	private async call<T>(
		method: string,
		invoke: (handle: SongQueueRpcHandleStub) => Promise<unknown>,
		parsers: RpcResultParsers<T, SongQueueError>,
	): Promise<Result<T, SongQueueError | DurableObjectError>> {
		const acquired = await this.handleAcquisition;
		if (acquired.status === "error") return Result.err(acquired.error);
		return callRpcResult(method, invoke(acquired.value), parsers);
	}

	/** Persist a parsed Pending Request and its durable synchronization intent. */
	persistRequest(
		request: PendingRequestInput,
	): Promise<Result<void, SongQueueError | DurableObjectError>> {
		return this.call("persistRequest", (handle) => handle.persistRequest(request), VoidRpcParsers);
	}

	/** Delete a Pending Request by event identity. */
	deleteRequest(eventId: string): Promise<Result<void, SongQueueError | DurableObjectError>> {
		return this.call("deleteRequest", (handle) => handle.deleteRequest(eventId), VoidRpcParsers);
	}

	/** Read a bounded upcoming Spotify Queue snapshot. */
	getSongQueue(limit: number): Promise<Result<QueueResult, SongQueueError | DurableObjectError>> {
		return this.call(
			"getSongQueue",
			(handle) => handle.getSongQueue(limit),
			rpcParsers(QueueResultSchema),
		);
	}

	/** Read the current Spotify Track with explicit Viewer or autoplay attribution. */
	getCurrentlyPlaying(): Promise<Result<NowPlaying, SongQueueError | DurableObjectError>> {
		return this.call(
			"getCurrentlyPlaying",
			(handle) => handle.getCurrentlyPlaying(),
			rpcParsers(NowPlayingSchema),
		);
	}

	/** Read bounded, decoded Request History records. */
	getRequestHistory(
		limit: number,
		offset = 0,
		since?: string,
		until?: string,
	): Promise<Result<RequestHistoryResult, SongQueueError | DurableObjectError>> {
		return this.call(
			"getRequestHistory",
			(handle) => handle.getRequestHistory(limit, offset, since, until),
			rpcParsers(RequestHistoryResultSchema),
		);
	}

	/** Count fulfilled Song Requests for one stable Viewer ID. */
	getUserRequestCount(
		userId: string,
	): Promise<Result<number, SongQueueError | DurableObjectError>> {
		return this.call(
			"getUserRequestCount",
			(handle) => handle.getUserRequestCount(userId),
			NumberRpcParsers,
		);
	}

	/** Count fulfilled Song Requests for a historical Viewer display name. */
	getUserRequestCountByDisplayName(
		displayName: string,
	): Promise<Result<number, SongQueueError | DurableObjectError>> {
		return this.call(
			"getUserRequestCountByDisplayName",
			(handle) => handle.getUserRequestCountByDisplayName(displayName),
			NumberRpcParsers,
		);
	}

	/** Aggregate Spotify Tracks by stable Track ID with decoded artist names. */
	getTopTracks(limit: number): Promise<Result<TopTrack[], SongQueueError | DurableObjectError>> {
		return this.call("getTopTracks", (handle) => handle.getTopTracks(limit), TopTracksRpcParsers);
	}

	/** Aggregate one Viewer's Spotify Tracks by stable Track ID. */
	getTopTracksByUser(
		userId: string,
		limit: number,
	): Promise<Result<TopTrack[], SongQueueError | DurableObjectError>> {
		return this.call(
			"getTopTracksByUser",
			(handle) => handle.getTopTracksByUser(userId, limit),
			TopTracksRpcParsers,
		);
	}

	/** Aggregate Viewers by stable Viewer ID using their most recent display name. */
	getTopRequesters(
		limit: number,
	): Promise<Result<TopRequester[], SongQueueError | DurableObjectError>> {
		return this.call(
			"getTopRequesters",
			(handle) => handle.getTopRequesters(limit),
			TopRequestersRpcParsers,
		);
	}
}

/** Create a Song Queue client that classifies namespace, stub, startup, and connectRpc failures. */
export function createSongQueueClient(
	acquireHandle: () => Promise<SongQueueRpcHandleStub>,
): SongQueueClient {
	const acquisition: SongQueueHandleAcquisition = (async () => {
		try {
			return Result.ok(await acquireHandle());
		} catch (cause) {
			return Result.err(
				new DurableObjectError({
					method: "connectRpc",
					message: "Song Queue RPC acquisition failed",
					cause,
				}),
			);
		}
	})();
	return SongQueueClient.fromHandleAcquisition(acquisition);
}
