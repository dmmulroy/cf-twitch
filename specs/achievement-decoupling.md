# Achievement System Decoupling

**Status:** Ready for implementation  
**Effort:** L-XL (1-2 days)  
**Type:** Architecture refactor

## Problem

Achievement logic is scattered across saga DOs:

- `SongRequestSagaDO`: ~150 lines of achievement code (steps 6, 9, 10)
- `KeyboardRaffleSagaDO`: ~170 lines of achievement code (steps 4, 7)
- `StreamLifecycleDO`: ~60 lines for lifecycle notifications

This coupling causes:

- Poor code organization (achievement logic clutters saga flow)
- Low extensibility (adding achievements requires modifying sagas)
- Difficult testing (must mock multiple DOs to test achievements)
- Tight coupling between unrelated concerns

## Solution

Introduce an **EventBusDO** to decouple event producers (sagas) from consumers (AchievementsDO). Sagas publish events and forget; AchievementsDO subscribes and handles all achievement logic.

### Architecture

```
┌─────────────────────┐     publish      ┌─────────────┐
│ SongRequestSagaDO   │─────────────────▶│             │
└─────────────────────┘                  │             │
                                         │ EventBusDO  │──▶ DLQ (on failure)
┌─────────────────────┐     publish      │  (singleton)│
│ KeyboardRaffleSagaDO│─────────────────▶│             │
└─────────────────────┘                  │             │
                                         └──────┬──────┘
┌─────────────────────┐     publish             │
│ StreamLifecycleDO   │─────────────────▶───────┤
└─────────────────────┘                         │
                                                │ route
                                                ▼
                                         ┌──────────────┐
                                         │AchievementsDO│
                                         │              │
                                         │ - handle events
                                         │ - track streaks
                                         │ - check unlocks
                                         │ - send announcements
                                         └──────────────┘
```

### Event Flow Example (Song Request)

```
1. SongRequestSagaDO completes successfully
2. Saga publishes: { type: "song_request_success", v: 1, user, sagaId, timestamp }
3. EventBusDO receives, routes to AchievementsDO.handleEvent()
4. AchievementsDO:
   a. Increments streak (persisted in SQLite)
   b. Records song_request progress
   c. Checks if first request of stream (queries StreamLifecycleDO + own history)
   d. Unlocks achievements if thresholds met
   e. Sends chat announcements for unlocks
   f. Writes analytics
5. If step 4 fails: EventBusDO retries, eventually moves to DLQ
```

## Design Decisions

### EventBusDO

**Responsibilities:**

- Receive events from publishers
- Route to hardcoded subscriber handlers
- Retry failed deliveries with exponential backoff
- Persist failures to DLQ after max retries
- Alarm-based DLQ processing

**Not responsible for:**

- Event transformation
- Subscriber registration (hardcoded)
- Event ordering guarantees

**Instance model:** Singleton (low traffic, simplicity > scale)

### Event Schema

Location: `durable-objects/event-bus-do/schema.ts`

```typescript
// Base event structure
interface BaseEvent {
	id: string; // UUID, idempotency key
	type: string; // Event discriminant
	v: number; // Schema version
	timestamp: string; // ISO8601
	source: string; // Publisher DO name
}

// Domain events
interface SongRequestSuccessEvent extends BaseEvent {
	type: "song_request_success";
	v: 1;
	userId: string;
	userDisplayName: string;
	sagaId: string;
	trackId: string;
}

interface RaffleRollEvent extends BaseEvent {
	type: "raffle_roll";
	v: 1;
	userId: string;
	userDisplayName: string;
	sagaId: string;
	roll: number;
	winningNumber: number;
	distance: number;
	isWinner: boolean;
}

interface StreamOnlineEvent extends BaseEvent {
	type: "stream_online";
	v: 1;
	streamId: string;
	startedAt: string;
}

interface StreamOfflineEvent extends BaseEvent {
	type: "stream_offline";
	v: 1;
	streamId: string;
	endedAt: string;
}

type DomainEvent =
	| SongRequestSuccessEvent
	| RaffleRollEvent
	| StreamOnlineEvent
	| StreamOfflineEvent;
```

### Streak Tracking

**Moved entirely to AchievementsDO** with SQLite persistence.

Two streak types (song requests only):

- `song_request_session_streak`: Current consecutive successes this stream. Resets on `stream_online` event.
- `song_request_longest_streak`: High watermark, never decreases.

**Schema addition:**

```sql
CREATE TABLE user_song_request_streaks (
  user_id TEXT PRIMARY KEY,
  user_display_name TEXT NOT NULL,
  song_request_session_streak INTEGER NOT NULL DEFAULT 0,
  song_request_longest_streak INTEGER NOT NULL DEFAULT 0,
  last_request_at TEXT,
  session_started_at TEXT
);
```

