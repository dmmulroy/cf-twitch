import { Result } from "better-result";
import { z } from "zod";

import { SagaCodecParseError } from "./errors";

/** A primitive value that JSON can represent without coercion or omission. */
export type JsonPrimitive = string | number | boolean | null;

/**
 * A recursively JSON-safe persistence representation.
 *
 * Functions, symbols, `undefined`, and arbitrary class instances are excluded.
 */
export type JsonValue =
	| JsonPrimitive
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };

/**
 * A named, Zod-backed boundary between canonical values and JSON-safe DTOs.
 * Decode and encode failures are returned as expected values.
 */
export interface SagaCodec<T> {
	readonly name: string;
	readonly codec: z.ZodCodec<z.ZodType<JsonValue, JsonValue>, z.ZodType<T>>;

	/** Decodes unknown input into the canonical value that flows inward. */
	parse(raw: unknown): Result<T, SagaCodecParseError>;

	/** Encodes a canonical value into its JSON-safe representation. */
	encode(value: T): Result<JsonValue, SagaCodecParseError>;
}

/**
 * Creates a named codec from a synchronous Zod codec.
 *
 * Unknown decode input is first parsed by the persistence schema. Encoding uses
 * Zod's reverse path, so both directions return typed expected failures.
 */
export function zodSagaCodec<T>(args: {
	readonly name: string;
	readonly codec: z.ZodCodec<z.ZodType<JsonValue, JsonValue>, z.ZodType<T>>;
}): SagaCodec<T> {
	const parseError = (error: z.ZodError): SagaCodecParseError =>
		new SagaCodecParseError({
			codecName: args.name,
			parseError: z.prettifyError(error),
		});

	return {
		name: args.name,
		codec: args.codec,

		parse(raw) {
			try {
				const input = args.codec.in.safeParse(raw);
				if (!input.success) {
					return Result.err(parseError(input.error));
				}

				const parsed = z.safeDecode(args.codec, input.data);
				return parsed.success ? Result.ok(parsed.data) : Result.err(parseError(parsed.error));
			} catch {
				return Result.err(
					new SagaCodecParseError({
						codecName: args.name,
						parseError: "Codec decode failed",
					}),
				);
			}
		},

		encode(value) {
			try {
				const encoded = z.safeEncode(args.codec, value);
				return encoded.success ? Result.ok(encoded.data) : Result.err(parseError(encoded.error));
			} catch {
				return Result.err(
					new SagaCodecParseError({
						codecName: args.name,
						parseError: "Codec encode failed",
					}),
				);
			}
		},
	};
}

/** Identity codec for persisted string values. */
export const stringCodec: SagaCodec<string> = zodSagaCodec({
	name: "string",
	codec: z.codec(z.string(), z.string(), {
		decode: (value) => value,
		encode: (value) => value,
	}),
});

/** Identity codec for persisted finite number values. */
export const numberCodec: SagaCodec<number> = zodSagaCodec({
	name: "number",
	codec: z.codec(z.number(), z.number(), {
		decode: (value) => value,
		encode: (value) => value,
	}),
});

/** Codec for successful operations with no canonical result; persists exactly `null`. */
export const noResultCodec: SagaCodec<void> = zodSagaCodec({
	name: "no-result",
	codec: z.codec(z.null(), z.void(), {
		decode: () => undefined,
		encode: () => null,
	}),
});

/** Alias using the domain's existing `void` result terminology. */
export const voidCodec = noResultCodec;
