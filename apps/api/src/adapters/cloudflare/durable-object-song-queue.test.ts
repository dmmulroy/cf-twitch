import { describe, expect, it } from "vite-plus/test";

import {
	DurableObjectSongQueue,
	type SongQueueRpcHandle,
	type SongQueueRpcNamespace,
} from "./durable-object-song-queue";

import type { SongQueueOperation } from "../../capabilities/song-queue";
import type { TraceAttributes, Tracer } from "../../capabilities/tracer";
import type { JsonValue } from "../../lib/codecs";

class RecordingTracer implements Tracer {
	readonly spans: Array<{
		readonly name: string;
		readonly attributes: TraceAttributes;
	}> = [];

	async span<T>(name: string, attributes: TraceAttributes, run: () => Promise<T>): Promise<T> {
		this.spans.push({ name, attributes });
		return run();
	}
}

function unsupportedSongQueueRpc(): Promise<never> {
	return Promise.reject(new Error("Unexpected Song Queue RPC method"));
}

function songQueueRpcHandleReturning(rawResult: JsonValue | undefined): SongQueueRpcHandle {
	return {
		persistRequest: unsupportedSongQueueRpc,
		deleteRequest: unsupportedSongQueueRpc,
		getSongQueue: unsupportedSongQueueRpc,
		getCurrentlyPlaying: () => Promise.resolve(rawResult),
		getRequestHistory: unsupportedSongQueueRpc,
		getUserRequestCount: unsupportedSongQueueRpc,
		getUserRequestCountByDisplayName: unsupportedSongQueueRpc,
		getTopTracks: unsupportedSongQueueRpc,
		getTopTracksByUser: unsupportedSongQueueRpc,
		getTopRequesters: unsupportedSongQueueRpc,
	};
}

function songQueueNamespace(
	connectRpc: () => Promise<SongQueueRpcHandle>,
): SongQueueRpcNamespace<string> {
	return {
		idFromName: (name) => name,
		get: () => ({ connectRpc }),
	};
}

function songQueueNamespaceReturning(
	rawResult: JsonValue | undefined,
): SongQueueRpcNamespace<string> {
	return songQueueNamespace(() => Promise.resolve(songQueueRpcHandleReturning(rawResult)));
}

describe("Durable Object Song Queue adapter", () => {
	it("parses Now Playing through the public Song Queue reader and records its RPC span", async () => {
		const tracer = new RecordingTracer();
		const songQueue = new DurableObjectSongQueue(
			songQueueNamespaceReturning({ status: "ok", value: { track: null, position: 0 } }),
			tracer,
		);

		const result = await songQueue.getNowPlaying();

		expect(result.status).toBe("ok");
		if (result.status === "ok") expect(result.value).toEqual({ track: null, position: 0 });
		expect(tracer.spans).toEqual([
			{
				name: "durable_object.song_queue.get_now_playing",
				attributes: {
					operation: "getNowPlaying" satisfies SongQueueOperation,
					rpc_method: "getCurrentlyPlaying",
				},
			},
		]);
	});

	const malformedNowPlayingResults: readonly (JsonValue | undefined)[] = [
		undefined,
		{ status: "ok", value: { track: null, position: 1 } },
		{ status: "error", error: { _tag: "UnknownSongQueueError", message: "bad wire" } },
	];

	it.each(malformedNowPlayingResults)(
		"panics on a malformed owned Now Playing wire contract",
		async (rawResult) => {
			const songQueue = new DurableObjectSongQueue(
				songQueueNamespaceReturning(rawResult),
				new RecordingTracer(),
			);

			await expect(songQueue.getNowPlaying()).rejects.toThrow();
		},
	);

	it("preserves the operation and transport stage when RPC connection fails", async () => {
		const namespace = songQueueNamespace(() => Promise.reject(new Error("cold start failed")));
		const songQueue = new DurableObjectSongQueue(namespace, new RecordingTracer());

		const result = await songQueue.getNowPlaying();

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "SongQueueUnavailableError",
				operation: "getNowPlaying",
				failure: "connect-rpc",
			});
		}
	});
});
