import type { OAuthProvider } from "@cf-twitch/contracts/provider";
import { Context } from "effect";

/** Context value naming the provider whose token Durable Object is running, selected by the physical server and never by caller payload. */
export class ProviderTokenIdentity extends Context.Service<ProviderTokenIdentity, OAuthProvider>()(
  "@cf-twitch/ProviderTokenIdentity",
) {}
