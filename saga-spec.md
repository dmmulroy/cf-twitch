# Make Saga Host Own Retry Lifecycle and Persisted DTO Codecs

## Summary

Introduce a shared abstract `SagaHost<P, E>` that owns the complete technical lifecycle common to saga Durable Objects:

- SQLite/Drizzle initialization and migration;
- typed `SagaRunner<P>` construction;
- `start()` parameter parsing and idempotent resume;
- running-status gating;
- persisted parameter loading;
- retry scheduling, cancellation, restoration, and callbacks;
- status projection;
- safe retry observability.

Concrete saga DOs own only:

- their parameter schema/codec;
- their step definitions and persisted result/undo codecs;
- their business orchestration;
- saga-specific compensation and terminal-failure policy.

`SagaHost` uses the installed Agents runtime internally because its scheduling APIs are preferable to default Durable Object alarms. That runtime choice must not appear in concrete saga class names, contracts, or business orchestration.

Keep unchanged:

- Cloudflare Durable Object topology;
- current one-object-per-saga identity;
- Agent one-shot scheduling internally;
- SQLite `saga_runs` and `saga_steps` schema;
- existing saga step sequences;
- EventBus fire-and-forget delivery ownership.

Do not migrate to Cloudflare Workflows.

---

## Context / Current State

### Repeated retry lifecycle

Song Request currently owns:

- retry coordination state at `song-request-saga-do.ts:89`;
- startup restoration at `:151`;
- relative and absolute scheduling at `:179` and `:184`;
- cancellation/state clearing at `:197`;
- scheduled resume callback at `:666`.

Keyboard Raffle repeats the same behavior:

- state at `keyboard-raffle-saga-do.ts:79`;
- restoration at `:148`;
- scheduling at `:176` and `:181`;
- clearing at `:194`;
- callback at `:586`.

Raid Shoutout has a smaller, divergent implementation:

- retry state at `raid-shoutout-saga-do.ts:31`;
- scheduling at `:151`;
- callback at `:169`;
- no equivalent startup restoration.

This creates three owners for one technical invariant: SQLite owns pending retry evidence while each concrete saga separately coordinates an Agent schedule.

### Unchecked persistence boundaries

`SagaRunner` currently trusts JSON decoded from SQLite:

```ts
JSON.parse(existing.resultJson) as T;
JSON.parse(sagaResult.value.paramsJson) as P;
```

Undo payloads are decoded as `unknown` and cast by concrete sagas:

```ts
undoPayload as { eventId: string };
undoPayload as { trackId: string };
undoPayload as string;
```

These values cross a serialized SQLite boundary and therefore must be parsed again.

### Inconsistent start parsing

Song Request and Keyboard Raffle define Zod schemas but persist incoming `start()` values without parsing:

```ts
runner.initSaga(params);
```

Raid Shoutout parses first with:

```ts
RaidShoutoutParamsSchema.safeParse(params);
```

All three RPC boundaries need consistent parsing.

### Repository constraints

`AGENTS.md` requires:

- Zod parsing at boundaries;
- no unchecked type assertions;
- expected errors returned through `Result`;
- Drizzle rather than raw SQL;
- cached saga steps to remain replay-safe;
- EventBus publishing to remain fire-and-forget.

`docs/durable-object-agent-migration-guide.md` says:

- SQLite should own durable due-time work evidence;
- Agent state should coordinate only active schedules;
- shared scheduling behavior should be extracted rather than forked per DO;
- timestamp schedules must use `new Date(isoString)`.

---

## Goals

1. Give one shared host ownership of retry scheduling and resume semantics.
2. Remove scheduling APIs and callback names from concrete saga implementations.
3. Parse all saga parameters before initial persistence.
4. Parse all parameters, cached results, and undo payloads read from SQLite.
5. Make result and undo codecs mandatory in step definitions.
6. Preserve current replay, compensation, retry, and point-of-no-return behavior.
7. Keep concrete saga modules focused on business orchestration.

---

## Non-Goals

- Cloudflare Workflow migration.
- Changing the `saga_runs` or `saga_steps` schema.
- Redesigning saga business steps.
- Moving EventBus retry ownership into the saga host.
- Introducing a generic workflow-definition DSL.
- Adding test-only production seams.
- Standardizing saga-specific refund, compensation, or failure messaging beyond existing behavior.
- Introducing user-requested saga cancellation.

---

## Invariants

### Persistence ownership

```ts
interface SagaRunRow {
	readonly id: string;
	readonly status: SagaStatus;
	readonly paramsJson: string;
	readonly fulfilledAt: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly error: string | null;
}

interface SagaStepRow {
	readonly sagaId: string;
	readonly stepName: string;
	readonly state: SagaStepState;
	readonly attempt: number;
	readonly resultJson: string | null;
	readonly undoJson: string | null;
	readonly nextRetryAt: string | null;
	readonly lastError: string | null;
}
```

SQLite remains the source of truth for:

- saga status;
- original parameters;
- successful step results;
- compensation payloads;
- attempt counts;
- pending retry due times.

### Schedule coordination

```ts
export interface SagaHostState {
	readonly retryScheduleId: string | null;
	readonly retryDueAt: string | null;
}
```

Host state coordinates only the currently active runtime schedule.

A schedule may be reconstructed from SQLite. Agent state is not authoritative evidence that a step needs retrying.

### Replay

```txt
saga_steps.state == SUCCEEDED
    => do not execute handler again
    => parse cached resultJson through that step's result codec
    => return parsed canonical result
```

A malformed cached result must never flow into saga business logic.

### Compensation

A rollbackable successful step must persist a valid undo payload.

```txt
rollbackable step success
    => resultJson exists and parses through result codec
    => undoJson exists and parses through undo codec
```

Compensation handlers receive typed values rather than `unknown`.

### Duplicate start

A repeated valid `start()` call:

- does not replace original persisted parameters;
- does not re-run successful steps;
- resumes from the persisted saga state.

---

## Design Constraints

