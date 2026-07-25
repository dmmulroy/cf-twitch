/**
 * KeyboardRaffleDO integration tests
 *
 * Tests public raffle behavior through the Agent interface.
 */

import { beforeEach, describe, expect, it } from "vite-plus/test";

import { getStub } from "../../lib/durable-objects";

import type { RecordRaffleRollInput } from "../../durable-objects/schemas/keyboard-raffle-do.schema";

type TestRollOverrides = Partial<RecordRaffleRollInput> & { readonly distance?: number };

function createTestRoll(overrides: TestRollOverrides = {}): RecordRaffleRollInput {
	const winningNumber = overrides.winningNumber ?? 777;
	const roll = overrides.roll ?? winningNumber - (overrides.distance ?? 277);
	const { distance: _derivedDistance, ...inputOverrides } = overrides;
	return {
		id: `roll-${Date.now()}-${crypto.randomUUID()}`,
		userId: "user-123",
		displayName: "TestUser",
		roll,
		winningNumber,
		rolledAt: new Date().toISOString(),
		...inputOverrides,
	};
}

describe("KeyboardRaffleDO", () => {
	type KeyboardRaffleStub = ReturnType<typeof getStub<"KEYBOARD_RAFFLE_DO">>;

	let stub: KeyboardRaffleStub;
	let raffleName: string;

	beforeEach(async () => {
		raffleName = `keyboard-raffle-${crypto.randomUUID()}`;
		stub = getStub("KEYBOARD_RAFFLE_DO", raffleName);
		await stub.getClosestRecord();
	});

	describe("recordRoll", () => {
		it("records a roll and returns the persisted roll plus record status", async () => {
			const rollData = createTestRoll({ id: "test-roll-1" });

			const result = await stub.recordRoll(rollData);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.roll).toMatchObject({
					id: "test-roll-1",
					userId: "user-123",
					isWinner: false,
				});
				expect(result.value.isNewRecord).toBe(true);
			}
		});

		it("marks a roll as a winner when distance is 0", async () => {
			const rollData = createTestRoll({
				id: "winner-roll",
				roll: 777,
				winningNumber: 777,
				distance: 0,
			});

			const result = await stub.recordRoll(rollData);

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.roll.isWinner).toBe(true);
				expect(result.value.isNewRecord).toBe(false);
			}
		});

		it("replays the same stable Roll id with its original record result", async () => {
			const input = createTestRoll({ id: "idempotent-roll", roll: 770, winningNumber: 777 });
			const first = await stub.recordRoll(input);
			const replay = await stub.recordRoll(input);

			expect(first.status).toBe("ok");
			expect(replay.status).toBe("ok");
			if (first.status === "ok" && replay.status === "ok") {
				expect(replay.value).toEqual(first.value);
			}
			const stats = await stub.getUserStats(input.userId);
			expect(stats.status === "ok" && stats.value.totalRolls).toBe(1);
		});

		it("rejects a stable Roll id replayed with different immutable evidence", async () => {
			const input = createTestRoll({ id: "conflicting-roll" });
			await stub.recordRoll(input);
			const conflict = await stub.recordRoll({ ...input, roll: input.roll + 1 });
			expect(conflict).toMatchObject({
				status: "error",
				error: { _tag: "RollIdempotencyConflictError", rollId: input.id },
			});
		});

		it("parses Roll RPC input and derives Distance instead of trusting caller fields", async () => {
			const contradictory = await stub.recordRoll({
				...createTestRoll({ id: "contradictory-roll", roll: 777, winningNumber: 777 }),
				distance: 5,
				isWinner: false,
			});
			expect(contradictory).toMatchObject({
				status: "error",
				error: { _tag: "KeyboardRaffleInputParseError" },
			});

			const outOfRange = await stub.recordRoll({
				...createTestRoll({ id: "out-of-range-roll" }),
				roll: 10_001,
			});
			expect(outOfRange).toMatchObject({
				status: "error",
				error: { _tag: "KeyboardRaffleInputParseError" },
			});
		});

		it("allows multiple rolls from the same user", async () => {
			const result1 = await stub.recordRoll(createTestRoll({ id: "roll-1" }));
			const result2 = await stub.recordRoll(createTestRoll({ id: "roll-2" }));

			expect(result1.status).toBe("ok");
			expect(result2.status).toBe("ok");
		});

		it("flags only strictly better non-winning rolls as new records", async () => {
			const first = await stub.recordRoll(
				createTestRoll({
					id: "record-1",
					userId: "record-user-1",
					displayName: "RecordUser1",
					distance: 50,
				}),
			);
			const tied = await stub.recordRoll(
				createTestRoll({
					id: "record-2",
					userId: "record-user-2",
					displayName: "RecordUser2",
					distance: 50,
				}),
			);
			const better = await stub.recordRoll(
				createTestRoll({
					id: "record-3",
					userId: "record-user-3",
					displayName: "RecordUser3",
					distance: 12,
				}),
			);

			expect(first.status).toBe("ok");
			expect(tied.status).toBe("ok");
			expect(better.status).toBe("ok");
			if (first.status === "ok" && tied.status === "ok" && better.status === "ok") {
				expect(first.value.isNewRecord).toBe(true);
				expect(tied.value.isNewRecord).toBe(false);
				expect(better.value.isNewRecord).toBe(true);
			}
		});
	});

	describe("deleteRollById", () => {
		it("deletes an existing roll", async () => {
			await stub.recordRoll(createTestRoll({ id: "roll-to-delete" }));

			const result = await stub.deleteRollById("roll-to-delete");

			expect(result.status).toBe("ok");
		});

		it("treats deletion replay after the Roll is already absent as idempotent success", async () => {
			const first = await stub.deleteRollById("nonexistent-roll-id");
			const replay = await stub.deleteRollById("nonexistent-roll-id");

			expect(first.status).toBe("ok");
			expect(replay.status).toBe("ok");
		});

		it("updates the leaderboard after deletion", async () => {
			await stub.recordRoll(createTestRoll({ id: "temp-roll", userId: "temp-user" }));

			let leaderboard = await stub.getLeaderboard({ sortBy: "rolls", limit: 10 });
			expect(leaderboard.status).toBe("ok");
			if (leaderboard.status === "ok") {
				const user = leaderboard.value.find((entry) => entry.userId === "temp-user");
				expect(user).toBeDefined();
			}

			await stub.deleteRollById("temp-roll");

			leaderboard = await stub.getLeaderboard({ sortBy: "rolls", limit: 10 });
			expect(leaderboard.status).toBe("ok");
			if (leaderboard.status === "ok") {
				const user = leaderboard.value.find((entry) => entry.userId === "temp-user");
				expect(user).toBeUndefined();
			}
		});
	});

	describe("getUserStats", () => {
		it("returns a not-found error for a user with no rolls", async () => {
			const result = await stub.getUserStats("nonexistent-user");

			expect(result.status).toBe("error");
			if (result.status === "error") {
				expect(result.error.message).toContain("No stats found for user: nonexistent-user");
			}
		});

		it("returns stats after a user rolls", async () => {
			await stub.recordRoll(
				createTestRoll({
					id: "stats-roll-1",
					userId: "stats-user",
					displayName: "StatsUser",
				}),
			);

			const result = await stub.getUserStats("stats-user");
			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.userId).toBe("stats-user");
				expect(result.value.totalRolls).toBe(1);
				expect(result.value.totalWins).toBe(0);
			}
		});

		it("tracks wins correctly", async () => {
			await stub.recordRoll(
				createTestRoll({
					id: "winning-roll",
					userId: "winner-user",
					roll: 777,
					winningNumber: 777,
					distance: 0,
				}),
			);

			const result = await stub.getUserStats("winner-user");
			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.totalWins).toBe(1);
			}
		});

		it("tracks the closest distance", async () => {
			await stub.recordRoll(
				createTestRoll({
					id: "far-roll",
					userId: "distance-user",
					roll: 100,
					winningNumber: 777,
					distance: 677,
				}),
			);
			await stub.recordRoll(
				createTestRoll({
					id: "close-roll",
					userId: "distance-user",
					roll: 770,
					winningNumber: 777,
					distance: 7,
				}),
			);

			const result = await stub.getUserStats("distance-user");
			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.closestDistance).toBe(7);
			}
		});
	});

	describe("getUserStatsByDisplayName", () => {
		it("returns stats by display name", async () => {
			await stub.recordRoll(
				createTestRoll({
					id: "display-name-roll",
					userId: "display-name-user",
					displayName: "DisplayNameUser",
				}),
			);

			const result = await stub.getUserStatsByDisplayName("DisplayNameUser");
			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value.userId).toBe("display-name-user");
				expect(result.value.displayName).toBe("DisplayNameUser");
			}
		});
	});

	describe("getLeaderboard", () => {
		it("returns an empty leaderboard initially", async () => {
			const result = await stub.getLeaderboard({ sortBy: "rolls", limit: 10 });

			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toHaveLength(0);
			}
		});

		it("sorts by rolls correctly", async () => {
			for (let i = 0; i < 3; i++) {
				await stub.recordRoll(
					createTestRoll({
						id: `user-a-${i}`,
						userId: "user-a",
						displayName: "UserA",
					}),
				);
			}
			await stub.recordRoll(
				createTestRoll({
					id: "user-b-1",
					userId: "user-b",
					displayName: "UserB",
				}),
			);

			const result = await stub.getLeaderboard({ sortBy: "rolls", limit: 10 });
			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toHaveLength(2);
				expect(result.value[0]?.userId).toBe("user-a");
				expect(result.value[0]?.totalRolls).toBe(3);
				expect(result.value[1]?.userId).toBe("user-b");
				expect(result.value[1]?.totalRolls).toBe(1);
			}
		});

		it("sorts by wins correctly", async () => {
			await stub.recordRoll(
				createTestRoll({
					id: "user-a-win",
					userId: "user-a",
					displayName: "UserA",
					roll: 777,
					winningNumber: 777,
					distance: 0,
				}),
			);
			await stub.recordRoll(
				createTestRoll({
					id: "user-b-win-1",
					userId: "user-b",
					displayName: "UserB",
					roll: 777,
					winningNumber: 777,
					distance: 0,
				}),
			);
			await stub.recordRoll(
				createTestRoll({
					id: "user-b-win-2",
					userId: "user-b",
					displayName: "UserB",
					roll: 500,
					winningNumber: 500,
					distance: 0,
				}),
			);

			const result = await stub.getLeaderboard({ sortBy: "wins", limit: 10 });
			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value[0]?.userId).toBe("user-b");
				expect(result.value[0]?.totalWins).toBe(2);
			}
		});

		it("sorts by closest distance correctly", async () => {
			await stub.recordRoll(
				createTestRoll({
					id: "user-a-roll",
					userId: "user-a",
					displayName: "UserA",
					roll: 677,
					winningNumber: 777,
					distance: 100,
				}),
			);
			await stub.recordRoll(
				createTestRoll({
					id: "user-b-roll",
					userId: "user-b",
					displayName: "UserB",
					roll: 772,
					winningNumber: 777,
					distance: 5,
				}),
			);

			const result = await stub.getLeaderboard({ sortBy: "closest", limit: 10 });
			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value[0]?.userId).toBe("user-b");
				expect(result.value[0]?.closestDistance).toBe(5);
			}
		});

		it("respects the limit", async () => {
			for (let i = 0; i < 5; i++) {
				await stub.recordRoll(
					createTestRoll({
						id: `limit-test-${i}`,
						userId: `user-${i}`,
						displayName: `User${i}`,
					}),
				);
			}

			const result = await stub.getLeaderboard({ sortBy: "rolls", limit: 3 });
			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toHaveLength(3);
			}
		});
	});

	describe("getClosestRecord", () => {
		it("returns the closest non-winning record and ignores winners", async () => {
			await stub.recordRoll(
				createTestRoll({
					id: "winner-roll",
					userId: "winner-user",
					displayName: "WinnerUser",
					roll: 777,
					winningNumber: 777,
					distance: 0,
				}),
			);
			await stub.recordRoll(
				createTestRoll({
					id: "far-record",
					userId: "far-user",
					displayName: "FarUser",
					distance: 25,
				}),
			);
			await stub.recordRoll(
				createTestRoll({
					id: "close-record",
					userId: "close-user",
					displayName: "CloseUser",
					distance: 3,
				}),
			);

			const result = await stub.getClosestRecord();
			expect(result.status).toBe("ok");
			if (result.status === "ok") {
				expect(result.value).toEqual({
					userId: "close-user",
					displayName: "CloseUser",
					distance: 3,
				});
			}
		});
	});
});
