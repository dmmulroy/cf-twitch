import {
  ConsumeAuthorizationState,
  OAuthAuthorizationAttempt,
  OAuthError,
  OAuthStateOutcome,
} from "@cf-twitch/contracts/oauth";
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";

/** OAuth state HTTP contract exposes atomic creation and one-use consumption, not raw storage. */
export class OAuthStateHttpApi extends HttpApi.make("OAuthStateHttpApi")
  .add(
    HttpApiGroup.make("oauthState")
      .add(
        HttpApiEndpoint.post("createAttempt", "/oauth-state", {
          payload: OAuthAuthorizationAttempt,
          error: OAuthError,
        }),
      )
      .add(
        HttpApiEndpoint.post("consumeAttempt", "/oauth-state/consume", {
          payload: ConsumeAuthorizationState,
          success: OAuthStateOutcome,
          error: OAuthError,
        }),
      ),
  )
  .prefix("/v1") {}
