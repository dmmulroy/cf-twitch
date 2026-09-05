import { Result } from "better-result";

import {
	ApplicationStateError,
	type AchievementAdministration,
	type AchievementReader,
	type ApplicationStateOperation,
	type StreamLifecycle,
} from "../../capabilities/http-state-readers";
import {
	type AchievementDebugTableCounts,
	type AchievementDebugUserSnapshot,
	type AchievementDefinition,
	type AchievementLeaderboardEntry,
	type AchievementResetResult,
	type UnlockedAchievement,
	type ViewerAchievementProgress,
} from "../../domain/achievement";
import {
	GetAchievementDefinitionsResultCodec,
	GetAchievementLeaderboardResultCodec,
	GetAchievementTableCountsResultCodec,
	GetAchievementUserSnapshotResultCodec,
	GetUnlockedAchievementsResultCodec,
	GetViewerAchievementsResultCodec,
	ResetOneTimeAchievementsResultCodec,
} from "../../lib/achievement-rpc-result-codecs";
import {
	GetStreamLifecycleStateResultCodec,
	StreamOfflineResultCodec,
	StreamOnlineResultCodec,
} from "../../lib/stream-lifecycle-rpc-result-codecs";
import { initializeDurableObjectAgentStub } from "./durable-object-agent-stub";

import type { Tracer } from "../../capabilities/tracer";
import type { StreamLifecycleState } from "../../domain/stream-lifecycle";
import type { RpcWireValue } from "../../lib/rpc-result";
import type { DurableObjectAgentStub } from "./durable-object-agent-stub";

type StateRpcError = Readonly<{ _tag: string }>;

const ApplicationStateSpanNames = {
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
} as const satisfies Readonly<{
	[Operation in ApplicationStateOperation]: string;
}>;

interface StreamLifecycleRpcStub extends DurableObjectAgentStub {
	getStreamState(): Promise<RpcWireValue>;
	onStreamOnline(startedAt: string): Promise<RpcWireValue>;
	onStreamOffline(endedAt?: string): Promise<RpcWireValue>;
}

interface AchievementReaderRpcStub extends DurableObjectAgentStub {
	getDefinitions(): Promise<RpcWireValue>;
	getLeaderboard(options: { readonly limit: number }): Promise<RpcWireValue>;
	getUserAchievements(viewer: string): Promise<RpcWireValue>;
	getUnlockedAchievements(viewer: string): Promise<RpcWireValue>;
	resetOneTimeAchievements(viewer?: string): Promise<RpcWireValue>;
	getDebugTableCounts(): Promise<RpcWireValue>;
	getDebugUserSnapshot(viewer: string): Promise<RpcWireValue>;
}

/** Durable Object adapter for runtime-validated Stream Lifecycle reads and transitions. */
export class DurableObjectStreamLifecycle implements StreamLifecycle {
	constructor(
		private readonly namespace: Cloudflare.Env["STREAM_LIFECYCLE_DO"],
		private readonly tracer: Tracer,
	) {}