- The host implementation may use the installed `agents` scheduling APIs internally.
- Concrete saga files must not call `schedule()`, `cancelSchedule()`, or `getSchedule()`.
- Concrete saga files must not define or name `retrySagaTick`.
- The scheduling runtime requires a named method on the Durable Object instance. That method will exist once as an inherited host implementation.
- `start()` and `getStatus()` remain public RPC methods.
- `retrySagaTick` remains the persisted runtime callback name to avoid unnecessary callback-name migration.
- Startup migration and schedule restoration run inside `ctx.blockConcurrencyWhile`.
- No database transaction spans external API calls.

---

## Alternatives Considered

### Option 1: Harden `SagaRunner` only

Add codecs to `SagaRunner`, but leave retry scheduling and callbacks in each concrete saga.

```ts
class SagaRunner<P> {
	constructor(args: { paramsCodec: SagaCodec<P>; retryScheduler: SagaRetryScheduler });
}
```

#### Tradeoffs

- Fixes unsafe persistence decoding.
- Requires the fewest structural changes.
- Leaves retry state, startup restoration, callbacks, status, and resume behavior duplicated.
- Allows Raid, Song Request, and Keyboard Raffle to continue diverging.

This does not satisfy the ownership goal.

---

### Option 2: Composed host with a scheduling adapter

Each saga creates a composed host and adapts its runtime methods:

```ts
this.host.retrySagaTick(() => this.execute());

scheduleRetryTick: (when, dueAt) => this.schedule(when, "retrySagaTick", dueAt, options);
```

#### Tradeoffs

- Avoids inheritance.
- Makes the business class adapt runtime mechanics in every saga.
- Leaks callback names, schedule options, and forwarding methods.
- Creates an adapter around an API that the shared host itself should own.

Rejected because the concrete saga remains aware of retry infrastructure.

---

### Option 3: Shared `SagaHost` base

```ts
abstract class SagaHost<P, E> extends RuntimeBase<Env, SagaHostState> {
	@rpc
	start(raw: unknown): Promise<Result<void, SagaStartError | E>>;

	@rpc
	getStatus(): Promise<Result<SagaStatusDto | null, SagaRunnerDbError>>;

	async retrySagaTick(scheduledFor?: string): Promise<void>;

	protected abstract executeSaga(
		params: P,
		runner: SagaRunner<P>,
	): Promise<Result<void, E>>;
}
```

`RuntimeBase` above represents the installed Agent base class as an implementation detail.

#### Tradeoffs

- Completely removes retry mechanics from concrete sagas.
- Keeps callback-name scheduling in one module.
- Centralizes initialization, restore, resume, and status invariants.
- Uses inheritance only for the actual framework/runtime seam.
- Concrete sagas cannot independently customize startup or retry behavior without an explicit host contract change.
- Requires validating inherited RPC and scheduled callback behavior in worker-pool tests.

This provides the deepest interface and is recommended.

---

## Recommendation

Implement a shared `SagaHost<P, E>` in `apps/api/src/lib/saga-host.ts`.

It should directly own the runtime integration rather than introducing a separate `SagaAgentSchedulePort`.

The resulting concrete saga shape is:

```ts
class _SongRequestSagaDO extends SagaHost<SongRequestParams, SongRequestSagaExecuteError> {
	protected readonly definition = SongRequestSagaDefinition;

	protected async executeSaga(
		params: SongRequestParams,
		runner: SagaRunner<SongRequestParams>,
	): Promise<Result<void, SongRequestSagaExecuteError>> {
		// Song Request business orchestration only.
	}
}

export const SongRequestSagaDO = withRpcSerialization(_SongRequestSagaDO);
```

Concrete saga files no longer need to import from `agents`.

---

## Proposed Design

## Domain Model and Types

### JSON-safe persistence values

```ts
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue =
	| JsonPrimitive
	| readonly JsonValue[]
	| { readonly [key: string]: JsonValue };
```

Codecs must explicitly project canonical values to `JsonValue`. This prevents arbitrary class instances, functions, symbols, or `undefined` from being handed to `JSON.stringify`.

### Codec parsing error

```ts
export class SagaCodecParseError extends TaggedError("SagaCodecParseError")<{
	readonly codecName: string;
	readonly parseError: string;
	readonly message: string;
}>() {
	constructor(args: { codecName: string; parseError: string }) {
		super({
			...args,
			message: `Invalid ${args.codecName}: ${args.parseError}`,
		});
	}
}
```

### Persisted boundary error

```ts
export type SagaPersistedField = "params" | "step-result" | "step-undo";

export class SagaPersistedDataError extends TaggedError("SagaPersistedDataError")<{
	readonly sagaId: string;
	readonly field: SagaPersistedField;
	readonly stepName?: string;
	readonly codecName: string;
	readonly parseError: string;
	readonly message: string;
}>() {
	constructor(args: {
		sagaId: string;
		field: SagaPersistedField;
		stepName?: string;
		codecName: string;
		parseError: string;
	}) {
		super({
			...args,
			message:
				args.stepName === undefined
					? `Invalid persisted saga ${args.field}`
					: `Invalid persisted ${args.field} for step "${args.stepName}"`,
		});
	}
}
```

Do not include raw JSON in this error.

### Start boundary error

```ts
export class SagaInputParseError extends TaggedError("SagaInputParseError")<{
	readonly sagaType: SagaType;
	readonly parseError: string;
	readonly message: string;
}>() {
	constructor(args: { sagaType: SagaType; parseError: string }) {
		super({
			...args,
			message: `Invalid ${args.sagaType} start parameters`,
		});
	}
}
```

### Scheduling error

```ts
export class SagaScheduleError extends TaggedError("SagaScheduleError")<{
	readonly sagaId: string;
	readonly operation: "schedule" | "cancel";
	readonly message: string;
	readonly cause?: unknown;
}>() {}
```

The cause is retained internally but never spread into structured logs.

---

## Types, Interfaces, and APIs

### Canonical codec

`SagaCodec<T>` is a thin repository boundary over Zod 4 codecs. It preserves a stable codec name, constrains the persisted representation to `JsonValue`, and translates both decode and encode failures into `Result` values.

