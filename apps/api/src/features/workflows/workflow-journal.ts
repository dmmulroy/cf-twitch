import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, SqlError } from "effect/unstable/sql";
import type { SchemaError } from "effect/Schema";
import { IsoTimestamp, NonNegativeInt } from "@cf-twitch/contracts/identity";
import {
  WorkflowError,
  WorkflowId,
  WorkflowInput,
  WorkflowRunStatus,
  WorkflowStatus,
} from "@cf-twitch/contracts/workflow";
import { WorkflowAlarm, WorkflowAlarmError } from "./workflow-alarm.ts";
import { TwitchAnalytics, type SagaLifecycleMetric } from "../../runtime/twitch-analytics.ts";

/** Step failure classification states the safety guarantee for a subsequent attempt. */
export class WorkflowStepFailure extends Schema.TaggedError<WorkflowStepFailure>()(
  "WorkflowStepFailure",
  {
    kind: Schema.Literals(["retryable", "permanent", "unknown"]),
    message: Schema.String,
    retryAfterMs: Schema.OptionFromNullOr(Schema.Number),
  },
) {}

/** Durable control flow is not a persistence error and must never trigger automatic refund itself. */
export class WorkflowStepHalt extends Schema.TaggedError<WorkflowStepHalt>()("WorkflowStepHalt", {
  stepName: Schema.String,
  reason: Schema.Literals(["retry", "failed", "unknown"]),
  message: Schema.String,
}) {}

/** Checkpoint policy declares total attempts and whether interruption permits replay. */
export interface WorkflowStepPolicy {
  readonly attempts: number;
  readonly timeoutMs: number;
  readonly safety: "idempotent" | "non-idempotent";
  readonly rollback: boolean;
}

const StoredWorkflowRun = Schema.Struct({
  id: WorkflowId,
  status: WorkflowStatus,
  params_json: Schema.String,
  fulfilled_at: Schema.OptionFromNullOr(IsoTimestamp),
  created_at: IsoTimestamp,
  updated_at: IsoTimestamp,
  error: Schema.OptionFromNullOr(Schema.String),
});

const StoredWorkflowStep = Schema.Struct({
  step_name: Schema.NonEmptyString,
  state: Schema.Literals(["PENDING", "SUCCEEDED", "FAILED", "COMPENSATION_PENDING", "COMPENSATED"]),
  attempt: NonNegativeInt,
  result_json: Schema.OptionFromNullOr(Schema.String),
  undo_json: Schema.OptionFromNullOr(Schema.String),
  next_retry_at: Schema.OptionFromNullOr(IsoTimestamp),
  last_error: Schema.OptionFromNullOr(Schema.String),
});

const parseRunRows = Schema.decodeUnknownEffect(Schema.Array(StoredWorkflowRun));

const parseStepRows = Schema.decodeUnknownEffect(Schema.Array(StoredWorkflowStep));

const parseWorkflowInput = Schema.decodeEffect(Schema.fromJsonString(WorkflowInput));

const encodeWorkflowInput = Schema.encodeEffect(Schema.fromJsonString(WorkflowInput));

