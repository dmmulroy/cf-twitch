import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "@alchemy.run/cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { DateTime, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { TwitchAnalytics, twitchAnalyticsLayer } from "../../runtime/twitch-analytics.ts";
import { TwitchService, twitchServiceLayer } from "../providers/twitch-service.ts";
import { Achievements, achievementsLayer } from "./achievements-service.ts";
import { AchievementOutbox, achievementOutboxLayer } from "./achievement-outbox.ts";
import { achievementsHttpHandlersLayer } from "./achievements-http-handlers.ts";
import { AchievementsHttpApi } from "./achievements-http-api.ts";

/** Handlers the `AchievementsDO` Durable Object exposes to the Worker runtime. */
interface AchievementsServerContract {
  /**
   * Serves the versioned achievements HTTP contract after scheduling an outbox wake-up.
   *
   * @throws Dies when the outbox wake-up alarm cannot be read or scheduled.
   */
  readonly fetch: HttpEffect;
  /**
   * Flushes pending unlock deliveries when any remain.
   *
   * @throws Dies with any storage, scheduling, or outbox failure, so Cloudflare retries the alarm.
   */
  readonly alarm: () => Effect.Effect<void>;
}

/**
 * Durable Object class that hosts the achievement authority under its physical name `AchievementsDO`.
 *
 * **Details**
 *
 * The physical class name and the `achievements` singleton key are retained without namespace transfer.
 */
export class AchievementsServer extends Cloudflare.DurableObject<
  AchievementsServer,
  AchievementsServerContract
>()("AchievementsDO") {}

/**
 * Layer that registers the `AchievementsDO` server while leaving Twitch and analytics required.
 *
 * **Details**
 *
 * Outer initialization only captures `TwitchService` and `TwitchAnalytics`. SQL acquisition,
 * migrations, outbox recovery, and alarms run in the Durable Object runtime phase, where storage or
 * alarm-scheduling failures are defects.
 */
export const achievementsServerLayerWithoutDependencies = AchievementsServer.make<
  Cloudflare.DurableObjectState | TwitchService | TwitchAnalytics
>(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const twitch = yield* TwitchService;
    const analytics = yield* TwitchAnalytics;

    // The outbox and handlers share one memoized SQL authority from `achievementsLayer`.
    const services = Layer.mergeAll(achievementOutboxLayer, achievementsLayer).pipe(
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

/** Production Layer that registers the `AchievementsDO` server with Twitch and analytics infrastructure selected. */
export const achievementsServerLayer = achievementsServerLayerWithoutDependencies.pipe(
  Layer.provide([twitchServiceLayer, twitchAnalyticsLayer]),
  Layer.orDie,
);