> **Note:** Table/columns explicitly named for song requests. Raffle has no streak mechanic (consecutive wins too rare to track meaningfully).

**Streak semantics:**

- Only `song_request_success` events increment streak
- Failed sagas don't publish events, streak unchanged
- Retried requests that succeed continue from previous state
- Infrastructure errors (EventBusDO down) don't affect streak

### DLQ Design

**Schema:**

```sql
CREATE TABLE dead_letter_queue (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,           -- JSON serialized
  error TEXT NOT NULL,           -- Last error message
  attempts INTEGER NOT NULL,
  first_failed_at TEXT NOT NULL,
  last_failed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL       -- 30 days from first failure
);
```

**Retry policy:**

- Max 3 delivery attempts with exponential backoff (1s, 4s, 16s)
- After 3 failures: move to DLQ
- Alarm checks DLQ every 5 minutes, retries items older than 1 hour
- Auto-purge after 30 days

**Admin API:**

- `GET /api/admin/dlq` - List failed events
- `POST /api/admin/dlq/:id/replay` - Manual retry
- `DELETE /api/admin/dlq/:id` - Discard event

### Announcement Handling

**Kept in AchievementsDO** (simpler than separate AnnouncerDO).

After unlocking achievement:

1. Send chat message via TwitchService
2. Mark as announced
3. If chat fails: log warning, don't block (best-effort)

### "First Request of Stream" Logic

**Moved to AchievementsDO.** On `song_request_success`:

```typescript
async isFirstRequestOfStream(userId: string, streamStartedAt: string): Promise<boolean> {
  // Check own history for any song_request_success events after stream start
  // (excluding current event)
  const count = await this.db.query.songRequestHistory
    .where(and(
      gt(songRequestHistory.timestamp, streamStartedAt),
      ne(songRequestHistory.eventId, currentEventId)
    ))
    .count();
  return count === 0;
}
```

No longer queries SongQueueDO - AchievementsDO maintains its own event history.

## Deliverables

| #   | Deliverable                                             | Effort | Depends |
| --- | ------------------------------------------------------- | ------ | ------- |
| 1   | Define event schema types + Zod validators              | S      | -       |
| 2   | Implement EventBusDO (routing, retry, DLQ, alarm)       | L      | 1       |
| 3   | Add EventBusDO to wrangler.jsonc + migration            | S      | 2       |
| 4   | Add user_streaks table to AchievementsDO schema         | S      | -       |
| 5   | Add event history table to AchievementsDO               | S      | 1       |
| 6   | Implement AchievementsDO.handleEvent() dispatcher       | M      | 1, 4, 5 |
| 7   | Implement streak tracking in AchievementsDO             | M      | 4, 6    |
| 8   | Implement "first request" check in AchievementsDO       | S      | 5, 6    |
| 9   | Move announcement logic to AchievementsDO event handler | S      | 6       |
| 10  | Simplify SongRequestSagaDO (publish event only)         | M      | 2       |
| 11  | Simplify KeyboardRaffleSagaDO (publish event only)      | M      | 2       |
| 12  | Update StreamLifecycleDO to publish events              | S      | 2       |
| 13  | Remove streak tracking from SongQueueDO                 | S      | 7       |
| 14  | Add admin DLQ routes                                    | S      | 2       |
| 15  | Delete old achievement code from sagas                  | S      | 10, 11  |

**Suggested implementation order:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15

## Non-Goals

- Event sourcing / full event store
- Dynamic subscriber registration
- Cross-region event replication
- Event ordering guarantees
- Separate AnnouncerDO

## Risks

| Risk                             | Likelihood | Impact | Mitigation                                        |
| -------------------------------- | ---------- | ------ | ------------------------------------------------- |
| EventBusDO becomes bottleneck    | Low        | Medium | Monitor latency; partition if needed              |
| DLQ grows unbounded              | Low        | Low    | 30-day auto-purge; alerting on size               |
| Achievement timing feels delayed | Medium     | Low    | Fire-and-forget is fast; only DLQ adds delay      |
| Migration breaks existing data   | Low        | Medium | Achievements already isolated; streak data is new |

## Migration

1. Deploy new DOs (EventBusDO with empty handlers)
2. Deploy AchievementsDO with new schema + handleEvent()
3. Deploy saga changes (old code removed, publish added)
4. Delete SongQueueDO streak code
5. Run migration for any existing streak data (likely none in prod)

No backwards compatibility needed - rip and replace per your preference.

## Success Criteria

- [ ] Sagas contain zero achievement logic
- [ ] Adding new achievement requires only AchievementsDO changes
- [ ] Achievement tests don't mock saga internals
- [ ] DLQ captures and retries failed events
- [ ] Streaks persist across DO hibernation
- [ ] Session streaks reset on stream start
- [ ] Chat announcements still work
