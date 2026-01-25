# Workflow → Durable Object Migration Plan

**Status:** Planning  
**Created:** 2026-01-27  
**Author:** AI-assisted analysis (Librarian + Oracle consultation)

## Executive Summary

Migrate from Cloudflare Workflows to Durable Objects to eliminate cold start latency. Even with pre-warming pools, Workflows add ~200-500ms overhead from the `waitForEvent("activate")` hop. DOs provide direct RPC invocation with single-digit millisecond latency.

### Key Decisions

| Workflow                 | Migration Target       | Rationale                                       |
| ------------------------ | ---------------------- | ----------------------------------------------- |
| `SongRequestWorkflow`    | `SongRequestSagaDO`    | Complex saga with rollback, external APIs, PoNR |
| `KeyboardRaffleWorkflow` | `KeyboardRaffleSagaDO` | Saga with rollback, simpler but same pattern    |
| `ChatCommandWorkflow`    | Inline in Worker/route | Simple request/response, no saga needed         |

### Architecture Pattern

**Per-Saga DO Instance** (NOT single orchestrator per type):

- DO ID = redemption/event ID
- Each saga runs in its own single-threaded DO
- No global bottleneck under load
- Clean durability and retry via DO alarms

## Current State Analysis

### Pain Points

1. **Workflow cold starts** - Even with `WorkflowPoolDO` maintaining 3 warm instances, there's latency from:
   - Pool lookup RPC to `WorkflowPoolDO`
   - `sendEvent("activate")` to wake warm instance
   - Workflow step execution overhead

2. **Warm pool complexity** - Extra infrastructure (WorkflowPoolDO, warm-workflow.ts) adds maintenance burden

3. **Step execution overhead** - CF Workflows persist every step result, even for fast operations

### Current Flows

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Current: Workflow Pattern                        │
├─────────────────────────────────────────────────────────────────────┤
│  Webhook → WorkflowPoolDO.getWarmInstance() → workflow.sendEvent()  │
│         → WorkflowEntrypoint.run() → step.do() × N → complete       │
│                                                                      │
│  Latency: Pool RPC (~10ms) + activate event (~50-200ms) +           │
│           step persistence overhead per step                         │
└─────────────────────────────────────────────────────────────────────┘
```

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Target: Saga DO Pattern                          │
├─────────────────────────────────────────────────────────────────────┤
│  Webhook → SagaDO.get(redemptionId).start(params)                   │
│         → execute steps with SQLite persistence → complete           │
│                                                                      │
│  Latency: Single DO RPC (~5-10ms) + step execution (no persistence  │
│           overhead for transient steps)                              │
└─────────────────────────────────────────────────────────────────────┘
```

## Migration Architecture

### 1. SongRequestSagaDO

Handles the full song request saga with proper rollback support.

#### Schema (Drizzle)

```typescript
// schemas/song-request-saga-do.schema.ts

export const sagaRuns = sqliteTable("saga_runs", {
	id: text("id").primaryKey(), // redemption ID
	status: text("status").notNull(), // RUNNING | COMPLETED | FAILED | COMPENSATING
	paramsJson: text("params_json").notNull(), // SongRequestParams serialized
	fulfilledAt: text("fulfilled_at"), // ISO8601 - marks PoNR
	createdAt: text("created_at").notNull(),
	updatedAt: text("updated_at").notNull(),
	error: text("error"), // Last error message if failed
});

export const sagaSteps = sqliteTable(
	"saga_steps",
	{
		sagaId: text("saga_id").notNull(),
		stepName: text("step_name").notNull(),
		state: text("state").notNull(), // PENDING | SUCCEEDED | FAILED | COMPENSATED
		attempt: integer("attempt").notNull().default(0),
		resultJson: text("result_json"), // Step output for idempotent replay
		undoJson: text("undo_json"), // Payload for compensation
		nextRetryAt: text("next_retry_at"), // ISO8601 for alarm scheduling
		lastError: text("last_error"),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.sagaId, table.stepName] }),
	}),
);
```

