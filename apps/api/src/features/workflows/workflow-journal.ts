import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-do";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Clock, Context, Effect, Layer, Match, Option, Result, Schema } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import type { SchemaError } from "effect/Schema";
import { IsoTimestamp, NonNegativeInt } from "@cf-twitch/contracts/identity";
import { ProviderFailureKind } from "@cf-twitch/contracts/provider";
import {
  WorkflowError,
  WorkflowId,
  WorkflowInput,
  type WorkflowOperation,
  WorkflowRunStatus,
  WorkflowStatus,
} from "@cf-twitch/contracts/workflow";
import {
  WorkflowAlarm,
  WorkflowAlarmError,
  workflowAlarmLayer,
  workflowAlarmTestLayer,
} from "./workflow-alarm.ts";
import { TwitchAnalytics, type SagaLifecycleMetric } from "../../runtime/twitch-analytics.ts";

/** Schema for the external operations a workflow checkpoint can perform. */
export const WorkflowStepOperation = Schema.Literals([
  "run-step",
  "parse-spotify-track",
  "get-spotify-track",
  "add-to-spotify-queue",
  "remove-from-spotify-queue",
  "persist-song-request",
  "delete-song-request",
  "record-raffle-roll",
  "delete-raffle-roll",
  "send-chat-message",
  "create-shoutout",
  "update-redemption-status",
  "publish-domain-event",
  "derive-event-id",
]);

/** External operation a workflow checkpoint performs. */
export type WorkflowStepOperation = typeof WorkflowStepOperation.Type;

/** Schema for the classified causes of a `WorkflowStepFailure`. */
export const WorkflowStepFailureReason = Schema.Literals([
  "timed_out",
  "outcome_unknown",
  "rate_limited",
  "provider_unavailable",
  "provider_rejected",
  "invalid_track_input",
  "dependency_unavailable",
  "compensation_unconfirmed",
  "chat_message_too_long",
  "digest_unavailable",
]);

/** Classified cause of a workflow step failure. */
export type WorkflowStepFailureReason = typeof WorkflowStepFailureReason.Type;

/**
 * Persisted run-error text for invalid Spotify track input.
 *
 * **Gotchas**
 *
 * Compensation selects the viewer's refund message by matching this prefix in the persisted run error, so changing it changes the chat message for runs already compensating.
 */
export const invalidSpotifyTrackInputMessagePrefix = "Workflow Spotify track input is invalid";