	/** Reads and parses the current Stream Lifecycle State. */
	getStreamState(): Promise<Result<StreamLifecycleState, ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "stream-lifecycle",
			operation: "getStreamState",
			tracer: this.tracer,
			invoke: async () => (await this.acquireStreamLifecycleStub()).getStreamState(),
			deserializeUnsafe: (value) => GetStreamLifecycleStateResultCodec.deserializeUnsafe(value),
		});
	}

	/** Marks a Stream Session online at its authoritative Twitch timestamp. */
	markStreamOnline(startedAt: string): Promise<Result<void, ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "stream-lifecycle",
			operation: "markStreamOnline",
			tracer: this.tracer,
			invoke: async () => (await this.acquireStreamLifecycleStub()).onStreamOnline(startedAt),
			deserializeUnsafe: (value) => StreamOnlineResultCodec.deserializeUnsafe(value),
		});
	}

	/** Marks the active Stream Session offline. */
	markStreamOffline(endedAt?: string): Promise<Result<void, ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "stream-lifecycle",
			operation: "markStreamOffline",
			tracer: this.tracer,
			invoke: async () => (await this.acquireStreamLifecycleStub()).onStreamOffline(endedAt),
			deserializeUnsafe: (value) => StreamOfflineResultCodec.deserializeUnsafe(value),
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
	): Promise<Result<AchievementResetResult, ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "achievements",
			operation: "resetOneTimeAchievements",
			tracer: this.tracer,
			invoke: async () =>
				(await this.acquireAchievementReaderStub()).resetOneTimeAchievements(viewer),
			deserializeUnsafe: (value) => ResetOneTimeAchievementsResultCodec.deserializeUnsafe(value),
		});
	}

	/** Reads Achievement persistence table counts for administrators. */
	getDebugTableCounts(): Promise<Result<AchievementDebugTableCounts, ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "achievements",
			operation: "getAchievementDebugTableCounts",
			tracer: this.tracer,
			invoke: async () => (await this.acquireAchievementReaderStub()).getDebugTableCounts(),
			deserializeUnsafe: (value) => GetAchievementTableCountsResultCodec.deserializeUnsafe(value),
		});
	}

	/** Reads one Viewer's Achievement persistence diagnostics. */
	getDebugUserSnapshot(
		viewer: string,
	): Promise<Result<AchievementDebugUserSnapshot, ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "achievements",
			operation: "getAchievementDebugUserSnapshot",
			tracer: this.tracer,
			invoke: async () => (await this.acquireAchievementReaderStub()).getDebugUserSnapshot(viewer),
			deserializeUnsafe: (value) => GetAchievementUserSnapshotResultCodec.deserializeUnsafe(value),
		});
	}

	/** Reads and parses all persisted Achievement Definitions. */
	getDefinitions(): Promise<Result<readonly AchievementDefinition[], ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "achievements",
			operation: "getAchievementDefinitions",
			tracer: this.tracer,
			invoke: async () => (await this.acquireAchievementReaderStub()).getDefinitions(),
			deserializeUnsafe: (value) => GetAchievementDefinitionsResultCodec.deserializeUnsafe(value),
		});
	}

	/** Reads and parses the Achievement ranking with a bounded result count. */
	getLeaderboard(options: {
		readonly limit: number;
	}): Promise<Result<readonly AchievementLeaderboardEntry[], ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "achievements",
			operation: "getAchievementLeaderboard",
			tracer: this.tracer,
			invoke: async () => (await this.acquireAchievementReaderStub()).getLeaderboard(options),
			deserializeUnsafe: (value) => GetAchievementLeaderboardResultCodec.deserializeUnsafe(value),
		});
	}

	/** Reads and parses one Viewer's complete Achievement Progress. */
	getViewerAchievements(
		viewer: string,
	): Promise<Result<readonly ViewerAchievementProgress[], ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "achievements",
			operation: "getViewerAchievements",
			tracer: this.tracer,
			invoke: async () => (await this.acquireAchievementReaderStub()).getUserAchievements(viewer),
			deserializeUnsafe: (value) => GetViewerAchievementsResultCodec.deserializeUnsafe(value),
		});
	}

	/** Reads and parses one Viewer's unlocked Achievements. */
	getViewerUnlockedAchievements(
		viewer: string,
	): Promise<Result<readonly UnlockedAchievement[], ApplicationStateError>> {
		return callApplicationStateRpc({
			resource: "achievements",
			operation: "getViewerUnlockedAchievements",
			tracer: this.tracer,
			invoke: async () =>
				(await this.acquireAchievementReaderStub()).getUnlockedAchievements(viewer),
			deserializeUnsafe: (value) => GetUnlockedAchievementsResultCodec.deserializeUnsafe(value),
		});
	}

	private acquireAchievementReaderStub(): Promise<AchievementReaderRpcStub> {
		return initializeDurableObjectAgentStub(
			this.namespace.getByName("achievements"),
			"achievements",
		);
	}
}

type ApplicationStateRpcCall<T, E extends StateRpcError, WireValue> = Readonly<{
	resource: "stream-lifecycle" | "achievements";
	operation: ApplicationStateOperation;
	tracer: Tracer;
	invoke: () => Promise<WireValue>;
	deserializeUnsafe: (value: WireValue) => Result<T, E> | Promise<Result<T, E>>;
}>;

async function callApplicationStateRpc<T, E extends StateRpcError, WireValue>(
	call: ApplicationStateRpcCall<T, E, WireValue>,
): Promise<Result<T, ApplicationStateError>> {
	return call.tracer.span(
		ApplicationStateSpanNames[call.operation],
		{ operation: call.operation, resource: call.resource },
		async () => {
			let rawResult: WireValue;
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

			const parsed = await call.deserializeUnsafe(rawResult);
			if (parsed.status === "ok") return Result.ok(parsed.value);
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