```ts
export interface SagaCodec<T> {
	readonly name: string;
	readonly codec: z.ZodCodec<z.ZodType<JsonValue, JsonValue>, z.ZodType<T>>;

	/**
	 * Decodes an RPC or JSON-decoded boundary value into a canonical value.
	 */
	parse(raw: unknown): Result<T, SagaCodecParseError>;

	/**
	 * Encodes a canonical value into its JSON-safe persistence DTO.
	 */
	encode(value: T): Result<JsonValue, SagaCodecParseError>;
}
```

Zod helper:

```ts
export function zodSagaCodec<T>(args: {
	readonly name: string;
	readonly codec: z.ZodCodec<z.ZodType<JsonValue, JsonValue>, z.ZodType<T>>;
}): SagaCodec<T> {
	const parseError = (error: z.ZodError): SagaCodecParseError =>
		new SagaCodecParseError({
			codecName: args.name,
			parseError: z.prettifyError(error),
		});

	return {
		name: args.name,
		codec: args.codec,

		parse(raw) {
			const input = args.codec.in.safeParse(raw);
			if (!input.success) {
				return Result.err(parseError(input.error));
			}

			const parsed = z.safeDecode(args.codec, input.data);
			return parsed.success ? Result.ok(parsed.data) : Result.err(parseError(parsed.error));
		},

		encode(value) {
			const encoded = z.safeEncode(args.codec, value);
			return encoded.success ? Result.ok(encoded.data) : Result.err(parseError(encoded.error));
		},
	};
}
```

The Zod codec input schema both accepts and produces `JsonValue`; specifying both `ZodType` parameters keeps `z.safeEncode` statically constrained to `JsonValue`. Its output schema describes canonical `T`. Because Zod's typed `safeDecode` does not accept `unknown`, `parse` first parses the raw boundary value through the codec's input schema and then decodes that parsed value. It returns `parsed.data`; it must not validate and continue using `raw`. `encode` uses `z.safeEncode` so reverse-transform or schema failures remain expected values rather than throws.

### JSON text helpers

```ts
export function parsePersistedJson(args: {
	readonly sagaId: string;
	readonly field: SagaPersistedField;
	readonly stepName?: string;
	readonly codecName: string;
	readonly json: string;
}): Result<unknown, SagaPersistedDataError>;

export function stringifyPersistedJson(args: {
	readonly sagaId: string;
	readonly field: SagaPersistedField;
	readonly stepName?: string;
	readonly codecName: string;
	readonly value: JsonValue;
}): Result<string, SagaPersistedDataError>;
```

`parsePersistedJson` catches `JSON.parse` exceptions and returns `unknown`.

Before stringification, callers use `SagaCodec.encode()` and map any `SagaCodecParseError` to `SagaPersistedDataError` with the relevant saga, field, and step context. `stringifyPersistedJson` must check that `JSON.stringify` returned a string rather than asserting it.

### Step definitions

```ts
export interface SagaStepDefinition<T> {
	readonly name: string;
	readonly resultCodec: SagaCodec<T>;
	readonly options?: StepOptions;
}

export interface SagaRollbackStepDefinition<T, Undo> {
	readonly name: string;
	readonly resultCodec: SagaCodec<T>;
	readonly undoCodec: SagaCodec<Undo>;
	readonly options?: StepOptions;
}
```

### Step handler values

```ts
export interface SagaStepSuccess<T> {
	readonly result: T;
}

export interface SagaRollbackStepSuccess<T, Undo> {
	readonly result: T;
	readonly undoPayload: Undo;
}

export type SagaStepHandler<T> = () => Promise<SagaStepSuccess<T>>;

export type SagaRollbackStepHandler<T, Undo> = () => Promise<SagaRollbackStepSuccess<T, Undo>>;

export type SagaCompensationHandler<Undo> = (undoPayload: Undo) => Promise<void>;
```

Separating rollback and non-rollback result types makes a missing undo payload unrepresentable for rollbackable steps.

### Retry scheduler seam

`SagaRunner` depends only on this capability:

```ts
export interface SagaRetryScheduler {
	scheduleRetry(delayMs: number): Promise<Result<void, SagaScheduleError>>;
}
```

`SagaRunner` does not know about callback names, runtime schedules, or host state.

`SagaHost` implements this interface.

### Saga definition

```ts
export interface SagaDefinition<P> {
	readonly sagaType: SagaType;
	readonly paramsCodec: SagaCodec<P>;
}
```

Avoid adding a declarative step array. Step ordering and branching remain ordinary TypeScript in each concrete saga.

### Shared status DTO

```ts
export interface SagaStatusDto {
	readonly sagaId: string;
	readonly status: SagaStatus;
	readonly fulfilledAt: string | null;
	readonly error: string | null;
	readonly createdAt: string;
	readonly updatedAt: string;
}
```

Existing per-saga status interfaces become aliases if external names should be preserved:

```ts
export type SongRequestSagaStatus = SagaStatusDto;
export type KeyboardRaffleSagaStatus = SagaStatusDto;
```

---

## `SagaRunner<P>` Contract

```ts
export type SagaRunnerError = SagaRunnerDbError | SagaPersistedDataError | SagaScheduleError;

export type SagaStepExecutionError = SagaStepError | SagaStepRetrying | SagaRunnerError;

export class SagaRunner<P> {
	constructor(args: {
		readonly sagaId: string;
		readonly db: DrizzleSqliteDODatabase<SagaSchema>;
		readonly paramsCodec: SagaCodec<P>;
		readonly retryScheduler: SagaRetryScheduler;
		readonly analytics?: AnalyticsEngineDataset;
		readonly sagaType?: SagaType;
	});

	initSaga(
		params: P,
	): Promise<Result<void, SagaAlreadyExistsError | SagaRunnerDbError | SagaPersistedDataError>>;

	getParams(): Promise<Result<P, SagaNotFoundError | SagaRunnerDbError | SagaPersistedDataError>>;

	executeStep<T>(
		step: SagaStepDefinition<T>,
		handler: SagaStepHandler<T>,
	): Promise<Result<T, SagaStepExecutionError>>;

	executeStepWithRollback<T, Undo>(
		step: SagaRollbackStepDefinition<T, Undo>,
		handler: SagaRollbackStepHandler<T, Undo>,
		compensate: SagaCompensationHandler<Undo>,
	): Promise<Result<T, SagaStepExecutionError>>;

	getSaga(): Promise<Result<SagaRun | undefined, SagaRunnerDbError>>;

	isRunning(): Promise<Result<boolean, SagaRunnerDbError>>;

	getNextRetryStep(): Promise<Result<SagaStep | undefined, SagaRunnerDbError>>;

	isPointOfNoReturnReached(): Promise<Result<boolean, SagaRunnerDbError>>;

	markPointOfNoReturn(): Promise<Result<void, SagaNotFoundError | SagaRunnerDbError>>;

	compensateAll(): Promise<Result<void, SagaCompensationError[]>>;

	complete(): Promise<Result<void, SagaRunnerDbError>>;

	fail(error: string): Promise<Result<void, SagaRunnerDbError>>;
}
```

