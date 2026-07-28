import { Result } from "better-result";
import { z } from "zod";

import {
	ApplicationStateError,
	type AchievementAdministration,
	type AchievementReader,
	type ApplicationStateOperation,
	type StreamLifecycle,
} from "../../capabilities/http-state-readers";
import {
	AchievementDebugTableCountsSchema,
	AchievementDebugUserSnapshotSchema,
	AchievementDefinitionsSchema,
	AchievementLeaderboardSchema,
	AchievementResetResultSchema,
	UnlockedAchievementsSchema,
	ViewerAchievementProgressListSchema,
	type AchievementDebugTableCounts,
	type AchievementDebugUserSnapshot,
	type AchievementDefinition,
	type AchievementLeaderboardEntry,
	type AchievementResetResult,
	type UnlockedAchievement,
	type ViewerAchievementProgress,
} from "../../domain/achievement";
import {
	StreamLifecycleStateSchema,
	type StreamLifecycleState,
} from "../../domain/stream-lifecycle";
import { DurableObjectError } from "../../lib/errors";
import { fromRpcResult, type RpcPayloadParser, type RpcResultParsers } from "../../lib/rpc-result";
import { initializeDurableObjectAgentStub } from "./durable-object-agent-stub";

import type { Tracer } from "../../capabilities/tracer";
import type { DurableObjectAgentStub } from "./durable-object-agent-stub";
import type { Result as ResultType } from "better-result";

const StreamStateWireErrorSchema = z
	.object({ _tag: z.literal("DurableObjectError"), message: z.string() })
	.passthrough();
const StreamTransitionWireErrorSchema = z.discriminatedUnion("_tag", [
	z.object({ _tag: z.literal("InvalidIsoTimestampError"), message: z.string() }).passthrough(),
	z
		.object({ _tag: z.literal("StreamLifecycleEffectsPendingError"), message: z.string() })
		.passthrough(),
]);
const AchievementWireErrorSchema = z.discriminatedUnion("_tag", [
	z.object({ _tag: z.literal("AchievementDbError"), message: z.string() }).passthrough(),
	z.object({ _tag: z.literal("AchievementNotFoundError"), message: z.string() }).passthrough(),
	z
		.object({ _tag: z.literal("AchievementEventValidationError"), message: z.string() })
		.passthrough(),
	z
		.object({ _tag: z.literal("AchievementQueryValidationError"), message: z.string() })
		.passthrough(),
	z.object({ _tag: z.literal("InvalidAchievementRecordError"), message: z.string() }).passthrough(),
]);

type StateWireError = Readonly<{ _tag: string; message: string }>;

const ApplicationStateSpanNames: Readonly<Record<ApplicationStateOperation, string>> = {
	getStreamState: "durable_object.stream_lifecycle.get_stream_state",
	markStreamOnline: "durable_object.stream_lifecycle.mark_stream_online",
	markStreamOffline: "durable_object.stream_lifecycle.mark_stream_offline",
	getAchievementDefinitions: "durable_object.achievements.get_definitions",
	getAchievementLeaderboard: "durable_object.achievements.get_leaderboard",
	getViewerAchievements: "durable_object.achievements.get_viewer_achievements",
	getViewerUnlockedAchievements: "durable_object.achievements.get_viewer_unlocked_achievements",
	resetOneTimeAchievements: "durable_object.achievements.reset_one_time_achievements",
	getAchievementDebugTableCounts: "durable_object.achievements.get_debug_table_counts",
	getAchievementDebugUserSnapshot: "durable_object.achievements.get_debug_user_snapshot",
};

interface StreamLifecycleRpcStub extends DurableObjectAgentStub {
	getStreamState(): Promise<unknown>;
	onStreamOnline(startedAt: string): Promise<unknown>;
	onStreamOffline(endedAt?: string): Promise<unknown>;
}

interface AchievementReaderRpcStub extends DurableObjectAgentStub {
	getDefinitions(): Promise<unknown>;
	getLeaderboard(options: { readonly limit: number }): Promise<unknown>;
	getUserAchievements(viewer: string): Promise<unknown>;
	getUnlockedAchievements(viewer: string): Promise<unknown>;
	resetOneTimeAchievements(viewer?: string): Promise<unknown>;
	getDebugTableCounts(): Promise<unknown>;
	getDebugUserSnapshot(viewer: string): Promise<unknown>;
}

