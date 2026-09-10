import { Redacted, Effect, Layer } from "effect";

import type { OAuthProvider } from "@cf-twitch/contracts/provider";
import { providerScenarioTransportLayer } from "../../src/features/providers/provider-scenario-transport.test-support.ts";
import { ProviderAccessTokens } from "../../src/features/providers/provider-access-tokens.ts";
import { providerTokenExchangeLayerWithoutDependencies } from "../../src/features/providers/provider-token-exchange.ts";
import { twitchServiceLayerWithoutDependencies } from "../../src/features/providers/twitch-service.ts";
import { TwitchConfiguration } from "../../src/runtime/twitch-configuration.ts";
import { httpTestConfiguration } from "../../src/features/http/http-test-fixtures.ts";

/** Provider modes understood by the closed controlled HTTP transport. */
export type ControlledTwitchProviderMode =
  | "normal"
  | "rate-limited"
  | "unknown"
  | "unauthorized"
  | "malformed-chat"
  | "dropped-chat";

/**
 * Build the complete production Twitch HTTP service over a transport that cannot reach the network.
 * The selected bearer-token mode controls deterministic provider success and failure responses.
 */
export const controlledTwitchServiceLayer = (mode: ControlledTwitchProviderMode) => {
  const accessTokens = Layer.succeed(
    ProviderAccessTokens,
    ProviderAccessTokens.of({
      getValidAccessToken: (_provider: OAuthProvider) =>
        Effect.succeed(Redacted.make(`scenario:${mode}`)),
      setTokens: () => Effect.void,
      onStreamOnline: () => Effect.void,
      onStreamOffline: () => Effect.void,
    }),
  );

  const configuration = Layer.succeed(TwitchConfiguration, httpTestConfiguration);

  const tokenExchange = providerTokenExchangeLayerWithoutDependencies.pipe(
    Layer.provide([providerScenarioTransportLayer, configuration]),
  );

  return twitchServiceLayerWithoutDependencies.pipe(
    Layer.provide([providerScenarioTransportLayer, accessTokens, tokenExchange, configuration]),
  );
};