Remove:

```ts
getParams<P>();
scheduleRetry(delayMs);
```

The runner already receives a scheduler; a second public scheduling method adds no value.

---

## Typed Compensation Registration

The runner should not retain heterogeneous `unknown` payloads.

Use closures that capture an already parsed typed payload:

```ts
interface RegisteredCompensation {
	readonly stepName: string;
	readonly run: () => Promise<void>;
}
```

Registration after fresh execution:

```ts
const undoJson = yield * encodeStepUndo(step, handlerResult.undoPayload);

this.compensations.push({
	stepName: step.name,
	run: () => compensate(handlerResult.undoPayload),
});
```

Registration after replay:

```ts
const undoPayload = yield * decodeStepUndo(step, existing.undoJson);

this.compensations.push({
	stepName: step.name,
	run: () => compensate(undoPayload),
});
```

`compensateAll()` invokes `registration.run()` and never handles `unknown`.

---

## `SagaHost<P, E>` Contract

```ts
export type SagaHostStartError<E> =
	| SagaInputParseError
	| SagaAlreadyExistsError
	| SagaRunnerDbError
	| SagaPersistedDataError
	| SagaScheduleError
	| E;

export abstract class SagaHost<P, E> extends Agent<Env, SagaHostState>
	implements SagaRetryScheduler
{
	initialState: SagaHostState;

	protected abstract readonly definition: SagaDefinition<P>;

	protected abstract executeSaga(
		params: P,
		runner: SagaRunner<P>,
	): Promise<Result<void, E>>;

	async onStart(): Promise<void>;

	@rpc
	async start(
		raw: unknown,
	): Promise<Result<void, SagaHostStartError<E>>>;

	@rpc
	async getStatus(): Promise<
		Result<SagaStatusDto | null, SagaRunnerDbError>
	>;

	/**
	 * Runtime scheduling entrypoint inherited by every concrete saga.
	 * Concrete sagas must not override or call it.
	 */
	async retrySagaTick(scheduledFor?: string): Promise<void>;

	async scheduleRetry(
		delayMs: number,
	): Promise<Result<void, SagaScheduleError>>;
}
```

Although the implementation extends the installed runtime base, the exported abstraction and file remain `SagaHost`. Concrete saga modules import only `SagaHost` and saga contracts.

### Internal host methods

```ts
private getRunner(): SagaRunner<P>;

private resumeSaga(): Promise<
	Result<
		void,
		| SagaNotFoundError
		| SagaRunnerDbError
		| SagaPersistedDataError
		| SagaScheduleError
		| E
	>
>;

private restoreOrRecomputeRetrySchedule(): Promise<
	Result<void, SagaRunnerDbError | SagaScheduleError>
>;

private scheduleRetryAt(
	whenIso: string,
): Promise<Result<void, SagaScheduleError>>;

private clearRetrySchedule(): Promise<
	Result<void, SagaScheduleError>
>;

private clearRetryCoordinationState(): void;
```

---

## Host Lifecycle Behavior

### Construction

The host initializes Drizzle using the Durable Object storage binding:

```ts
constructor(ctx: AgentContext, env: Env) {
	super(ctx, env);
	this.db = drizzle(this.ctx.storage, { schema: sagaSchema });
}
```

This runtime constructor detail remains confined to `saga-host.ts`.

### Startup

```ts
async onStart(): Promise<void> {
	await this.ctx.blockConcurrencyWhile(async () => {
		await migrate(this.db, migrations);
		await this.ctx.storage.deleteAlarm();

		const restoreResult =
			await this.restoreOrRecomputeRetrySchedule();

		if (restoreResult.status === "error") {
			logger.error("Failed to restore saga retry schedule", {
				event: "saga.retry.restore_failed",
				sagaType: this.definition.sagaType,
				sagaId: this.ctx.id.toString(),
				errorTag: restoreResult.error._tag,
				errorMessage: restoreResult.error.message,
			});

			const clearResult = await this.clearRetrySchedule();
			if (clearResult.status === "error") {
				// Log safe fields; lifecycle boundary cannot return Result.
			}
		}
	});
}
```

This gives Raid the same durable retry restoration semantics as Song Request and Keyboard Raffle.

### Start

```txt
unknown RPC input
  -> definition.paramsCodec.parse(raw)
  -> canonical P
  -> runner.initSaga(P)
  -> if newly inserted: continue
  -> if already exists: ignore incoming canonical value
  -> resumeSaga()
  -> load original persisted params
  -> executeSaga(originalParams, runner)
```

The original persisted params remain authoritative on duplicate start.

### Resume

```ts
private async resumeSaga(): Promise<Result<void, SagaResumeError<E>>> {
	const runner = this.getRunner();

	const runningResult = await runner.isRunning();
	if (runningResult.status === "error") {
		return Result.err(runningResult.error);
	}

	if (!runningResult.value) {
		return Result.ok();
	}

	const paramsResult = await runner.getParams();
	if (paramsResult.status === "error") {
		return Result.err(paramsResult.error);
	}

	return this.executeSaga(paramsResult.value, runner);
}
```

Concrete sagas no longer call `isRunning()` or `getParams()`.

---

## Scheduling Ownership

The callback name appears only in `saga-host.ts`:

```ts
const SAGA_RETRY_CALLBACK = "retrySagaTick";
```

### Schedule retry