const migration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS saga_runs (
    id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('RUNNING','COMPENSATING','COMPLETED','FAILED','COMPENSATION_FAILED','OUTCOME_UNKNOWN','POST_COMMIT_FAILED')),
    params_json TEXT NOT NULL, fulfilled_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS saga_steps (
    saga_id TEXT NOT NULL, step_name TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('PENDING','SUCCEEDED','FAILED','COMPENSATION_PENDING','COMPENSATED')),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0), result_json TEXT, undo_json TEXT, next_retry_at TEXT, last_error TEXT,
    PRIMARY KEY(saga_id,step_name)
  )`;
  // A version marker is intentionally not backfilled for historical runs. Legacy active runs must drain/translate before cutover.
  yield* sql`CREATE TABLE IF NOT EXISTS workflow_format (id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version=1))`;
  yield* sql`CREATE TABLE IF NOT EXISTS workflow_metric_claims (saga_id TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY(saga_id,identity))`;
});

const migrationLoader = SqliteMigrator.fromRecord({ "1_workflow_journal": migration });

type WorkflowJournalBoundaryError =
  | SchemaError
  | SqlError.SqlError
  | WorkflowAlarmError
  | WorkflowError;

const catchWorkflowJournalBoundaryErrors =
  (operation: string) =>
  <A, R>(
    effect: Effect.Effect<A, WorkflowJournalBoundaryError, R>,
  ): Effect.Effect<A, WorkflowError, R> =>
    effect.pipe(
      Effect.catchTags({
        SqlError: () => Effect.fail(new WorkflowError({ operation, reason: "storage" })),
        SchemaError: () => Effect.fail(new WorkflowError({ operation, reason: "corrupt" })),
        WorkflowAlarmError: () => Effect.fail(new WorkflowError({ operation, reason: "schedule" })),
      }),
    );

const catchWorkflowStepBoundaryErrors =
  (operation: string) =>
  <A, R>(
    effect: Effect.Effect<A, WorkflowJournalBoundaryError | WorkflowStepHalt, R>,
  ): Effect.Effect<A, WorkflowError | WorkflowStepHalt, R> =>
    effect.pipe(
      Effect.catchTags({
        SqlError: () => Effect.fail(new WorkflowError({ operation, reason: "storage" })),
        SchemaError: () => Effect.fail(new WorkflowError({ operation, reason: "corrupt" })),
        WorkflowAlarmError: () => Effect.fail(new WorkflowError({ operation, reason: "schedule" })),
      }),
    );

/** Journal owns checkpoint replay, durable retry budgets, and point-of-no-return evidence. */
export interface IWorkflowJournal {
  readonly initialize: (input: WorkflowInput) => Effect.Effect<void, WorkflowError>;
  readonly getInput: () => Effect.Effect<Option.Option<WorkflowInput>, WorkflowError>;
  readonly getStatus: () => Effect.Effect<Option.Option<WorkflowRunStatus>, WorkflowError>;
  readonly transition: (
    status: WorkflowStatus,
    error: Option.Option<string>,
  ) => Effect.Effect<void, WorkflowError>;
  readonly restoreAlarm: () => Effect.Effect<void, WorkflowError>;
  readonly checkpoint: <A, I>(
    name: string,
    schema: Schema.Codec<A, I>,
    operation: Effect.Effect<A, WorkflowStepFailure>,
    policy: WorkflowStepPolicy,
  ) => Effect.Effect<A, WorkflowError | WorkflowStepHalt>;
  readonly compensate: <A, I>(
    name: string,
    schema: Schema.Codec<A, I>,
    operation: (undo: A) => Effect.Effect<void, WorkflowStepFailure>,
    safety: WorkflowStepPolicy["safety"],
  ) => Effect.Effect<void, WorkflowError | WorkflowStepHalt>;
}

/** Persisted workflow journal is local to one Durable Object SQL database. */
export class WorkflowJournal extends Context.Service<WorkflowJournal, IWorkflowJournal>()(
  "@cf-twitch/WorkflowJournal",
) {}

/** Build checkpoint persistence after migrations, with runtime alarm authority explicit. */
export const makeWorkflowJournal = Effect.gen(function* () {
  yield* SqliteMigrator.run({ loader: migrationLoader, table: "workflow_schema_migrations" });
  const sql = yield* SqlClient.SqlClient;
  const alarm = yield* WorkflowAlarm;
  const analytics = yield* TwitchAnalytics;

  const emitLifecycle = Effect.fn("WorkflowJournal.emitLifecycle")(function* (
    run: typeof StoredWorkflowRun.Type,
    event: SagaLifecycleMetric["event"],
    identity: string,
    stepName: Option.Option<string>,
    error: Option.Option<string>,
  ) {
    const input = yield* parseWorkflowInput(run.params_json);

    // Analytics has no provider idempotency key. Claim before sending: at most once, with an explicit possible loss window.
    const claimed =
      yield* sql`INSERT INTO workflow_metric_claims(saga_id,identity) VALUES(${run.id},${identity}) ON CONFLICT DO NOTHING RETURNING identity`;

    if (claimed.length === 0) return;
    yield* analytics.writeSagaLifecycleMetric({
      sagaType:
        input._tag === "SongRequest"
          ? "song-request-saga"
          : input._tag === "KeyboardRaffle"
            ? "keyboard-raffle-saga"
            : "raid-shoutout-saga",
      sagaId: run.id,
      event,
      stepName,
      error,
      durationMs: Option.some(
        Math.max(0, (yield* Clock.currentTimeMillis) - Date.parse(run.created_at)),
      ),
    });
  });

  const findRun = Effect.fn("WorkflowJournal.findRun")(function* () {
    const rows = yield* parseRunRows(yield* sql`SELECT * FROM saga_runs LIMIT 2`);

    if (rows.length > 1)
      return yield* new WorkflowError({
        operation: "read-run",
        reason: "corrupt",
      });

    return Option.fromUndefinedOr(rows[0]);
  });

  const requireCurrentWorkflowFormat = Effect.fn("WorkflowJournal.requireCurrentWorkflowFormat")(
    function* (run: typeof StoredWorkflowRun.Type) {
      const formats = yield* sql`SELECT version FROM workflow_format WHERE id=${run.id}`;

      const parsed = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ version: Schema.Literal(1) })),
      )(formats);

      if (parsed.length !== 1)
        return yield* new WorkflowError({
          operation: "legacy-state-gate",
          reason: "corrupt",
        });
    },
  );

  const requireRun = Effect.fn("WorkflowJournal.requireRun")(function* () {
    const row = yield* findRun();

    if (Option.isNone(row))
      return yield* new WorkflowError({
        operation: "require-run",
        reason: "corrupt",
      });
    yield* requireCurrentWorkflowFormat(row.value);

    return row.value;
  });

  const getStatus = Effect.fn("WorkflowJournal.getStatus")(function* () {
    return Option.map(yield* findRun(), (run) => ({
      sagaId: run.id,
      status: run.status,
      fulfilledAt: run.fulfilled_at,
      error: run.error,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
    }));
  }, catchWorkflowJournalBoundaryErrors("get-status"));

  const getInput = Effect.fn("WorkflowJournal.getInput")(function* () {
    const existing = yield* findRun();

    if (Option.isNone(existing)) return Option.none();
    yield* requireCurrentWorkflowFormat(existing.value);

    return Option.some(yield* parseWorkflowInput(existing.value.params_json));
  }, catchWorkflowJournalBoundaryErrors("get-input"));

  const initialize = Effect.fn("WorkflowJournal.initialize")(function* (input: WorkflowInput) {
    const id = WorkflowId.make(
      input._tag === "RaidShoutout" ? input.raid.messageId : input.redemption.id,
    );

    const json = yield* encodeWorkflowInput(input);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* findRun();

        if (Option.isSome(existing)) {
          if (existing.value.id !== id)
            return yield* new WorkflowError({
              operation: "initialize",
              reason: "conflict",
            });

          // Schema encoding establishes canonical field order; a direct caller cannot mutate original input on replay.
          const canonical = yield* encodeWorkflowInput(
            yield* parseWorkflowInput(existing.value.params_json),
          );

          if (canonical !== json)
            return yield* new WorkflowError({
              operation: "initialize",
              reason: "conflict",
            });

          return;
        }

        const now = new Date(yield* Clock.currentTimeMillis).toISOString();
        yield* sql`INSERT INTO saga_runs (id,status,params_json,created_at,updated_at) VALUES (${id},'RUNNING',${json},${now},${now})`;
        yield* sql`INSERT INTO workflow_format (id,version) VALUES (${id},1)`;
      }),
    );
    yield* emitLifecycle(yield* requireRun(), "started", "started", Option.none(), Option.none());
    yield* restoreAlarm();
  }, catchWorkflowJournalBoundaryErrors("initialize"));

  const transition = Effect.fn("WorkflowJournal.transition")(function* (
    status: WorkflowStatus,
    error: Option.Option<string>,
  ) {
    const run = yield* requireRun();
    const now = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* sql`UPDATE saga_runs SET status=${status},error=${Option.getOrNull(error)},updated_at=${now} WHERE id=${run.id}`;
    yield* Effect.logInfo("Workflow lifecycle transitioned", { workflowId: run.id, status });

    if (status === "COMPLETED" || status === "FAILED" || status === "COMPENSATING")
      yield* emitLifecycle(
        run,
        status === "COMPLETED" ? "completed" : status === "FAILED" ? "failed" : "compensating",
        status,
        Option.none(),
        error,
      );
    yield* restoreAlarm();
  }, catchWorkflowJournalBoundaryErrors("transition"));

  const readStep = Effect.fn("WorkflowJournal.readStep")(function* (id: WorkflowId, name: string) {
    return Option.fromUndefinedOr(
      (yield* parseStepRows(
        yield* sql`SELECT * FROM saga_steps WHERE saga_id=${id} AND step_name=${name}`,
      ))[0],
    );
  });

  const restoreAlarm = Effect.fn("WorkflowJournal.restoreAlarm")(function* () {
    const existing = yield* findRun();

    if (
      Option.isNone(existing) ||
      (existing.value.status !== "RUNNING" && existing.value.status !== "COMPENSATING")
    )
      return yield* alarm.set(Option.none());
    const run = existing.value;
    yield* requireCurrentWorkflowFormat(run);

    const steps = yield* parseStepRows(
      yield* sql`SELECT * FROM saga_steps WHERE saga_id=${run.id} AND next_retry_at IS NOT NULL ORDER BY next_retry_at ASC`,
    );

    const now = yield* Clock.currentTimeMillis;
    const first = steps[0];

    const due =
      first === undefined
        ? now + 1_000
        : Option.match(first.next_retry_at, {
            onNone: () => now + 1_000,
            onSome: (value) => Math.max(now + 1, Date.parse(value)),
          });

    yield* alarm.set(Option.some(due));
  }, catchWorkflowJournalBoundaryErrors("restore-alarm"));

  const checkpoint = <A, I>(
    name: string,
    schema: Schema.Codec<A, I>,
    operation: Effect.Effect<A, WorkflowStepFailure>,
    policy: WorkflowStepPolicy,
  ): Effect.Effect<A, WorkflowError | WorkflowStepHalt> =>
    Effect.gen(function* () {
      const run = yield* requireRun();
      const existing = yield* readStep(run.id, name);
      const decode = Schema.decodeEffect(Schema.fromJsonString(schema));
      const encode = Schema.encodeEffect(Schema.fromJsonString(schema));

      const halt = (reason: WorkflowStepHalt["reason"], message: string) =>
        new WorkflowStepHalt({ stepName: name, reason, message });

      const replayStoredCheckpoint = Effect.fn("WorkflowJournal.replayStoredCheckpoint")(
        function* () {
          if (Option.isNone(existing)) return Option.none<A>();
          const step = existing.value;

          if (
            step.state === "SUCCEEDED" ||
            step.state === "COMPENSATED" ||
            step.state === "COMPENSATION_PENDING"
          ) {
            if (Option.isNone(step.result_json))
              return yield* new WorkflowError({
                operation: name,
                reason: "corrupt",
              });
            const result = yield* decode(step.result_json.value);

            if (policy.rollback) {
              if (Option.isNone(step.undo_json))
                return yield* new WorkflowError({
                  operation: name,
                  reason: "corrupt",
                });
              yield* decode(step.undo_json.value);
            }

            return Option.some(result);
          }

          if (step.state === "FAILED")
            return yield* halt(
              Option.getOrNull(step.last_error) === "unknown" ? "unknown" : "failed",
              Option.getOrElse(step.last_error, () => "Workflow step retry budget exhausted"),
            );

          if (
            policy.safety === "non-idempotent" &&
            Option.isNone(step.next_retry_at) &&
            step.attempt > 0
          ) {
            yield* sql`UPDATE saga_steps SET state='FAILED',last_error='unknown' WHERE saga_id=${run.id} AND step_name=${name}`;

            return yield* halt(
              "unknown",
              "Workflow non-idempotent effect interrupted before durable success evidence",
            );
          }

          if (
            Option.isSome(step.next_retry_at) &&
            Date.parse(step.next_retry_at.value) > (yield* Clock.currentTimeMillis)
          ) {
            yield* alarm.set(Option.some(Date.parse(step.next_retry_at.value)));

            return yield* halt("retry", "Workflow retry is not due yet");
          }

          return Option.none<A>();
        },
      );

      const replayed = yield* replayStoredCheckpoint();

      if (Option.isSome(replayed)) return replayed.value;
      const attempt = Option.isSome(existing) ? existing.value.attempt + 1 : 1;

      if (attempt > policy.attempts) {
        yield* sql`UPDATE saga_steps SET state='FAILED',next_retry_at=NULL,last_error='exhausted' WHERE saga_id=${run.id} AND step_name=${name}`;

        return yield* halt("failed", "Workflow interrupted attempts exhausted the retry budget");
      }

      // Prepared intent is provably safe to dispatch if scheduling fails. Only the dispatch guard below consumes an attempt.
      const preparedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      yield* sql`INSERT INTO saga_steps (saga_id,step_name,state,attempt,next_retry_at) VALUES (${run.id},${name},'PENDING',${attempt - 1},${preparedAt})
      ON CONFLICT(saga_id,step_name) DO UPDATE SET state='PENDING',next_retry_at=${preparedAt},last_error=NULL`;
      yield* alarm.set(Option.some((yield* Clock.currentTimeMillis) + 60_000));
      yield* emitLifecycle(
        run,
        "step_started",
        `${name}:started:${attempt}`,
        Option.some(name),
        Option.none(),
      );
      // Null retry evidence marks the non-idempotent dispatch boundary. Interruption after this write is outcome-unknown.
      yield* sql`UPDATE saga_steps SET attempt=${attempt},next_retry_at=NULL WHERE saga_id=${run.id} AND step_name=${name}`;

      const outcome = yield* operation.pipe(
        Effect.timeout(policy.timeoutMs),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(
            new WorkflowStepFailure({
              kind: policy.safety === "non-idempotent" ? "unknown" : "retryable",
              message: "Workflow step timed out",
              retryAfterMs: Option.none(),
            }),
          ),
        ),
        Effect.result,
      );

      if (outcome._tag === "Failure") {
        const error = outcome.failure;

        if (error.kind === "retryable" && attempt < policy.attempts) {
          const delay = Math.max(
            Math.min(30_000, 1_000 * 2 ** attempt),
            Option.getOrElse(error.retryAfterMs, () => 0),
          );

          const due = (yield* Clock.currentTimeMillis) + delay;
          yield* sql`UPDATE saga_steps SET next_retry_at=${new Date(due).toISOString()},last_error=${error.message} WHERE saga_id=${run.id} AND step_name=${name}`;
          yield* alarm.set(Option.some(due));

          return yield* halt("retry", "Workflow step scheduled for durable retry");
        }

        yield* sql`UPDATE saga_steps SET state='FAILED',last_error=${error.kind === "unknown" ? "unknown" : error.message},next_retry_at=NULL WHERE saga_id=${run.id} AND step_name=${name}`;
        yield* emitLifecycle(
          run,
          "step_failed",
          `${name}:failed`,
          Option.some(name),
          Option.some(error.message),
        );

        return yield* halt(error.kind === "unknown" ? "unknown" : "failed", error.message);
      }

      const json = yield* encode(outcome.success);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE saga_steps SET state='SUCCEEDED',result_json=${json},undo_json=${policy.rollback ? json : null},next_retry_at=NULL,last_error=NULL WHERE saga_id=${run.id} AND step_name=${name}`;

          // Fulfillment and its point-of-no-return marker commit in the same local transaction.
          if (name === "fulfill-redemption") {
            const now = new Date(yield* Clock.currentTimeMillis).toISOString();
            yield* sql`UPDATE saga_runs SET fulfilled_at=COALESCE(fulfilled_at,${now}),updated_at=${now} WHERE id=${run.id}`;
          }
        }),
      );
      yield* emitLifecycle(
        run,
        "step_completed",
        `${name}:completed`,
        Option.some(name),
        Option.none(),
      );

      if (name === "fulfill-redemption")
        yield* emitLifecycle(run, "fulfilled", "fulfilled", Option.none(), Option.none());

      return outcome.success;
    }).pipe(
      catchWorkflowStepBoundaryErrors(name),
      Effect.withSpan("WorkflowJournal.checkpoint", { attributes: { stepName: name } }),
    );

  const compensate = <A, I>(
    name: string,
    schema: Schema.Codec<A, I>,
    operation: (undo: A) => Effect.Effect<void, WorkflowStepFailure>,
    safety: WorkflowStepPolicy["safety"],
  ): Effect.Effect<void, WorkflowError | WorkflowStepHalt> =>
    Effect.gen(function* () {
      const run = yield* requireRun();

      if (Option.isSome(run.fulfilled_at))
        return yield* new WorkflowError({
          operation: name,
          reason: "conflict",
        });
      const step = yield* readStep(run.id, name);

      if (
        Option.isNone(step) ||
        step.value.state === "COMPENSATED" ||
        step.value.state === "FAILED" ||
        step.value.state === "PENDING"
      )
        return;

      if (Option.isNone(step.value.undo_json) || Option.isNone(step.value.result_json))
        return yield* new WorkflowError({
          operation: name,
          reason: "corrupt",
        });
      const decode = Schema.decodeEffect(Schema.fromJsonString(schema));
      yield* decode(step.value.result_json.value);
      const undo = yield* decode(step.value.undo_json.value);
      yield* checkpoint(`compensate:${name}`, Schema.Null, operation(undo).pipe(Effect.as(null)), {
        attempts: 5,
        timeoutMs: 30_000,
        safety,
        rollback: false,
      });
      yield* sql`UPDATE saga_steps SET state='COMPENSATED' WHERE saga_id=${run.id} AND step_name=${name}`;
      yield* emitLifecycle(
        run,
        "step_compensated",
        `${name}:compensated`,
        Option.some(name),
        Option.none(),
      );
    }).pipe(catchWorkflowStepBoundaryErrors(`compensate:${name}`));

  return WorkflowJournal.of({
    initialize,
    getInput,
    getStatus,
    transition,
    restoreAlarm,
    checkpoint,
    compensate,
  });
});

/** SQL-backed workflow journal with explicit alarm and SQL requirements for runtime composition. */
export const workflowJournalLayerWithoutDependencies = Layer.effect(
  WorkflowJournal,
  makeWorkflowJournal,
);
