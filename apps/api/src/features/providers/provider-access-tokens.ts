import { Context, type Effect, type Redacted } from "effect";
import type {
  OAuthProvider,
  ProviderError,
  SetProviderTokens,
} from "@cf-twitch/contracts/provider";

/** Provider access tokens own durable authorization and stream-aware refresh policy. */
export interface IProviderAccessTokens {
  readonly getValidAccessToken: (
    provider: OAuthProvider,
  ) => Effect.Effect<Redacted.Redacted<string>, ProviderError>;
  readonly setTokens: (input: SetProviderTokens) => Effect.Effect<void, ProviderError>;
  readonly onStreamOnline: (provider: OAuthProvider) => Effect.Effect<void, ProviderError>;
  readonly onStreamOffline: (provider: OAuthProvider) => Effect.Effect<void, ProviderError>;
}
/** Durable token capability shared by providers, OAuth setup, and stream lifecycle fanout. */
export class ProviderAccessTokens extends Context.Service<
  ProviderAccessTokens,
  IProviderAccessTokens
>()("@cf-twitch/ProviderAccessTokens") {}
