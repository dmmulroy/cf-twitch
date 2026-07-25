/**
 * AchievementsDO integration tests
 *
 * Tests public achievement behavior through the Durable Object interface.
 */

import { runInDurableObject } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { describe, expect, it } from "vite-plus/test";

import { AchievementsDO } from "../../durable-objects/achievements-do";
import * as achievementSchema from "../../durable-objects/schemas/achievements-do.schema";
import {
	createRaffleRollEvent,
	createSongRequestSuccessEvent,
	createStreamOfflineEvent,
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

	it("applies a redelivered event exactly once", async () => {
		await ensureNamedTwitchTokenStub();
		const stub = await createAchievementsStub(`achievements-${crypto.randomUUID()}`);
		const event = createSongRequestSuccessEvent({
			id: crypto.randomUUID(),
			userId: "stable-viewer-1",
			userDisplayName: "FirstName",
			sagaId: "saga-duplicate",
			trackId: "spotify:track:duplicate",
		});

		expect((await stub.handleEvent(event)).status).toBe("ok");
		expect((await stub.handleEvent(event)).status).toBe("ok");
		const progress = await stub.getUserAchievements("FirstName");
		expect(progress.status).toBe("ok");
		if (progress.status === "ok") {
			expect(progress.value.find((item) => item.achievementId === "request_10")?.progress).toBe(1);
		}
	});

	it("keeps Achievement Progress on stable Viewer identity after a display-name change", async () => {
		await ensureNamedTwitchTokenStub();
		const stub = await createAchievementsStub(`achievements-${crypto.randomUUID()}`);
		for (const [index, userDisplayName] of ["OldName", "NewName"].entries()) {
			await stub.handleEvent(
				createSongRequestSuccessEvent({
					id: crypto.randomUUID(),
					userId: "stable-viewer-2",
					userDisplayName,
					sagaId: `saga-name-${index}`,
					trackId: `spotify:track:name-${index}`,
				}),
			);
		}

		const progress = await stub.getUserAchievements("NewName");
		expect(progress.status).toBe("ok");
		if (progress.status === "ok") {
			expect(progress.value.find((item) => item.achievementId === "request_10")?.progress).toBe(2);
		}
	});

	it("does not move Stream Session state backward when an older online event is retried", async () => {
		const stub = await createAchievementsStub(`achievements-${crypto.randomUUID()}`);
		await stub.handleEvent(
			createStreamOfflineEvent({
				id: crypto.randomUUID(),
				streamId: "stream-ordered",
				endedAt: "2026-04-07T16:00:00.000Z",
			}),
		);
		await stub.handleEvent(
			createStreamOnlineEvent({
				id: crypto.randomUUID(),
				streamId: "stream-ordered",
				startedAt: "2026-04-07T14:00:00.000Z",
			}),
		);

		const state = await runInDurableObject(stub, (instance: AchievementsDO) => instance.state);
		expect(state).toMatchObject({ isStreamLive: false, currentStreamStartedAt: null });
	});

	it("persists a stable unlock outbox effect and guards repeated callback execution", async () => {
		await ensureNamedTwitchTokenStub();
		const stub = await createAchievementsStub(`achievements-${crypto.randomUUID()}`);
		const event = createSongRequestSuccessEvent({
			id: crypto.randomUUID(),
			userId: "outbox-viewer",
			userDisplayName: "OutboxViewer",
			sagaId: "saga-outbox",
			trackId: "spotify:track:outbox",
		});
		expect((await stub.handleEvent(event)).status).toBe("ok");

		const effect = await runInDurableObject(stub, async (instance: AchievementsDO) => {
			const db = drizzle(instance.ctx.storage, { schema: achievementSchema });
			const [row] = await db
				.select()
				.from(achievementSchema.achievementUnlockOutbox)
				.where(eq(achievementSchema.achievementUnlockOutbox.effectId, `${event.id}:first_request`));
			if (row === undefined) {
				throw new Error("Achievement unlock outbox row missing");
			}
			await instance.processAchievementUnlockEffects({ effectId: row.effectId });
			await instance.processAchievementUnlockEffects({ effectId: row.effectId });
			const [after] = await db
				.select()
				.from(achievementSchema.achievementUnlockOutbox)
				.where(eq(achievementSchema.achievementUnlockOutbox.effectId, row.effectId));
			return after;
		});
		expect(effect).toMatchObject({
			effectId: `${event.id}:first_request`,
			metricState: "claimed",
		});
	});

	it("parses definition records and rejects unbounded leaderboard limits at the RPC boundary", async () => {
		const stub = await createAchievementsStub(`achievements-${crypto.randomUUID()}`);
		const definitions = await stub.getDefinitions();
		expect(definitions.status).toBe("ok");
		if (definitions.status === "ok") {
			expect(definitions.value.length).toBeGreaterThan(0);
		}
		const invalidLimit = await stub.getLeaderboard({ limit: -1 });
		expect(invalidLimit.status).toBe("error");
		if (invalidLimit.status === "error") {
			expect(invalidLimit.error._tag).toBe("AchievementQueryValidationError");
		}
	});

	it("returns a precise error for an invalid persisted Achievement Definition", async () => {
		const stub = await createAchievementsStub(`achievements-${crypto.randomUUID()}`);
		const result = await runInDurableObject(stub, async (instance: AchievementsDO) => {
			const db = drizzle(instance.ctx.storage, { schema: achievementSchema });
			await db
				.update(achievementSchema.achievementDefinitions)
				.set({ category: "corrupt-category" })
				.where(eq(achievementSchema.achievementDefinitions.id, "first_request"));
			return instance.getDefinitions();
		});
		expect(result.status).toBe("error");
		if (result.status === "error") {
			expect(result.error._tag).toBe("InvalidAchievementRecordError");
		}
	});
});
