import * as Cloudflare from "@alchemy.run/cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { OAuthStateHttpApi } from "./oauth-state-http-api.ts";
import { oauthStateHttpHandlersLayer } from "./oauth-state-http-handlers.ts";
import { OAuthStateStore, oauthStateStoreLayerWithoutDependencies } from "./oauth-state-store.ts";

type OAuthStateServerContract = {
  readonly fetch: HttpEffect;
  readonly alarm: () => Effect.Effect<void>;
};

/** OAuth state namespace preserves the historical physical class and state-derived object identities. */
export class OAuthStateServer extends Cloudflare.DurableObject<
  OAuthStateServer,
  OAuthStateServerContract
>()("OAuthStateDO") {}

/** OAuth state server accesses native storage only inside the returned runtime Effect. */
export const oauthStateServerLayer = OAuthStateServer.make<Cloudflare.DurableObjectState>(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      const store = yield* OAuthStateStore;

      const httpLayer = HttpApiBuilder.layer(OAuthStateHttpApi).pipe(
        Layer.provide(
          oauthStateHttpHandlersLayer.pipe(Layer.provide(Layer.succeed(OAuthStateStore, store))),
        ),
        Layer.provide(cloudflareHttpServerLayer),
      );

      const fetch = yield* HttpRouter.toHttpEffect(httpLayer);

      return { fetch, alarm: () => store.expireAttempt().pipe(Effect.orDie) };
    }).pipe(
      Effect.provide(
        oauthStateStoreLayerWithoutDependencies.pipe(
          Layer.provide(Layer.succeed(Cloudflare.DurableObjectState, state)),
        ),
      ),
      Effect.orDie,
    );
  }),
);

export default oauthStateServerLayer;
