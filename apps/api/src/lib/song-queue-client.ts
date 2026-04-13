import { Result } from "better-result";
import { env as globalEnv } from "cloudflare:workers";

import { SONG_QUEUE_DO_NAME } from "../durable-objects/song-queue-do";
import { DurableObjectError } from "./errors";
import { callRpcResult } from "./rpc-result";

import type { InsertPendingRequest } from "../durable-objects/schemas/song-queue-do.schema";
import type {
	CurrentlyPlayingResult,
	QueueResult,
	RequestHistoryResult,
	SongQueueRpcHandleStub,
	TopRequester,
	TopTrack,
} from "../durable-objects/song-queue-do";
import type { Env } from "../index";
import type { SongQueueDbError } from "./errors";

function getEnv(): Env {
	return globalEnv as Env;
}

export class SongQueueClient {
	constructor(private readonly handle: SongQueueRpcHandleStub) {}

	[Symbol.dispose](): void {
		this.handle[Symbol.dispose]?.();
	}

	persistRequest(
		request: InsertPendingRequest,
	): Promise<Result<void, SongQueueDbError | DurableObjectError>> {
		return callRpcResult<void, SongQueueDbError>(
			"persistRequest",
			this.handle.persistRequest(request),
		);
	}

	deleteRequest(eventId: string): Promise<Result<void, SongQueueDbError | DurableObjectError>> {
		return callRpcResult<void, SongQueueDbError>(
			"deleteRequest",
			this.handle.deleteRequest(eventId),
		);
	}

	getSongQueue(limit: number): Promise<Result<QueueResult, SongQueueDbError | DurableObjectError>> {
		return callRpcResult<QueueResult, SongQueueDbError>(
			"getSongQueue",
			this.handle.getSongQueue(limit),
		);
	}

	getCurrentlyPlaying(): Promise<
		Result<CurrentlyPlayingResult, SongQueueDbError | DurableObjectError>
	> {
		return callRpcResult<CurrentlyPlayingResult, SongQueueDbError>(
			"getCurrentlyPlaying",
			this.handle.getCurrentlyPlaying(),
		);
	}

	getRequestHistory(
		limit: number,
		offset = 0,
		since?: string,
		until?: string,
	): Promise<Result<RequestHistoryResult, SongQueueDbError | DurableObjectError>> {
		return callRpcResult<RequestHistoryResult, SongQueueDbError>(
			"getRequestHistory",
			this.handle.getRequestHistory(limit, offset, since, until),
		);
	}

	getUserRequestCount(
		userId: string,
	): Promise<Result<number, SongQueueDbError | DurableObjectError>> {
		return callRpcResult<number, SongQueueDbError>(
			"getUserRequestCount",
			this.handle.getUserRequestCount(userId),
		);
	}

	getUserRequestCountByDisplayName(
		displayName: string,
	): Promise<Result<number, SongQueueDbError | DurableObjectError>> {
		return callRpcResult<number, SongQueueDbError>(
			"getUserRequestCountByDisplayName",
			this.handle.getUserRequestCountByDisplayName(displayName),
		);
	}

	getTopTracks(limit: number): Promise<Result<TopTrack[], SongQueueDbError | DurableObjectError>> {
		return callRpcResult<TopTrack[], SongQueueDbError>(
			"getTopTracks",
			this.handle.getTopTracks(limit),
		);
	}

	getTopTracksByUser(
		userId: string,
		limit: number,
	): Promise<Result<TopTrack[], SongQueueDbError | DurableObjectError>> {
		return callRpcResult<TopTrack[], SongQueueDbError>(
			"getTopTracksByUser",
			this.handle.getTopTracksByUser(userId, limit),
		);
	}

	getTopRequesters(
		limit: number,
	): Promise<Result<TopRequester[], SongQueueDbError | DurableObjectError>> {
		return callRpcResult<TopRequester[], SongQueueDbError>(
			"getTopRequesters",
			this.handle.getTopRequesters(limit),
		);
	}
}

export async function getSongQueue(): Promise<SongQueueClient> {
	const env = getEnv();
	const id = env.SONG_QUEUE_DO.idFromName(SONG_QUEUE_DO_NAME);
	const stub = env.SONG_QUEUE_DO.get(id);
	const handle = await stub.connectRpc();
	return new SongQueueClient(handle);
}
