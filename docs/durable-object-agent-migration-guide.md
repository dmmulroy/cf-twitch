# Durable Object → Agent migration guide

This doc captures lessons learned from migrating `apps/api/src/durable-objects/stream-lifecycle-do.ts` from a plain `DurableObject<Env>` to `Agent<Env, StreamLifecycleAgentState>`.

It is intended as a playbook for migrating other Durable Objects in this repo.

## How this was reviewed

I reviewed the migration in three ways:

1. the final implementation in `apps/api/src/durable-objects/stream-lifecycle-do.ts`
2. the rewritten tests in `apps/api/src/__tests__/durable-objects/stream-lifecycle-do.test.ts`
3. the saved pi session for this repo

I also attempted to use the pi CLI directly against the current session file:

```bash
pi -p --session ~/.pi/agent/sessions/--Users-dmmulroy-Code-personal-cf-twitch--/2026-04-05T18-52-22-765Z_f88957f1-59b2-47eb-83a8-464c0c9d573f.jsonl --no-tools "Review this session history focusing on the StreamLifecycleDO migration from DurableObject to Agent..."
```

In this harness, that subprocess returned no model output, so the guidance below is based on the saved session context, the code review feedback, and the final code/tests.

## What changed in `StreamLifecycleDO`

### Before

`StreamLifecycleDO` was a regular Durable Object that used:

- `DurableObject<Env>`
- constructor-time Drizzle migrations
- in-memory live state
- custom `fetch()` switch routing
- raw alarm-based viewer polling
- legacy/debug compatibility paths

### After

`StreamLifecycleDO` now uses:

- `Agent<Env, StreamLifecycleAgentState>`
- `initialState` for current stream state
- `onStart()` for bootstrap and migration work
- `ctx.blockConcurrencyWhile(...)` during startup
- `scheduleEvery()` / `cancelSchedule()` instead of alarms
- `onRequest()` instead of the old `fetch()` switch
- Agent state for hot/current lifecycle state
- Drizzle/SQLite for history/query data like viewer snapshots

### Current state split

The migration worked best once state ownership became explicit:

#### Agent state

Use Agent state for current mutable state:

- `isLive`
- `startedAt`
- `endedAt`
- `peakViewerCount`
- `streamSessionId`
- `viewerPollScheduleId`

#### SQLite / Drizzle

Keep durable history/query data in SQLite:

- `viewer_snapshots`
- any audit/history/query-oriented records

## Biggest migration struggles

## 1. Testing pressure pushed the design in the wrong direction at first

The hardest part of the migration was not the runtime refactor itself. It was testing.

Main friction points:

- Agent lifecycle differs from plain DO lifecycle
- startup behavior moved into `onStart()`
- scheduling behavior changed
- cross-DO RPC is already brittle in worker-pool tests
- the task explicitly disallowed `vi.mock()` / module mocking

That led to an initial temptation to add:

- test-only dependency injection hooks
- `envOverride` plumbing in `getStub()`
- implementation-detail seams that only existed to satisfy tests

Review feedback correctly pushed back on that.

### Lesson

Do not mutate production design just to accommodate test harness limitations.

For this repo, prefer:

- public-method tests
- `runInDurableObject(...)` where needed
- real stub interactions where practical
- `fetchMock` only for true external HTTP boundaries

Avoid:

- `setTestDependencies()` / `clearTestDependencies()` patterns
- test-only branches in production code
- env override escape hatches added purely for tests

## 2. Backward compatibility logic can sprawl if not constrained

The initial migration drifted toward ongoing compatibility code:

- syncing old DB state continuously
- reconciling Agent state from legacy storage repeatedly
- keeping compatibility shims around after the migration point

Review feedback pushed toward a simpler rule:

- do a one-time migration in `onStart()`
- switch fully to the Agent-native model
- delete old compatibility paths immediately after migration

### Lesson

Prefer a one-time state migration over indefinite dual-write or dual-read logic.

For `StreamLifecycleDO`, the right pattern was:

1. run migrations in `onStart()`
2. read the old row once
3. hydrate Agent state if needed
4. delete the old compatibility row
5. continue from the new source of truth only

## 3. Migration is the right time to delete old code

The migration surfaced several pieces of code that no longer deserved to survive:

- old debug `ping`
- vestigial websocket/debug behavior
- compatibility sync helpers
- old fetch/alarm-era leftovers

### Lesson

When migrating to Agent, treat the work as a cleanup opportunity, not a preservation exercise.

If a route/helper/path only exists because of the old DO shape, strongly prefer deleting it during migration.

## 4. Types and runtime conventions still matter

Review feedback also called out avoiding type/runtime workarounds.

### Lesson

Use the repo's normal conventions instead of introducing migration-only type shims.

Specifically:

- keep using Wrangler-generated types
- keep using typed `Env`
- keep using typed DO namespaces
- keep using `getStub()` normally
- do not add ad hoc env injection just to make migration easier

## Recommended migration playbook for other DOs

## Step 1: inventory the DO's public contract first

Before refactoring the class, list all public entrypoints:

- RPC methods other DOs call
- route handlers or compatibility endpoints
- scheduled/alarm entrypoints
- any lifecycle side effects callers depend on

This prevents accidental behavior regressions while internals change.

### Rule

Preserve the public contract first. Rewrite internals second.

## Step 2: classify each piece of state

For each DO, separate state into three buckets:

### Agent state

Use for:

- current status
- active session ids
- in-flight flags
- schedule ids
- small mutable state needed often

