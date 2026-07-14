import { describe, expect, it } from "vite-plus/test";

import {
	goOffline,
	goOnline,
	initialOfflineState,
	parsePersistedStreamLifecycleState,
} from "../../durable-objects/stream-lifecycle-state";
import { SystemClock } from "../../lib/clock";

describe("stream lifecycle state", () => {
	it("parses old offline persisted state into an offline stream", () => {
		const clock = new SystemClock(() => new Date("2026-01-22T14:00:00.000Z"));

		expect(
			parsePersistedStreamLifecycleState(
				{
					isLive: false,
					startedAt: "2026-01-22T12:00:00.000Z",
					endedAt: "2026-01-22T13:00:00.000Z",
					peakViewerCount: 250,
					streamSessionId: "stale-session",
					viewerPollScheduleId: "stale-schedule",
				},
				clock,
			),
		).toEqual({
			_tag: "OfflineStream",
			lastStartedAt: "2026-01-22T12:00:00.000Z",
			endedAt: "2026-01-22T13:00:00.000Z",
			peakViewerCount: 250,
		});
	});

	it("parses old live persisted state into a live stream", () => {
		const clock = new SystemClock(() => new Date("2026-01-22T14:00:00.000Z"));

		expect(
			parsePersistedStreamLifecycleState(
				{
					isLive: true,
					startedAt: "2026-01-22T12:00:00.000Z",
					endedAt: null,
					peakViewerCount: 250,
					streamSessionId: "session-id",
					viewerPollScheduleId: "schedule-id",
				},
				clock,
			),
		).toEqual({
			_tag: "LiveStream",
			streamSessionId: "session-id",
			startedAt: "2026-01-22T12:00:00.000Z",
			peakViewerCount: 250,
			viewerPollScheduleId: "schedule-id",
		});
	});

	it("goOnline creates a live stream with session and start evidence", () => {
		const clock = new SystemClock(() => new Date("2026-01-22T12:00:00.000Z"));

		expect(goOnline(initialOfflineState(), clock.nowIsoTimestamp(), "session-id")).toEqual({
			_tag: "LiveStream",
			streamSessionId: "session-id",
			startedAt: "2026-01-22T12:00:00.000Z",
			peakViewerCount: 0,
			viewerPollScheduleId: null,
		});
	});

	it("goOffline removes active session and poll schedule evidence", () => {
		const clock = new SystemClock(() => new Date("2026-01-22T13:00:00.000Z"));
		const live = goOnline(initialOfflineState(), clock.nowIsoTimestamp(), "session-id");

		expect(
			goOffline({ ...live, viewerPollScheduleId: "schedule-id" }, clock.nowIsoTimestamp()),
		).toEqual({
			_tag: "OfflineStream",
			lastStartedAt: "2026-01-22T13:00:00.000Z",
			endedAt: "2026-01-22T13:00:00.000Z",
			peakViewerCount: 0,
		});
	});
});