/** Error raised by one checkpoint operation, classified by whether another attempt is safe. */
export class WorkflowStepFailure extends Schema.TaggedError<WorkflowStepFailure>()(
  "WorkflowStepFailure",
  {
    operation: WorkflowStepOperation,
    reason: WorkflowStepFailureReason,
    /** Retry safety: `retryable` may repeat, `permanent` will fail again, `unknown` may already have taken effect. */
    kind: Schema.Literals(["retryable", "permanent", "unknown"]),
    /** Provider classification behind the failure, when a provider reported one. */
    providerFailure: Schema.OptionFromNullOr(ProviderFailureKind),
    /** Provider-requested delay before another attempt, in milliseconds. */
    retryAfterMs: Schema.OptionFromNullOr(Schema.Number),
  },
) {
  /** Step failure message naming the operation and classified reason; persisted as the step's and run's operator diagnostic. */
  override get message(): string {
    const provider = Option.match(this.providerFailure, {
      onNone: () => "",
      onSome: (kind) => ` (provider reported ${kind})`,
    });

    return Match.value(this.reason).pipe(
      Match.when(
        "timed_out",
        () =>
          `Workflow step ${this.operation} timed out. Inspect the workflow status; idempotent steps retry automatically and others are marked outcome unknown.`,
      ),
      Match.when(
        "outcome_unknown",
        () =>
          `Workflow step ${this.operation} ended with an unknown outcome${provider}. Reconcile the external effect before retrying; it is not retried automatically.`,
      ),
      Match.when(
        "rate_limited",
        () =>
          `Workflow step ${this.operation} was rate limited${provider}. Wait for the workflow alarm; the journal retries after the provider's delay while attempts remain.`,
      ),
      Match.when(
        "provider_unavailable",
        () =>
          `Workflow step ${this.operation} failed because the provider was unavailable${provider}. Wait for the workflow alarm; the journal retries while attempts remain.`,
      ),
      Match.when(
        "provider_rejected",
        () =>
          `Workflow step ${this.operation} was rejected by the provider${provider}. Check the provider connection and configuration before the next redemption.`,
      ),
      Match.when(
        "invalid_track_input",
        () =>
          `${invalidSpotifyTrackInputMessagePrefix}. Ask the viewer to redeem again with a Spotify track link.`,
      ),
      Match.when(
        "dependency_unavailable",
        () =>
          `Workflow step ${this.operation} failed because a durable dependency was unavailable. Wait for the workflow alarm; the journal retries while attempts remain.`,
      ),
      Match.when(
        "compensation_unconfirmed",
        () =>
          `Workflow Spotify compensation was not confirmed during ${this.operation}, so the refund was withheld. Inspect the Spotify queue and remove the track before refunding.`,
      ),
      Match.when(
        "chat_message_too_long",
        () =>
          `Workflow chat message exceeds Twitch delivery constraints during ${this.operation}, so it was not sent. Shorten the chat message template.`,
      ),
      Match.when(
        "digest_unavailable",
        () =>
          `Workflow event identity digest failed during ${this.operation} because SHA-256 was unavailable. Wait for the workflow alarm; the identity is derived deterministically on retry.`,
      ),
      Match.exhaustive,
    );
  }
}

/** Error that halts a workflow at a checkpoint; durable control flow, never a persistence failure, and never a refund trigger by itself. */
export class WorkflowStepHalt extends Schema.TaggedError<WorkflowStepHalt>()("WorkflowStepHalt", {
  operation: Schema.Literal("checkpoint"),
  /** Checkpoint step that halted. */
  stepName: Schema.String,
  /** `retry` waits for the alarm, `failed` exhausted or refused the step, `unknown` may already have taken effect. */
  reason: Schema.Literals(["retry", "failed", "unknown"]),
  /** Operator diagnostic persisted as the run error when the halt ends or pauses the run. */
  detail: Schema.String,
}) {
  /** Halt message naming the step and halt reason, followed by its diagnostic and way forward. */
  override get message(): string {
    return `Workflow step ${this.stepName} halted with reason ${this.reason}. ${this.detail}`;
  }
}

/** Checkpoint policy declaring the attempt budget and whether interruption permits replay. */
export interface WorkflowStepPolicy {
  /** Total attempts, including the first, before the step fails permanently. */
  readonly attempts: number;
  /** Per-attempt deadline in milliseconds; a timeout counts as a failed attempt. */
  readonly timeoutMs: number;
  /** `non-idempotent` steps interrupted after dispatch become outcome unknown instead of being replayed. */
  readonly safety: "idempotent" | "non-idempotent";
  /** Whether the step's result is also stored as undo evidence for compensation. */
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

type StoredWorkflowRun = typeof StoredWorkflowRun.Type;

const StoredWorkflowStep = Schema.Struct({
  step_name: Schema.NonEmptyString,
  state: Schema.Literals(["PENDING", "SUCCEEDED", "FAILED", "COMPENSATION_PENDING", "COMPENSATED"]),
  attempt: NonNegativeInt,
  result_json: Schema.OptionFromNullOr(Schema.String),
  undo_json: Schema.OptionFromNullOr(Schema.String),
  next_retry_at: Schema.OptionFromNullOr(IsoTimestamp),
  last_error: Schema.OptionFromNullOr(Schema.String),
});

type StoredWorkflowStep = typeof StoredWorkflowStep.Type;

const parseRunRows = Schema.decodeUnknownEffect(Schema.Array(StoredWorkflowRun));

const parseStepRows = Schema.decodeUnknownEffect(Schema.Array(StoredWorkflowStep));

const parseFormatRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ version: Schema.Literal(1) })),
);

