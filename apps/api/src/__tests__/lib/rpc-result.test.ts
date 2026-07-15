import { Result } from "better-result";
import { describe, expect, it } from "vite-plus/test";

import { SongQueueDbError } from "../../lib/errors";
import { toRpcResult } from "../../lib/rpc-result";

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
});
