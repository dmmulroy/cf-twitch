/**
 * StreamLifecycleDO unit tests
 *
 * Tests stream state management, viewer tracking, and lifecycle events.
 *
 * KNOWN LIMITATION: This test file causes "Isolated storage failed" errors in
 * vitest-pool-workers due to SQLite shared memory files (.sqlite-shm) created
 * during write operations. The StreamLifecycleDO constructor uses
 * `blockConcurrencyWhile()` for migrations which the test runner can't properly
 * track. See: https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#isolated-storage
 *
 * Tests that use getStub() (onStreamOnline, onStreamOffline, alarm) are skipped
 * because getStub() uses global `env` from cloudflare:workers which doesn't work
 * in vitest-pool-workers context.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { StreamLifecycleDO } from "../../durable-objects/stream-lifecycle-do";

// NOTE: Some tests may cause isolated storage errors due to SQLite .shm files
// from concurrent writes in blockConcurrencyWhile()
describe("StreamLifecycleDO", () => {
	let stub: DurableObjectStub<StreamLifecycleDO>;

	beforeEach(async () => {
		const id = env.STREAM_LIFECYCLE_DO.idFromName("stream-lifecycle");
		stub = env.STREAM_LIFECYCLE_DO.get(id);

		// Force DO initialization to complete - the constructor uses fire-and-forget
		// blockConcurrencyWhile which confuses vitest-pool-workers isolated storage.
		// Calling any method ensures initialization completes before test runs.
		await runInDurableObject(stub, async (instance: StreamLifecycleDO) => {
			await instance.ping();
		});
	});

	describe("getStreamState", () => {
		it("should return initial offline state", async () => {
			const result = await runInDurableObject(stub, (instance: StreamLifecycleDO) =>
				instance.getStreamState(),
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.isLive).toBe(false);
				expect(result.value.peakViewerCount).toBe(0);
			}
		});
	});

	describe("getIsLive", () => {
		it("should return false initially", async () => {
			const isLive = await runInDurableObject(stub, (instance: StreamLifecycleDO) =>
				instance.getIsLive(),
			);

			expect(isLive).toBe(false);
		});
	});

	// NOTE: onStreamOnline/onStreamOffline call getStub() internally to notify token DOs.
	// getStub() uses global env from cloudflare:workers which fails in vitest context.
	// These tests cause DataCloneError unhandled rejections even though assertions pass.
	describe.skip("onStreamOnline", () => {
		it("should set isLive to true", async () => {
			await runInDurableObject(stub, async (instance: StreamLifecycleDO) => {
				await instance.onStreamOnline();
				const isLive = await instance.getIsLive();
				expect(isLive).toBe(true);
			});
		});

		it("should update stream state with startedAt", async () => {
			await runInDurableObject(stub, async (instance: StreamLifecycleDO) => {
				await instance.onStreamOnline();
				const state = await instance.getStreamState();

				expect(state.status).toBe("ok");
				if (state.status === "ok") {
					expect(state.value.isLive).toBe(true);
					expect(state.value.startedAt).toBeTruthy();
					expect(state.value.endedAt).toBeNull();
				}
			});
		});

		it("should reset peakViewerCount to 0", async () => {
			await runInDurableObject(stub, async (instance: StreamLifecycleDO) => {
				// Record some viewers first
				await instance.recordViewerCount(100);
				await instance.onStreamOnline();

				const state = await instance.getStreamState();
				expect(state.status).toBe("ok");
				if (state.status === "ok") {
					expect(state.value.peakViewerCount).toBe(0);
				}
			});
		});
	});

	describe.skip("onStreamOffline", () => {
		it("should set isLive to false", async () => {
			await runInDurableObject(stub, async (instance: StreamLifecycleDO) => {
				await instance.onStreamOnline();
				await instance.onStreamOffline();

				const isLive = await instance.getIsLive();
				expect(isLive).toBe(false);
			});
		});

		it("should update stream state with endedAt", async () => {
			await runInDurableObject(stub, async (instance: StreamLifecycleDO) => {
				await instance.onStreamOnline();
				await instance.onStreamOffline();

				const state = await instance.getStreamState();
				expect(state.status).toBe("ok");
				if (state.status === "ok") {
					expect(state.value.isLive).toBe(false);
					expect(state.value.endedAt).toBeTruthy();
				}
			});
		});
	});

	describe("recordViewerCount", () => {
		// Helper to delay between calls to avoid timestamp collisions
		const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

		it("should record viewer snapshot", async () => {
			await runInDurableObject(stub, async (instance: StreamLifecycleDO) => {
				await instance.recordViewerCount(150);

				const history = await instance.getViewerHistory();
				expect(history.snapshots).toHaveLength(1);
				expect(history.snapshots[0]?.viewerCount).toBe(150);
			});
		});

		it("should update peak viewer count when higher", async () => {
			await runInDurableObject(stub, async (instance: StreamLifecycleDO) => {
				await instance.recordViewerCount(100);
				await delay(5);
				await instance.recordViewerCount(200);
				await delay(5);
				await instance.recordViewerCount(150);

				const state = await instance.getStreamState();
				expect(state.status).toBe("ok");
				if (state.status === "ok") {
					expect(state.value.peakViewerCount).toBe(200);
				}
			});
		});

		it("should not lower peak viewer count", async () => {
			await runInDurableObject(stub, async (instance: StreamLifecycleDO) => {
				await instance.recordViewerCount(200);
				await delay(5);
				await instance.recordViewerCount(100);

				const state = await instance.getStreamState();
				expect(state.status).toBe("ok");
				if (state.status === "ok") {
					expect(state.value.peakViewerCount).toBe(200);
				}
			});
		});
	});

	describe("getViewerHistory", () => {
		// Helper to delay between calls to avoid timestamp collisions
		const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

		it("should return empty snapshots initially", async () => {
			const history = await runInDurableObject(stub, (instance: StreamLifecycleDO) =>
				instance.getViewerHistory(),
			);

			expect(history.snapshots).toHaveLength(0);
		});

		it("should return all snapshots when no filter", async () => {
			await runInDurableObject(stub, async (instance: StreamLifecycleDO) => {
				await instance.recordViewerCount(100);
				await delay(5);
				await instance.recordViewerCount(150);
				await delay(5);
				await instance.recordViewerCount(125);

				const history = await instance.getViewerHistory();
				expect(history.snapshots).toHaveLength(3);
			});
		});

		it("should filter by since", async () => {
			await runInDurableObject(stub, async (instance: StreamLifecycleDO) => {
				await instance.recordViewerCount(100);
				await delay(5);
				await instance.recordViewerCount(150);

				// Filter to future time - should return empty
				const history = await instance.getViewerHistory("2099-01-01T00:00:00.000Z");
				expect(history.snapshots).toHaveLength(0);
			});
		});
	});

	describe("ping", () => {
		it("should return ok: true", async () => {
			const result = await runInDurableObject(stub, (instance: StreamLifecycleDO) =>
				instance.ping(),
			);

			expect(result).toEqual({ ok: true });
		});
	});

	// NOTE: alarm tests are skipped - onStreamOnline (which schedules alarms) uses getStub()
	// These would require runDurableObjectAlarm, mockTwitchGetStreams, fetchMock etc.
	// IMPORTANT: When enabling, add afterEach to clean up alarms per vitest-pool-workers requirements:
	//   afterEach(async () => { await runDurableObjectAlarm(stub); });
	// See: https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#durable-object-alarms
	describe.skip("alarm", () => {
		it.todo("should not run when stream is offline");
		it.todo("should record viewer count when stream is live");
	});

	describe("fetch handler (legacy)", () => {
		it("should handle /ping endpoint", async () => {
			const response = await stub.fetch("http://do/ping");

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data).toEqual({ ok: true });
		});

		it("should handle /is-live endpoint", async () => {
			const response = await stub.fetch("http://do/is-live");

			expect(response.status).toBe(200);
			const data = (await response.json()) as { is_live: boolean };
			expect(data.is_live).toBe(false);
		});

		it("should handle /state endpoint", async () => {
			const response = await stub.fetch("http://do/state");

			expect(response.status).toBe(200);
			const data = (await response.json()) as { isLive: boolean };
			expect(data.isLive).toBe(false);
		});

		it("should return 404 for unknown paths", async () => {
			const response = await stub.fetch("http://do/unknown");

			expect(response.status).toBe(404);
			await response.text(); // Consume body per vitest-pool-workers requirements
		});

		// NOTE: /stream-online and /stream-offline fetch endpoints call getStub() internally
		// which causes DataCloneError in vitest context. Use runInDurableObject tests above.
		it.skip("should handle /stream-online endpoint", async () => {
			const response = await stub.fetch("http://do/stream-online");

			expect(response.status).toBe(200);
			await response.text(); // Consume body per vitest-pool-workers requirements

			const isLive = await runInDurableObject(stub, (instance: StreamLifecycleDO) =>
				instance.getIsLive(),
			);
			expect(isLive).toBe(true);
		});

		it.skip("should handle /stream-offline endpoint", async () => {
			// First go online
			const onlineRes = await stub.fetch("http://do/stream-online");
			await onlineRes.text(); // Consume body per vitest-pool-workers requirements

			const response = await stub.fetch("http://do/stream-offline");

			expect(response.status).toBe(200);
			await response.text(); // Consume body per vitest-pool-workers requirements

			const isLive = await runInDurableObject(stub, (instance: StreamLifecycleDO) =>
				instance.getIsLive(),
			);
			expect(isLive).toBe(false);
		});

		it("should handle /record-viewer-count endpoint", async () => {
			const response = await stub.fetch("http://do/record-viewer-count", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ count: 250 }),
			});

			expect(response.status).toBe(200);
			await response.text(); // Consume body per vitest-pool-workers requirements

			const state = await runInDurableObject(stub, (instance: StreamLifecycleDO) =>
				instance.getStreamState(),
			);
			expect(state.status).toBe("ok");
			if (state.status === "ok") {
				expect(state.value.peakViewerCount).toBe(250);
			}
		});

		it("should reject invalid viewer count body", async () => {
			const response = await stub.fetch("http://do/record-viewer-count", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ invalid: "body" }),
			});

			expect(response.status).toBe(400);
			await response.text(); // Consume body per vitest-pool-workers requirements
		});
	});
});