```ts
async scheduleRetry(
	delayMs: number,
): Promise<Result<void, SagaScheduleError>> {
	const dueAt = new Date(Date.now() + delayMs).toISOString();
	return this.scheduleRetryAt(dueAt);
}
```

### Schedule at persisted due time

```ts
private async scheduleRetryAt(
	whenIso: string,
): Promise<Result<void, SagaScheduleError>> {
	return Result.gen(async function* (this: SagaHost<P, E>) {
		yield* Result.await(this.clearRetrySchedule());

		const schedule = yield* Result.await(
			Result.tryPromise({
				try: () =>
					this.schedule(
						new Date(whenIso),
						SAGA_RETRY_CALLBACK,
						whenIso,
						{
							idempotent: true,
							retry: { maxAttempts: 1 },
						},
					),
				catch: (cause) =>
					new SagaScheduleError({
						sagaId: this.ctx.id.toString(),
						operation: "schedule",
						message: "Failed to schedule saga retry",
						cause,
					}),
			}),
		);

		this.setState({
			retryScheduleId: schedule.id,
			retryDueAt: whenIso,
		});

		return Result.ok();
	}, this);
}
```

### Restore schedule

```txt
host startup
  -> runner.getSaga()
  -> missing or non-RUNNING:
       cancel/clear coordinated schedule
  -> RUNNING:
       runner.getNextRetryStep()
  -> no pending nextRetryAt:
       cancel/clear coordinated schedule
  -> matching due time and schedule exists:
       retain schedule
  -> otherwise:
       replace schedule using persisted nextRetryAt
```

### Scheduled callback

```txt
runtime invokes inherited SagaHost.retrySagaTick()
  -> clear coordination state without canceling executing schedule
  -> runner.getSaga()
  -> missing:
       safe warning, return
  -> non-RUNNING:
       safe informational log, return
  -> RUNNING:
       resumeSaga()
  -> SagaStepRetrying:
       next schedule was already persisted and created
  -> other expected error:
       safe error log
```

The callback remains public only because the runtime resolves scheduled callbacks by method name on the instance. It is inherited once and does not appear in concrete saga files.

---

## Per-Saga Codecs

### Song Request params

The persisted canonical type does not need the redemption routing `_tag`.

```ts
export const SongRequestParamsSchema = z.object({
	id: z.string(),
	broadcaster_user_id: z.string(),
	broadcaster_user_login: z.string(),
	broadcaster_user_name: z.string(),
	user_id: z.string(),
	user_login: z.string(),
	user_name: z.string(),
	user_input: z.string(),
	status: z.enum(["unknown", "unfulfilled", "fulfilled", "canceled"]),
	reward: z.object({
		id: z.string(),
		title: z.string(),
		cost: z.number(),
		prompt: z.string(),
	}),
	redeemed_at: z.string(),
});

export type SongRequestParams = z.infer<typeof SongRequestParamsSchema>;
```

Zod’s object projection strips the routing `_tag` passed by the webhook route.

```ts
export const SongRequestParamsCodec: SagaCodec<SongRequestParams> = zodSagaCodec({
	name: "SongRequestParams",
	codec: z.codec(SongRequestParamsSchema, SongRequestParamsSchema, {
		decode: (value) => value,
		encode: (value) => value,
	}),
});
```

### Keyboard Raffle params

Mirror Song Request using `KeyboardRaffleParamsSchema`. Its canonical persisted type also excludes the routing `_tag`.

### Raid Shoutout params

Reuse `RaidShoutoutParamsSchema` through the same codec contract.

Invalid raid params should return `SagaInputParseError` rather than silently returning `Result.ok()`. The webhook route still controls EventSub acknowledgment behavior.

---

## Per-Saga Step Definitions

### Common codecs

```ts
export const voidCodec = zodSagaCodec({
	name: "void",
	codec: z.codec(z.null(), z.void(), {
		decode: () => undefined,
		encode: () => null,
	}),
});

export const stringCodec: SagaCodec<string>;
export const numberCodec: SagaCodec<number>;
```

`voidCodec` persists `null` and decodes only `null` to `undefined`. `stringCodec` and `numberCodec` use identity `z.codec` transforms with matching primitive input and output schemas.

### Song Request

```ts
const ParseSpotifyUrlStep: SagaStepDefinition<SpotifyTrackId> = {
	name: "parse-spotify-url",
	resultCodec: spotifyTrackIdCodec,
};

const GetTrackInfoStep: SagaStepDefinition<TrackInfo> = {
	name: "get-track-info",
	resultCodec: trackInfoCodec,
	options: { timeout: 30000, maxRetries: 3 },
};

interface PersistRequestUndoDto {
	readonly eventId: string;
}

const PersistRequestStep: SagaRollbackStepDefinition<string, PersistRequestUndoDto> = {
	name: "persist-request",
	resultCodec: stringCodec,
	undoCodec: persistRequestUndoCodec,
	options: { timeout: 10000, maxRetries: 2 },
};

interface AddToQueueUndoDto {
	readonly trackId: SpotifyTrackId;
}

const AddToQueueStep: SagaRollbackStepDefinition<SpotifyTrackId, AddToQueueUndoDto> = {
	name: "add-to-spotify-queue",
	resultCodec: spotifyTrackIdCodec,
	undoCodec: addToQueueUndoCodec,
	options: { timeout: 30000, maxRetries: 3 },
};

const FulfillRedemptionStep: SagaStepDefinition<void> = {
	name: "fulfill-redemption",
	resultCodec: voidCodec,
	options: { timeout: 30000, maxRetries: 3 },
};

const SendChatConfirmationStep: SagaStepDefinition<void> = {
	name: "send-chat-confirmation",
	resultCodec: voidCodec,
	options: { timeout: 10000, maxRetries: 2 },
};

const PublishSongRequestEventStep: SagaStepDefinition<void> = {
	name: "publish-event",
	resultCodec: voidCodec,
	options: { timeout: 10000, maxRetries: 2 },
};
```

Compensation becomes typed:

```ts
async (undo: PersistRequestUndoDto) => {
	using songQueue = await getSongQueue();
	await songQueue.deleteRequest(undo.eventId);
};
```

No cast remains.