const parseWorkflowInput = Schema.decodeEffect(Schema.fromJsonString(WorkflowInput));

const encodeWorkflowInput = Schema.encodeEffect(Schema.fromJsonString(WorkflowInput));

// `last_error` sentinels are durable step state, not messages: replay reads them to choose the halt reason.
const unknownOutcomeSentinel = "unknown";

const exhaustedSentinel = "exhausted";

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

type WorkflowJournalBoundaryError = SchemaError | SqlError.SqlError | WorkflowAlarmError;

const journalBoundaryError = (
  operation: WorkflowOperation,
  reason: "storage" | "corrupt" | "schedule",
  stepName: Option.Option<string>,
) => Effect.fail(new WorkflowError({ operation, reason, workflowId: Option.none(), stepName }));

/** Translates journal storage, codec, and alarm failures into `WorkflowError`; journal errors pass through unchanged. */
const catchWorkflowJournalBoundaryErrors =
  (operation: WorkflowOperation) =>
  <A, R>(
    effect: Effect.Effect<A, WorkflowJournalBoundaryError | WorkflowError, R>,
  ): Effect.Effect<A, WorkflowError, R> =>
    effect.pipe(
      Effect.catchTags({
        SqlError: () => journalBoundaryError(operation, "storage", Option.none()),
        SchemaError: () => journalBoundaryError(operation, "corrupt", Option.none()),
        WorkflowAlarmError: () => journalBoundaryError(operation, "schedule", Option.none()),
      }),
    );

/** Translates checkpoint storage, codec, and alarm failures into `WorkflowError` for the named step; halts pass through unchanged. */
const catchWorkflowStepBoundaryErrors =
  (operation: "checkpoint" | "compensate", stepName: string) =>
  <A, R>(
    effect: Effect.Effect<A, WorkflowJournalBoundaryError | WorkflowError | WorkflowStepHalt, R>,
  ): Effect.Effect<A, WorkflowError | WorkflowStepHalt, R> =>
    effect.pipe(
      Effect.catchTags({
        SqlError: () => journalBoundaryError(operation, "storage", Option.some(stepName)),
        SchemaError: () => journalBoundaryError(operation, "corrupt", Option.some(stepName)),
        WorkflowAlarmError: () =>
          journalBoundaryError(operation, "schedule", Option.some(stepName)),
      }),
    );

/** Checkpoint replay, durable retry budgets, and point-of-no-return evidence for one workflow run. */
export interface IWorkflowJournal {
  /**
   * Persists the canonical input of a new run, or confirms an identical input for an existing run.
   *
   * @returns Nothing, or fails with `WorkflowError` reason `conflict` when the input differs from the existing run, `storage`/`corrupt` when SQL fails or stored data is unreadable, and `schedule` when the alarm cannot be set.
   */
  readonly initialize: (input: WorkflowInput) => Effect.Effect<void, WorkflowError>;
  /**
   * Returns the run's canonical input, or `None` when no run exists.
   *
   * @returns The input, or fails with `WorkflowError` reason `legacy_state` for runs without the current format marker, and `storage`/`corrupt` for SQL or codec failures.
   */
  readonly getInput: () => Effect.Effect<Option.Option<WorkflowInput>, WorkflowError>;
  /**
   * Returns the run's operational status, or `None` when no run exists.
   *
   * @returns The status, or fails with `WorkflowError` reason `storage`/`corrupt` for SQL or codec failures.
   */
  readonly getStatus: () => Effect.Effect<Option.Option<WorkflowRunStatus>, WorkflowError>;
  /**
   * Records a lifecycle status and diagnostic, then re-arms or clears the alarm.
   *
   * @returns Nothing, or fails with `WorkflowError` reason `missing_run`, `legacy_state`, `storage`, `corrupt`, or `schedule`.
   */
  readonly transition: (
    status: WorkflowStatus,
    error: Option.Option<string>,
  ) => Effect.Effect<void, WorkflowError>;
  /**
   * Schedules the alarm for the earliest retry of an unfinished run, or cancels it for finished runs.
   *
   * @returns Nothing, or fails with `WorkflowError` reason `legacy_state`, `storage`, `corrupt`, or `schedule`.
   */
  readonly restoreAlarm: () => Effect.Effect<void, WorkflowError>;
  /**
   * Runs `operation` at most as allowed by `policy`, replaying a stored result instead of repeating a completed step.
   *
   * @returns The step result, or fails with `WorkflowStepHalt` when the step waits for retry, fails, or has an unknown outcome, and with `WorkflowError` when journal storage, codecs, or the alarm fail.
   */
  readonly checkpoint: <A, I>(
    name: string,
    schema: Schema.Codec<A, I>,
    operation: Effect.Effect<A, WorkflowStepFailure>,
    policy: WorkflowStepPolicy,
  ) => Effect.Effect<A, WorkflowError | WorkflowStepHalt>;
  /**
   * Undoes a completed rollback step using its stored undo evidence, at most once.
   *
   * @returns Nothing, or fails with `WorkflowError` reason `already_fulfilled` after the point of no return, `corrupt` when undo evidence is missing or unreadable, and `WorkflowStepHalt` when the undo operation halts.
   */
  readonly compensate: <A, I>(
    name: string,
    schema: Schema.Codec<A, I>,
    operation: (undo: A) => Effect.Effect<void, WorkflowStepFailure>,
    safety: WorkflowStepPolicy["safety"],
  ) => Effect.Effect<void, WorkflowError | WorkflowStepHalt>;
}

