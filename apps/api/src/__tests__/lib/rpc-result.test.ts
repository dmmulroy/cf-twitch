import { Result } from "better-result";
import { describe, expect, it } from "vite-plus/test";

import { DurableObjectError, SongQueueDbError } from "../../lib/errors";
import { createSongQueueClient } from "../../lib/song-queue-client";
import { GetUserRequestCountResultCodec } from "../../lib/song-queue-rpc-result-codecs";

describe("Song Queue RPC Result codecs", () => {
	it("projects typed Errors into plain clone-safe values", () => {
		const serialized = GetUserRequestCountResultCodec.serializeUnsafe(
			Result.err(new SongQueueDbError({ operation: "persistRequest(event-1)" })),
		);

		expect(serialized.status).toBe("error");
		if (serialized.status === "error") {
			expect(serialized.error).not.toBeInstanceOf(Error);
			expect(serialized.error).toMatchObject({
				_tag: "SongQueueDbError",
				operation: "persistRequest(event-1)",
				message: "Song queue DB error during persistRequest(event-1)",
				name: "SongQueueDbError",
			});
		}
		const cloned = structuredClone(serialized);
		expect(cloned).toMatchObject({
			status: "error",
			error: {
				_tag: "SongQueueDbError",
				operation: "persistRequest(event-1)",
			},
		});

		const deserialized = GetUserRequestCountResultCodec.deserializeUnsafe(cloned);
		expect(deserialized.status).toBe("error");
		if (deserialized.status === "error") {
			expect(deserialized.error).toBeInstanceOf(SongQueueDbError);
			expect(deserialized.error.operation).toBe("persistRequest(event-1)");
		}
	});

	it("panics on malformed success and unknown error payloads at the owned RPC boundary", () => {
		expect(() =>
			GetUserRequestCountResultCodec.deserializeUnsafe({ status: "ok", value: {} }),
		).toThrow();
		expect(() =>
			GetUserRequestCountResultCodec.deserializeUnsafe({
				status: "error",
				error: { _tag: "UnknownError" },
			}),
		).toThrow();
	});

	it("returns acquisition failures through every Song Queue client operation", async () => {
		const client = createSongQueueClient(() => Promise.reject(new Error("cold start failed")));
		const result = await client.getSongQueue(10);
		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toBeInstanceOf(DurableObjectError);
			expect(result.error.message).toContain("Song Queue RPC acquisition failed");
		}
	});
});