### Keyboard Raffle

```ts
const GenerateWinningNumberStep: SagaStepDefinition<number> = {
	name: "generate-winning-number",
	resultCodec: numberCodec,
};

const GenerateUserRollStep: SagaStepDefinition<number> = {
	name: "generate-user-roll",
	resultCodec: numberCodec,
};

interface RecordRollResultDto {
	readonly rollId: string;
	readonly isNewRecord: boolean;
}

const RecordRollStep: SagaRollbackStepDefinition<RecordRollResultDto, string> = {
	name: "record-roll",
	resultCodec: recordRollResultCodec,
	undoCodec: stringCodec,
	options: { timeout: 10000, maxRetries: 2 },
};
```

Compensation receives `rollId: string` directly.

### Raid Shoutout

Both steps use `voidCodec`:

```ts
const SendChatThanksStep: SagaStepDefinition<void> = {
	name: "send-chat-thanks",
	resultCodec: voidCodec,
	options: { timeout: 10000, maxRetries: 2 },
};

const CreateNativeShoutoutStep: SagaStepDefinition<void> = {
	name: "create-native-shoutout",
	resultCodec: voidCodec,
	options: { timeout: 10000, maxRetries: 2 },
};
```

---

## Seams, Boundaries, Adapters, and Implementations

| Boundary            | Owner                     | Raw input                | Canonical output                  |
| ------------------- | ------------------------- | ------------------------ | --------------------------------- |
| RPC `start()`       | `SagaHost` + params codec | `unknown`                | `P`                               |
| SQLite `paramsJson` | `SagaRunner<P>`           | JSON text                | `P`                               |
| SQLite `resultJson` | Step result codec         | JSON text                | typed step result                 |
| SQLite `undoJson`   | Step undo codec           | JSON text                | typed undo payload                |
| Retry request       | `SagaRunner`              | `delayMs`                | `Result<void, SagaScheduleError>` |
| Runtime schedule    | `SagaHost`                | due-time ISO string      | coordinated schedule              |
| Business effects    | Concrete saga             | canonical params/results | Twitch, Spotify, other DO calls   |

### Layer knowledge

`SagaRunner` may know:

- Drizzle saga tables;
- step retry policy;
- persisted codecs;
- the narrow retry scheduler interface.

`SagaRunner` must not know:

- runtime callback names;
- schedule IDs;
- host state;
- concrete saga classes.

`SagaHost` may know:

- the Durable Object runtime;
- Agent scheduling APIs;
- Drizzle initialization;
- saga lifecycle and status projection.

Concrete sagas may know:

- their domain parameters;
- their step definitions;
- Twitch/Spotify/service collaborators;
- compensation and point-of-no-return policy.

Concrete sagas must not know:

- schedule callback names;
- retry schedule IDs;
- startup schedule restoration;
- raw persisted JSON;
- generic `getParams<P>()` calls.

---

## Call Stacks and Data Flow

### Current Start Flow

```txt
webhook parsed redemption
  -> concrete saga stub.start(typed params)
  -> concrete saga runner.initSaga(params)
  -> JSON.stringify(params)
  -> SQLite
  -> concrete execute()
  -> runner.getParams<P>()
  -> JSON.parse(paramsJson) as P
  -> business steps
```

### Proposed Start Flow

```txt
webhook parsed redemption
  -> concrete saga stub.start(raw RPC value)
  -> inherited SagaHost.start(raw: unknown)
  -> saga params codec.parse(raw)
  -> canonical P
  -> SagaRunner.initSaga(P)
  -> params codec.encode(P) via z.safeEncode
  -> Result<JsonValue, SagaCodecParseError>
  -> map encode failure to SagaPersistedDataError
  -> JSON.stringify(JsonValue)
  -> SQLite paramsJson
  -> SagaHost.resumeSaga()
  -> SagaRunner.getParams()
  -> JSON.parse(paramsJson): unknown
  -> params codec.parse(unknown)
  -> canonical P
  -> concrete executeSaga(P, runner)
```

### Cached Result Replay

```txt
concrete executeSaga()
  -> runner.executeStep(stepDefinition, handler)
  -> read saga_steps
  -> state == SUCCEEDED
  -> parse resultJson to unknown
  -> stepDefinition.resultCodec.parse(unknown)
  -> typed result
  -> handler is not invoked
```

### Fresh Rollbackable Step

```txt
runner.executeStepWithRollback(definition, handler, compensate)
  -> handler returns { result: T, undoPayload: Undo }
  -> result codec safe-encodes T to JsonValue
  -> undo codec safe-encodes Undo to JsonValue
  -> map either encode failure to SagaPersistedDataError
  -> persist resultJson and undoJson
  -> register closure capturing typed Undo
  -> return T
```

### Replayed Rollbackable Step

```txt
runner finds SUCCEEDED row
  -> result codec parses resultJson into T
  -> undo codec parses undoJson into Undo
  -> register closure capturing typed Undo
  -> return T
```

### Compensation

```txt
later step fails permanently
  -> concrete saga applies existing point-of-no-return policy
  -> runner.compensateAll()
  -> reverse registered closures
  -> compensation handler receives typed Undo
  -> mark compensated step
```

---

## Failure Flow

### Invalid start params

```txt
start(raw)
  -> params codec rejects
  -> Result.err(SagaInputParseError)
  -> no saga_runs row
  -> no step side effects
  -> caller logs safe error fields
```

### Malformed persisted params

```txt
resumeSaga()
  -> runner.getParams()
  -> JSON parse or params codec fails
  -> Result.err(SagaPersistedDataError)
  -> no business step runs
  -> host logs saga type/id, field, codec name
```

### Malformed cached result

```txt
executeStep()
  -> SUCCEEDED row
  -> result codec rejects resultJson
  -> SagaPersistedDataError
  -> handler does not run
  -> concrete failure policy receives expected error
```

The host/runner must not reinterpret malformed persisted data as a cache miss. Re-running the side effect could duplicate an already successful operation.

### Malformed undo payload

```txt
executeStepWithRollback()
  -> SUCCEEDED row
  -> undo codec rejects undoJson
  -> SagaPersistedDataError
  -> compensation is not registered with untrusted data
  -> saga fails safely
```

