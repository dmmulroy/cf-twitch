import * as Cloudflare from "@alchemy.run/cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Cache, Clock, Context, Effect, Equal, HashMap, Layer, Option, Ref } from "effect";
import { HttpClientError } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import type { SchemaError } from "effect/Schema";
import {
  type EventSubMessageId,
  IsoTimestamp,
  type RedemptionId,
} from "@cf-twitch/contracts/identity";
import type { ChannelPointRedemption } from "@cf-twitch/contracts/redemption";
import {
  type RaidShoutoutInput,
  WorkflowError,
  type WorkflowId,
  WorkflowInput,
  WorkflowLookup,
  type WorkflowOperation,
  type WorkflowRunStatus,
  workflowIdOfInput,
  workflowIdOfLookup,
} from "@cf-twitch/contracts/workflow";
import { WorkflowHttpApi } from "./workflow-http-api.ts";
import workflowServersLayer, {
  KeyboardRaffleSagaServer,
  RaidShoutoutSagaServer,
  SongRequestSagaServer,
} from "./workflow-server.ts";

// One run recorded by `workflowStartersTestLayer`.
interface InMemoryWorkflowRun {
  readonly input: WorkflowInput;
  readonly status: WorkflowRunStatus;
}

/**
 * Translates workflow HTTP client failures into `WorkflowError` for the identified workflow.
 *
 * @returns The effect, failing with `WorkflowError` reason `transport` or `invalid_response` instead of `HttpClientError` or `SchemaError`.
 */
const catchWorkflowClientErrors =
  (operation: WorkflowOperation, workflowId: WorkflowId) =>
  <A, R>(
    effect: Effect.Effect<A, WorkflowError | HttpClientError.HttpClientError | SchemaError, R>,
  ): Effect.Effect<A, WorkflowError, R> =>
    effect.pipe(
      Effect.catchTags({
        HttpClientError: () =>
          Effect.fail(
            new WorkflowError({
              operation,
              reason: "transport",
              workflowId: Option.some(workflowId),
              stepName: Option.none(),
            }),
          ),
        SchemaError: () =>
          Effect.fail(
            new WorkflowError({
              operation,
              reason: "invalid_response",
              workflowId: Option.some(workflowId),
              stepName: Option.none(),
            }),
          ),
      }),
    );

/** Workflow start and status by deterministic identity; starting the same input again resumes the existing run. */
export interface IWorkflowStarters {
  /**
   * Starts or resumes the Song Request workflow identified by the redemption ID.
   *
   * @returns Nothing once the run is durably accepted, or fails with `WorkflowError` reason `conflict` when the redemption ID was started with different input, `transport`/`invalid_response` when the workflow object is unreachable or unreadable, and journal reasons from the workflow object.
   */
  readonly startSongRequest: (
    redemption: ChannelPointRedemption,
  ) => Effect.Effect<void, WorkflowError>;
  /**
   * Starts or resumes the Keyboard Raffle workflow identified by the redemption ID.
   *
   * @returns Nothing once the run is durably accepted, or fails with `WorkflowError` as for `startSongRequest`.
   */
  readonly startKeyboardRaffle: (
    redemption: ChannelPointRedemption,
  ) => Effect.Effect<void, WorkflowError>;
  /**
   * Starts or resumes the raid shoutout workflow identified by the EventSub message ID.
   *
   * @returns Nothing once the run is durably accepted, or fails with `WorkflowError` as for `startSongRequest`.
   */
  readonly startRaidShoutout: (raid: RaidShoutoutInput) => Effect.Effect<void, WorkflowError>;
  /**
   * Returns the status of the workflow selected by `input`, or `None` when it was never started.
   *
   * @returns The status, or fails with `WorkflowError` reason `transport`/`invalid_response` when the workflow object is unreachable or unreadable, and `storage`/`corrupt` from its journal.
   */
  readonly getStatus: (
    input: WorkflowLookup,
  ) => Effect.Effect<Option.Option<WorkflowRunStatus>, WorkflowError>;
}

/** Service tag for workflow start and status; implementations own namespace selection and never expose invocation-scoped stubs. */
export class WorkflowStarters extends Context.Service<WorkflowStarters, IWorkflowStarters>()(
  "@cf-twitch/WorkflowStarters",
) {}

