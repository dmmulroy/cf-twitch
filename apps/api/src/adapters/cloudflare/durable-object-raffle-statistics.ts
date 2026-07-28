import { Result } from "better-result";
import { z } from "zod";

import { KeyboardRaffleRollStoreError } from "../../capabilities/keyboard-raffle-roll-store";
import {
	RaffleStatisticsReadError,
	RaffleViewerNotFoundError,
	type RaffleStatistics,
	type RaffleStatisticsError,
	type RaffleStatisticsOperation,
} from "../../capabilities/raffle-statistics";
import {
	KeyboardRaffleRollSchema,
	RaffleLeaderboardEntrySchema,
	RaffleLeaderboardSchema,
	type RecordKeyboardRaffleRoll,
	type RaffleLeaderboardEntry,
	type RaffleLeaderboardQuery,
} from "../../domain/keyboard-raffle";
import { DurableObjectError } from "../../lib/errors";
import { fromRpcResult, type RpcPayloadParser, type RpcResultParsers } from "../../lib/rpc-result";
import { initializeDurableObjectAgentStub } from "./durable-object-agent-stub";

import type { KeyboardRaffleRollStore } from "../../capabilities/keyboard-raffle-roll-store";
import type { Tracer } from "../../capabilities/tracer";
import type { DurableObjectAgentStub } from "./durable-object-agent-stub";
import type { Result as ResultType } from "better-result";

const RaffleStatisticsWireErrorSchema = z.discriminatedUnion("_tag", [
	z
		.object({
			_tag: z.literal("KeyboardRaffleInputParseError"),
			operation: z.string(),
			issues: z.string(),
			message: z.string(),
		})
		.passthrough(),
	z
		.object({
			_tag: z.literal("KeyboardRaffleDataParseError"),
			operation: z.string(),
			issues: z.string(),
			message: z.string(),
		})
		.passthrough(),
	z
		.object({
			_tag: z.literal("KeyboardRaffleDbError"),
			operation: z.string(),
			message: z.string(),
		})
		.passthrough(),
	z
		.object({
			_tag: z.literal("RollIdempotencyConflictError"),
			message: z.string(),
		})
		.passthrough(),
	z
		.object({
			_tag: z.literal("UserStatsNotFoundError"),
			userId: z.string(),
			message: z.string(),
		})
		.passthrough(),
]);

type RaffleStatisticsWireError = z.infer<typeof RaffleStatisticsWireErrorSchema>;

interface RaffleStatisticsRpcStub extends DurableObjectAgentStub {
	getLeaderboard(options: RaffleLeaderboardQuery): Promise<unknown>;
	getUserStats(viewerId: string): Promise<unknown>;
	getUserStatsByDisplayName(displayName: string): Promise<unknown>;
	recordRoll(input: RecordKeyboardRaffleRoll): Promise<unknown>;
	deleteRollById(rollId: string): Promise<unknown>;
}

function parseRaffleStatisticsPayload<T>(schema: z.ZodType<T>): RpcPayloadParser<T> {
	return (input) => {
		const parsed = schema.safeParse(input);
		return parsed.success ? Result.ok(parsed.data) : Result.err(parsed.error.message);
	};
}

const parseRaffleStatisticsWireError: RpcPayloadParser<RaffleStatisticsWireError> = (input) => {
	const parsed = RaffleStatisticsWireErrorSchema.safeParse(input);
	return parsed.success ? Result.ok(parsed.data) : Result.err(parsed.error.message);
};

function raffleStatisticsRpcParsers<T>(
	schema: z.ZodType<T>,
): RpcResultParsers<T, RaffleStatisticsWireError> {
	return {
		success: parseRaffleStatisticsPayload(schema),
		error: parseRaffleStatisticsWireError,
	};
}

/** Durable Object adapter for runtime-validated Raffle Leaderboard and Viewer-statistics reads. */
export class DurableObjectRaffleStatistics implements RaffleStatistics, KeyboardRaffleRollStore {
	constructor(
		private readonly namespace: Cloudflare.Env["KEYBOARD_RAFFLE_DO"],
		private readonly tracer: Tracer,
	) {}

	/** Records and parses one idempotent Keyboard Raffle Roll. */
	recordRoll(
		input: RecordKeyboardRaffleRoll,
	): Promise<
		ResultType<
			Readonly<{ roll: z.infer<typeof KeyboardRaffleRollSchema>; isNewRecord: boolean }>,
			KeyboardRaffleRollStoreError
		>
	> {
		return this.callRollStore(
			"recordRoll",
			async () => (await this.acquireRaffleStatisticsStub()).recordRoll(input),
			z.object({ roll: KeyboardRaffleRollSchema, isNewRecord: z.boolean() }),
		);
	}

