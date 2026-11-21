import { Effect } from "effect";

import { OAuthScenarioWorker, oauthScenarioWorkerLayer } from "./oauth-scenario-worker.ts";

/**
 * Scenario stack that composes the real Worker → HTTP client → native-storage OAuth Durable Object graph.
 *
 * @returns The local Worker URL; construction failures surface from the scenario Worker Layer.
 */
export const oauthScenarioStack = Effect.gen(function* () {
  const worker = yield* OAuthScenarioWorker;

  return { url: worker.url };
}).pipe(Effect.provide(oauthScenarioWorkerLayer));
