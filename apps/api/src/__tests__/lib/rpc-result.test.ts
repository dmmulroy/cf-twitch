import { Result } from "better-result";
import { describe, expect, it } from "vite-plus/test";

import { DurableObjectError, SongQueueDbError } from "../../lib/errors";
import { fromRpcResult, toRpcResult, type RpcPayloadParser } from "../../lib/rpc-result";
import { createSongQueueClient } from "../../lib/song-queue-client";

describe("toRpcResult", () => {
	it("projects typed Errors into plain clone-safe values", () => {
		const serialized = toRpcResult(
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
		expect(structuredClone(serialized)).toMatchObject({
			status: "error",
			error: {
				_tag: "SongQueueDbError",
				operation: "persistRequest(event-1)",
			},
		});
	});

	it("rejects malformed success and unknown error payloads at the RPC boundary", () => {
		const numberParser: RpcPayloadParser<number> = (value) =>
			typeof value === "number" ? Result.ok(value) : Result.err("expected number");
		const errorParser: RpcPayloadParser<SongQueueDbError> = (value) =>
			value instanceof SongQueueDbError
				? Result.ok(value)
				: Result.err("expected SongQueueDbError");

		const malformedSuccess = fromRpcResult({ status: "ok", value: {} }, "count", {
			success: numberParser,
			error: errorParser,
		});
		const unknownError = fromRpcResult(
			{ status: "error", error: { _tag: "UnknownError" } },
			"count",
			{ success: numberParser, error: errorParser },
		);

		expect(malformedSuccess.status).toBe("error");
		expect(unknownError.status).toBe("error");
		if (malformedSuccess.status === "error")
			expect(malformedSuccess.error._tag).toBe("DurableObjectError");
		if (unknownError.status === "error") expect(unknownError.error._tag).toBe("DurableObjectError");
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