### SQLite / Drizzle state

Use for:

- history
- audit trails
- queries over time
- large or append-only records

### Derived/transient state

Use for:

- values that can be recomputed cheaply
- process-local timing helpers
- ephemeral helpers not worth persisting

### Rule of thumb

If the value answers "what is true right now?", it probably belongs in Agent state.

If it answers "what happened over time?", it probably belongs in SQLite.

## Step 3: move bootstrap into `onStart()`

For Agent migrations in this repo, startup work should follow this pattern:

```ts
async onStart(): Promise<void> {
  await this.ctx.blockConcurrencyWhile(async () => {
    await migrate(this.db, migrations);
    await this.migrateLegacyStateOnce();
    await this.restoreOrCancelSchedules();
  });
}
```

### Why

This keeps startup deterministic and prevents request handling from racing with bootstrap/migration work.

### Rule

Use `ctx.blockConcurrencyWhile(...)` for migration/bootstrap work that must complete before normal handling.

## Step 4: replace alarms deliberately

When a plain DO used alarms, map each alarm responsibility explicitly.

### Common mapping

- recurring work → `scheduleEvery()`
- one-shot delayed work → `schedule()`
- cleanup/shutdown → `cancelSchedule()`

### Important

Store schedule ids in Agent state when you need to:

- avoid duplicate schedules
- cancel a prior schedule
- restore behavior after startup

For `StreamLifecycleDO`, this became `viewerPollScheduleId`.

## Step 5: choose one source of truth for current state

Avoid mixing current-state ownership across Agent state and DB rows.

For migrated DOs, prefer:

- Agent state as the source of truth for current state
- DB tables as the source of truth for historical records

### Bad pattern

- update Agent state
- also mirror the same concept forever in a legacy row
- reconcile both on every request/startup

### Good pattern

- migrate once
- keep current state only in Agent state
- delete the compatibility representation

## Step 6: keep state updates explicit

Use `this.setState(...)` deliberately and consistently.

Prefer small, explicit updates that make ownership obvious.

Be careful about:

- mutating nested objects in place
- assuming in-memory changes are persistence changes
- partially updating state while another field still reflects old ownership rules

## Step 7: migrate tests to public behavior, not internals

A DO → Agent migration usually changes:

- startup timing
- scheduling shape
- request entrypoints
- where data is stored

That often means tests need to be rewritten, not lightly patched.

### Test the following

- public RPC methods
- observable state transitions
- durable history outcomes
- route compatibility where still supported
- externally visible side effects

### Avoid testing

- private helpers
- migration-only internals
- test-only injection seams
- constructor/bootstrap implementation details unless they are the behavior under test

### For this repo specifically

Prefer:

- Vitest with worker pools
- `runInDurableObject(...)`
- `fetchMock` for Twitch/Spotify/external APIs

Avoid:

- `vi.mock()`
- filesystem/module mocking
- production code branches created only for tests

## Step 8: do a cleanup pass after the migration compiles

Once the Agent version works, do a second pass specifically to remove:

- debug routes
- leftover compatibility helpers
- env/test hooks introduced during exploration
- old alarm/fetch-era code paths
- dead abstractions that no longer justify themselves

This step mattered a lot in the `StreamLifecycleDO` migration.

## Repo-specific rules for future DO → Agent migrations

When migrating more DOs in this repo, follow these rules:

- use a one-time migration in `onStart()`
- wrap startup migration/bootstrap in `ctx.blockConcurrencyWhile(...)`
- keep Agent state small and focused on current mutable state
- keep Drizzle/SQLite for history and query-oriented records
- preserve public RPC methods where possible
- use `onRequest()` only for compatibility HTTP endpoints that still matter
- replace alarms with Agent scheduling APIs intentionally
- do not add `getStub(..., envOverride)`-style workarounds
- do not add test-only dependency injection to production code
- use Wrangler-generated types instead of migration-specific type hacks
- delete debug and backward-compat code during the migration

## Suggested checklist for the next migration

Use this checklist before opening review:

### Design

- [ ] listed all public RPC/HTTP/scheduled entrypoints
- [ ] classified current vs historical state
- [ ] defined `initialState`
- [ ] chose one source of truth for current state

### Implementation

- [ ] moved bootstrap into `onStart()`
- [ ] wrapped startup work in `ctx.blockConcurrencyWhile(...)`
- [ ] replaced alarms with Agent scheduling APIs
- [ ] implemented a one-time legacy migration only
- [ ] removed compatibility sync code

### Testing

- [ ] rewrote tests around public behavior
- [ ] used `fetchMock` only for external APIs
- [ ] avoided `vi.mock()` and test-only production hooks
- [ ] validated scheduled behavior through public/scheduled methods

### Cleanup

- [ ] deleted obsolete debug helpers/routes
- [ ] removed migration-only escape hatches
- [ ] ran targeted tests
- [ ] ran typecheck

## Concrete takeaways from `StreamLifecycleDO`

The most reusable lessons from this migration are:

1. **Agent state should own current state.**
2. **History should stay in SQLite.**
3. **Startup migration belongs in `onStart()` with `blockConcurrencyWhile`.**
4. **Testing difficulties are not a good reason to add production seams.**
5. **One-time migration beats indefinite compatibility logic.**
6. **Migration is a cleanup chance; delete old code aggressively.**
7. **Keep using the repo's typed RPC and Wrangler conventions.**

If we follow those rules, future DO → Agent migrations should be much smaller, cleaner, and easier to review.