#### Step Execution Algorithm

```typescript
async executeStep<T>(
  stepName: string,
  execute: () => Promise<{ result: T; undoPayload?: unknown }>,
  options?: { timeout?: number; maxRetries?: number }
): Promise<Result<T, SagaStepError>> {
  // 1. Check for cached success (idempotent replay)
  const existing = await this.db.query.sagaSteps.findFirst({
    where: and(eq(sagaSteps.sagaId, this.sagaId), eq(sagaSteps.stepName, stepName)),
  });

  if (existing?.state === "SUCCEEDED") {
    return Result.ok(JSON.parse(existing.resultJson) as T);
  }

  // 2. Increment attempt, update state
  const attempt = (existing?.attempt ?? 0) + 1;
  await this.db.insert(sagaSteps)
    .values({
      sagaId: this.sagaId,
      stepName,
      state: "PENDING",
      attempt,
    })
    .onConflictDoUpdate({
      target: [sagaSteps.sagaId, sagaSteps.stepName],
      set: { attempt, state: "PENDING", updatedAt: now() },
    });

  // 3. Execute step with timeout
  try {
    const { result, undoPayload } = await withTimeout(execute(), options?.timeout ?? 30000);

    // 4. Persist success
    await this.db.update(sagaSteps)
      .set({
        state: "SUCCEEDED",
        resultJson: JSON.stringify(result),
        undoJson: undoPayload ? JSON.stringify(undoPayload) : null,
      })
      .where(and(eq(sagaSteps.sagaId, this.sagaId), eq(sagaSteps.stepName, stepName)));

    return Result.ok(result);
  } catch (error) {
    // 5. Handle failure - schedule retry or mark failed
    const shouldRetry = isRetryableError(error) && attempt < (options?.maxRetries ?? 3);

    if (shouldRetry) {
      const delay = Math.min(30000, 1000 * Math.pow(2, attempt));
      const nextRetryAt = new Date(Date.now() + delay).toISOString();

      await this.db.update(sagaSteps)
        .set({ state: "PENDING", nextRetryAt, lastError: String(error) })
        .where(and(eq(sagaSteps.sagaId, this.sagaId), eq(sagaSteps.stepName, stepName)));

      // Schedule alarm for retry
      await this.ctx.storage.setAlarm(Date.now() + delay);

      return Result.err(new SagaStepRetrying({ stepName, attempt, nextRetryAt }));
    }

    // Mark permanently failed
    await this.db.update(sagaSteps)
      .set({ state: "FAILED", lastError: String(error) })
      .where(and(eq(sagaSteps.sagaId, this.sagaId), eq(sagaSteps.stepName, stepName)));

    return Result.err(new SagaStepFailed({ stepName, error: String(error) }));
  }
}
```

#### Song Request Steps

| Step                     | Rollback                  | Notes                                    |
| ------------------------ | ------------------------- | ---------------------------------------- |
| `parse-spotify-url`      | None                      | Validation only, NonRetryable on invalid |
| `get-track-info`         | None                      | Read-only, retry on transient errors     |
| `persist-request`        | Delete from SongQueueDO   | Idempotent via eventId PK                |
| `add-to-spotify-queue`   | Skip if currently playing | Best-effort, Spotify has no remove API   |
| `write-history`          | None                      | Analytics, non-critical                  |
| `fulfill-redemption`     | **POINT OF NO RETURN**    | After this, no refunds                   |
| `send-chat-confirmation` | None                      | Best-effort, don't fail saga             |

#### Point of No Return Handling

```typescript
// After fulfill step succeeds
await this.db.update(sagaRuns)
  .set({ fulfilledAt: new Date().toISOString() })
  .where(eq(sagaRuns.id, this.sagaId));

// In compensation handler
async compensateAll(): Promise<void> {
  const saga = await this.db.query.sagaRuns.findFirst({
    where: eq(sagaRuns.id, this.sagaId),
  });

  if (saga?.fulfilledAt) {
    // PoNR reached - only safe compensations (DB cleanup), NO refund
    logger.warn("PoNR reached, skipping refund", { sagaId: this.sagaId });
    await this.compensateInternalSteps();
  } else {
    // Full compensation including refund
    await this.compensateAllSteps();
    await this.refundRedemption();
  }
}
```

