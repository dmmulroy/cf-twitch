import { describe, expect, it } from "vite-plus/test";

import {
	evaluateAchievementRules,
	type AchievementRuleDefinition,
} from "../../durable-objects/achievements/rules";
import { createSongRequestSuccessEvent } from "../../durable-objects/schemas/event-bus-do.schema";

function definition(params: {
	id: string;
	triggerEvent: AchievementRuleDefinition["triggerEvent"];
	threshold: number | null;
	scope?: AchievementRuleDefinition["scope"];
}): AchievementRuleDefinition {
	return {
		id: params.id,
		name: params.id,
		description: `${params.id} description`,
		icon: "🏆",
		category: "song_request",
		threshold: params.threshold,
		triggerEvent: params.triggerEvent,
		scope: params.scope ?? "cumulative",
	};
}

describe("evaluateAchievementRules", () => {
	it("unlocks the Stream Opener for the first Song Request in a Stream Session", () => {
		const now = "2026-04-07T14:16:00.000Z";
		const event = createSongRequestSuccessEvent({
			id: "00000000-0000-4000-8000-000000000001",
			userId: "user-123",
			userDisplayName: "TestUser",
			sagaId: "saga-123",
			trackId: "spotify:track:abc123",
		});

		const decisions = evaluateAchievementRules({
			event,
			now,
			facts: {
				definitions: [
					definition({ id: "first_request", triggerEvent: "song_request", threshold: null }),
					definition({
						id: "stream_opener",
						triggerEvent: "stream_first_request",
						threshold: null,
						scope: "session",
					}),
				],
				viewer: {
					userId: "user-123",
					userDisplayName: "TestUser",
					progressByAchievementId: new Map(),
				},
				streamSession: {
					isLive: true,
					currentStreamStartedAt: "2026-04-07T14:15:00.000Z",
					isStreamOpenerCandidate: true,
				},
			},
		});

		expect(decisions).toContainEqual(
			expect.objectContaining({
				kind: "upsert-achievement-progress",
				achievementId: "stream_opener",
				newlyUnlocked: true,
				unlockedAt: now,
			}),
		);
		expect(decisions).toContainEqual(
			expect.objectContaining({
				kind: "queue-achievement-unlock-effect",
				userDisplayName: "TestUser",
			}),
		);
	});

	it("sets Request Streak achievement progress to the current streak count", () => {
		const now = "2026-04-07T14:18:00.000Z";
		const event = createSongRequestSuccessEvent({
			id: "00000000-0000-4000-8000-000000000002",
			userId: "user-123",
			userDisplayName: "TestUser",
			sagaId: "saga-456",
			trackId: "spotify:track:def456",
		});

		const decisions = evaluateAchievementRules({
			event,
			now,
			facts: {
				definitions: [definition({ id: "streak_3", triggerEvent: "request_streak", threshold: 3 })],
				viewer: {
					userId: "user-123",
					userDisplayName: "TestUser",
					progressByAchievementId: new Map(),
					requestStreak: {
						userId: "user-123",
						userDisplayName: "TestUser",
						sessionStreak: 2,
						longestStreak: 2,
						lastRequestAt: "2026-04-07T14:17:00.000Z",
					},
				},
				streamSession: {
					isLive: true,
					currentStreamStartedAt: "2026-04-07T14:15:00.000Z",
					isStreamOpenerCandidate: false,
				},
			},
		});

		expect(decisions).toContainEqual(
			expect.objectContaining({
				kind: "update-request-streak",
				sessionStreak: 3,
				longestStreak: 3,
			}),
		);
		expect(decisions).toContainEqual(
			expect.objectContaining({
				kind: "upsert-achievement-progress",
				achievementId: "streak_3",
				progress: 3,
				newlyUnlocked: true,
			}),
		);
	});
});