function parseStatePayload<T>(schema: z.ZodType<T>): RpcPayloadParser<T> {
	return (input) => {
		const parsed = schema.safeParse(input);
		return parsed.success ? Result.ok(parsed.data) : Result.err(parsed.error.message);
	};
}

function stateRpcParsers<T, E extends StateWireError>(
	successSchema: z.ZodType<T>,
	errorSchema: z.ZodType<E>,
): RpcResultParsers<T, E> {
	return {
		success: parseStatePayload(successSchema),
		error: parseStatePayload(errorSchema),
	};
}

/** Durable Object adapter for runtime-validated Stream Lifecycle reads and transitions. */
export class DurableObjectStreamLifecycle implements StreamLifecycle {
	constructor(
		private readonly namespace: Cloudflare.Env["STREAM_LIFECYCLE_DO"],
		private readonly tracer: Tracer,
	) {}

	/** Reads and parses the current Stream Lifecycle State. */
	getStreamState(): Promise<ResultType<StreamLifecycleState, ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "stream-lifecycle",
			operation: "getStreamState",
			tracer: this.tracer,
			invoke: async () => (await this.acquireStreamLifecycleStub()).getStreamState(),
			parsers: stateRpcParsers(StreamLifecycleStateSchema, StreamStateWireErrorSchema),
		});
	}

	/** Marks a Stream Session online at its authoritative Twitch timestamp. */
	markStreamOnline(startedAt: string): Promise<ResultType<void, ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "stream-lifecycle",
			operation: "markStreamOnline",
			tracer: this.tracer,
			invoke: async () => (await this.acquireStreamLifecycleStub()).onStreamOnline(startedAt),
			parsers: stateRpcParsers(z.undefined(), StreamTransitionWireErrorSchema),
		});
	}

	/** Marks the active Stream Session offline. */
	markStreamOffline(endedAt?: string): Promise<ResultType<void, ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "stream-lifecycle",
			operation: "markStreamOffline",
			tracer: this.tracer,
			invoke: async () => (await this.acquireStreamLifecycleStub()).onStreamOffline(endedAt),
			parsers: stateRpcParsers(z.undefined(), StreamTransitionWireErrorSchema),
		});
	}

	private acquireStreamLifecycleStub(): Promise<StreamLifecycleRpcStub> {
		return initializeDurableObjectAgentStub(
			this.namespace.getByName("stream-lifecycle"),
			"stream-lifecycle",
		);
	}
}

