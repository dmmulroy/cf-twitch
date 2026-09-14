import { Effect } from "effect";

import { OAuthScenarioWorker, oauthScenarioWorkerLayer } from "./oauth-scenario-worker.ts";

/** Compose the real Worker → HTTP client → native-storage OAuth Durable Object graph. */
export const oauthScenarioStack = Effect.gen(function* () {
  const worker = yield* OAuthScenarioWorker;

  return { url: worker.url };
}).pipe(Effect.provide(oauthScenarioWorkerLayer));
