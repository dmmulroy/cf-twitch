import { env } from "cloudflare:workers";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { getStubFromNamespace, parseDurableObjectRpcResult } from "../../lib/durable-objects";
import { VALID_TOKEN_RESPONSE } from "../fixtures/spotify";

describe("parseDurableObjectRpcResult", () => {
	const codec = {
		success: z.object({ count: z.number().int().nonnegative() }),
		error: z.object({
			_tag: z.literal("SongQueueDbError"),
			message: z.string(),
			operation: z.string(),
		}),
	};

	it("rejects a malformed Result envelope", () => {
		const result = parseDurableObjectRpcResult({ status: "ok" }, "getQueue", codec);
		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "DurableObjectRpcProtocolError",
				payloadPart: "envelope",
			});
		}
	});

	it("rejects a malformed method success payload", () => {
		const result = parseDurableObjectRpcResult(
			{ status: "ok", value: { count: -1 } },
			"getQueue",
			codec,
		);
		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "DurableObjectRpcProtocolError",
				payloadPart: "success",
			});
		}
	});

	it("rejects unknown serialized error tags", () => {
		const result = parseDurableObjectRpcResult(
			{ status: "error", error: { _tag: "UnknownRemoteError", message: "unknown" } },
			"getQueue",
			codec,
		);
		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "DurableObjectRpcProtocolError",
				payloadPart: "error",
			});
		}
	});

	it("round-trips a valid method payload", () => {
		const result = parseDurableObjectRpcResult(
			{ status: "ok", value: { count: 2 } },
			"getQueue",
			codec,
		);
		expect(result.status).toBe("ok");
		if (result.status === "ok") expect(result.value).toEqual({ count: 2 });
	});
});

describe("getStubFromNamespace", () => {
	it("uses an explicitly injected binding and validates token RPC payloads", async () => {
		const stub = getStubFromNamespace(
			"SPOTIFY_TOKEN_DO",
			env.SPOTIFY_TOKEN_DO,
			`explicit-token-${crypto.randomUUID()}`,
		);
		const setResult = await stub.setTokens(VALID_TOKEN_RESPONSE);
		expect(setResult.status).toBe("ok");
		const tokenResult = await stub.getValidToken();
		expect(tokenResult.status).toBe("ok");
		if (tokenResult.status === "ok") expect(tokenResult.value).toBe("test-access-token");
	});
});