/** Service tag for the workflow journal, local to one Durable Object SQL database. */
export class WorkflowJournal extends Context.Service<WorkflowJournal, IWorkflowJournal>()(
  "@cf-twitch/WorkflowJournal",
) {}

/**
 * Effect that runs journal migrations and builds checkpoint persistence over SQL, the alarm, and analytics.
 *
 * @returns The journal, or fails with `SqlError`/`MigrationError` when migrations cannot run.
 */
export const makeWorkflowJournal = Effect.gen(function* () {
  yield* SqliteMigrator.run({ loader: migrationLoader, table: "workflow_schema_migrations" });
  const sql = yield* SqlClient.SqlClient;
  const alarm = yield* WorkflowAlarm;
  const analytics = yield* TwitchAnalytics;

  const emitLifecycle = Effect.fn("WorkflowJournal.emitLifecycle")(function* (
    run: StoredWorkflowRun,
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
      sagaType: WorkflowInput.match(input, {
        SongRequest: () => "song-request-saga" as const,
        KeyboardRaffle: () => "keyboard-raffle-saga" as const,
        RaidShoutout: () => "raid-shoutout-saga" as const,
      }),
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
        workflowId: Option.none(),
        stepName: Option.none(),
      });

    return Option.fromUndefinedOr(rows[0]);
  });

  const requireCurrentWorkflowFormat = Effect.fn("WorkflowJournal.requireCurrentWorkflowFormat")(
    function* (run: StoredWorkflowRun) {
      const formats = yield* parseFormatRows(
        yield* sql`SELECT version FROM workflow_format WHERE id=${run.id}`,
      );

      if (formats.length !== 1)
        return yield* new WorkflowError({
          operation: "legacy-state-gate",
          reason: "legacy_state",
          workflowId: Option.some(run.id),
          stepName: Option.none(),
        });
    },
  );

  const requireRun = Effect.fn("WorkflowJournal.requireRun")(function* () {
    const row = yield* findRun();

    if (Option.isNone(row))
      return yield* new WorkflowError({
        operation: "require-run",
        reason: "missing_run",
        workflowId: Option.none(),
        stepName: Option.none(),
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
      WorkflowInput.match(input, {
        SongRequest: ({ redemption }) => redemption.id,
        KeyboardRaffle: ({ redemption }) => redemption.id,
        RaidShoutout: ({ raid }) => raid.messageId,
      }),
    );

    const conflict = () =>
      new WorkflowError({
        operation: "initialize",
        reason: "conflict",
        workflowId: Option.some(id),
        stepName: Option.none(),
      });

    const json = yield* encodeWorkflowInput(input);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* findRun();

        if (Option.isSome(existing)) {
          if (existing.value.id !== id) return yield* conflict();

          // Schema encoding establishes canonical field order; a direct caller cannot mutate original input on replay.
          const canonical = yield* encodeWorkflowInput(
            yield* parseWorkflowInput(existing.value.params_json),
          );

          if (canonical !== json) return yield* conflict();

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
        Match.value(status).pipe(
          Match.when("COMPLETED", () => "completed" as const),
          Match.when("FAILED", () => "failed" as const),
          Match.orElse(() => "compensating" as const),
        ),
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
      // The codec depends on the caller's step schema, so it cannot be instantiated once at module scope.
      const decode = Schema.decodeEffect(Schema.fromJsonString(schema));
      const encode = Schema.encodeEffect(Schema.fromJsonString(schema));

      const halt = (reason: WorkflowStepHalt["reason"], detail: string) =>
        new WorkflowStepHalt({ operation: "checkpoint", stepName: name, reason, detail });

      const corruptStep = () =>
        new WorkflowError({
          operation: "checkpoint",
          reason: "corrupt",
          workflowId: Option.some(run.id),
          stepName: Option.some(name),
        });

      const replayCompletedCheckpoint = Effect.fn("WorkflowJournal.replayCompletedCheckpoint")(
        function* (step: StoredWorkflowStep) {
          const completed =
            step.state === "SUCCEEDED" ||
            step.state === "COMPENSATED" ||
            step.state === "COMPENSATION_PENDING";

          if (!completed) return Option.none<A>();

          if (Option.isNone(step.result_json)) return yield* corruptStep();
          const result = yield* decode(step.result_json.value);

          if (!policy.rollback) return Option.some(result);

          if (Option.isNone(step.undo_json)) return yield* corruptStep();
          yield* decode(step.undo_json.value);

          return Option.some(result);
        },
      );

      const haltFailedCheckpoint = Effect.fn("WorkflowJournal.haltFailedCheckpoint")(function* (
        step: StoredWorkflowStep,
      ) {
        if (step.state !== "FAILED") return;
        const lastError = Option.getOrNull(step.last_error);

        if (lastError === unknownOutcomeSentinel)
          return yield* halt(
            "unknown",
            "Workflow step ended with an unknown outcome. Reconcile the external effect before retrying; it is not retried automatically.",
          );

        if (lastError === null || lastError === exhaustedSentinel)
          return yield* halt(
            "failed",
            "Workflow step retry budget exhausted. Inspect the workflow status before retrying manually.",
          );

        return yield* halt("failed", lastError);
      });

      const protectInterruptedCheckpoint = Effect.fn(
        "WorkflowJournal.protectInterruptedCheckpoint",
      )(function* (step: StoredWorkflowStep) {
        const interruptedNonIdempotent =
          policy.safety === "non-idempotent" &&
          Option.isNone(step.next_retry_at) &&
          step.attempt > 0;

        if (!interruptedNonIdempotent) return;
        yield* sql`UPDATE saga_steps SET state='FAILED',last_error=${unknownOutcomeSentinel} WHERE saga_id=${run.id} AND step_name=${name}`;

        return yield* halt(
          "unknown",
          "Workflow non-idempotent effect interrupted before durable success evidence. Reconcile the external effect before retrying; it is not retried automatically.",
        );
      });

      const deferEarlyCheckpointRetry = Effect.fn("WorkflowJournal.deferEarlyCheckpointRetry")(
        function* (step: StoredWorkflowStep) {
          if (Option.isNone(step.next_retry_at)) return;
          const retryAt = Date.parse(step.next_retry_at.value);

          if (retryAt <= (yield* Clock.currentTimeMillis)) return;
          yield* alarm.set(Option.some(retryAt));

          return yield* halt(
            "retry",
            "Workflow retry is not due yet. Wait for the workflow alarm to resume the step.",
          );
        },
      );

      const replayStoredCheckpoint = Effect.fn("WorkflowJournal.replayStoredCheckpoint")(
        function* () {
          if (Option.isNone(existing)) return Option.none<A>();
          const step = existing.value;
          const completed = yield* replayCompletedCheckpoint(step);

          if (Option.isSome(completed)) return completed;
          yield* haltFailedCheckpoint(step);
          yield* protectInterruptedCheckpoint(step);
          yield* deferEarlyCheckpointRetry(step);

          return Option.none<A>();
        },
      );

      const replayed = yield* replayStoredCheckpoint();

      if (Option.isSome(replayed)) return replayed.value;
      const attempt = Option.isSome(existing) ? existing.value.attempt + 1 : 1;

      if (attempt > policy.attempts) {
        yield* sql`UPDATE saga_steps SET state='FAILED',next_retry_at=NULL,last_error=${exhaustedSentinel} WHERE saga_id=${run.id} AND step_name=${name}`;

        return yield* halt(
          "failed",
          "Workflow interrupted attempts exhausted the retry budget. Inspect the workflow status before retrying manually.",
        );
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
        Effect.timeoutOrElse({
          duration: policy.timeoutMs,
          orElse: () =>
            Effect.fail(
              new WorkflowStepFailure({
                operation: "run-step",
                reason: "timed_out",
                kind: policy.safety === "non-idempotent" ? "unknown" : "retryable",
                providerFailure: Option.none(),
                retryAfterMs: Option.none(),
              }),
            ),
        }),
        Effect.result,
      );

      if (Result.isFailure(outcome)) {
        const error = outcome.failure;

        if (error.kind === "retryable" && attempt < policy.attempts) {
          const delay = Math.max(
            Math.min(30_000, 1_000 * 2 ** attempt),
            Option.getOrElse(error.retryAfterMs, () => 0),
          );

          const due = (yield* Clock.currentTimeMillis) + delay;
          yield* sql`UPDATE saga_steps SET next_retry_at=${new Date(due).toISOString()},last_error=${error.message} WHERE saga_id=${run.id} AND step_name=${name}`;
          yield* alarm.set(Option.some(due));

          return yield* halt(
            "retry",
            "Workflow step scheduled for durable retry. Wait for the workflow alarm to resume the step.",
          );
        }

        yield* sql`UPDATE saga_steps SET state='FAILED',last_error=${error.kind === "unknown" ? unknownOutcomeSentinel : error.message},next_retry_at=NULL WHERE saga_id=${run.id} AND step_name=${name}`;
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
      catchWorkflowStepBoundaryErrors("checkpoint", name),
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
          operation: "compensate",
          reason: "already_fulfilled",
          workflowId: Option.some(run.id),
          stepName: Option.some(name),
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
          operation: "compensate",
          reason: "corrupt",
          workflowId: Option.some(run.id),
          stepName: Option.some(name),
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
    }).pipe(catchWorkflowStepBoundaryErrors("compensate", name));

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

/** Layer that provides the SQL workflow journal; requires SQL, the alarm, and analytics. */
export const workflowJournalLayerWithoutDependencies = Layer.effect(
  WorkflowJournal,
  makeWorkflowJournal,
);

// Built inside the Durable Object runtime phase, where `DurableObjectState` is available; never during planning.
const durableObjectSqliteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return SqliteClient.layer({ storage: state.raw.storage });
  }),
);

/** Production journal Layer over the Durable Object's SQLite storage and native alarm; requires the runtime `DurableObjectState` and analytics. */
export const workflowJournalLayer = workflowJournalLayerWithoutDependencies.pipe(
  Layer.provide([durableObjectSqliteLayer, workflowAlarmLayer]),
);

/** Journal Layer over the in-memory alarm; the test selects the SQL database and analytics recorder. */
export const workflowJournalTestLayer = workflowJournalLayerWithoutDependencies.pipe(
  Layer.provide(workflowAlarmTestLayer),
);
