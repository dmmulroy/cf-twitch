import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "@alchemy.run/cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Effect, Layer } from "effect";
import { SecureRandom } from "effect/crypto";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { raffleLayer } from "./raffle-service.ts";
import { raffleHttpHandlersLayer } from "./raffle-http-handlers.ts";
import { RaffleHttpApi } from "./raffle-http-api.ts";

/** Handlers the `KeyboardRaffleDO` Durable Object exposes to the Worker runtime. */
interface RaffleServerContract {
  /**
   * Serves the versioned raffle HTTP contract.
   *
   * @throws Dies when the raffle authority cannot be built, for example when migrations fail.
   */
  readonly fetch: HttpEffect;
}

/**
 * Durable Object class that hosts the Keyboard Raffle authority under its physical name `KeyboardRaffleDO`.
 *
 * **Details**
 *
 * The physical class name is retained for identity; namespace adoption is never automatic.
 */
export class RaffleServer extends Cloudflare.DurableObject<RaffleServer, RaffleServerContract>()(
  "KeyboardRaffleDO",
) {}

/**
 * Layer that registers the `KeyboardRaffleDO` server and builds its runtime handlers.
 *
 * **Details**
 *
 * Outer initialization only captures the platform `SecureRandom`. SQL acquisition, migrations, and the
 * raffle authority are built inside the Durable Object runtime phase, where any failure is a defect.
 */
export const raffleServerLayer = RaffleServer.make<
  Cloudflare.DurableObjectState | SecureRandom.SecureRandom
>(
  Effect.gen(function* () {
    const secureRandom = yield* SecureRandom.SecureRandom;
    const state = yield* Cloudflare.DurableObjectState;

    const database = raffleLayer.pipe(
      Layer.provide(SqliteClient.layer({ storage: state.raw.storage })),
      Layer.provide(Layer.succeed(SecureRandom.SecureRandom, secureRandom)),
    );

    const handlers = raffleHttpHandlersLayer.pipe(Layer.provide(database));

    return Effect.gen(function* () {
      const fetch = yield* HttpRouter.toHttpEffect(
        HttpApiBuilder.layer(RaffleHttpApi).pipe(
          Layer.provide(handlers),
          Layer.provide(cloudflareHttpServerLayer),
        ),
      );

      return { fetch };
    }).pipe(Effect.orDie);
  }),
);
