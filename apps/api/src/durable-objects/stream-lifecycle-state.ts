import { Result, TaggedError } from "better-result";
import { z } from "zod";

import type { Clock, IsoTimestamp } from "../lib/clock";

/** Durable completion evidence for every side effect of one stream transition. */
export interface StreamLifecycleTransitionIntent {
	readonly _tag: "StreamOnlineIntent" | "StreamOfflineIntent";
	readonly eventId: string;
	readonly streamSessionId: string;
	readonly transitionAt: IsoTimestamp;
	readonly viewerPollScheduleId: string | null;
	readonly spotifyTokenNotified: boolean;
	readonly twitchTokenNotified: boolean;
	readonly lifecycleEventPublished: boolean;
	readonly viewerPollingUpdated: boolean;
}

/** Persisted Stream Lifecycle State with live-only evidence encoded by its discriminant. */
export type StreamLifecycleAgentState = OfflineStreamAgentState | LiveStreamAgentState;

/** Stream lifecycle state when there is no active Stream Session. */
export interface OfflineStreamAgentState {
	readonly _tag: "OfflineStream";
	readonly lastStartedAt: IsoTimestamp | null;
	readonly endedAt: IsoTimestamp | null;
	readonly peakViewerCount: number;
	readonly transitionIntent: StreamLifecycleTransitionIntent | null;
}

/** Stream lifecycle state while a Stream Session is active. */
export interface LiveStreamAgentState {
	readonly _tag: "LiveStream";
	readonly streamSessionId: string;
	readonly startedAt: IsoTimestamp;
	readonly peakViewerCount: number;
	readonly viewerPollScheduleId: string | null;
	readonly transitionIntent: StreamLifecycleTransitionIntent | null;
}

/** Explicit corruption error for invalid current or legacy Stream Lifecycle persisted state. */
export class PersistedStreamLifecycleStateError extends TaggedError(
	"PersistedStreamLifecycleStateError",
)<{
	message: string;
	parseError: string;
}> {
	constructor(parseError: string) {
		super({
			message: `Stream Lifecycle persisted state parse failed: ${parseError}`,
			parseError,
		});
	}
}

const TransitionIntentRecordSchema = z.object({
	_tag: z.enum(["StreamOnlineIntent", "StreamOfflineIntent"]),
	eventId: z.string().min(1),
	streamSessionId: z.string().min(1),
	transitionAt: z.string().min(1),
	viewerPollScheduleId: z.string().min(1).nullable(),
	spotifyTokenNotified: z.boolean(),
	twitchTokenNotified: z.boolean(),
	lifecycleEventPublished: z.boolean(),
	viewerPollingUpdated: z.boolean(),
});

const CurrentPersistedStreamLifecycleStateSchema = z.discriminatedUnion("_tag", [
	z.object({
		_tag: z.literal("OfflineStream"),
		lastStartedAt: z.string().nullable(),
		endedAt: z.string().nullable(),
		peakViewerCount: z.number().int().nonnegative(),
		transitionIntent: TransitionIntentRecordSchema.nullable().optional(),
	}),
	z.object({
		_tag: z.literal("LiveStream"),
		streamSessionId: z.string().min(1),
		startedAt: z.string(),
		peakViewerCount: z.number().int().nonnegative(),
		viewerPollScheduleId: z.string().min(1).nullable(),
		transitionIntent: TransitionIntentRecordSchema.nullable().optional(),
	}),
]);

const LegacyPersistedStreamLifecycleStateSchema = z.object({
	isLive: z.boolean(),
	startedAt: z.string().nullable(),
	endedAt: z.string().nullable(),
	peakViewerCount: z.number().int().nonnegative(),
	streamSessionId: z.string().min(1).nullable(),
	viewerPollScheduleId: z.string().min(1).nullable(),
});

function parseTimestamp(
	input: string,
	clock: Clock,
): Result<IsoTimestamp, PersistedStreamLifecycleStateError> {
	const parsed = clock.parseIsoTimestamp(input);
	return parsed.status === "ok"
		? Result.ok(parsed.value)
		: Result.err(new PersistedStreamLifecycleStateError(parsed.error.message));
}

function parseNullableTimestamp(
	input: string | null,
	clock: Clock,
): Result<IsoTimestamp | null, PersistedStreamLifecycleStateError> {
	if (input === null) return Result.ok(null);
	return parseTimestamp(input, clock);
}

function parseTransitionIntent(
	input: z.infer<typeof TransitionIntentRecordSchema> | null | undefined,
	clock: Clock,
): Result<StreamLifecycleTransitionIntent | null, PersistedStreamLifecycleStateError> {
	if (input === null || input === undefined) return Result.ok(null);
	const transitionAt = parseTimestamp(input.transitionAt, clock);
	return transitionAt.status === "error"
		? transitionAt
		: Result.ok({ ...input, transitionAt: transitionAt.value });
}

/** Create the initial offline state for a new StreamLifecycleDO instance. */
export function initialOfflineState(): OfflineStreamAgentState {
	return {
		_tag: "OfflineStream",
		lastStartedAt: null,
		endedAt: null,
		peakViewerCount: 0,
		transitionIntent: null,
	};
}

