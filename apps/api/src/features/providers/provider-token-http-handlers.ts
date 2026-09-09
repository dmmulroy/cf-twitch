import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ProviderTokenHttpApi } from "./provider-token-http-api.ts";
import { ProviderTokenLifecycle } from "./provider-token-lifecycle.ts";

/** Token HTTP handlers select provider identity from their server, never from an untrusted payload. */
export const providerTokenHttpHandlersLayer = HttpApiBuilder.group(
  ProviderTokenHttpApi,
  "token",
  (handlers) =>
    Effect.gen(function* () {
      const lifecycle = yield* ProviderTokenLifecycle;

      return handlers
        .handle("getValidToken", () => lifecycle.getValidToken())
        .handle("setTokens", ({ payload }) => lifecycle.setTokens(payload))
        .handle("onStreamOnline", () => lifecycle.onStreamOnline())
        .handle("onStreamOffline", () => lifecycle.onStreamOffline());
    }),
);
