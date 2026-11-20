import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "@alchemy.run/cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Effect, Layer } from "effect";
import { SecureRandom } from "effect/crypto";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
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
  { transferredFrom: "CfTwitchApi" },
) {}

/** Captures outer SecureRandom while keeping SQL acquisition inside the Durable Object runtime phase. */
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

export default raffleServerLayer;
