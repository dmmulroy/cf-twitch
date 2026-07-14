import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import { noResultCodec, numberCodec, stringCodec, zodSagaCodec } from "../../lib/codecs";
import { parsePersistedJson, stringifyPersistedJson } from "../../lib/saga-codecs";

describe("saga codecs", () => {
	it("round trips a Date as an ISO string", () => {
		const isoDateCodec = zodSagaCodec({
			name: "iso-date",
			codec: z.codec(z.iso.datetime(), z.date(), {
				decode: (value) => new Date(value),
				encode: (value) => value.toISOString(),
			}),
		});
		const canonical = new Date("2026-07-14T12:34:56.000Z");

		const encoded = isoDateCodec.encode(canonical);
		expect(encoded).toEqual({ status: "ok", value: "2026-07-14T12:34:56.000Z" });

		const decoded = isoDateCodec.parse(
			encoded.status === "ok" ? encoded.value : "encode unexpectedly failed",
		);
		expect(decoded).toEqual({ status: "ok", value: canonical });
	});

	it("rejects values that do not match the schema", () => {
		const result = numberCodec.parse("not a number");

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "SagaCodecParseError",
				codecName: "number",
			});
			expect(result.error.parseError).toContain("expected number");
			expect(result.error.message).not.toContain("not a number");
		}
	});

	it("reports encoding errors", () => {
		const finiteNumberCodec = zodSagaCodec({
			name: "finite-number",
			codec: z.codec(z.number(), z.number(), {
				decode: (value) => value,
				encode: (value) => value,
			}),
		});

		const result = finiteNumberCodec.encode(Number.NaN);

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "SagaCodecParseError",
				codecName: "finite-number",
			});
			expect(result.error.parseError).toContain("expected number");
		}
	});

	it("catches errors thrown by codec transforms", () => {
		const throwingCodec = zodSagaCodec({
			name: "throwing-codec",
			codec: z.codec(z.string(), z.string(), {
				decode: () => {
					throw new Error("secret decode payload");
				},
				encode: () => {
					throw new Error("secret encode payload");
				},
			}),
		});

		const decoded = throwingCodec.parse("valid-input");
		const encoded = throwingCodec.encode("valid-output");

		expect(decoded.status).toBe("error");
		expect(encoded.status).toBe("error");
		if (decoded.status === "error" && encoded.status === "error") {
			expect(decoded.error).toMatchObject({
				_tag: "SagaCodecParseError",
				codecName: "throwing-codec",
				parseError: "Codec decode failed",
			});
			expect(encoded.error).toMatchObject({
				_tag: "SagaCodecParseError",
				codecName: "throwing-codec",
				parseError: "Codec encode failed",
			});
			expect(JSON.stringify([decoded.error, encoded.error])).not.toContain("secret");
			expect(decoded.error).not.toHaveProperty("cause");
			expect(encoded.error).not.toHaveProperty("cause");
		}
	});

	it("leaves strings and numbers unchanged", () => {
		expect(stringCodec.encode("ready")).toEqual({ status: "ok", value: "ready" });
		expect(stringCodec.parse("ready")).toEqual({ status: "ok", value: "ready" });
		expect(numberCodec.encode(42)).toEqual({ status: "ok", value: 42 });
		expect(numberCodec.parse(42)).toEqual({ status: "ok", value: 42 });
	});

	it("stores no result as null", () => {
		expect(noResultCodec.encode(undefined)).toEqual({ status: "ok", value: null });
		expect(noResultCodec.parse(null)).toEqual({ status: "ok", value: undefined });

		const invalid = noResultCodec.parse("undefined");
		expect(invalid.status).toBe("error");
		if (invalid.status === "error") {
			expect(invalid.error.codecName).toBe("no-result");
		}
	});
});

describe("persisted saga JSON", () => {
	it("parses valid JSON", () => {
		expect(
			parsePersistedJson({
				sagaId: "saga-123",
				field: "params",
				codecName: "song-request-params",
				json: '{"track":"abc"}',
			}),
		).toEqual({ status: "ok", value: { track: "abc" } });
	});

	it("does not leak malformed JSON in errors", () => {
		const rawJson = '{"token":"secret-token"';
		const result = parsePersistedJson({
			sagaId: "saga-123",
			field: "step-result",
			stepName: "lookup-track",
			codecName: "spotify-track",
			json: rawJson,
		});

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "SagaPersistedDataError",
				sagaId: "saga-123",
				field: "step-result",
				stepName: "lookup-track",
				codecName: "spotify-track",
			});
			expect(result.error.parseError).toBe("Malformed JSON");
			expect(JSON.stringify(result.error)).not.toContain(rawJson);
			expect(JSON.stringify(result.error)).not.toContain("secret-token");
			expect(result.error).not.toHaveProperty("cause");
		}
	});

	it("stringifies JSON values", () => {
		const result = stringifyPersistedJson({
			sagaId: "saga-123",
			field: "step-undo",
			stepName: "save-request",
			codecName: "request-id",
			value: { id: "request-456", active: true },
		});

		expect(result).toEqual({
			status: "ok",
			value: '{"id":"request-456","active":true}',
		});
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"rejects %s instead of writing null",
		(value) => {
			const result = stringifyPersistedJson({
				sagaId: "saga-123",
				field: "step-result",
				stepName: "calculate",
				codecName: "calculation",
				value,
			});

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error.parseError).toBe("JSON stringification failed");
			}
		},
	);

	it("rejects circular values", () => {
		const cyclic: { [key: string]: import("../../lib/codecs").JsonValue } = {};
		cyclic.self = cyclic;

		const result = stringifyPersistedJson({
			sagaId: "saga-123",
			field: "params",
			codecName: "cyclic-test",
			value: cyclic,
		});

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error).toMatchObject({
				_tag: "SagaPersistedDataError",
				sagaId: "saga-123",
				field: "params",
				codecName: "cyclic-test",
				parseError: "JSON stringification failed",
			});
			expect(result.error).not.toHaveProperty("cause");
		}
	});

	it("reports when JSON.stringify returns undefined", () => {
		const result = stringifyPersistedJson({
			sagaId: "saga-123",
			field: "params",
			codecName: "invalid-runtime-value",
			// @ts-expect-error Runtime defense for callers outside the TypeScript contract.
			value: undefined,
		});

		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error.parseError).toBe("JSON stringification produced no text");
		}
	});
});
