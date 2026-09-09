import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { DateTime, Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { TwitchAnalytics, twitchAnalyticsLayer } from "../../runtime/twitch-analytics.ts";
import { TwitchService, twitchServiceLayer } from "../providers/twitch-service.ts";
import { Achievements } from "./achievements-service.ts";
import { achievementsLayer } from "./achievements-database.ts";
import {
  AchievementOutbox,
  achievementOutboxLayerWithoutDependencies,
} from "./achievement-outbox.ts";
import { achievementsHttpHandlersLayer } from "./achievements-http-handlers.ts";
import { AchievementsHttpApi } from "./achievements-http-api.ts";

interface AchievementsServerContract {
  readonly fetch: HttpEffect;
  readonly alarm: () => Effect.Effect<void>;
}

/** Physical AchievementsDO class and achievements singleton key are retained without namespace transfer. */
export class AchievementsServer extends Cloudflare.DurableObject<
  AchievementsServer,
  AchievementsServerContract
>()("AchievementsDO") {}

/** Captures infrastructure at init; SQL, migration, recovery and alarms execute only at runtime. */
export const achievementsServerLayerWithoutDependencies = AchievementsServer.make<
  TwitchService | TwitchAnalytics
>(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const twitch = yield* TwitchService;
    const analytics = yield* TwitchAnalytics;

    const services = achievementOutboxLayerWithoutDependencies.pipe(
      Layer.provideMerge(achievementsLayer),
      Layer.provide(SqliteClient.layer({ storage: state.raw.storage })),
      Layer.provide(Layer.succeed(TwitchService, twitch)),
      Layer.provide(Layer.succeed(TwitchAnalytics, analytics)),
    );

    return Effect.gen(function* () {
      const achievements = yield* Achievements;
      const outbox = yield* AchievementOutbox;

      const wake = Effect.fn("AchievementsServer.wakeOutbox")(function* () {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const alarm = yield* Effect.tryPromise(() => state.raw.storage.getAlarm());

        if (alarm === null || alarm > now + 1_000)
          yield* Effect.tryPromise(() => state.raw.storage.setAlarm(now + 1_000));
      });

      const handlers = achievementsHttpHandlersLayer.pipe(
        Layer.provide(Layer.succeed(Achievements, achievements)),
      );

      const http = yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(AchievementsHttpApi).pipe(
          Layer.provide(handlers),
          Layer.provide(cloudflareHttpServerLayer),
        ),
      );

      // Wake before committing any HTTP-triggered work, closing the commit-to-schedule crash gap.
      const fetch: HttpEffect = Effect.andThen(wake().pipe(Effect.orDie), http);

      if (yield* outbox.hasPending()) yield* wake();

      const alarm = Effect.fn("AchievementsServer.alarm")(function* () {
        // A durable successor is installed before provider I/O; process loss cannot strand an intent.
        const nextAlarm = DateTime.toEpochMillis(yield* DateTime.now) + 1_000;
        yield* Effect.tryPromise(() => state.raw.storage.setAlarm(nextAlarm));
        yield* outbox.flush();
        // Do not delete a concurrently scheduled alarm. An empty pass stops on the following invocation.
      }, Effect.orDie);

      return {
        fetch,
        alarm: Effect.fn("AchievementsServer.dispatchAlarm")(function* () {
          if (yield* outbox.hasPending()) yield* alarm();
        }, Effect.orDie),
      };
    }).pipe(Effect.provide(services), Effect.orDie);
  }),
);

/** Ready server registers Twitch and analytics infrastructure during outer initialization. */
export const achievementsServerLayer = achievementsServerLayerWithoutDependencies.pipe(
  Layer.provide([twitchServiceLayer, twitchAnalyticsLayer]),
  Layer.orDie,
);

export default achievementsServerLayer;
