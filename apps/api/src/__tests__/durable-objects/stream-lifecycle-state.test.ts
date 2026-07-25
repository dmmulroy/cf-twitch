import { describe, expect, it } from "vite-plus/test";

import {
	goOffline,
	goOnline,
	initialOfflineState,
	parsePersistedStreamLifecycleState,
} from "../../durable-objects/stream-lifecycle-state";
import { SystemClock } from "../../lib/clock";

const clock = new SystemClock(() => new Date("2026-01-22T14:00:00.000Z"));

function expectParsedState(input: unknown): unknown {
	const result = parsePersistedStreamLifecycleState(input, clock);
	expect(result.status).toBe("ok");
	if (result.status === "error") throw result.error;
	return result.value;
}

describe("stream lifecycle state", () => {
	it("parses old offline persisted state into an offline stream", () => {
		expect(
			expectParsedState({
				isLive: false,
				startedAt: "2026-01-22T12:00:00.000Z",
				endedAt: "2026-01-22T13:00:00.000Z",
				peakViewerCount: 250,
				streamSessionId: "stale-session",
				viewerPollScheduleId: "stale-schedule",
			}),
		).toEqual({
			_tag: "OfflineStream",
			lastStartedAt: "2026-01-22T12:00:00.000Z",
			endedAt: "2026-01-22T13:00:00.000Z",
			peakViewerCount: 250,
			transitionIntent: null,
		});
	});

	it("parses old live persisted state into a live stream", () => {
		expect(
			expectParsedState({
				isLive: true,
				startedAt: "2026-01-22T12:00:00.000Z",
				endedAt: null,
				peakViewerCount: 250,
				streamSessionId: "session-id",
				viewerPollScheduleId: "schedule-id",
			}),
		).toEqual({
			_tag: "LiveStream",
			streamSessionId: "session-id",
			startedAt: "2026-01-22T12:00:00.000Z",
			peakViewerCount: 250,
			viewerPollScheduleId: "schedule-id",
			transitionIntent: null,
		});
	});

	it.each([
		["unknown shape", { invalid: true }],
		[
			"invalid current timestamp",
			{
				_tag: "LiveStream",
				streamSessionId: "session-id",
				startedAt: "not-a-time",
				peakViewerCount: 0,
				viewerPollScheduleId: null,
			},
		],
		[
			"invalid legacy live evidence",
			{
				isLive: true,
				startedAt: null,
				endedAt: null,
				peakViewerCount: 0,
				streamSessionId: null,
				viewerPollScheduleId: null,
			},
		],
	])("returns an explicit corruption error for %s", (_caseName, input) => {
		const result = parsePersistedStreamLifecycleState(input, clock);
		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error._tag).toBe("PersistedStreamLifecycleStateError");
		}
	});

	it("goOnline atomically creates state and online effect intent", () => {
		const startedAt = clock.nowIsoTimestamp();
		expect(goOnline(initialOfflineState(), startedAt, "session-id", "online-event-id")).toEqual({
			_tag: "LiveStream",
			streamSessionId: "session-id",
			startedAt,
			peakViewerCount: 0,
			viewerPollScheduleId: null,
			transitionIntent: {
				_tag: "StreamOnlineIntent",
				eventId: "online-event-id",
				streamSessionId: "session-id",
				transitionAt: startedAt,
				viewerPollScheduleId: null,
				spotifyTokenNotified: false,
				twitchTokenNotified: false,
				lifecycleEventPublished: false,
				viewerPollingUpdated: false,
			},
		});
	});

	it("goOffline preserves schedule evidence in its durable cancellation intent", () => {
		const startedAt = clock.nowIsoTimestamp();
		const live = goOnline(initialOfflineState(), startedAt, "session-id", "online-event-id");
		const endedAt = clock.nowIsoTimestamp();
		const offline = goOffline(
			{ ...live, viewerPollScheduleId: "schedule-id", transitionIntent: null },
			endedAt,
			"offline-event-id",
		);
		expect(offline.transitionIntent).toMatchObject({
			_tag: "StreamOfflineIntent",
			eventId: "offline-event-id",
			streamSessionId: "session-id",
			viewerPollScheduleId: "schedule-id",
		});
	});
});
