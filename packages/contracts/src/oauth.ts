import { Option, Schema } from "effect";
import { isOpenApiPattern } from "./schema-pattern.ts";
import { NonNegativeInt, PositiveInt } from "./identity.ts";
import { OAuthProvider } from "./provider.ts";

/** Schema for OAuth state, a redacted UUID bound to one provider and exact redirect URI for ten minutes. */
export const OAuthState = Schema.RedactedFromValue(Schema.String.check(Schema.isUUID()));

/** OAuth state capability value. */
export type OAuthState = typeof OAuthState.Type;

/** Schema for an OAuth redirect URI, which must be an absolute HTTP or HTTPS URL. */
export const OAuthRedirectUri = Schema.String.check(
  isOpenApiPattern(/^https?:\/\/[^\s]+$/),
  Schema.makeFilter((value) => URL.canParse(value)),
).pipe(Schema.brand("OAuthRedirectUri"));

/** Parsed absolute callback URI retained through provider-bound authorization state. */
export type OAuthRedirectUri = typeof OAuthRedirectUri.Type;

/** Schema for authorization start input; HTTP owns setup-secret verification. */
export const BeginAuthorization = Schema.Struct({
  provider: OAuthProvider,
  redirectUri: OAuthRedirectUri,
});

/** Authorization start input. */
export interface BeginAuthorization extends Schema.Schema.Type<typeof BeginAuthorization> {}

/** Schema for authorization state consumption input, including exact callback redirect binding. */
export const ConsumeAuthorizationState = Schema.Struct({
  ...BeginAuthorization.fields,
  state: OAuthState,
});

/** Authorization state consumption input. */
export interface ConsumeAuthorizationState extends Schema.Schema.Type<
  typeof ConsumeAuthorizationState
> {}

/** Schema for authorization code exchange input, used only after successful one-use state consumption. */
export const ExchangeAuthorizationCode = Schema.Struct({
  ...BeginAuthorization.fields,
  /** Single-use authorization code from the provider callback. */
  code: Schema.RedactedFromValue(Schema.NonEmptyString),
});

/** Code exchange input keeps credentials redacted. */
export interface ExchangeAuthorizationCode extends Schema.Schema.Type<
  typeof ExchangeAuthorizationCode
> {}

/** Schema for OAuth state consumption outcomes, preserving legacy callback error codes without disclosing state values. */
export const OAuthStateOutcome = Schema.Literals([
  "ok",
  "invalid",
  "expired",
  "consumed",
  "mismatch",
]);

/** OAuth state consumption result. */
export type OAuthStateOutcome = typeof OAuthStateOutcome.Type;

/** Schema for the OAuth operations that can report an `OAuthError`. */
export const OAuthOperation = Schema.Literals([
  "beginAuthorization",
  "createAttempt",
  "consumeAttempt",
  "expireAttempt",
]);

/** OAuth operation that reported an `OAuthError`. */
export type OAuthOperation = typeof OAuthOperation.Type;

/** Schema for classified OAuth state failure reasons. */
export const OAuthFailureReason = Schema.Literals([
  "attempt-window-invalid",
  "attempt-already-exists",
  "invalid-response",
  "persistence",
  "transport",
  "randomness",
]);

/** Classified reason an OAuth state operation failed. */
export type OAuthFailureReason = typeof OAuthFailureReason.Type;

/**
 * Typed failure of OAuth authorization state creation, consumption or expiry.
 *
 * **Details**
 *
 * Excludes state values, authorization codes, redirect URIs and storage payloads.
 */
export class OAuthError extends Schema.TaggedError<OAuthError>()("OAuthError", {
  /** OAuth operation that failed. */
  operation: OAuthOperation,
  /** Classified failure reason. */
  reason: OAuthFailureReason,
  /** Provider being authorized, or none when the failing code could not establish it. */
  provider: Schema.OptionFromNullOr(OAuthProvider),
}) {
  /** Error message naming the OAuth operation, its classified reason and one way forward. */
  override get message(): string {
    const subject = Option.match(this.provider, {
      onNone: () => this.operation,
      onSome: (provider) => `${this.operation} for ${provider}`,
    });

    switch (this.reason) {
      case "attempt-window-invalid":
        return `OAuth authorization attempt expiry must be within ten minutes of creation during ${subject}. Start authorization again from the setup link.`;
      case "attempt-already-exists":
        return `OAuth authorization state is already in use during ${subject}. Start authorization again to receive a new state.`;
      case "invalid-response":
        return `OAuth state storage returned an unreadable response during ${subject}. Start authorization again from the setup link.`;
      case "transport":
        return `OAuth state storage could not be reached during ${subject}. Start authorization again from the setup link.`;
      case "randomness":
        return `OAuth state generation failed during ${subject} because secure randomness was unavailable. Retry the authorization request.`;
      case "persistence":
        return this.operation === "expireAttempt"
          ? `OAuth state storage failed while removing an expired attempt. Inspect the OAuth state storage for the expired attempt.`
          : `OAuth state storage failed during ${subject}. Start authorization again from the setup link.`;
    }
  }
}

/** Schema for the authorization start result; the redirect URL contains secret state and stays redacted until HTTP. */
export const AuthorizationStarted = Schema.Struct({
  state: OAuthState,
  /** Provider authorization URL to redirect the operator to; it embeds the secret state. */
  authorizationUrl: Schema.RedactedFromValue(Schema.String),
});

/** Authorization start result. */
export interface AuthorizationStarted extends Schema.Schema.Type<typeof AuthorizationStarted> {}

/** Schema for a persisted OAuth attempt with source timestamps in Unix milliseconds. */
export const OAuthAuthorizationAttempt = Schema.Struct({
  ...ConsumeAuthorizationState.fields,
  createdAtMs: NonNegativeInt,
  /** Expiry in Unix milliseconds, at most ten minutes after `createdAtMs`. */
  expiresAtMs: PositiveInt,
});

/** Persisted OAuth attempt input. */
export interface OAuthAuthorizationAttempt extends Schema.Schema.Type<
  typeof OAuthAuthorizationAttempt
> {}
