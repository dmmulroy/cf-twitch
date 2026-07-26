import { Result } from "better-result";

import {
	SongQueueReadError,
	SongQueueUnavailableError,
} from "../../capabilities/song-queue-reader";
import { SONG_QUEUE_DO_NAME } from "../../durable-objects/song-queue-do";
import { DurableObjectError } from "../../lib/errors";
import { createSongQueueClient } from "../../lib/song-queue-client";

import type { SongQueueReader, SongQueueReadFailure } from "../../capabilities/song-queue-reader";
import type { CurrentlyPlayingResult } from "../../domain/spotify-queue";

/** Durable Object adapter for the Now Playing Song Queue read capability. */
export class DurableObjectSongQueue implements SongQueueReader {
	constructor(private readonly namespace: Cloudflare.Env["SONG_QUEUE_DO"]) {}

	/** Reads and runtime-validates the complete Song Queue Now Playing RPC result. */
	async getNowPlaying(): Promise<Result<CurrentlyPlayingResult, SongQueueReadFailure>> {
		using client = createSongQueueClient(async () => {
			const id = this.namespace.idFromName(SONG_QUEUE_DO_NAME);
			return this.namespace.get(id).connectRpc();
		});
		const result = await client.getCurrentlyPlaying();
		if (result.status === "ok") return Result.ok(result.value);
		return Result.err(
			DurableObjectError.is(result.error) && result.error.method === "connectRpc"
				? new SongQueueUnavailableError()
				: new SongQueueReadError(),
		);
	}
}
