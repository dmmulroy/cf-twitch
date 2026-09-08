import * as Cloudflare from "alchemy/Cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { makeExecutionMemo } from "alchemy/Runtime/ExecutionMemo";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";

import {
  OAuthStateClient,
  oauthStateClientLayerWithoutDependencies,
} from "../../src/features/oauth/oauth-state-client.ts";
import { OAuthStateHttpApi } from "../../src/features/oauth/oauth-state-http-api.ts";
import { oauthStateServerLayer } from "../../src/features/oauth/oauth-state-server.ts";
import { cloudflareHttpServerLayer } from "../../src/runtime/cloudflare-http-server.ts";

type OAuthScenarioWorkerContract = {
  readonly fetch: HttpEffect;
};

/** Minimal workerd Worker exposing the real OAuth state client and Durable Object over HTTP. */
export class OAuthScenarioWorker extends Cloudflare.Worker<
  OAuthScenarioWorker,
  OAuthScenarioWorkerContract
>()("CfTwitchOAuthScenarioWorker") {}

const oauthScenarioHttpHandlersLayer = HttpApiBuilder.group(
  OAuthStateHttpApi,
  "oauthState",
  (handlers) =>
    Effect.gen(function* () {
      const client = yield* OAuthStateClient;
      return handlers
        .handle("createAttempt", ({ payload }) => client.createAttempt(payload))
        .handle("consumeAttempt", ({ payload }) => client.consumeAttempt(payload));
    }),
);

/** Scenario Worker leaves its OAuth client graph visible to the test-stack composition root. */
export const oauthScenarioWorkerLayerWithoutDependencies = OAuthScenarioWorker.make(
  {
    main: import.meta.url,
    compatibility: { date: "2026-09-08", flags: ["nodejs_compat"] },
    dev: { host: "127.0.0.1", port: 8787, strictPort: true },
  },
  Effect.gen(function* () {
    const client = yield* OAuthStateClient;
    const httpLayer = HttpApiBuilder.layer(OAuthStateHttpApi).pipe(
      Layer.provide(
        oauthScenarioHttpHandlersLayer.pipe(Layer.provide(Layer.succeed(OAuthStateClient, client))),
      ),
      Layer.provide(cloudflareHttpServerLayer),
    );
    const runtimeRouter = yield* makeExecutionMemo(HttpRouter.toHttpEffect(httpLayer));
    return { fetch: Effect.flatten(runtimeRouter) };
  }).pipe(
    // Durable Object declarations require the surrounding Worker service during outer initialization.
    Effect.provide(
      oauthStateClientLayerWithoutDependencies.pipe(Layer.provide(oauthStateServerLayer)),
    ),
  ),
);

/** Real native-storage OAuth scenario graph; no production Worker or provider HTTP is reachable. */
export const oauthScenarioWorkerLayer = oauthScenarioWorkerLayerWithoutDependencies;

export default oauthScenarioWorkerLayer;
