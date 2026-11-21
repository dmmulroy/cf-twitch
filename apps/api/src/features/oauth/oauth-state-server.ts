import * as Cloudflare from "@alchemy.run/cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { OAuthStateHttpApi } from "./oauth-state-http-api.ts";
import { oauthStateHttpHandlersLayer } from "./oauth-state-http-handlers.ts";
import { OAuthStateStore, oauthStateStoreLayer } from "./oauth-state-store.ts";

type OAuthStateServerContract = {
  readonly fetch: HttpEffect;
  readonly alarm: () => Effect.Effect<void>;
};

/** Durable Object namespace of OAuth state, preserving the historical `OAuthStateDO` class and state-derived object names. */
export class OAuthStateServer extends Cloudflare.DurableObject<
  OAuthStateServer,
  OAuthStateServerContract
>()("OAuthStateDO") {}

/**
 * Layer that registers the OAuth state server; native storage is accessed only inside the returned runtime Effect.
 *
 * @throws Dies when the expiry alarm cannot read or update native storage, so the Workers runtime records the alarm as failed.
 */
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
        oauthStateStoreLayer.pipe(
          Layer.provide(Layer.succeed(Cloudflare.DurableObjectState, state)),
        ),
      ),
      Effect.orDie,
    );
  }),
);

/** Default export of the OAuth state server registration Layer for the Worker composition root. */
export default oauthStateServerLayer;
