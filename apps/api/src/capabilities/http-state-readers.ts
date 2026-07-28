import { TaggedError } from "better-result";

import type {
	AchievementDebugTableCounts,
	AchievementDebugUserSnapshot,
	AchievementDefinition,
	AchievementLeaderboardEntry,
	AchievementResetResult,
	UnlockedAchievement,
	ViewerAchievementProgress,
} from "../domain/achievement";
import type { StreamLifecycleState } from "../domain/stream-lifecycle";
import type { Result } from "better-result";

/** Expected failure while reading or transitioning public application state. */
export class ApplicationStateError extends TaggedError("ApplicationStateError")<{
	readonly resource: "stream-lifecycle" | "achievements";
	readonly operation: ApplicationStateOperation;
	readonly failure: "transport" | "protocol" | "remote";
	readonly remoteErrorTag?: string;
	readonly message: string;
	readonly cause?: unknown;
}>() {
	constructor(args: {
		resource: "stream-lifecycle" | "achievements";
		operation: ApplicationStateOperation;
		failure: "transport" | "protocol" | "remote";
		remoteErrorTag?: string;
		cause?: unknown;
	}) {
		super({
			...args,
			message: `Application state operation failed for ${args.resource}.${args.operation} (${args.failure})`,
		});
	}
}

/** Public state operations used for failure classification and tracing. */
export type ApplicationStateOperation =
	| "getStreamState"
	| "markStreamOnline"
	| "markStreamOffline"
	| "getAchievementDefinitions"
	| "getAchievementLeaderboard"
	| "getViewerAchievements"
	| "getViewerUnlockedAchievements"
	| "resetOneTimeAchievements"
	| "getAchievementDebugTableCounts"
	| "getAchievementDebugUserSnapshot";

/** Reads and reconciles durable Stream Lifecycle state. */
export interface StreamLifecycle {
	/** Reads the current Stream Lifecycle State. */
	getStreamState(): Promise<Result<StreamLifecycleState, ApplicationStateError>>;
	/** Marks a Stream Session online at an authoritative timestamp. */
	markStreamOnline(startedAt: string): Promise<Result<void, ApplicationStateError>>;
	/** Marks the active Stream Session offline. */
	markStreamOffline(endedAt?: string): Promise<Result<void, ApplicationStateError>>;
}

/** Administers and diagnoses durable Achievement state. */
export interface AchievementAdministration {
	/** Resets one-time cumulative Achievements for one Viewer or all Viewers. */
	resetOneTimeAchievements(
		viewer?: string,
	): Promise<Result<AchievementResetResult, ApplicationStateError>>;
	/** Reads persistence table counts for Achievement diagnostics. */
	getDebugTableCounts(): Promise<Result<AchievementDebugTableCounts, ApplicationStateError>>;
	/** Reads one Viewer's Achievement persistence diagnostics. */
	getDebugUserSnapshot(
		viewer: string,
	): Promise<Result<AchievementDebugUserSnapshot, ApplicationStateError>>;
}

/** Reads public Achievement Definition, progress, unlock, and ranking projections. */
export interface AchievementReader {
	/** Reads all persisted Achievement Definitions. */
	getDefinitions(): Promise<Result<readonly AchievementDefinition[], ApplicationStateError>>;
	/** Reads the Achievement ranking by unlocked count. */
	getLeaderboard(options: {
		readonly limit: number;
	}): Promise<Result<readonly AchievementLeaderboardEntry[], ApplicationStateError>>;
	/** Reads one Viewer's complete Achievement Progress. */
	getViewerAchievements(
		viewer: string,
	): Promise<Result<readonly ViewerAchievementProgress[], ApplicationStateError>>;
	/** Reads one Viewer's unlocked Achievements. */
	getViewerUnlockedAchievements(
		viewer: string,
	): Promise<Result<readonly UnlockedAchievement[], ApplicationStateError>>;
}
