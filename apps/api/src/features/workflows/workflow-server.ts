import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Crypto, Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { WorkflowError, type WorkflowInput } from "@cf-twitch/contracts/workflow";
import { TwitchAnalytics } from "../../runtime/twitch-analytics.ts";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { EventPublisher } from "../events/event-publisher.ts";
import { eventPublisherLayer } from "../events/event-bus-client.ts";
import { Raffle } from "../raffle/raffle-service.ts";
import { raffleClientLayer } from "../raffle/raffle-client.ts";
import { SongQueue } from "../song-queue/song-queue.ts";
import { songQueueClientLayer } from "../song-queue/song-queue-client.ts";
import { SpotifyService, spotifyServiceLayer } from "../providers/spotify-service.ts";
import { TwitchService, twitchServiceLayer } from "../providers/twitch-service.ts";
import { workflowAlarmLayer } from "./workflow-alarm.ts";
import { WorkflowJournal, workflowJournalLayerWithoutDependencies } from "./workflow-journal.ts";
import {
  WorkflowExecution,
  workflowExecutionLayerWithoutDependencies,
} from "./workflow-execution.ts";
import { WorkflowHttpApi } from "./workflow-http-api.ts";
import { workflowHttpHandlersLayer } from "./workflow-http-handlers.ts";

interface WorkflowServerContract {
  readonly fetch: HttpEffect;
  readonly alarm: () => Effect.Effect<void>;
}

/** Song request namespace preserves the physical class and redemption-name identity. */
export class SongRequestSagaServer extends Cloudflare.DurableObject<
  SongRequestSagaServer,
  WorkflowServerContract
>()("SongRequestSagaDO") {}

/** Keyboard raffle namespace preserves the physical class and redemption-name identity. */
export class KeyboardRaffleSagaServer extends Cloudflare.DurableObject<
  KeyboardRaffleSagaServer,
  WorkflowServerContract
>()("KeyboardRaffleSagaDO") {}

/** Raid shoutout namespace preserves the physical class and EventSub-message-name identity. */
export class RaidShoutoutSagaServer extends Cloudflare.DurableObject<
  RaidShoutoutSagaServer,
  WorkflowServerContract
>()("RaidShoutoutSagaDO") {}

const makeWorkflowServerRuntime = (kind: WorkflowInput["_tag"]) =>
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const spotify = yield* SpotifyService;
    const twitch = yield* TwitchService;
    const queue = yield* SongQueue;
    const raffle = yield* Raffle;
    const publisher = yield* EventPublisher;
    const crypto = yield* Crypto.Crypto;
    const analytics = yield* TwitchAnalytics;

    // Only stable capabilities are captured during planning. SQL, migration and alarm acquisition are runtime-only.
    return Effect.gen(function* () {
      const sqlLayer = SqliteClient.layer({ storage: state.raw.storage });

      const journalLayer = workflowJournalLayerWithoutDependencies.pipe(
        Layer.provide([sqlLayer, workflowAlarmLayer, Layer.succeed(TwitchAnalytics, analytics)]),
      );

      const executionLayer = workflowExecutionLayerWithoutDependencies.pipe(
        Layer.provide([
          journalLayer,
          Layer.succeed(SpotifyService, spotify),
          Layer.succeed(TwitchService, twitch),
          Layer.succeed(SongQueue, queue),
          Layer.succeed(Raffle, raffle),
          Layer.succeed(EventPublisher, publisher),
          Layer.succeed(Crypto.Crypto, crypto),
          Layer.succeed(TwitchAnalytics, analytics),
        ]),
      );

      return yield* Effect.gen(function* () {
        const journal = yield* WorkflowJournal;
        const execution = yield* WorkflowExecution;
        yield* journal.restoreAlarm();

        const restrictedExecution = WorkflowExecution.of({
          ...execution,
          start: (input) =>
            input._tag === kind
              ? execution.start(input)
              : Effect.fail(
                  new WorkflowError({
                    operation: "start",
                    reason: "conflict",
                  }),
                ),
        });

        const httpLayer = HttpApiBuilder.layer(WorkflowHttpApi).pipe(
          Layer.provide(
            workflowHttpHandlersLayer.pipe(
              Layer.provide(Layer.succeed(WorkflowExecution, restrictedExecution)),
            ),
          ),
          Layer.provide(cloudflareHttpServerLayer),
        );

        const fetch = yield* HttpRouter.toHttpEffect(httpLayer);

        return { fetch, alarm: () => execution.resume().pipe(Effect.orDie) };
      }).pipe(Effect.provide(Layer.merge(executionLayer, journalLayer)));
    }).pipe(Effect.orDie);
  });

/** Real song HTTP/SQL server with provider and durable dependency selection left visible. */
export const songRequestSagaServerLayerWithoutDependencies = SongRequestSagaServer.make(
  makeWorkflowServerRuntime("SongRequest"),
);

/** Real raffle HTTP/SQL server with provider and durable dependency selection left visible. */
export const keyboardRaffleSagaServerLayerWithoutDependencies = KeyboardRaffleSagaServer.make(
  makeWorkflowServerRuntime("KeyboardRaffle"),
);

/** Real raid HTTP/SQL server with provider and durable dependency selection left visible. */
export const raidShoutoutSagaServerLayerWithoutDependencies = RaidShoutoutSagaServer.make(
  makeWorkflowServerRuntime("RaidShoutout"),
);

const workflowDependenciesLayer = Layer.mergeAll(
  spotifyServiceLayer,
  twitchServiceLayer,
  songQueueClientLayer,
  raffleClientLayer,
  eventPublisherLayer,
);

/** Production song workflow server selects real providers and durable dependency clients. */
export const songRequestSagaServerLayer = songRequestSagaServerLayerWithoutDependencies.pipe(
  Layer.provide(workflowDependenciesLayer),
);

/** Production raffle workflow server selects real providers and durable dependency clients. */
export const keyboardRaffleSagaServerLayer = keyboardRaffleSagaServerLayerWithoutDependencies.pipe(
  Layer.provide(workflowDependenciesLayer),
);

/** Production raid workflow server selects real providers and durable dependency clients. */
export const raidShoutoutSagaServerLayer = raidShoutoutSagaServerLayerWithoutDependencies.pipe(
  Layer.provide(workflowDependenciesLayer),
);

/** All workflow namespaces are composed explicitly; no existing namespace is auto-transferred. */
const workflowServersLayer = Layer.mergeAll(
  songRequestSagaServerLayer,
  keyboardRaffleSagaServerLayer,
  raidShoutoutSagaServerLayer,
);

export default workflowServersLayer;