### Scheduling failure

```txt
retryable step failure
  -> persist PENDING + nextRetryAt
  -> SagaHost.scheduleRetry()
  -> runtime scheduling call fails
  -> Result.err(SagaScheduleError)
  -> pending SQLite evidence remains recoverable
  -> host/caller logs failure
```

Startup restoration can recover the schedule on the next activation. Guaranteed autonomous recovery when the runtime scheduling API itself fails remains an open operational question.

---

## Retry / Cancellation / Idempotency Flow

### Retry

```txt
retryable handler error
  -> increment persisted attempt
  -> persist PENDING and nextRetryAt
  -> SagaRunner asks SagaRetryScheduler
  -> SagaHost replaces coordinated schedule
  -> return SagaStepRetrying
```

### Runtime callback

```txt
runtime invokes inherited retrySagaTick
  -> clear executing schedule coordination state
  -> verify saga still RUNNING
  -> load and parse original params
  -> call concrete executeSaga
  -> successful prior steps replay from parsed cache
```

### Stale schedule cancellation

Before scheduling a replacement:

```txt
retryScheduleId exists
  -> cancel existing runtime schedule
  -> clear host state
  -> create replacement
  -> persist new schedule id and due time
```

This is infrastructure cancellation only. No public saga cancellation behavior is introduced.

### Idempotency

- Successful steps remain authoritative.
- Duplicate `start()` calls use persisted original params.
- Raffle randomness stays inside cached steps.
- UUID generation inside cached publish steps remains replay-safe.
- Fire-and-forget EventBus steps continue treating accepted publication as the saga step boundary.
- EventBus remains responsible for downstream delivery retries.

---

## Observability Flow

The host uses stable structured events:

```ts
type SagaHostEvent =
	| "saga.params.invalid"
	| "saga.retry.scheduled"
	| "saga.retry.triggered"
	| "saga.retry.skipped"
	| "saga.retry.restore_failed"
	| "saga.persisted_data.invalid"
	| "saga.schedule.failed";
```

Safe fields:

```ts
interface SagaHostLogFields {
	readonly event: SagaHostEvent;
	readonly sagaType: SagaType;
	readonly sagaId: string;
	readonly status?: SagaStatus;
	readonly stepName?: string;
	readonly codecName?: string;
	readonly errorTag?: string;
	readonly errorMessage?: string;
}
```

Do not log:

- raw params JSON;
- raw result or undo JSON;
- environments;
- tokens;
- arbitrary causes;
- complete external payloads.

Existing `writeSagaLifecycleMetric` ownership remains in `SagaRunner`.

Authorization is unchanged: saga starts continue to originate from the existing webhook routing path.

---

## Files to Add / Change / Delete

### Add `apps/api/src/lib/saga-host.ts`

Owns:

- `SagaHost<P, E>`;
- `SagaHostState`;
- `SagaDefinition<P>`;
- shared `start()` and `getStatus()`;
- shared startup migration;
- runner construction;
- resume behavior;
- schedule creation/cancellation;
- schedule restoration;
- inherited `retrySagaTick`.

This is the only saga module that imports the runtime Agent base.

### Add `apps/api/src/lib/saga-codecs.ts`

Owns:

- `JsonValue`;
- `SagaCodec<T>`;
- `zodSagaCodec` backed by `z.codec`, `z.safeDecode`, and `z.safeEncode`;
- common scalar/void Zod codecs;
- JSON text parsing/stringification;
- mapping codec failures to persisted-data errors.

### Change `apps/api/src/lib/saga-runner.ts`

- Make `SagaRunner` generic over params.
- Require a params codec.
- Require typed step definitions.
- Parse cached results through result codecs.
- Parse undo payloads through undo codecs.
- Replace `RegisteredCompensation.undoPayload: unknown` with typed closures.
- Remove generic `getParams<P>()`.
- Remove unchecked JSON casts.
- Return schedule and persisted-data failures through `Result`.

### Change `apps/api/src/lib/errors.ts`

Add:

- `SagaCodecParseError`;
- `SagaInputParseError`;
- `SagaPersistedDataError`;
- `SagaScheduleError`.

Update saga error unions.

### Change `apps/api/src/durable-objects/song-request-saga-do.ts`

Remove:

- direct `Agent` import and inheritance;
- database/runner initialization;
- retry state declaration;
- `onStart`;
- `getRunner`;
- restore/schedule/clear helpers;
- running gate and `getParams`;
- local `getStatus`;
- local `retrySagaTick`;
- undo casts.

Add:

- `extends SagaHost<...>`;
- params codec;
- typed step definitions;
- `executeSaga(params, runner)`.

### Change `apps/api/src/durable-objects/keyboard-raffle-saga-do.ts`

Apply the same ownership move and remove the `undoPayload as string` cast.

### Change `apps/api/src/durable-objects/raid-shoutout-saga-do.ts`

Apply the same ownership move.

Raid gains shared startup retry restoration. Its params parsing moves into the common host boundary.

### Potentially change `apps/api/src/services/spotify-service.ts`

Export a Zod-derived `TrackInfo` schema if `TrackInfo` should remain the canonical cached result type.

Alternative: define a saga-local persisted track-info DTO codec. Choose during implementation based on whether `TrackInfo` is intended as a stable service contract.

### No persistence/config changes

- No Drizzle migration.
- No Wrangler binding change.
- No Durable Object migration entry.
- No callback-name migration.

### Tests

Change:

- `apps/api/src/__tests__/durable-objects/song-request-saga-do.test.ts`
- `apps/api/src/__tests__/durable-objects/keyboard-raffle-saga-do.test.ts`
- `apps/api/src/__tests__/durable-objects/raid-shoutout-saga-do.test.ts`

Add focused runner tests only if existing public DO tests cannot isolate corrupted persisted DTO behavior cleanly:

- `apps/api/src/__tests__/lib/saga-runner.test.ts`

---

## RGR TDD Test Plan

Each item is one vertical red-green-refactor cycle.

### Slice 1: Song Request parses start input

**RED**

Call the public Song Request stub with malformed runtime input.

Assert:

