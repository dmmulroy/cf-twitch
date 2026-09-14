import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { OAuthStateHttpApi } from "./oauth-state-http-api.ts";
import { OAuthStateStore } from "./oauth-state-store.ts";

/** OAuth handlers delegate one-use validation to the storage transaction. */
export const oauthStateHttpHandlersLayer = HttpApiBuilder.group(
  OAuthStateHttpApi,
  "oauthState",
  (handlers) =>
    Effect.gen(function* () {
      const store = yield* OAuthStateStore;

      return handlers
        .handle("createAttempt", ({ payload }) => store.createAttempt(payload))
        .handle("consumeAttempt", ({ payload }) => store.consumeAttempt(payload));
    }),
);
