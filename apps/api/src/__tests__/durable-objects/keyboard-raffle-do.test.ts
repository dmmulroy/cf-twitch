/**
 * KeyboardRaffleDO unit tests
 *
 * Tests roll recording, leaderboard, and user stats.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { KeyboardRaffleDO } from "../../durable-objects/keyboard-raffle-do";

import type { InsertRoll } from "../../durable-objects/schemas/keyboard-raffle-do.schema";

/**
 * Create a test roll with defaults
 */
function createTestRoll(overrides: Partial<InsertRoll> = {}): InsertRoll {
	return {
		id: `roll-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		userId: "user-123",
		displayName: "TestUser",
		roll: 500,
		winningNumber: 777,
		distance: 277,
		isWinner: false,
		rolledAt: new Date().toISOString(),
		...overrides,
	};
}

describe("KeyboardRaffleDO", () => {
	let stub: DurableObjectStub<KeyboardRaffleDO>;

	beforeEach(() => {
		const id = env.KEYBOARD_RAFFLE_DO.idFromName("keyboard-raffle");
		stub = env.KEYBOARD_RAFFLE_DO.get(id);
	});

	describe("recordRoll", () => {
		it("should record a roll and return it", async () => {
			const rollData = createTestRoll({ id: "test-roll-1" });

			const result = await runInDurableObject(stub, (instance: KeyboardRaffleDO) =>
				instance.recordRoll(rollData),
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.id).toBe("test-roll-1");
				expect(result.value.userId).toBe("user-123");
				expect(result.value.isWinner).toBe(false);
			}
		});

		it("should mark roll as winner when distance is 0", async () => {
			const rollData = createTestRoll({
				id: "winner-roll",
				roll: 777,
				winningNumber: 777,
				distance: 0,
			});

			const result = await runInDurableObject(stub, (instance: KeyboardRaffleDO) =>
				instance.recordRoll(rollData),
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.isWinner).toBe(true);
			}
		});

		it("should allow multiple rolls from same user", async () => {
			await runInDurableObject(stub, async (instance: KeyboardRaffleDO) => {
				const result1 = await instance.recordRoll(createTestRoll({ id: "roll-1" }));
				const result2 = await instance.recordRoll(createTestRoll({ id: "roll-2" }));

				expect(result1.status).toBe("ok");
				expect(result2.status).toBe("ok");
			});
		});
	});

	describe("deleteRollById", () => {
		it("should delete existing roll", async () => {
			const rollData = createTestRoll({ id: "roll-to-delete" });

			await runInDurableObject(stub, async (instance: KeyboardRaffleDO) => {
				await instance.recordRoll(rollData);
				const result = await instance.deleteRollById("roll-to-delete");

				expect(result.status).toBe("ok");
			});
		});

		it("should return RollNotFoundError for nonexistent roll", async () => {
			const result = await runInDurableObject(stub, (instance: KeyboardRaffleDO) =>
				instance.deleteRollById("nonexistent-roll-id"),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("RollNotFoundError");
			}
		});

		it("should update leaderboard after deletion", async () => {
			await runInDurableObject(stub, async (instance: KeyboardRaffleDO) => {
				// Record a roll
				await instance.recordRoll(createTestRoll({ id: "temp-roll", userId: "temp-user" }));

				// Verify user appears in leaderboard
				let leaderboard = await instance.getLeaderboard({ sortBy: "rolls", limit: 10 });
				expect(leaderboard.status).toBe("ok");
				if (leaderboard.status === "ok") {
					const user = leaderboard.value.find((e) => e.userId === "temp-user");
					expect(user).toBeDefined();
				}

				// Delete the roll
				await instance.deleteRollById("temp-roll");

				// Verify user no longer appears (or has 0 rolls)
				leaderboard = await instance.getLeaderboard({ sortBy: "rolls", limit: 10 });
				expect(leaderboard.status).toBe("ok");
				if (leaderboard.status === "ok") {
					const user = leaderboard.value.find((e) => e.userId === "temp-user");
					expect(user).toBeUndefined();
				}
			});
		});
	});

	describe("getUserStats", () => {
		it("should return UserStatsNotFoundError for user with no rolls", async () => {
			const result = await runInDurableObject(stub, (instance: KeyboardRaffleDO) =>
				instance.getUserStats("nonexistent-user"),
			);

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error._tag).toBe("UserStatsNotFoundError");
			}
		});

		it("should return stats after user rolls", async () => {
			await runInDurableObject(stub, async (instance: KeyboardRaffleDO) => {
				await instance.recordRoll(
					createTestRoll({
						id: "stats-roll-1",
						userId: "stats-user",
						displayName: "StatsUser",
					}),
				);

				const result = await instance.getUserStats("stats-user");
				expect(result.status).toBe("ok");
				if (result.status === "ok") {
					expect(result.value.userId).toBe("stats-user");
					expect(result.value.totalRolls).toBe(1);
					expect(result.value.totalWins).toBe(0);
				}
			});
		});

		it("should track wins correctly", async () => {
			await runInDurableObject(stub, async (instance: KeyboardRaffleDO) => {
				// Record a winning roll
				await instance.recordRoll(
					createTestRoll({
						id: "winning-roll",
						userId: "winner-user",
						roll: 777,
						winningNumber: 777,
						distance: 0,
					}),
				);

				const result = await instance.getUserStats("winner-user");
				expect(result.status).toBe("ok");
				if (result.status === "ok") {
					expect(result.value.totalWins).toBe(1);
				}
			});
		});

		it("should track closest distance", async () => {
			await runInDurableObject(stub, async (instance: KeyboardRaffleDO) => {
				// Record rolls with different distances
				await instance.recordRoll(
					createTestRoll({
						id: "far-roll",
						userId: "distance-user",
						roll: 100,
						winningNumber: 777,
						distance: 677,
					}),
				);

				await instance.recordRoll(
					createTestRoll({
						id: "close-roll",
						userId: "distance-user",
						roll: 770,
						winningNumber: 777,
						distance: 7,
					}),
				);

				const result = await instance.getUserStats("distance-user");
				expect(result.status).toBe("ok");
				if (result.status === "ok") {
					expect(result.value.closestDistance).toBe(7);
				}
			});
		});
	});

	describe("getLeaderboard", () => {
		it("should return empty leaderboard initially", async () => {
			const result = await runInDurableObject(stub, (instance: KeyboardRaffleDO) =>
				instance.getLeaderboard({ sortBy: "rolls", limit: 10 }),
			);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toHaveLength(0);
			}
		});

		it("should sort by rolls correctly", async () => {
			await runInDurableObject(stub, async (instance: KeyboardRaffleDO) => {
				// User A: 3 rolls
				for (let i = 0; i < 3; i++) {
					await instance.recordRoll(
						createTestRoll({
							id: `user-a-${i}`,
							userId: "user-a",
							displayName: "UserA",
						}),
					);
				}

				// User B: 1 roll
				await instance.recordRoll(
					createTestRoll({
						id: "user-b-1",
						userId: "user-b",
						displayName: "UserB",
					}),
				);

				const result = await instance.getLeaderboard({ sortBy: "rolls", limit: 10 });
				expect(result.status).toBe("ok");
				if (result.status === "ok") {
					expect(result.value).toHaveLength(2);
					expect(result.value[0]?.userId).toBe("user-a");
					expect(result.value[0]?.totalRolls).toBe(3);
					expect(result.value[1]?.userId).toBe("user-b");
					expect(result.value[1]?.totalRolls).toBe(1);
				}
			});
		});

		it("should sort by wins correctly", async () => {
			await runInDurableObject(stub, async (instance: KeyboardRaffleDO) => {
				// User A: 1 win
				await instance.recordRoll(
					createTestRoll({
						id: "user-a-win",
						userId: "user-a",
						displayName: "UserA",
						roll: 777,
						winningNumber: 777,
						distance: 0,
					}),
				);

				// User B: 2 wins
				await instance.recordRoll(
					createTestRoll({
						id: "user-b-win-1",
						userId: "user-b",
						displayName: "UserB",
						roll: 777,
						winningNumber: 777,
						distance: 0,
					}),
				);
				await instance.recordRoll(
					createTestRoll({
						id: "user-b-win-2",
						userId: "user-b",
						displayName: "UserB",
						roll: 500,
						winningNumber: 500,
						distance: 0,
					}),
				);

				const result = await instance.getLeaderboard({ sortBy: "wins", limit: 10 });
				expect(result.status).toBe("ok");
				if (result.status === "ok") {
					expect(result.value[0]?.userId).toBe("user-b");
					expect(result.value[0]?.totalWins).toBe(2);
				}
			});
		});

		it("should sort by closest distance correctly", async () => {
			await runInDurableObject(stub, async (instance: KeyboardRaffleDO) => {
				// User A: closest = 100
				await instance.recordRoll(
					createTestRoll({
						id: "user-a-roll",
						userId: "user-a",
						displayName: "UserA",
						roll: 677,
						winningNumber: 777,
						distance: 100,
					}),
				);

				// User B: closest = 5
				await instance.recordRoll(
					createTestRoll({
						id: "user-b-roll",
						userId: "user-b",
						displayName: "UserB",
						roll: 772,
						winningNumber: 777,
						distance: 5,
					}),
				);

				const result = await instance.getLeaderboard({ sortBy: "closest", limit: 10 });
				expect(result.status).toBe("ok");
				if (result.status === "ok") {
					// Closest distance first
					expect(result.value[0]?.userId).toBe("user-b");
					expect(result.value[0]?.closestDistance).toBe(5);
				}
			});
		});

		it("should respect limit", async () => {
			await runInDurableObject(stub, async (instance: KeyboardRaffleDO) => {
				// Create 5 users
				for (let i = 0; i < 5; i++) {
					await instance.recordRoll(
						createTestRoll({
							id: `limit-test-${i}`,
							userId: `user-${i}`,
							displayName: `User${i}`,
						}),
					);
				}

				const result = await instance.getLeaderboard({ sortBy: "rolls", limit: 3 });
				expect(result.status).toBe("ok");
				if (result.status === "ok") {
					expect(result.value).toHaveLength(3);
				}
			});
		});
	});

	describe("lifecycle handlers", () => {
		it("should handle onStreamOnline", async () => {
			const result = await runInDurableObject(stub, (instance: KeyboardRaffleDO) =>
				instance.onStreamOnline(),
			);

			expect(result.status).toBe("ok");
		});

		it("should handle onStreamOffline", async () => {
			const result = await runInDurableObject(stub, (instance: KeyboardRaffleDO) =>
				instance.onStreamOffline(),
			);

			expect(result.status).toBe("ok");
		});
	});
});