/** Effect that builds execution-scoped HTTP clients for the three workflow namespaces; cache entries never retain an invocation stub globally. */
export const makeWorkflowStarters = Effect.gen(function* () {
  const song = yield* SongRequestSagaServer;
  const raffle = yield* KeyboardRaffleSagaServer;
  const raid = yield* RaidShoutoutSagaServer;

  const songClients = yield* makeExecutionMemo(
    Cache.make({
      capacity: Number.POSITIVE_INFINITY,
      lookup: (redemptionId: RedemptionId) =>
        Effect.suspend(() =>
          HttpApiClient.makeWith(WorkflowHttpApi, {
            baseUrl: "http://workflow.internal",
            httpClient: Cloudflare.toHttpClient(song.getByName(redemptionId)),
          }),
        ),
    }),
  );

  const raffleClients = yield* makeExecutionMemo(
    Cache.make({
      capacity: Number.POSITIVE_INFINITY,
      lookup: (redemptionId: RedemptionId) =>
        Effect.suspend(() =>
          HttpApiClient.makeWith(WorkflowHttpApi, {
            baseUrl: "http://workflow.internal",
            httpClient: Cloudflare.toHttpClient(raffle.getByName(redemptionId)),
          }),
        ),
    }),
  );

  const raidClients = yield* makeExecutionMemo(
    Cache.make({
      capacity: Number.POSITIVE_INFINITY,
      lookup: (messageId: EventSubMessageId) =>
        Effect.suspend(() =>
          HttpApiClient.makeWith(WorkflowHttpApi, {
            baseUrl: "http://workflow.internal",
            httpClient: Cloudflare.toHttpClient(raid.getByName(messageId)),
          }),
        ),
    }),
  );

  const songClientFor = (redemptionId: RedemptionId) =>
    songClients.pipe(Effect.flatMap((cache) => Cache.get(cache, redemptionId)));

  const raffleClientFor = (redemptionId: RedemptionId) =>
    raffleClients.pipe(Effect.flatMap((cache) => Cache.get(cache, redemptionId)));

  const raidClientFor = (messageId: EventSubMessageId) =>
    raidClients.pipe(Effect.flatMap((cache) => Cache.get(cache, messageId)));

  const start = Effect.fn("WorkflowStarters.start")((input: WorkflowInput) =>
    WorkflowInput.match(input, {
      SongRequest: (songRequest) =>
        songClientFor(songRequest.redemption.id).pipe(
          Effect.flatMap((client) => client.workflow.start({ payload: songRequest })),
        ),
      KeyboardRaffle: (keyboardRaffle) =>
        raffleClientFor(keyboardRaffle.redemption.id).pipe(
          Effect.flatMap((client) => client.workflow.start({ payload: keyboardRaffle })),
        ),
      RaidShoutout: (raidShoutout) =>
        raidClientFor(raidShoutout.raid.messageId).pipe(
          Effect.flatMap((client) => client.workflow.start({ payload: raidShoutout })),
        ),
    }).pipe(catchWorkflowClientErrors("start", workflowIdOfInput(input))),
  );

  const getStatus = Effect.fn("WorkflowStarters.getStatus")((input: WorkflowLookup) =>
    WorkflowLookup.match(input, {
      SongRequest: (songRequest) =>
        songClientFor(songRequest.redemptionId).pipe(
          Effect.flatMap((client) => client.workflow.getStatus()),
        ),
      KeyboardRaffle: (keyboardRaffle) =>
        raffleClientFor(keyboardRaffle.redemptionId).pipe(
          Effect.flatMap((client) => client.workflow.getStatus()),
        ),
      RaidShoutout: (raidShoutout) =>
        raidClientFor(raidShoutout.messageId).pipe(
          Effect.flatMap((client) => client.workflow.getStatus()),
        ),
    }).pipe(catchWorkflowClientErrors("get-status", workflowIdOfLookup(input))),
  );

  return WorkflowStarters.of({
    startSongRequest: Effect.fn("WorkflowStarters.startSongRequest")((redemption) =>
      start(WorkflowInput.cases.SongRequest.make({ redemption })),
    ),
    startKeyboardRaffle: Effect.fn("WorkflowStarters.startKeyboardRaffle")((redemption) =>
      start(WorkflowInput.cases.KeyboardRaffle.make({ redemption })),
    ),
    startRaidShoutout: Effect.fn("WorkflowStarters.startRaidShoutout")((raid) =>
      start(WorkflowInput.cases.RaidShoutout.make({ raid })),
    ),
    getStatus,
  });
});

/** Layer that provides workflow clients; requires the three workflow Durable Object namespaces. */
export const workflowStartersLayerWithoutDependencies = Layer.effect(
  WorkflowStarters,
  makeWorkflowStarters,
);

/** Production workflow clients, registering all three durable namespaces at the outer composition phase. */
export const workflowStartersLayer = workflowStartersLayerWithoutDependencies.pipe(
  Layer.provide(workflowServersLayer),
);

/**
 * Layer that provides in-memory workflow start and status, keyed by workflow kind and deterministic identity.
 *
 * **Details**
 *
 * Accepted runs stay `RUNNING`, because no workflow steps execute. Starting the same input again is accepted; a different input for the same identity fails with `WorkflowError` reason `conflict`, as the durable journal does.
 */
export const workflowStartersTestLayer = Layer.effect(
  WorkflowStarters,
  Effect.gen(function* () {
    const runs = yield* Ref.make(HashMap.empty<string, InMemoryWorkflowRun>());

    const start = Effect.fn("WorkflowStartersTest.start")(function* (input: WorkflowInput) {
      const workflowId = workflowIdOfInput(input);
      const key = `${input._tag}:${workflowId}`;
      const existing = HashMap.get(yield* Ref.get(runs), key);

      if (Option.isSome(existing)) {
        if (Equal.equals(existing.value.input, input)) return;

        return yield* new WorkflowError({
          operation: "initialize",
          reason: "conflict",
          workflowId: Option.some(workflowId),
          stepName: Option.none(),
        });
      }

      const now = IsoTimestamp.make(new Date(yield* Clock.currentTimeMillis).toISOString());

      const run: InMemoryWorkflowRun = {
        input,
        status: {
          sagaId: workflowId,
          status: "RUNNING",
          fulfilledAt: Option.none(),
          error: Option.none(),
          createdAt: now,
          updatedAt: now,
        },
      };

      yield* Ref.update(runs, (current) => HashMap.set(current, key, run));
    });

    return WorkflowStarters.of({
      startSongRequest: (redemption) => start(WorkflowInput.cases.SongRequest.make({ redemption })),
      startKeyboardRaffle: (redemption) =>
        start(WorkflowInput.cases.KeyboardRaffle.make({ redemption })),
      startRaidShoutout: (raid) => start(WorkflowInput.cases.RaidShoutout.make({ raid })),
      getStatus: (lookup) =>
        Ref.get(runs).pipe(
          Effect.map((current) =>
            Option.map(
              HashMap.get(current, `${lookup._tag}:${workflowIdOfLookup(lookup)}`),
              (run) => run.status,
            ),
          ),
        ),
    });
  }),
);
