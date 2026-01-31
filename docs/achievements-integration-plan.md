# Achievements Integration Plan

AchievementsDO is **100% implemented** but **unused**. This plan covers wiring it up.

## What Exists (No Work Needed)

- `AchievementsDO` - full 543-line DO with all RPC methods returning `Result<T,E>`
- DB schema + migrations (13 achievement definitions seeded)
- Error types (`AchievementDbError`, `AchievementNotFoundError`)
- `getStub("ACHIEVEMENTS_DO")` support
- Session reset via `onStreamOnline()`

## Integration Tasks

### 1. StreamLifecycleDO: Notify AchievementsDO on Lifecycle

**File:** `apps/api/src/durable-objects/stream-lifecycle-do.ts`

Add AchievementsDO to `notifyTokenDOsOnline()` and `notifyTokenDOsOffline()`:

```typescript
// In notifyTokenDOsOnline() ~line 343
const achievementsStub = getStub("ACHIEVEMENTS_DO");
const achievementsResult = await achievementsStub.onStreamOnline();
// log error if failed

// In notifyTokenDOsOffline() ~line 368
const achievementsResult = await achievementsStub.onStreamOffline();
```

Resets session-scoped achievements (`stream_opener`, streaks) on stream start.

---

### 2. SongRequestSagaDO: Record Achievement Events

**File:** `apps/api/src/durable-objects/song-request-saga-do.ts`

Add step after `write-history` (step 5), before `fulfill-redemption`:

```typescript
// Step 5.5: Record achievement event (non-critical)
await runner.executeStep(
	"record-achievement",
	async () => {
		const stub = getStub("ACHIEVEMENTS_DO");
		const result = await stub.recordEvent({
			userDisplayName: params.user_name,
			event: "song_request",
			eventId: sagaId,
		});

		if (result.status === "ok" && result.value.length > 0) {
			// Optionally announce in chat (or defer to separate announcement system)
			logger.info("Achievements unlocked", {
				sagaId,
				achievements: result.value.map((a) => a.name),
			});
		}
		return { result: undefined };
	},
	{ timeout: 10000, maxRetries: 2 },
);
```

**Events to fire:**

- `song_request` - triggers `first_request`, `request_10`, `request_50`, `request_100`

**Deferred (requires additional state):**

- `stream_first_request` - needs "is first request of stream" tracking

**Note:** Song request streaks now tracked in `user_song_request_streaks` table with columns `song_request_session_streak` and `song_request_longest_streak`. See specs/achievement-decoupling.md.

---

### 3. KeyboardRaffleSagaDO: Record Achievement Events

**File:** `apps/api/src/durable-objects/keyboard-raffle-saga-do.ts`

Add step after `record-roll` (step 3), before `fulfill-redemption`:

```typescript
// Step 3.5: Record achievement events (non-critical)
await runner.executeStep(
	"record-achievements",
	async () => {
		const stub = getStub("ACHIEVEMENTS_DO");

		// Always record roll
		const rollResult = await stub.recordEvent({
			userDisplayName: params.user_name,
			event: "raffle_roll",
			eventId: sagaId,
		});

		// Record win if winner
		if (isWinner) {
			await stub.recordEvent({
				userDisplayName: params.user_name,
				event: "raffle_win",
				eventId: `${sagaId}-win`,
			});
		}

		// TODO: raffle_close, raffle_closest_record need KeyboardRaffleDO state

		return { result: undefined };
	},
	{ timeout: 10000, maxRetries: 2 },
);
```

**Events to fire:**

- `raffle_roll` - triggers `first_roll`, `roll_25`, `roll_100`
- `raffle_win` - triggers `first_win`

**Deferred (requires KeyboardRaffleDO state):**

- `raffle_close` - needs distance comparison with global best
- `raffle_closest_record` - needs global closest distance tracking

---

### 4. API Routes

**File:** `apps/api/src/routes/api.ts`

```typescript
/**
 * GET /api/achievements/definitions
 * All achievement definitions
 */
api.get("/achievements/definitions", async (c) => {
	const stub = getStub("ACHIEVEMENTS_DO");
	const result = await stub.getDefinitions();
	if (result.status === "error") {
		return c.json({ error: result.error.message }, 500);
	}
	return c.json(result.value);
});

/**
 * GET /api/achievements/:user
 * User's achievement progress
 */
api.get("/achievements/:user", async (c) => {
	const user = c.req.param("user");
	const stub = getStub("ACHIEVEMENTS_DO");
	const result = await stub.getUserAchievements(user);
	if (result.status === "error") {
		return c.json({ error: result.error.message }, 500);
	}
	return c.json(result.value);
});

/**
 * GET /api/achievements/:user/unlocked
 * User's unlocked achievements only
 */
api.get("/achievements/:user/unlocked", async (c) => {
	const user = c.req.param("user");
	const stub = getStub("ACHIEVEMENTS_DO");
	const result = await stub.getUnlockedAchievements(user);
	if (result.status === "error") {
		return c.json({ error: result.error.message }, 500);
	}
	return c.json(result.value);
});

/**
 * GET /api/achievements/leaderboard?limit=10
 * Top users by achievement count
 */
api.get("/achievements/leaderboard", async (c) => {
	const limit = Number(c.req.query("limit") ?? 10);
	const stub = getStub("ACHIEVEMENTS_DO");
	const result = await stub.getLeaderboard({ limit });
	if (result.status === "error") {
		return c.json({ error: result.error.message }, 500);
	}
	return c.json(result.value);
});
```

---

### 5. Analytics

**File:** `apps/api/src/lib/analytics.ts`

```typescript
export interface AchievementUnlockMetric {
	user: string;
	achievementId: string;
	achievementName: string;
	category: string;
}

export function writeAchievementUnlockMetric(
	analytics: AnalyticsEngineDataset,
	metric: AchievementUnlockMetric,
): void {
	safeWriteMetric(analytics, "achievement_unlock", {
		blobs: [metric.user, metric.achievementId, metric.achievementName, metric.category],
		doubles: [],
	});
}
```

Call from saga steps when `recordEvent()` returns unlocked achievements.

---

## Deferred Work (Not in Scope)

| Feature                                  | Requires                                          | Notes                                                      |
| ---------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| `stream_first_request`                   | Session state in SongQueueDO or StreamLifecycleDO | Track "first request made this stream"                     |
| `raffle_close` / `raffle_closest_record` | KeyboardRaffleDO global state                     | Track/compare best distances                               |
| Chat announcements                       | Polling system or inline in sagas                 | `getUnannounced()` + `markAnnounced()` exist but no caller |

**Removed from scope:**
- Consecutive raffle wins achievement (odds too rare to be meaningful)

---

## Task Summary

| Task                                    | Priority | Effort    |
| --------------------------------------- | -------- | --------- |
| StreamLifecycleDO notify AchievementsDO | High     | ~10 lines |
| SongRequestSagaDO `recordEvent()`       | High     | ~20 lines |
| KeyboardRaffleSagaDO `recordEvent()`    | High     | ~30 lines |
| API routes                              | Medium   | ~50 lines |
| Analytics metric                        | Low      | ~15 lines |

**Total estimated:** ~125 lines of integration code