### 2. KeyboardRaffleSagaDO

Similar pattern to SongRequestSagaDO but simpler:

| Step                      | Rollback                     | Notes                               |
| ------------------------- | ---------------------------- | ----------------------------------- |
| `generate-winning-number` | None                         | Deterministic in step result        |
| `generate-user-roll`      | None                         | Deterministic in step result        |
| `record-roll`             | Delete from KeyboardRaffleDO | Idempotent via roll ID              |
| `fulfill-redemption`      | None (PoNR)                  | Always fulfill (winners and losers) |
| `send-chat-message`       | None                         | Best-effort                         |

### 3. ChatCommandWorkflow → Inline Handler

No saga needed. Convert to simple route handler with lightweight idempotency:

```typescript
// routes/chat-commands.ts

app.post("/internal/chat-command", async (c) => {
	const params = ChatCommandParamsSchema.parse(await c.req.json());

	// Optional: Idempotency via message_id in KV or small DO
	// For chat responses, duplicate sends are generally harmless

	const command = parseCommand(params.message.text);
	if (!command) {
		return c.json({ error: "Unknown command" }, 400);
	}

	const response = await handleCommand(command, c.env);

	const twitchService = new TwitchService(c.env);
	const result = await twitchService.sendChatMessage(response);

	if (result.status === "error") {
		// Log but don't fail - chat is best-effort
		logger.warn("Failed to send chat response", { error: result.error.message });
	}

	return c.json({ success: true });
});
```

## Implementation Tasks

### Phase 1: Infrastructure (Task 75-77)

1. **Create SagaRunner base class** - Reusable saga execution logic
2. **Create saga schemas** - Drizzle migrations for saga_runs, saga_steps
3. **Add saga error types** - SagaStepError, SagaCompensationError, etc.

### Phase 2: SongRequestSagaDO (Task 78-80)

1. **Implement SongRequestSagaDO** - Full saga with all steps
2. **Add alarm handler for retries** - DO.alarm() implementation
3. **Wire up webhook trigger** - Replace workflow.create() with sagaDO.start()

### Phase 3: KeyboardRaffleSagaDO (Task 81-82)

1. **Implement KeyboardRaffleSagaDO** - Similar to song request
2. **Wire up webhook trigger** - Replace workflow trigger

### Phase 4: ChatCommand Inline (Task 83)

1. **Move to route handler** - Simple inline execution

### Phase 5: Cleanup (Task 84-85)

1. **Remove WorkflowPoolDO** - No longer needed
2. **Remove Workflow exports** - Clean up index.ts
3. **Update wrangler.jsonc** - Remove workflow bindings

## Rollback Strategy

If issues arise post-migration:

1. Workflow bindings remain in wrangler.jsonc (commented) for quick restore
2. Old workflow files preserved in `workflows-deprecated/` directory
3. Feature flag to route between old/new paths during transition

## Performance Expectations

| Metric             | Current (Workflows) | Target (DO Saga)      |
| ------------------ | ------------------- | --------------------- |
| Cold start latency | 200-500ms           | 5-10ms                |
| Warm activation    | 50-200ms            | N/A (no warming)      |
| Step persistence   | Every step          | Only on failure/retry |
| Concurrent sagas   | Limited by pool     | Unlimited (per-ID DO) |

## Open Questions

1. **Alarm reliability** - DO alarms have ~1s precision. Acceptable for retry backoff?
2. **Saga timeout** - What's the max saga duration before force-fail? (Current: 24h warm timeout)
3. **Observability** - How to expose saga state for debugging? Admin API? Logs only?

## References

- [Cloudflare DO Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Saga Pattern](https://microservices.io/patterns/data/saga.html)
- [cf-workflow-rollback](https://github.com/dmmulroy/cf-workflow-rollback) - Current rollback library
