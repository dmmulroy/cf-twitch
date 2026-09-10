import { SqliteClient } from "@effect/sql-sqlite-node";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { recordingTwitchAnalyticsLayer } from "../../../test/support/recording-twitch-analytics.ts";
import { WorkflowInput } from "@cf-twitch/contracts/workflow";
import { WorkflowAlarm, WorkflowAlarmError } from "./workflow-alarm.ts";
import {
  WorkflowJournal,
  WorkflowStepFailure,
  workflowJournalLayerWithoutDependencies,
  type WorkflowStepPolicy,
} from "./workflow-journal.ts";

const input = Schema.decodeUnknownSync(WorkflowInput)({
  _tag: "RaidShoutout",
  raid: {
    messageId: "receipt-1",
    receivedAt: "2026-01-01T00:00:00Z",
    raider: { userId: "raider", login: "raider", displayName: "Raider" },
    viewers: 42,
  },
});

const safe: WorkflowStepPolicy = {
  attempts: 3,
  timeoutMs: 30_000,
  safety: "idempotent",
  rollback: false,
};

const unsafe: WorkflowStepPolicy = { ...safe, safety: "non-idempotent" };

const rollback: WorkflowStepPolicy = { ...safe, rollback: true };

const retryable = new WorkflowStepFailure({
  kind: "retryable",
  message: "Provider temporarily unavailable",
  retryAfterMs: Option.none(),
});

const testSql = Layer.merge(
  SqliteClient.layer({ filename: ":memory:" }),
  recordingTwitchAnalyticsLayer,
);

const alarmLayer = Layer.succeed(WorkflowAlarm, { set: () => Effect.void });

const journalLayer = workflowJournalLayerWithoutDependencies.pipe(Layer.provide(alarmLayer));

const withJournal = <A, E, R>(effect: Effect.Effect<A, E, R | WorkflowJournal>) =>
  effect.pipe(Effect.provide(journalLayer, { local: true }));

