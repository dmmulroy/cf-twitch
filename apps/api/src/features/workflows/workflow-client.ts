import * as Cloudflare from "alchemy/Cloudflare";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Cache, Effect, Layer } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import type { EventSubMessageId, RedemptionId } from "@cf-twitch/contracts/identity";
import {
  WorkflowError,
  type WorkflowInput,
  type WorkflowLookup,
} from "@cf-twitch/contracts/workflow";
import { WorkflowStarters } from "./workflow-starters.ts";
import { WorkflowHttpApi } from "./workflow-http-api.ts";
import workflowServersLayer, {
  KeyboardRaffleSagaServer,
  RaidShoutoutSagaServer,
  SongRequestSagaServer,
} from "./workflow-server.ts";

/** Construct execution-scoped HTTP clients; cache entries never retain an invocation stub globally. */
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
  const start = Effect.fn("WorkflowStarters.start")(
    function* (input: WorkflowInput) {
      switch (input._tag) {
        case "SongRequest": {
          const client = yield* songClientFor(input.redemption.id);
          return yield* client.workflow.start({ payload: input });
        }
        case "KeyboardRaffle": {
          const client = yield* raffleClientFor(input.redemption.id);
          return yield* client.workflow.start({ payload: input });
        }
        case "RaidShoutout": {
          const client = yield* raidClientFor(input.raid.messageId);
          return yield* client.workflow.start({ payload: input });
        }
      }
    },
    Effect.catchTags({
      HttpClientError: () =>
        Effect.fail(
          new WorkflowError({
            operation: "start",
            reason: "transport",
          }),
        ),
      SchemaError: () =>
        Effect.fail(
          new WorkflowError({
            operation: "start",
            reason: "invalid_response",
          }),
        ),
    }),
  );
  const getStatus = Effect.fn("WorkflowStarters.getStatus")(
    function* (input: WorkflowLookup) {
      switch (input._tag) {
        case "SongRequest": {
          const client = yield* songClientFor(input.redemptionId);
          return yield* client.workflow.getStatus();
        }
        case "KeyboardRaffle": {
          const client = yield* raffleClientFor(input.redemptionId);
          return yield* client.workflow.getStatus();
        }
        case "RaidShoutout": {
          const client = yield* raidClientFor(input.messageId);
          return yield* client.workflow.getStatus();
        }
      }
    },
    Effect.catchTags({
      HttpClientError: () =>
        Effect.fail(
          new WorkflowError({
            operation: "get-status",
            reason: "transport",
          }),
        ),
      SchemaError: () =>
        Effect.fail(
          new WorkflowError({
            operation: "get-status",
            reason: "invalid_response",
          }),
        ),
    }),
  );
  return WorkflowStarters.of({
    startSongRequest: Effect.fn("WorkflowStarters.startSongRequest")((redemption) =>
      start({ _tag: "SongRequest", redemption }),
    ),
    startKeyboardRaffle: Effect.fn("WorkflowStarters.startKeyboardRaffle")((redemption) =>
      start({ _tag: "KeyboardRaffle", redemption }),
    ),
    startRaidShoutout: Effect.fn("WorkflowStarters.startRaidShoutout")((raid) =>
      start({ _tag: "RaidShoutout", raid }),
    ),
    getStatus,
  });
});
/** Workflow clients retain namespace requirements for controlled HTTP tests. */
export const workflowStartersLayerWithoutDependencies = Layer.effect(
  WorkflowStarters,
  makeWorkflowStarters,
);
/** Ready workflow clients register all three durable namespaces at the outer composition phase. */
export const workflowStartersLayer = workflowStartersLayerWithoutDependencies.pipe(
  Layer.provide(workflowServersLayer),
);
