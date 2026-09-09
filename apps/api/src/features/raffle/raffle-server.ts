import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { raffleLayer } from "./raffle-database.ts";
import { raffleHttpHandlersLayer } from "./raffle-http-handlers.ts";
import { RaffleHttpApi } from "./raffle-http-api.ts";

interface RaffleServerContract {
  readonly fetch: HttpEffect;
}

/** Physical KeyboardRaffleDO class is retained; namespace adoption is never automatic. */
export class RaffleServer extends Cloudflare.DurableObject<RaffleServer, RaffleServerContract>()(
  "KeyboardRaffleDO",
) {}

/** Runtime-only SQL acquisition preserves Alchemy's planning phase storage boundary. */
export const raffleServerLayer = RaffleServer.make<never>(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    const database = raffleLayer.pipe(
      Layer.provide(SqliteClient.layer({ storage: state.raw.storage })),
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

export default raffleServerLayer;
