import { Result } from "better-result";

import { type JsonValue } from "./codecs";
import { SagaPersistedDataError, type SagaPersistedField } from "./errors";

/** Context identifying one serialized value at the saga persistence boundary. */
export interface SagaPersistedDataContext {
	readonly sagaId: string;
	readonly field: SagaPersistedField;
	readonly stepName?: string;
	readonly codecName: string;
}

/** Arguments for parsing persisted saga JSON text. */
export interface ParsePersistedJsonArgs extends SagaPersistedDataContext {
	readonly json: string;
}

/** Arguments for stringifying an encoded JSON-safe saga DTO. */
export interface StringifyPersistedJsonArgs extends SagaPersistedDataContext {
	readonly value: JsonValue;
}

/**
 * Parses JSON text from saga persistence into unknown boundary input.
 * Malformed text is not retained in the safe error projection.
 */
export function parsePersistedJson(
	args: ParsePersistedJsonArgs,
): Result<unknown, SagaPersistedDataError> {
	try {
		const parsed: unknown = JSON.parse(args.json);
		return Result.ok(parsed);
	} catch {
		return Result.err(
			new SagaPersistedDataError({
				sagaId: args.sagaId,
				field: args.field,
				stepName: args.stepName,
				codecName: args.codecName,
				parseError: "Malformed JSON",
			}),
		);
	}
}

/**
 * Stringifies an encoded saga DTO without assuming JSON produced text.
 * Stringification defects are translated to safe persisted-data errors.
 */
export function stringifyPersistedJson(
	args: StringifyPersistedJsonArgs,
): Result<string, SagaPersistedDataError> {
	let json: string | undefined;
	try {
		json = JSON.stringify(args.value, (_key: string, value: unknown): unknown => {
			if (typeof value === "number" && !Number.isFinite(value)) {
				throw new Error("Non-finite numbers are not JSON-safe");
			}
			return value;
		});
	} catch {
		return Result.err(
			new SagaPersistedDataError({
				sagaId: args.sagaId,
				field: args.field,
				stepName: args.stepName,
				codecName: args.codecName,
				parseError: "JSON stringification failed",
			}),
		);
	}

	if (json === undefined) {
		return Result.err(
			new SagaPersistedDataError({
				sagaId: args.sagaId,
				field: args.field,
				stepName: args.stepName,
				codecName: args.codecName,
				parseError: "JSON stringification produced no text",
			}),
		);
	}

	return Result.ok(json);
}
