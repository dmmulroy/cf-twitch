import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { ProviderTokenHttpApi } from "./provider-token-http-api.ts";
import { ProviderTokenLifecycle } from "./provider-token-lifecycle.ts";

/** Layer that implements the provider token HTTP handlers over the token lifecycle; provider identity comes from the server, never from an untrusted payload. */
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
