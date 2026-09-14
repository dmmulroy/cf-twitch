import { ProviderError, ProviderTokens } from "@cf-twitch/contracts/provider";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

/** Provider token HTTP API is internal-only; credentials never enter public Worker responses. */
export class ProviderTokenHttpApi extends HttpApi.make("ProviderTokenHttpApi")
  .add(
    HttpApiGroup.make("token")
      .add(
        HttpApiEndpoint.post("getValidToken", "/token/access", {
          success: Schema.RedactedFromValue(Schema.NonEmptyString),
          error: ProviderError,
        }),
      )
      .add(
        HttpApiEndpoint.post("setTokens", "/token", {
          payload: ProviderTokens,
          error: ProviderError,
        }),
      )
      .add(HttpApiEndpoint.post("onStreamOnline", "/token/stream-online", { error: ProviderError }))
      .add(
        HttpApiEndpoint.post("onStreamOffline", "/token/stream-offline", { error: ProviderError }),
      ),
  )
  .prefix("/v1") {}