/** Durable Object adapter for runtime-validated public Achievement projections. */
export class DurableObjectAchievementReader
	implements AchievementReader, AchievementAdministration
{
	constructor(
		private readonly namespace: Cloudflare.Env["ACHIEVEMENTS_DO"],
		private readonly tracer: Tracer,
	) {}

	/** Resets one-time cumulative Achievements for one Viewer or all Viewers. */
	resetOneTimeAchievements(
		viewer?: string,
	): Promise<ResultType<AchievementResetResult, ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "achievements",
			operation: "resetOneTimeAchievements",
			tracer: this.tracer,
			invoke: async () =>
				(await this.acquireAchievementReaderStub()).resetOneTimeAchievements(viewer),
			parsers: stateRpcParsers(AchievementResetResultSchema, AchievementWireErrorSchema),
		});
	}

	/** Reads Achievement persistence table counts for administrators. */
	getDebugTableCounts(): Promise<ResultType<AchievementDebugTableCounts, ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "achievements",
			operation: "getAchievementDebugTableCounts",
			tracer: this.tracer,
			invoke: async () => (await this.acquireAchievementReaderStub()).getDebugTableCounts(),
			parsers: stateRpcParsers(AchievementDebugTableCountsSchema, AchievementWireErrorSchema),
		});
	}

	/** Reads one Viewer's Achievement persistence diagnostics. */
	getDebugUserSnapshot(
		viewer: string,
	): Promise<ResultType<AchievementDebugUserSnapshot, ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "achievements",
			operation: "getAchievementDebugUserSnapshot",
			tracer: this.tracer,
			invoke: async () => (await this.acquireAchievementReaderStub()).getDebugUserSnapshot(viewer),
			parsers: stateRpcParsers(AchievementDebugUserSnapshotSchema, AchievementWireErrorSchema),
		});
	}

	/** Reads and parses all persisted Achievement Definitions. */
	getDefinitions(): Promise<ResultType<readonly AchievementDefinition[], ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "achievements",
			operation: "getAchievementDefinitions",
			tracer: this.tracer,
			invoke: async () => (await this.acquireAchievementReaderStub()).getDefinitions(),
			parsers: stateRpcParsers(AchievementDefinitionsSchema, AchievementWireErrorSchema),
		});
	}

	/** Reads and parses the Achievement ranking with a bounded result count. */
	getLeaderboard(options: {
		readonly limit: number;
	}): Promise<ResultType<readonly AchievementLeaderboardEntry[], ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "achievements",
			operation: "getAchievementLeaderboard",
			tracer: this.tracer,
			invoke: async () => (await this.acquireAchievementReaderStub()).getLeaderboard(options),
			parsers: stateRpcParsers(AchievementLeaderboardSchema, AchievementWireErrorSchema),
		});
	}

	/** Reads and parses one Viewer's complete Achievement Progress. */
	getViewerAchievements(
		viewer: string,
	): Promise<ResultType<readonly ViewerAchievementProgress[], ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "achievements",
			operation: "getViewerAchievements",
			tracer: this.tracer,
			invoke: async () => (await this.acquireAchievementReaderStub()).getUserAchievements(viewer),
			parsers: stateRpcParsers(ViewerAchievementProgressListSchema, AchievementWireErrorSchema),
		});
	}

	/** Reads and parses one Viewer's unlocked Achievements. */
	getViewerUnlockedAchievements(
		viewer: string,
	): Promise<ResultType<readonly UnlockedAchievement[], ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "achievements",
			operation: "getViewerUnlockedAchievements",
			tracer: this.tracer,
			invoke: async () =>
				(await this.acquireAchievementReaderStub()).getUnlockedAchievements(viewer),
			parsers: stateRpcParsers(UnlockedAchievementsSchema, AchievementWireErrorSchema),
		});
	}

	private acquireAchievementReaderStub(): Promise<AchievementReaderRpcStub> {
		return initializeDurableObjectAgentStub(
			this.namespace.getByName("achievements"),
			"achievements",
		);
	}
}

type ApplicationStateRpcCall<T, E extends StateWireError> = Readonly<{
	resource: "stream-lifecycle" | "achievements";
	operation: ApplicationStateOperation;
	tracer: Tracer;
	invoke: () => Promise<unknown>;
	parsers: RpcResultParsers<T, E>;
}>;

async function callApplicationStateRpc<T, E extends StateWireError>(
	call: ApplicationStateRpcCall<T, E>,
): Promise<ResultType<T, ApplicationStateError>> {
	return call.tracer.span(
		ApplicationStateSpanNames[call.operation],
		{ operation: call.operation, resource: call.resource },
		async () => {
			let rawResult: unknown;
			try {
				rawResult = await call.invoke();
			} catch (cause) {
				return Result.err(
					new ApplicationStateError({
						resource: call.resource,
						operation: call.operation,
						failure: "transport",
						cause,
					}),
				);
			}

			const parsed = fromRpcResult(rawResult, call.operation, call.parsers);
			if (parsed.status === "ok") return Result.ok(parsed.value);
			if (DurableObjectError.is(parsed.error)) {
				return Result.err(
					new ApplicationStateError({
						resource: call.resource,
						operation: call.operation,
						failure: "protocol",
						cause: parsed.error,
					}),
				);
			}
			return Result.err(
				new ApplicationStateError({
					resource: call.resource,
					operation: call.operation,
					failure: "remote",
					remoteErrorTag: parsed.error._tag,
				}),
			);
		},
	);
}