- `SagaInputParseError`;
- no saga row;
- no external side effect.

**GREEN**

Introduce the params codec and the minimal shared `start()` path.

**REFACTOR**

Move the host contract into `saga-host.ts`.

---

### Slice 2: Valid Song Request still completes

**RED**

Run the existing valid Song Request behavior through inherited `start()`.

Assert completed status and current external effects.

**GREEN**

Add Song Request `executeSaga(params, runner)`.

**REFACTOR**

Remove local start/status gate/params loading.

---

### Slice 3: Host schedules and resumes retry

**RED**

Use the existing retryable Spotify failure behavior:

- first execution returns `SagaStepRetrying`;
- one retry schedule is observable;
- invoking the inherited runtime callback resumes and completes.

**GREEN**

Implement host schedule creation and `retrySagaTick`.

**REFACTOR**

Remove every scheduling method and callback from Song Request.

---

### Slice 4: Host restores retries at startup

**RED**

Seed:

- a `RUNNING` saga;
- a `PENDING` step;
- future `nextRetryAt`;
- stale coordination state.

Invoke startup and assert a matching schedule exists.

**GREEN**

Implement host restoration.

**REFACTOR**

Keep SQLite query and schedule coordination entirely in the host.

---

### Slice 5: Keyboard Raffle adopts the host

**RED**

Keep its existing retry resume and completion behavior passing through inherited host methods.

**GREEN**

Move Keyboard Raffle to `SagaHost`.

**REFACTOR**

Delete its duplicated lifecycle code.

---

### Slice 6: Raid adopts the same retry lifecycle

**RED**

Create a retryable Twitch failure, then verify Raid receives a retry schedule and resumes through the inherited callback.

**GREEN**

Move Raid to `SagaHost`.

**REFACTOR**

Delete its divergent scheduling implementation.

---

### Slice 7: Cached step results are parsed

**RED**

Seed a `SUCCEEDED` raffle number step with a non-number `resultJson`.

Assert:

- `SagaPersistedDataError`;
- random handler does not execute;
- malformed data is not treated as a cache miss.

**GREEN**

Require `resultCodec` in `executeStep`.

**REFACTOR**

Remove `JSON.parse(...) as T`.

---

### Slice 8: Valid raffle cached values replay

**RED**

Seed known winning and user-roll results.

Resume and assert the saga uses those values and completes without regenerating them.

**GREEN**

Add number codecs.

**REFACTOR**

Keep randomness entirely inside cached handlers.

---

### Slice 9: Undo payloads are parsed

**RED**

Seed a successful rollbackable step with malformed `undoJson`, then trigger resume.

Assert:

- `SagaPersistedDataError`;
- no compensation is invoked with malformed data;
- no cast-related runtime failure.

**GREEN**

Require `undoCodec` and typed compensation closures.

**REFACTOR**

Delete all concrete undo casts.

---

### Slice 10: Valid compensation remains observable

**RED**

Trigger a permanent failure before point of no return.

Assert existing observable behavior:

- prior rollbackable effect is reversed;
- redemption refund behavior remains unchanged;
- saga reaches the existing terminal status.

**GREEN**

Complete typed compensation registration.

**REFACTOR**

Remove the old `unknown` compensation model.

---

### Slice 11: Duplicate start uses original persisted params

**RED**

Start a saga, then invoke `start()` again with different but schema-valid params.

Assert:

- no second saga row;
- successful steps do not repeat;
- persisted original params remain authoritative.

**GREEN**

Ensure host ignores incoming params after `SagaAlreadyExistsError` and resumes from `runner.getParams()`.

**REFACTOR**

Centralize duplicate-start logging in the host.

---

### Slice 12: Shared status projection

**RED**

Preserve existing assertions:

- status is `null` before start;
- status becomes `RUNNING`, `FAILED`, or `COMPLETED` as currently observable.

**GREEN**

Implement inherited `getStatus()`.

**REFACTOR**

Delete concrete status DTO projection queries.

---

## Acceptance Criteria

- Concrete saga files do not import `Agent` or `AgentContext`.
- Concrete saga files contain no schedule callback names or scheduling calls.
- `retrySagaTick` is implemented once in `SagaHost`.
- Song Request, Keyboard Raffle, and Raid share startup retry restoration.
- `SagaRunner` contains no `JSON.parse(... ) as T`.
- Saga code contains no undo payload casts.
- Song Request and Keyboard Raffle parse `start()` input before persistence.
- All params, cached result, and undo DTOs use explicit Zod codecs behind `SagaCodec`.
- Existing saga SQLite tables and migrations remain unchanged.
- Existing idempotent replay and EventBus ownership remain unchanged.
- Targeted worker-pool tests, typecheck, lint, and format checks pass.

---

## Risks and Open Questions

1. **Invalid Raid input behavior**
   - Current Raid logs invalid params and returns success.
   - Recommended behavior is `Result.err(SagaInputParseError)`.
   - The webhook route can still acknowledge EventSub independently.
   - Confirm whether any caller relies on the current successful RPC result.

2. **Schedule creation failure**
   - SQLite retains `nextRetryAt`, but no guaranteed wake exists if runtime schedule creation fails and the object receives no later traffic.
   - Keep current recover-on-activation semantics unless stronger operational guarantees are explicitly requested.

3. **Persisted corruption terminal policy**
   - Recommended: never rerun a `SUCCEEDED` side effect whose result or undo payload cannot be decoded.
   - Whether every saga should immediately mark itself `FAILED`, especially after point of no return, remains saga-specific unless a uniform policy is approved.

4. **Raid permanent-step failure**
   - Raid currently does not mirror Song Request/Keyboard Raffle’s full compensation/failure handling.
   - This spec does not silently redesign that policy.

5. **`TrackInfo` persistence ownership**
   - Decide whether the service exports its response schema or the Song Request saga owns a dedicated persisted DTO codec.
   - Prefer the saga-local codec if persistence stability should not be coupled to service implementation details.

6. **Inherited runtime hook visibility**
   - The scheduling runtime requires a method-name callback on the object instance.
   - The method can be inherited and absent from concrete saga source, but cannot be entirely removed from the runtime object while retaining current scheduling APIs.