describe("Workflow journal real SQLite checkpoint authority", () => {
  it.effect(
    "does not invent an unknown external outcome when watchdog scheduling fails before dispatch",
    () =>
      Effect.gen(function* () {
        const failing = yield* Ref.make(false);
        const calls = yield* Ref.make(0);

        const alarm = Layer.succeed(WorkflowAlarm, {
          set: () =>
            Ref.get(failing).pipe(
              Effect.flatMap((fail) =>
                fail
                  ? Effect.fail(new WorkflowAlarmError({ message: "Watchdog unavailable" }))
                  : Effect.void,
              ),
            ),
        });

        const use = <A, E, R>(effect: Effect.Effect<A, E, R | WorkflowJournal>) =>
          effect.pipe(
            Effect.provide(workflowJournalLayerWithoutDependencies.pipe(Layer.provide(alarm)), {
              local: true,
            }),
          );

        yield* use(
          Effect.gen(function* () {
            const journal = yield* WorkflowJournal;
            yield* journal.initialize(input);
            yield* Ref.set(failing, true);
            expect(
              yield* journal
                .checkpoint(
                  "send",
                  Schema.Null,
                  Ref.update(calls, (n) => n + 1).pipe(Effect.as(null)),
                  unsafe,
                )
                .pipe(Effect.result),
            ).toMatchObject({ failure: { reason: "schedule" } });
          }),
        );
        expect(yield* Ref.get(calls)).toBe(0);
        yield* Ref.set(failing, false);
        yield* use(
          Effect.gen(function* () {
            const journal = yield* WorkflowJournal;
            yield* journal.checkpoint(
              "send",
              Schema.Null,
              Ref.update(calls, (n) => n + 1).pipe(Effect.as(null)),
              unsafe,
            );
          }),
        );
        expect(yield* Ref.get(calls)).toBe(1);
      }).pipe(Effect.provide(testSql)),
  );

  it.effect("reconstructs a journal and replays successful results without repeating effects", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);

      const execute = Effect.gen(function* () {
        const journal = yield* WorkflowJournal;
        yield* journal.initialize(input);

        return yield* journal.checkpoint(
          "lookup",
          Schema.Number,
          Ref.update(calls, (n) => n + 1).pipe(Effect.as(42)),
          safe,
        );
      });

      expect(yield* withJournal(execute)).toBe(42);
      expect(yield* withJournal(execute)).toBe(42);
      expect(yield* Ref.get(calls)).toBe(1);
    }).pipe(Effect.provide(testSql)),
  );

  it.effect(
    "rejects changed canonical input on duplicate identity without changing original input",
    () =>
      Effect.gen(function* () {
        const journal = yield* WorkflowJournal;
        yield* journal.initialize(input);

        if (input._tag !== "RaidShoutout") return;
        expect(
          yield* journal
            .initialize({ ...input, raid: { ...input.raid, viewers: 99 } })
            .pipe(Effect.result),
        ).toMatchObject({ failure: { reason: "conflict" } });
        expect(yield* journal.getInput()).toEqual(Option.some(input));
      }).pipe(withJournal, Effect.provide(testSql)),
  );

  it.effect("cached result or undo corruption never reexecutes or compensates", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const calls = yield* Ref.make(0);
      yield* withJournal(
        Effect.gen(function* () {
          const journal = yield* WorkflowJournal;
          yield* journal.initialize(input);
          yield* journal.checkpoint(
            "reserve",
            Schema.String,
            Effect.succeed("reservation"),
            rollback,
          );
        }),
      );
      yield* sql`UPDATE saga_steps SET result_json='42' WHERE step_name='reserve'`;

      const replay = Effect.gen(function* () {
        const journal = yield* WorkflowJournal;

        return yield* journal
          .checkpoint(
            "reserve",
            Schema.String,
            Ref.update(calls, (n) => n + 1).pipe(Effect.as("new")),
            rollback,
          )
          .pipe(Effect.result);
      });

      expect(yield* withJournal(replay)).toMatchObject({ failure: { reason: "corrupt" } });
      yield* sql`UPDATE saga_steps SET result_json='"reservation"',undo_json='42' WHERE step_name='reserve'`;
      expect(yield* withJournal(replay)).toMatchObject({ failure: { reason: "corrupt" } });
      expect(
        yield* withJournal(
          Effect.gen(function* () {
            const journal = yield* WorkflowJournal;

            return yield* journal
              .compensate(
                "reserve",
                Schema.String,
                () => Ref.update(calls, (n) => n + 1),
                "idempotent",
              )
              .pipe(Effect.result);
          }),
        ),
      ).toMatchObject({ failure: { reason: "corrupt" } });
      expect(yield* Ref.get(calls)).toBe(0);
    }).pipe(Effect.provide(testSql)),
  );

  it.effect(
    "persists retry evidence before failed alarm scheduling and honors provider retry delay on restart",
    () =>
      Effect.gen(function* () {
        const failAlarm = yield* Ref.make(false);

        const alarm = Layer.succeed(WorkflowAlarm, {
          set: () =>
            Ref.get(failAlarm).pipe(
              Effect.flatMap((fail) =>
                fail
                  ? Effect.fail(new WorkflowAlarmError({ message: "Alarm unavailable" }))
                  : Effect.void,
              ),
            ),
        });

        const use = <A, E, R>(effect: Effect.Effect<A, E, R | WorkflowJournal>) =>
          effect.pipe(
            Effect.provide(workflowJournalLayerWithoutDependencies.pipe(Layer.provide(alarm)), {
              local: true,
            }),
          );

        const calls = yield* Ref.make(0);
        yield* use(
          Effect.gen(function* () {
            const journal = yield* WorkflowJournal;
            yield* journal.initialize(input);

            const result = yield* journal
              .checkpoint(
                "lookup",
                Schema.Null,
                Ref.update(calls, (n) => n + 1).pipe(
                  Effect.andThen(Ref.set(failAlarm, true)),
                  Effect.andThen(
                    Effect.fail(
                      new WorkflowStepFailure({
                        kind: "retryable",
                        message: "Provider temporarily unavailable",
                        retryAfterMs: Option.some(10_000),
                      }),
                    ),
                  ),
                ),
                safe,
              )
              .pipe(Effect.result);

            expect(result).toMatchObject({ failure: { reason: "schedule" } });
          }),
        );
        yield* Ref.set(failAlarm, false);

        const resume = Effect.gen(function* () {
          const journal = yield* WorkflowJournal;

          return yield* journal
            .checkpoint(
              "lookup",
              Schema.Null,
              Ref.update(calls, (n) => n + 1).pipe(Effect.as(null)),
              safe,
            )
            .pipe(Effect.result);
        });

        expect(yield* use(resume)).toMatchObject({ failure: { reason: "retry" } });
        yield* TestClock.adjust("10 seconds");
        expect(yield* use(resume)).toMatchObject({ success: null });
        expect(yield* Ref.get(calls)).toBe(2);
      }).pipe(Effect.provide(testSql)),
  );

  it.effect("bounds total retries across restarts and never reopens exhausted work", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);

      const attempt = Effect.gen(function* () {
        const journal = yield* WorkflowJournal;
        yield* journal.initialize(input);

        return yield* journal
          .checkpoint(
            "lookup",
            Schema.Null,
            Ref.update(calls, (n) => n + 1).pipe(Effect.andThen(Effect.fail(retryable))),
            safe,
          )
          .pipe(Effect.result);
      });

      expect(yield* withJournal(attempt)).toMatchObject({ failure: { reason: "retry" } });
      yield* TestClock.adjust("2 seconds");
      expect(yield* withJournal(attempt)).toMatchObject({ failure: { reason: "retry" } });
      yield* TestClock.adjust("4 seconds");
      expect(yield* withJournal(attempt)).toMatchObject({ failure: { reason: "failed" } });
      yield* TestClock.adjust("1 hour");
      expect(yield* withJournal(attempt)).toMatchObject({ failure: { reason: "failed" } });
      expect(yield* Ref.get(calls)).toBe(3);
    }).pipe(Effect.provide(testSql)),
  );

  it.effect("never repeats a non-idempotent effect after its local success commit failed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const calls = yield* Ref.make(0);
      yield* withJournal(
        Effect.gen(function* () {
          const journal = yield* WorkflowJournal;
          yield* journal.initialize(input);
          yield* sql`CREATE TRIGGER fail_success BEFORE UPDATE ON saga_steps WHEN NEW.state='SUCCEEDED' BEGIN SELECT RAISE(FAIL,'disk failure'); END`;
          expect(
            yield* journal
              .checkpoint(
                "spotify-add",
                Schema.Null,
                Ref.update(calls, (n) => n + 1).pipe(Effect.as(null)),
                unsafe,
              )
              .pipe(Effect.result),
          ).toMatchObject({ failure: { reason: "storage" } });
        }),
      );
      yield* sql`DROP TRIGGER fail_success`;
      expect(
        yield* withJournal(
          Effect.gen(function* () {
            const journal = yield* WorkflowJournal;

            return yield* journal
              .checkpoint(
                "spotify-add",
                Schema.Null,
                Ref.update(calls, (n) => n + 1).pipe(Effect.as(null)),
                unsafe,
              )
              .pipe(Effect.result);
          }),
        ),
      ).toMatchObject({ failure: { reason: "unknown" } });
      expect(yield* Ref.get(calls)).toBe(1);
    }).pipe(Effect.provide(testSql)),
  );

  it.effect("preserves external interruption as unknown after finalization without retry", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const finalized = yield* Ref.make(false);
      const calls = yield* Ref.make(0);

      yield* withJournal(
        Effect.gen(function* () {
          const journal = yield* WorkflowJournal;
          yield* journal.initialize(input);

          const fiber = yield* journal
            .checkpoint(
              "uncertain-send",
              Schema.Null,
              Ref.update(calls, (count) => count + 1).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Effect.never),
                Effect.ensuring(Ref.set(finalized, true)),
              ),
              unsafe,
            )
            .pipe(Effect.forkChild);

          yield* Deferred.await(started);
          yield* Fiber.interrupt(fiber);

          const interruptedExit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(interruptedExit)).toBe(true);

          if (Exit.isFailure(interruptedExit))
            expect(Cause.hasInterrupts(interruptedExit.cause)).toBe(true);
        }),
      );

      expect(yield* Ref.get(finalized)).toBe(true);
      expect(
        yield* withJournal(
          Effect.gen(function* () {
            const journal = yield* WorkflowJournal;

            return yield* journal
              .checkpoint(
                "uncertain-send",
                Schema.Null,
                Ref.update(calls, (count) => count + 1).pipe(Effect.as(null)),
                unsafe,
              )
              .pipe(Effect.result);
          }),
        ),
      ).toMatchObject({ failure: { reason: "unknown" } });
      expect(yield* Ref.get(calls)).toBe(1);
    }).pipe(Effect.provide(testSql)),
  );

  it.effect("fulfillment commits the point of no return atomically and forbids compensation", () =>
    Effect.gen(function* () {
      const journal = yield* WorkflowJournal;
      yield* journal.initialize(input);
      yield* journal.checkpoint("reserve", Schema.String, Effect.succeed("reservation"), rollback);
      yield* journal.checkpoint("fulfill-redemption", Schema.Null, Effect.succeed(null), safe);
      expect(yield* journal.getStatus()).toMatchObject({
        value: { fulfilledAt: { _tag: "Some" } },
      });
      expect(
        yield* journal
          .compensate("reserve", Schema.String, () => Effect.void, "idempotent")
          .pipe(Effect.result),
      ).toMatchObject({ failure: { reason: "conflict" } });
    }).pipe(withJournal, Effect.provide(testSql)),
  );

  it.effect(
    "resumes compensation from persisted undo without repeating completed compensation",
    () =>
      Effect.gen(function* () {
        const undone = yield* Ref.make<readonly string[]>([]);
        yield* withJournal(
          Effect.gen(function* () {
            const journal = yield* WorkflowJournal;
            yield* journal.initialize(input);
            yield* journal.checkpoint(
              "reserve",
              Schema.String,
              Effect.succeed("reservation"),
              rollback,
            );
            yield* journal.transition("COMPENSATING", Option.some("fulfillment rejected"));
            expect(
              yield* journal
                .compensate("reserve", Schema.String, () => Effect.fail(retryable), "idempotent")
                .pipe(Effect.result),
            ).toMatchObject({ failure: { reason: "retry" } });
          }),
        );
        yield* TestClock.adjust("2 seconds");

        const compensate = Effect.gen(function* () {
          const journal = yield* WorkflowJournal;
          yield* journal.compensate(
            "reserve",
            Schema.String,
            (undo) => Ref.update(undone, (values) => [...values, undo]),
            "idempotent",
          );
        });

        yield* withJournal(compensate);
        yield* withJournal(compensate);
        expect(yield* Ref.get(undone)).toEqual(["reservation"]);
      }).pipe(Effect.provide(testSql)),
  );

  it.effect("blocks unversioned historical runs without erasing checkpoint data", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* withJournal(
        Effect.gen(function* () {
          const journal = yield* WorkflowJournal;
          yield* journal.initialize(input);
          yield* journal.checkpoint("old-checkpoint", Schema.String, Effect.succeed("kept"), safe);
        }),
      );
      yield* sql`DELETE FROM workflow_format`;
      expect(
        yield* withJournal(
          Effect.gen(function* () {
            const journal = yield* WorkflowJournal;

            return yield* journal.getInput().pipe(Effect.result);
          }),
        ),
      ).toMatchObject({ failure: { operation: "legacy-state-gate" } });
      expect(
        yield* Schema.decodeUnknownEffect(
          Schema.Array(Schema.Struct({ result_json: Schema.String })),
        )(yield* sql`SELECT result_json FROM saga_steps`),
      ).toEqual([{ result_json: '"kept"' }]);
    }).pipe(Effect.provide(testSql)),
  );
});