/** Create an online Stream Session and its atomically persisted side-effect intent. */
export function goOnline(
	state: OfflineStreamAgentState,
	startedAt: IsoTimestamp,
	streamSessionId: string,
	eventId: string,
): LiveStreamAgentState {
	return {
		_tag: "LiveStream",
		streamSessionId,
		startedAt,
		peakViewerCount: state.peakViewerCount,
		viewerPollScheduleId: null,
		transitionIntent: {
			_tag: "StreamOnlineIntent",
			eventId,
			streamSessionId,
			transitionAt: startedAt,
			viewerPollScheduleId: null,
			spotifyTokenNotified: false,
			twitchTokenNotified: false,
			lifecycleEventPublished: false,
			viewerPollingUpdated: false,
		},
	};
}

/** End an active Stream Session and atomically persist its side-effect intent. */
export function goOffline(
	state: LiveStreamAgentState,
	endedAt: IsoTimestamp,
	eventId: string,
): OfflineStreamAgentState {
	return {
		_tag: "OfflineStream",
		lastStartedAt: state.startedAt,
		endedAt,
		peakViewerCount: state.peakViewerCount,
		transitionIntent: {
			_tag: "StreamOfflineIntent",
			eventId,
			streamSessionId: state.streamSessionId,
			transitionAt: endedAt,
			viewerPollScheduleId: state.viewerPollScheduleId,
			spotifyTokenNotified: false,
			twitchTokenNotified: false,
			lifecycleEventPublished: false,
			viewerPollingUpdated: false,
		},
	};
}

/** Parse current or legacy serialized Stream Lifecycle State without manufacturing evidence. */
export function parsePersistedStreamLifecycleState(
	raw: unknown,
	clock: Clock,
): Result<StreamLifecycleAgentState, PersistedStreamLifecycleStateError> {
	const current = CurrentPersistedStreamLifecycleStateSchema.safeParse(raw);
	if (current.success) {
		const intent = parseTransitionIntent(current.data.transitionIntent, clock);
		if (intent.status === "error") return intent;
		if (current.data._tag === "LiveStream") {
			const startedAt = parseTimestamp(current.data.startedAt, clock);
			if (startedAt.status === "error") return startedAt;
			if (
				intent.value !== null &&
				(intent.value._tag !== "StreamOnlineIntent" ||
					intent.value.streamSessionId !== current.data.streamSessionId ||
					intent.value.transitionAt !== startedAt.value)
			) {
				return Result.err(
					new PersistedStreamLifecycleStateError(
						"Live state requires a matching online transition intent",
					),
				);
			}
			return Result.ok({
				_tag: "LiveStream",
				streamSessionId: current.data.streamSessionId,
				startedAt: startedAt.value,
				peakViewerCount: current.data.peakViewerCount,
				viewerPollScheduleId: current.data.viewerPollScheduleId,
				transitionIntent: intent.value,
			});
		}

		const lastStartedAt = parseNullableTimestamp(current.data.lastStartedAt, clock);
		if (lastStartedAt.status === "error") return lastStartedAt;
		const endedAt = parseNullableTimestamp(current.data.endedAt, clock);
		if (endedAt.status === "error") return endedAt;
		if (
			intent.value !== null &&
			(intent.value._tag !== "StreamOfflineIntent" ||
				endedAt.value === null ||
				intent.value.transitionAt !== endedAt.value)
		) {
			return Result.err(
				new PersistedStreamLifecycleStateError(
					"Offline state requires a matching offline transition intent",
				),
			);
		}
		return Result.ok({
			_tag: "OfflineStream",
			lastStartedAt: lastStartedAt.value,
			endedAt: endedAt.value,
			peakViewerCount: current.data.peakViewerCount,
			transitionIntent: intent.value,
		});
	}

	const legacy = LegacyPersistedStreamLifecycleStateSchema.safeParse(raw);
	if (!legacy.success) {
		return Result.err(new PersistedStreamLifecycleStateError(legacy.error.message));
	}
	const startedAt = parseNullableTimestamp(legacy.data.startedAt, clock);
	if (startedAt.status === "error") return startedAt;
	const endedAt = parseNullableTimestamp(legacy.data.endedAt, clock);
	if (endedAt.status === "error") return endedAt;

	if (legacy.data.isLive) {
		if (startedAt.value === null || legacy.data.streamSessionId === null) {
			return Result.err(
				new PersistedStreamLifecycleStateError(
					"Legacy live state requires startedAt and streamSessionId",
				),
			);
		}
		return Result.ok({
			_tag: "LiveStream",
			streamSessionId: legacy.data.streamSessionId,
			startedAt: startedAt.value,
			peakViewerCount: legacy.data.peakViewerCount,
			viewerPollScheduleId: legacy.data.viewerPollScheduleId,
			transitionIntent: null,
		});
	}

	return Result.ok({
		_tag: "OfflineStream",
		lastStartedAt: startedAt.value,
		endedAt: endedAt.value,
		peakViewerCount: legacy.data.peakViewerCount,
		transitionIntent: null,
	});
}
