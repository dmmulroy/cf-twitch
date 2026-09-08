import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { SpotifyService, spotifyServiceLayer } from "../providers/spotify-service.ts";
import { songQueueAlarmLayer } from "./song-queue-alarm.ts";
import { songQueueDatabaseLayerWithoutDependencies } from "./song-queue-database.ts";
import { SongQueueHttpApi } from "./song-queue-http-api.ts";
import { songQueueHttpHandlersLayer } from "./song-queue-http-handlers.ts";
import { SongQueueCoordinator, songQueueLayerWithoutDependencies } from "./song-queue-service.ts";

interface SongQueueServerContract {
  readonly fetch: HttpEffect;
  readonly alarm: () => Effect.Effect<void>;
}

/** Song queue physical namespace identity is retained without automatically adopting production resources. */
export class SongQueueServer extends Cloudflare.DurableObject<
  SongQueueServer,
  SongQueueServerContract
>()("SongQueueDO") {}

/** Singleton song queue key is stable across HTTP client/server migration. */
export const songQueueSingletonKey = "song-queue";

/** Song queue server captures provider bindings during planning, acquiring SQL only at runtime. */
export const songQueueServerLayerWithoutDependencies = SongQueueServer.make(
  Effect.gen(function* () {
    const spotify = yield* SpotifyService;
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const databaseLayer = songQueueDatabaseLayerWithoutDependencies.pipe(
        Layer.provide(SqliteClient.layer({ storage: state.raw.storage })),
      );
      const applicationLayer = songQueueLayerWithoutDependencies.pipe(
        Layer.provide([
          databaseLayer,
          Layer.succeed(SpotifyService, spotify),
          songQueueAlarmLayer.pipe(
            Layer.provide(Layer.succeed(Cloudflare.DurableObjectState, state)),
          ),
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

/** Ready song queue server selects the durable Spotify provider while preserving root configuration needs. */
const songQueueServerLayer = songQueueServerLayerWithoutDependencies.pipe(
  Layer.provide(spotifyServiceLayer),
);
export default songQueueServerLayer;
