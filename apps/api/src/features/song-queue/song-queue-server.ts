import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "@alchemy.run/cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { SpotifyService, spotifyServiceLayer } from "../providers/spotify-service.ts";
import { SongQueueCoordinator, songQueueCoordinatorLayer } from "./song-queue-coordinator.ts";
import { SongQueueHttpApi } from "./song-queue-http-api.ts";
import { songQueueHttpHandlersLayer } from "./song-queue-http-handlers.ts";

interface SongQueueServerContract {
  readonly fetch: HttpEffect;
  readonly alarm: () => Effect.Effect<void>;
}

/** Durable Object namespace for the physical `SongQueueDO` class, retained without adopting production resources. */
export class SongQueueServer extends Cloudflare.DurableObject<
  SongQueueServer,
  SongQueueServerContract
>()("SongQueueDO") {}

/** Object key of the singleton song queue Durable Object, stable across the HTTP client/server migration. */
export const songQueueSingletonKey = "song-queue";

/**
 * Layer that hosts `SongQueueDO`, capturing Spotify during outer initialization and SQL at runtime.
 *
 * **Details**
 *
 * Runtime initialization migrates storage, restores polling deadlines, and installs the alarm
 * before serving the song queue HTTP API.
 *
 * @throws {MigrationError | SqlError | SongQueueError} As a defect when runtime initialization
 *   cannot migrate storage or restore polling, and from the alarm handler when alarm work fails so
 *   the platform retries the alarm.
 */
export const songQueueServerLayerWithoutDependencies = SongQueueServer.make(
  Effect.gen(function* () {
    const spotify = yield* SpotifyService;
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      const applicationLayer = songQueueCoordinatorLayer.pipe(
        Layer.provide([
          SqliteClient.layer({ storage: state.raw.storage }),
          Layer.succeed(SpotifyService, spotify),
          Layer.succeed(Cloudflare.DurableObjectState, state),
        ]),
      );

      return yield* Effect.gen(function* () {
        const coordinator = yield* SongQueueCoordinator;
        yield* coordinator.startPolling();

        const httpLayer = HttpApiBuilder.layer(SongQueueHttpApi).pipe(
          Layer.provide(songQueueHttpHandlersLayer),
          Layer.provide(cloudflareHttpServerLayer),
        );

        const fetch = yield* HttpRouter.toHttpEffect(httpLayer);

        return { fetch, alarm: () => coordinator.runAlarm().pipe(Effect.orDie) };
      }).pipe(Effect.provide(applicationLayer));
    }).pipe(Effect.orDie);
  }),
);

/** Layer that hosts `SongQueueDO` with the production Spotify provider, leaving configuration visible. */
const songQueueServerLayer = songQueueServerLayerWithoutDependencies.pipe(
  Layer.provide(spotifyServiceLayer),
);

/** Default export: the production `SongQueueDO` server Layer, discovered by Alchemy. */
export default songQueueServerLayer;
