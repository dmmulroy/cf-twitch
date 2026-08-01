import { Result } from "better-result";

import { KeyboardRaffleRollStoreError } from "../../capabilities/keyboard-raffle-roll-store";
import {
	RaffleStatisticsReadError,
	RaffleViewerNotFoundError,
	type RaffleStatistics,
	type RaffleStatisticsError,
	type RaffleStatisticsOperation,
} from "../../capabilities/raffle-statistics";
import {
	DeleteKeyboardRaffleRollResultCodec,
	GetKeyboardRaffleDisplayNameStatsResultCodec,
	GetKeyboardRaffleLeaderboardResultCodec,
	GetKeyboardRaffleViewerStatsResultCodec,
	RecordKeyboardRaffleRollResultCodec,
} from "../../lib/keyboard-raffle-rpc-result-codecs";
import { initializeDurableObjectAgentStub } from "./durable-object-agent-stub";

import type { KeyboardRaffleRollStore } from "../../capabilities/keyboard-raffle-roll-store";
import type { Tracer } from "../../capabilities/tracer";
import type {
	KeyboardRaffleRoll,
	RecordKeyboardRaffleRoll,
	RaffleLeaderboardEntry,
	RaffleLeaderboardQuery,
} from "../../domain/keyboard-raffle";
import type { DurableObjectAgentStub } from "./durable-object-agent-stub";
import type { Result as ResultType } from "better-result";

type KeyboardRaffleRemoteError = Readonly<{ _tag: string }>;
interface RaffleStatisticsRpcStub extends DurableObjectAgentStub {
	getLeaderboard(options: RaffleLeaderboardQuery): Promise<unknown>;
	getUserStats(viewerId: string): Promise<unknown>;
	getUserStatsByDisplayName(displayName: string): Promise<unknown>;
	recordRoll(input: RecordKeyboardRaffleRoll): Promise<unknown>;
	deleteRollById(rollId: string): Promise<unknown>;
}

/** Durable Object adapter for validated Raffle Leaderboard and Viewer-statistics RPC. */
export class DurableObjectRaffleStatistics implements RaffleStatistics, KeyboardRaffleRollStore {
	constructor(
		private readonly namespace: Cloudflare.Env["KEYBOARD_RAFFLE_DO"],
		private readonly tracer: Tracer,
	) {}

	recordRoll(
		input: RecordKeyboardRaffleRoll,
	): Promise<
		ResultType<
			Readonly<{ roll: KeyboardRaffleRoll; isNewRecord: boolean }>,
			KeyboardRaffleRollStoreError
		>
	> {
		return this.callRollStore(
			"recordRoll",
			async () => (await this.acquireRaffleStatisticsStub()).recordRoll(input),
			(value) => RecordKeyboardRaffleRollResultCodec.deserializeUnsafe(value),
		);
	}

	deleteRoll(rollId: string): Promise<ResultType<void, KeyboardRaffleRollStoreError>> {
		return this.callRollStore(
			"deleteRoll",
			async () => (await this.acquireRaffleStatisticsStub()).deleteRollById(rollId),
			(value) => DeleteKeyboardRaffleRollResultCodec.deserializeUnsafe(value),
		);
	}

	getLeaderboard(
		options: RaffleLeaderboardQuery,
	): Promise<ResultType<readonly RaffleLeaderboardEntry[], RaffleStatisticsError>> {
		return this.call(
			"getLeaderboard",
			async () => (await this.acquireRaffleStatisticsStub()).getLeaderboard(options),
			(value) => GetKeyboardRaffleLeaderboardResultCodec.deserializeUnsafe(value),
		);
	}

	getViewerStats(
		viewerId: string,
	): Promise<ResultType<RaffleLeaderboardEntry, RaffleStatisticsError>> {
		return this.call(
			"getViewerStats",
			async () => (await this.acquireRaffleStatisticsStub()).getUserStats(viewerId),
			(value) => GetKeyboardRaffleViewerStatsResultCodec.deserializeUnsafe(value),
			viewerId,
		);
	}

	getViewerStatsByDisplayName(
		displayName: string,
	): Promise<ResultType<RaffleLeaderboardEntry, RaffleStatisticsError>> {
		return this.call(
			"getViewerStatsByDisplayName",
			async () => (await this.acquireRaffleStatisticsStub()).getUserStatsByDisplayName(displayName),
			(value) => GetKeyboardRaffleDisplayNameStatsResultCodec.deserializeUnsafe(value),
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
		deserializeUnsafe: (
			value: unknown,
		) =>
			| ResultType<T, KeyboardRaffleRemoteError>
			| Promise<ResultType<T, KeyboardRaffleRemoteError>>,
	): Promise<ResultType<T, KeyboardRaffleRollStoreError>> {
		let rawResult: unknown;
		try {
			rawResult = await invoke();
		} catch (cause) {
			return Result.err(
				new KeyboardRaffleRollStoreError({ operation, failure: "transport", cause }),
			);
		}
		const result = await deserializeUnsafe(rawResult);
		return result.status === "ok"
			? Result.ok(result.value)
			: Result.err(
					new KeyboardRaffleRollStoreError({
						operation,
						failure: "remote",
						remoteErrorTag: result.error._tag,
					}),
				);
	}

	private call<T>(
		operation: RaffleStatisticsOperation,
		invoke: () => Promise<unknown>,
		deserializeUnsafe: (
			value: unknown,
		) =>
			| ResultType<T, KeyboardRaffleRemoteError>
			| Promise<ResultType<T, KeyboardRaffleRemoteError>>,
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
				const result = await deserializeUnsafe(rawResult);
				if (result.status === "ok") return Result.ok(result.value);
				if (result.error._tag === "UserStatsNotFoundError") {
					return Result.err(
						new RaffleViewerNotFoundError({
							operation:
								operation === "getViewerStatsByDisplayName"
									? "getViewerStatsByDisplayName"
									: "getViewerStats",
							viewerReference: viewerReference ?? "unknown",
						}),
					);
				}
				return Result.err(
					new RaffleStatisticsReadError({
						operation,
						failure:
							result.error._tag === "KeyboardRaffleInputParseError" ? "query" : "persistence",
						remoteErrorTag: result.error._tag,
					}),
				);
			},
		);
	}
}
