import { describe, expect, it } from "vite-plus/test";

import { DurableObjectSongQueue } from "./durable-object-song-queue";

import type { SongQueueOperation } from "../../capabilities/song-queue";
import type { TraceAttribute, Tracer } from "../../capabilities/tracer";

class RecordingTracer implements Tracer {
	readonly spans: Array<{
		readonly name: string;
		readonly attributes: Readonly<Record<string, TraceAttribute>>;
	}> = [];

	async span<T>(
		name: string,
		attributes: Readonly<Record<string, TraceAttribute>>,
		run: () => Promise<T>,
	): Promise<T> {
		this.spans.push({ name, attributes });
		return run();
	}
}

function songQueueNamespaceReturning(rawResult: unknown): Cloudflare.Env["SONG_QUEUE_DO"] {
	const namespace = {
		idFromName: () => ({ toString: () => "song-queue-id" }),
		get: () => ({
			connectRpc: () =>
				Promise.resolve({
					getCurrentlyPlaying: () => Promise.resolve(rawResult),
				}),
		}),
	};
	// SAFETY: This faithful adapter test double implements only the namespace and RPC methods
	// exercised through the SongQueueReader interface; omitted Cloudflare methods are unreachable.
	return namespace as unknown as Cloudflare.Env["SONG_QUEUE_DO"];
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

	it.each([
		undefined,
		{ status: "ok", value: { track: null, position: 1 } },
		{ status: "error", error: { _tag: "UnknownSongQueueError", message: "bad wire" } },
	])("rejects a malformed complete Now Playing wire contract", async (rawResult) => {
		const songQueue = new DurableObjectSongQueue(
			songQueueNamespaceReturning(rawResult),
			new RecordingTracer(),
		);

		const result = await songQueue.getNowPlaying();

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error._tag).toBe("SongQueueParseError");
			expect(result.error.operation).toBe("getCurrentlyPlaying");
		}
	});

	it("preserves the operation and transport stage when RPC connection fails", async () => {
		const namespace = {
			idFromName: () => ({ toString: () => "song-queue-id" }),
			get: () => ({ connectRpc: () => Promise.reject(new Error("cold start failed")) }),
		};
		// SAFETY: The test double reaches the adapter's connection-failure path before any omitted
		// Cloudflare namespace or Song Queue RPC method can be observed.
		const songQueue = new DurableObjectSongQueue(
			namespace as unknown as Cloudflare.Env["SONG_QUEUE_DO"],
			new RecordingTracer(),
		);

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
