import { Schema } from "effect";
import { NonNegativeInt, PositiveInt } from "./identity.ts";
import { OAuthProvider } from "./provider.ts";

/** OAuth state is a redacted UUID, bound to provider and exact redirect URI for ten minutes. */
export const OAuthState = Schema.RedactedFromValue(Schema.String.check(Schema.isUUID()));

/** OAuth state capability value. */
export type OAuthState = typeof OAuthState.Type;

/** OAuth redirect URI must be an absolute URL. */
export const OAuthRedirectUri = Schema.String.check(
  Schema.isPattern(/^https?:\/\/[^\s]+$/),
  Schema.makeFilter((value) => URL.canParse(value)),
).pipe(Schema.brand("OAuthRedirectUri"));

/** Parsed absolute callback URI retained through provider-bound authorization state. */
export type OAuthRedirectUri = typeof OAuthRedirectUri.Type;

/** Authorization attempt creation input; HTTP owns setup-secret verification. */
export const BeginAuthorization = Schema.Struct({
  provider: OAuthProvider,
  redirectUri: OAuthRedirectUri,
});

/** Authorization start input. */
export interface BeginAuthorization extends Schema.Schema.Type<typeof BeginAuthorization> {}

/** Authorization state consumption input, including exact callback redirect binding. */
export const ConsumeAuthorizationState = Schema.Struct({
  ...BeginAuthorization.fields,
  state: OAuthState,
});

/** Authorization state consumption input. */
export interface ConsumeAuthorizationState extends Schema.Schema.Type<
  typeof ConsumeAuthorizationState
> {}

/** Authorization code exchange occurs only after successful one-use state consumption. */
export const ExchangeAuthorizationCode = Schema.Struct({
  ...BeginAuthorization.fields,
  code: Schema.RedactedFromValue(Schema.NonEmptyString),
});

/** Code exchange input keeps credentials redacted. */
export interface ExchangeAuthorizationCode extends Schema.Schema.Type<
  typeof ExchangeAuthorizationCode
> {}

/** OAuth state outcomes preserve legacy callback error codes without disclosing state values. */
export const OAuthStateOutcome = Schema.Literals([
  "ok",
  "invalid",
  "expired",
  "consumed",
  "mismatch",
]);

/** OAuth state consumption result. */
export type OAuthStateOutcome = typeof OAuthStateOutcome.Type;

/** Safe OAuth state failure excludes state, code, redirect and storage payloads. */
export class OAuthError extends Schema.TaggedError<OAuthError>()("OAuthError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "invalid-input",
    "invalid_response",
    "persistence",
    "transport",
    "randomness",
  ]),
}) {
  /** OAuth error message contains no secret state or provider response. */
  override get message(): string {
    return `OAuth state operation failed: ${this.operation} (${this.reason})`;
  }
}

/** Authorization start result; the redirect URL also contains secret state and stays redacted until HTTP. */
export const AuthorizationStarted = Schema.Struct({
  state: OAuthState,
  authorizationUrl: Schema.RedactedFromValue(Schema.String),
});

/** Authorization start result. */
export interface AuthorizationStarted extends Schema.Schema.Type<typeof AuthorizationStarted> {}

/** Persisted OAuth attempt has source timestamps in Unix milliseconds. */
export const OAuthAuthorizationAttempt = Schema.Struct({
  ...ConsumeAuthorizationState.fields,
  createdAtMs: NonNegativeInt,
  expiresAtMs: PositiveInt,
});

/** Persisted OAuth attempt input. */
export interface OAuthAuthorizationAttempt extends Schema.Schema.Type<
  typeof OAuthAuthorizationAttempt
> {}
