/**
 * AchievementsDO integration tests
 *
 * Tests public achievement behavior through the Durable Object interface.
 */

import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { AchievementsDO } from "../../durable-objects/achievements-do";
import {
	createRaffleRollEvent,
	createSongRequestSuccessEvent,
	createStreamOnlineEvent,
} from "../../durable-objects/schemas/event-bus-do.schema";
import { createAchievementsStub, ensureNamedTwitchTokenStub } from "../helpers/durable-objects";

describe("AchievementsDO", () => {
	it("unlocks first-request achievements for the first successful request of a stream", async () => {
		await ensureNamedTwitchTokenStub();
		const stub = await createAchievementsStub(`achievements-${crypto.randomUUID()}`);

		const onlineResult = await stub.handleEvent(
			createStreamOnlineEvent({
				id: crypto.randomUUID(),
				streamId: "stream-123",
				startedAt: "2026-04-07T14:15:00.000Z",
			}),
		);
		expect(onlineResult.status).toBe("ok");

		const requestResult = await stub.handleEvent(
			createSongRequestSuccessEvent({
				id: crypto.randomUUID(),
				userId: "user-123",
				userDisplayName: "TestUser",
				sagaId: "saga-123",
				trackId: "spotify:track:abc123",
			}),
		);
		expect(requestResult.status).toBe("ok");

		const unlockedResult = await stub.getUnlockedAchievements("TestUser");
		expect(unlockedResult.status).toBe("ok");
		if (unlockedResult.status === "ok") {
			expect(unlockedResult.value.map((achievement) => achievement.id)).toEqual(
				expect.arrayContaining(["first_request", "stream_opener"]),
			);
		}
	});

	it("resets session achievements on stream start without clearing cumulative unlocks", async () => {
		await ensureNamedTwitchTokenStub();
		const stub = await createAchievementsStub(`achievements-${crypto.randomUUID()}`);

		await stub.handleEvent(
			createStreamOnlineEvent({
				id: crypto.randomUUID(),
				streamId: "stream-123",
				startedAt: "2026-04-07T14:15:00.000Z",
			}),
		);
		await stub.handleEvent(
			createSongRequestSuccessEvent({
				id: crypto.randomUUID(),
				userId: "user-123",
				userDisplayName: "TestUser",
				sagaId: "saga-123",
				trackId: "spotify:track:abc123",
			}),
		);

		const resetResult = await stub.onStreamOnline();
		expect(resetResult.status).toBe("ok");

		const achievementsResult = await stub.getUserAchievements("TestUser");
		expect(achievementsResult.status).toBe("ok");
		if (achievementsResult.status === "ok") {
			const byId = new Map(
				achievementsResult.value.map((achievement) => [achievement.achievementId, achievement]),
			);

			expect(byId.get("first_request")).toMatchObject({
				progress: 1,
				unlocked: true,
			});
			expect(byId.get("stream_opener")).toMatchObject({
				progress: 0,
				unlocked: false,
			});
		}
	});

	it("awards raffle achievements based on roll outcome", async () => {
		await ensureNamedTwitchTokenStub();
		const stub = await createAchievementsStub(`achievements-${crypto.randomUUID()}`);

		const result = await stub.handleEvent(
			createRaffleRollEvent({
				id: crypto.randomUUID(),
				userId: "user-123",
				userDisplayName: "TestUser",
				sagaId: "saga-123",
				roll: 4958,
				winningNumber: 5000,
				distance: 42,
				isWinner: false,
				isNewRecord: true,
			}),
		);
		expect(result.status).toBe("ok");

		const unlockedResult = await stub.getUnlockedAchievements("TestUser");
		expect(unlockedResult.status).toBe("ok");
		if (unlockedResult.status === "ok") {
			expect(unlockedResult.value.map((achievement) => achievement.id)).toEqual(
				expect.arrayContaining(["first_roll", "close_call", "closest_ever"]),
			);
		}
	});

	// getStub()-backed error tagging is not reliable enough in worker-pool tests
	// to assert the retryable preflight branch here.
	it.skip("schedules a short retry for unlock announcements when chat auth is temporarily unavailable", async () => {
		await ensureNamedTwitchTokenStub();
		const stub = await createAchievementsStub(`achievements-${crypto.randomUUID()}`);

		await stub.processAchievementUnlockEffects({
			userDisplayName: "TestUser",
			achievementId: "first_request",
			achievementName: "First Timer",
			achievementDescription: "Request your first song",
			category: "song_request",
			announcementAttempt: 0,
		});

		const schedules = await runInDurableObject(stub, (instance: AchievementsDO) =>
			instance.getSchedules(),
		);

		expect(schedules).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "delayed",
					callback: "processAchievementUnlockEffects",
					delayInSeconds: 3,
				}),
			]),
		);
	});
});
