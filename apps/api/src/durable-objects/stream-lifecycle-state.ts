import { z } from "zod";

import type { Clock, IsoTimestamp } from "../lib/clock";

/**
 * Public stream lifecycle response shape returned by StreamLifecycleDO RPC/API callers.
 * Keep this shape stable for compatibility; the precise Agent state lives below.
 */
export interface StreamLifecycleState {
	isLive: boolean;
	startedAt: string | null;
	endedAt: string | null;
	peakViewerCount: number;
}

/**
 * Persisted Agent state for StreamLifecycleDO.
 *
 * The discriminant makes live-only evidence available only in LiveStream and prevents
 * offline state from carrying active session or polling schedule evidence.
 */
export type StreamLifecycleAgentState = OfflineStreamAgentState | LiveStreamAgentState;

/** Stream lifecycle state when there is no active Stream Session. */
export interface OfflineStreamAgentState {
	_tag: "OfflineStream";
	lastStartedAt: IsoTimestamp | null;
	endedAt: IsoTimestamp | null;
	peakViewerCount: number;
}

/** Stream lifecycle state while a Stream Session is active. */
export interface LiveStreamAgentState {
	_tag: "LiveStream";
	streamSessionId: string;
	startedAt: IsoTimestamp;
	peakViewerCount: number;
	viewerPollScheduleId: string | null;
}

const NewPersistedStreamLifecycleStateSchema = z.discriminatedUnion("_tag", [
	z.object({
		_tag: z.literal("OfflineStream"),
		lastStartedAt: z.string().nullable(),
		endedAt: z.string().nullable(),
		peakViewerCount: z.number(),
	}),
	z.object({
		_tag: z.literal("LiveStream"),
		streamSessionId: z.string(),
		startedAt: z.string(),
		peakViewerCount: z.number(),
		viewerPollScheduleId: z.string().nullable(),
	}),
]);

const OldPersistedStreamLifecycleStateSchema = z.object({
	isLive: z.boolean(),
	startedAt: z.string().nullable(),
	endedAt: z.string().nullable(),
	peakViewerCount: z.number(),
	streamSessionId: z.string().nullable(),
	viewerPollScheduleId: z.string().nullable(),
});

function parseNullableIsoTimestamp(input: string | null, clock: Clock): IsoTimestamp | null {
	if (input === null) {
		return null;
	}

	const parsed = clock.parseIsoTimestamp(input);
	if (parsed.status === "ok") {
		return parsed.value;
	}

	return clock.nowIsoTimestamp();
}

/** Create the initial offline state for a new StreamLifecycleDO instance. */
export function initialOfflineState(): OfflineStreamAgentState {
	return {
		_tag: "OfflineStream",
		lastStartedAt: null,
		endedAt: null,
		peakViewerCount: 0,
	};
}

/**
 * Transition an offline stream into an active Stream Session.
 *
 * The caller supplies trusted timestamp evidence and the generated Stream Session id.
 */
export function goOnline(
	state: OfflineStreamAgentState,
	startedAt: IsoTimestamp,
	streamSessionId: string,
): LiveStreamAgentState {
	return {
		_tag: "LiveStream",
		streamSessionId,
		startedAt,
		peakViewerCount: state.peakViewerCount,
		viewerPollScheduleId: null,
	};
}

/**
 * Transition an active Stream Session offline, discarding live-only evidence.
 *
 * The returned state preserves lifecycle history and peak viewers, but cannot carry
 * a Stream Session id or viewer poll schedule.
 */
export function goOffline(
	state: LiveStreamAgentState,
	endedAt: IsoTimestamp,
): OfflineStreamAgentState {
	return {
		_tag: "OfflineStream",
		lastStartedAt: state.startedAt,
		endedAt,
		peakViewerCount: state.peakViewerCount,
	};
}

/**
 * Parse persisted Agent state into precise Stream Lifecycle State.
 *
 * Accepts both the current discriminated union and the legacy nullable shape so old
 * Durable Object state can be migrated lazily at startup.
 */
export function parsePersistedStreamLifecycleState(
	raw: unknown,
	clock: Clock,
): StreamLifecycleAgentState {
	const newState = NewPersistedStreamLifecycleStateSchema.safeParse(raw);
	if (newState.success) {
		if (newState.data._tag === "LiveStream") {
			return {
				_tag: "LiveStream",
				streamSessionId: newState.data.streamSessionId,
				startedAt:
					parseNullableIsoTimestamp(newState.data.startedAt, clock) ?? clock.nowIsoTimestamp(),
				peakViewerCount: newState.data.peakViewerCount,
				viewerPollScheduleId: newState.data.viewerPollScheduleId,
			};
		}

		return {
			_tag: "OfflineStream",
			lastStartedAt: parseNullableIsoTimestamp(newState.data.lastStartedAt, clock),
			endedAt: parseNullableIsoTimestamp(newState.data.endedAt, clock),
			peakViewerCount: newState.data.peakViewerCount,
		};
	}

	const oldState = OldPersistedStreamLifecycleStateSchema.safeParse(raw);
	if (!oldState.success) {
		return initialOfflineState();
	}

	if (oldState.data.isLive) {
		return {
			_tag: "LiveStream",
			streamSessionId: oldState.data.streamSessionId ?? crypto.randomUUID(),
			startedAt:
				parseNullableIsoTimestamp(oldState.data.startedAt, clock) ?? clock.nowIsoTimestamp(),
			peakViewerCount: oldState.data.peakViewerCount,
			viewerPollScheduleId: oldState.data.viewerPollScheduleId,
		};
	}

	return {
		_tag: "OfflineStream",
		lastStartedAt: parseNullableIsoTimestamp(oldState.data.startedAt, clock),
		endedAt: parseNullableIsoTimestamp(oldState.data.endedAt, clock),
		peakViewerCount: oldState.data.peakViewerCount,
	};
}
