/**
 * StreamLifecycleDO integration tests
 *
 * Tests stream lifecycle state transitions, viewer tracking, and HTTP routing
 * through the Durable Object public interface.
 */

import { env, fetchMock, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { StreamLifecycleDO } from "../../durable-objects/stream-lifecycle-do";
import { mockTwitchGetStreams, mockTwitchTokenRefresh } from "../fixtures/twitch";
import {
	ensureAchievementsSingletonStub,
	ensureNamedSpotifyTokenStub,
	ensureNamedTwitchTokenStub,
} from "../helpers/durable-objects";

const ONLINE_AT = "2026-01-22T12:00:00.000Z";
const OFFLINE_AT = "2026-01-22T13:00:00.000Z";

describe("StreamLifecycleDO", () => {
	let stub: DurableObjectStub<StreamLifecycleDO>;
	let streamName: string;

	beforeEach(async () => {
		streamName = `stream-lifecycle-${crypto.randomUUID()}`;
		const id = env.STREAM_LIFECYCLE_DO.idFromName(streamName);
		stub = env.STREAM_LIFECYCLE_DO.get(id);

		await stub.setName(streamName);
		await stub.getIsLive();
		await ensureNamedSpotifyTokenStub();
		await ensureNamedTwitchTokenStub();
		await ensureAchievementsSingletonStub();
	});

	afterEach(async () => {
		try {
			await stub.onStreamOffline("2099-01-01T00:00:00.000Z");
		} catch {
			// Best-effort cleanup only. Some failing tests may abort the DO runtime.
		}
	});

	it("returns the initial offline state", async () => {
		const result = await runInDurableObject(stub, (instance: StreamLifecycleDO) =>
			instance.getStreamState(),
		);

		expect(result.status).toBe("ok");
		if (result.status === "ok") {
			expect(result.value).toMatchObject({
				id: 1,
				isLive: false,
				startedAt: null,
				endedAt: null,
				peakViewerCount: 0,
			});
		}
	});

	it("transitions online through the public RPC method", async () => {
		await stub.onStreamOnline(ONLINE_AT);

		const [isLive, state] = await Promise.all([
			stub.getIsLive(),
			runInDurableObject(stub, (instance: StreamLifecycleDO) => instance.getStreamState()),
		]);

		expect(isLive).toBe(true);
		expect(state.status).toBe("ok");
		if (state.status === "ok") {
			expect(state.value).toMatchObject({
				isLive: true,
				startedAt: ONLINE_AT,
				endedAt: null,
				peakViewerCount: 0,
			});
		}
	});

	it("transitions offline through the public RPC method", async () => {
		await stub.onStreamOnline(ONLINE_AT);
		await stub.onStreamOffline(OFFLINE_AT);

		const [isLive, state] = await Promise.all([
			stub.getIsLive(),
			runInDurableObject(stub, (instance: StreamLifecycleDO) => instance.getStreamState()),
		]);

		expect(isLive).toBe(false);
		expect(state.status).toBe("ok");
		if (state.status === "ok") {
			expect(state.value).toMatchObject({
				isLive: false,
				startedAt: ONLINE_AT,
				endedAt: OFFLINE_AT,
			});
		}
	});

	it("ignores stale out-of-order lifecycle events", async () => {
		await stub.onStreamOnline("2026-01-22T12:00:00.000Z");
		await stub.onStreamOffline("2026-01-22T13:00:00.000Z");
		await stub.onStreamOnline("2026-01-22T12:30:00.000Z");

		const state = await runInDurableObject(stub, (instance: StreamLifecycleDO) =>
			instance.getStreamState(),
		);

		expect(state.status).toBe("ok");
		if (state.status === "ok") {
			expect(state.value).toMatchObject({
				isLive: false,
				startedAt: "2026-01-22T12:00:00.000Z",
				endedAt: "2026-01-22T13:00:00.000Z",
			});
		}
	});

	it("records viewer snapshots and tracks the peak viewer count", async () => {
		await stub.recordViewerCount(100);
		await stub.recordViewerCount(250);
		await stub.recordViewerCount(175);

		const [history, state] = await Promise.all([
			stub.getViewerHistory(),
			runInDurableObject(stub, (instance: StreamLifecycleDO) => instance.getStreamState()),
		]);

		expect(history.snapshots).toHaveLength(3);
		expect(history.snapshots.map((snapshot) => snapshot.viewerCount)).toEqual([100, 250, 175]);
		expect(state.status).toBe("ok");
		if (state.status === "ok") {
			expect(state.value.peakViewerCount).toBe(250);
		}
	});

	it("polls and records viewer count when live", async () => {
		mockTwitchTokenRefresh(fetchMock);
		mockTwitchGetStreams(fetchMock, true);

		await stub.onStreamOnline(ONLINE_AT);
		await stub.pollViewerCountTick();

		const [history, state] = await Promise.all([
			stub.getViewerHistory(),
			runInDurableObject(stub, (instance: StreamLifecycleDO) => instance.getStreamState()),
		]);

		expect(history.snapshots).toHaveLength(1);
		expect(history.snapshots[0]?.viewerCount).toBe(250);
		expect(state.status).toBe("ok");
		if (state.status === "ok") {
			expect(state.value.peakViewerCount).toBe(250);
		}
	});

	it("does not poll viewer count while offline", async () => {
		await stub.pollViewerCountTick();

		const history = await stub.getViewerHistory();
		expect(history.snapshots).toHaveLength(0);
	});

	describe("HTTP routing via Agent onRequest", () => {
		it("handles /stream-online and /stream-offline", async () => {
			const onlineResponse = await runInDurableObject(stub, (instance: StreamLifecycleDO) =>
				instance.onRequest(new Request("http://do/stream-online", { method: "POST" })),
			);
			expect(onlineResponse.status).toBe(200);
			expect(await onlineResponse.json()).toEqual({ success: true });

			let isLive = await stub.getIsLive();
			expect(isLive).toBe(true);

			const offlineResponse = await runInDurableObject(stub, (instance: StreamLifecycleDO) =>
				instance.onRequest(new Request("http://do/stream-offline", { method: "POST" })),
			);
			expect(offlineResponse.status).toBe(200);
			expect(await offlineResponse.json()).toEqual({ success: true });

			isLive = await stub.getIsLive();
			expect(isLive).toBe(false);
		});

		it("handles /record-viewer-count", async () => {
			const response = await runInDurableObject(stub, (instance: StreamLifecycleDO) =>
				instance.onRequest(
					new Request("http://do/record-viewer-count", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ count: 250 }),
					}),
				),
			);

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ success: true });

			const state = await runInDurableObject(stub, (instance: StreamLifecycleDO) =>
				instance.getStreamState(),
			);
			expect(state.status).toBe("ok");
			if (state.status === "ok") {
				expect(state.value.peakViewerCount).toBe(250);
			}
		});

		it("rejects an invalid /record-viewer-count body", async () => {
			const response = await runInDurableObject(stub, (instance: StreamLifecycleDO) =>
				instance.onRequest(
					new Request("http://do/record-viewer-count", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ invalid: true }),
					}),
				),
			);

			expect(response.status).toBe(400);
			await response.text();
		});

		it("returns 404 for unknown paths", async () => {
			const response = await runInDurableObject(stub, (instance: StreamLifecycleDO) =>
				instance.onRequest(new Request("http://do/unknown")),
			);

			expect(response.status).toBe(404);
			await response.text();
		});
	});
});