	/** Deletes one Keyboard Raffle Roll during saga compensation. */
	deleteRoll(rollId: string): Promise<ResultType<void, KeyboardRaffleRollStoreError>> {
		return this.callRollStore(
			"deleteRoll",
			async () => (await this.acquireRaffleStatisticsStub()).deleteRollById(rollId),
			z.undefined(),
		);
	}

	/** Reads and parses a bounded Raffle Leaderboard from the singleton durable state. */
	getLeaderboard(
		options: RaffleLeaderboardQuery,
	): Promise<ResultType<readonly RaffleLeaderboardEntry[], RaffleStatisticsError>> {
		return this.call(
			"getLeaderboard",
			async () => (await this.acquireRaffleStatisticsStub()).getLeaderboard(options),
			raffleStatisticsRpcParsers(RaffleLeaderboardSchema),
		);
	}

	/** Reads and parses one Viewer's Keyboard Raffle statistics by stable Viewer ID. */
	getViewerStats(
		viewerId: string,
	): Promise<ResultType<RaffleLeaderboardEntry, RaffleStatisticsError>> {
		return this.call(
			"getViewerStats",
			async () => (await this.acquireRaffleStatisticsStub()).getUserStats(viewerId),
			raffleStatisticsRpcParsers(RaffleLeaderboardEntrySchema),
			viewerId,
		);
	}

	/** Reads and parses one Viewer's Keyboard Raffle statistics by historical display name. */
	getViewerStatsByDisplayName(
		displayName: string,
	): Promise<ResultType<RaffleLeaderboardEntry, RaffleStatisticsError>> {
		return this.call(
			"getViewerStatsByDisplayName",
			async () => (await this.acquireRaffleStatisticsStub()).getUserStatsByDisplayName(displayName),
			raffleStatisticsRpcParsers(RaffleLeaderboardEntrySchema),
			displayName,
		);
	}

	private acquireRaffleStatisticsStub(): Promise<RaffleStatisticsRpcStub> {
		return initializeDurableObjectAgentStub(
			this.namespace.getByName("keyboard-raffle"),
			"keyboard-raffle",
		);
	}

	private async callRollStore<T>(
		operation: "recordRoll" | "deleteRoll",
		invoke: () => Promise<unknown>,
		schema: z.ZodType<T>,
	): Promise<ResultType<T, KeyboardRaffleRollStoreError>> {
		let rawResult: unknown;
		try {
			rawResult = await invoke();
		} catch (cause) {
			return Result.err(
				new KeyboardRaffleRollStoreError({ operation, failure: "transport", cause }),
			);
		}
		const parsed = fromRpcResult(
			rawResult,
			operation === "recordRoll"
				? "KeyboardRaffleDO.recordRoll"
				: "KeyboardRaffleDO.deleteRollById",
			raffleStatisticsRpcParsers(schema),
		);
		if (parsed.status === "ok") return Result.ok(parsed.value);
		return Result.err(
			new KeyboardRaffleRollStoreError({
				operation,
				failure: DurableObjectError.is(parsed.error) ? "protocol" : "remote",
				...(DurableObjectError.is(parsed.error)
					? { cause: parsed.error }
					: { remoteErrorTag: parsed.error._tag }),
			}),
		);
	}

	private call<T>(
		operation: RaffleStatisticsOperation,
		invoke: () => Promise<unknown>,
		parsers: RpcResultParsers<T, RaffleStatisticsWireError>,
		viewerReference?: string,
	): Promise<ResultType<T, RaffleStatisticsError>> {
		return this.tracer.span(
			`durable_object.keyboard_raffle.${operation}`,
			{ operation },
			async () => {
				let rawResult: unknown;
				try {
					rawResult = await invoke();
				} catch (cause) {
					return Result.err(
						new RaffleStatisticsReadError({ operation, failure: "transport", cause }),
					);
				}

				const parsed = fromRpcResult(rawResult, `KeyboardRaffleDO.${operation}`, parsers);
				if (parsed.status === "ok") return Result.ok(parsed.value);
				if (DurableObjectError.is(parsed.error)) {
					return Result.err(
						new RaffleStatisticsReadError({
							operation,
							failure: "protocol",
							cause: parsed.error,
						}),
					);
				}
				return Result.err(this.translateWireError(operation, parsed.error, viewerReference));
			},
		);
	}

	private translateWireError(
		operation: RaffleStatisticsOperation,
		error: RaffleStatisticsWireError,
		viewerReference?: string,
	): RaffleStatisticsError {
		if (error._tag === "UserStatsNotFoundError") {
			return new RaffleViewerNotFoundError({
				operation:
					operation === "getViewerStatsByDisplayName"
						? "getViewerStatsByDisplayName"
						: "getViewerStats",
				viewerReference: viewerReference ?? error.userId,
			});
		}
		return new RaffleStatisticsReadError({
			operation,
			failure: error._tag === "KeyboardRaffleInputParseError" ? "query" : "persistence",
			remoteErrorTag: error._tag,
		});
	}
}
