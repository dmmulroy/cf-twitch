import {
  ConsumeAuthorizationState,
  OAuthAuthorizationAttempt,
  OAuthError,
  type OAuthStateOutcome,
} from "@cf-twitch/contracts/oauth";
import * as Cloudflare from "alchemy/Cloudflare";
import { Clock, Context, Effect, Layer, Option, Redacted, Schema } from "effect";

/** One-use OAuth state authority is backed by a native Durable Object storage transaction. */
export interface IOAuthStateStore {
  readonly createAttempt: (input: OAuthAuthorizationAttempt) => Effect.Effect<void, OAuthError>;
  readonly consumeAttempt: (
    input: ConsumeAuthorizationState,
  ) => Effect.Effect<OAuthStateOutcome, OAuthError>;
  readonly expireAttempt: () => Effect.Effect<void, OAuthError>;
}

/** OAuth state storage retains the historical authorization-attempt key and consumed timestamp. */
export class OAuthStateStore extends Context.Service<OAuthStateStore, IOAuthStateStore>()(
  "@cf-twitch/OAuthStateStore",
) {}

const StoredAuthorizationAttempt = Schema.Struct({
  ...OAuthAuthorizationAttempt.fields,
  consumedAtMs: Schema.NullOr(OAuthAuthorizationAttempt.fields.createdAtMs),
});

const parseStoredAttempt = Schema.decodeUnknownOption(StoredAuthorizationAttempt);

/** Native storage parser never resets malformed or already-consumed OAuth attempts. */
export const makeOAuthStateStore = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;
  const storage = state.raw.storage;
  const failure = (operation: string) => new OAuthError({ operation, reason: "persistence" });

  const createAttempt = Effect.fn("OAuthStateStore.createAttempt")(function* (
    input: OAuthAuthorizationAttempt,
  ) {
    if (input.expiresAtMs <= input.createdAtMs || input.expiresAtMs - input.createdAtMs > 600_000)
      return yield* Effect.fail(
        new OAuthError({ operation: "createAttempt", reason: "invalid-input" }),
      );

    const created = yield* Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction) => {
          const existing: unknown = await transaction.get("authorization-attempt");

          if (existing !== undefined) return false;
          await transaction.put("authorization-attempt", {
            provider: input.provider,
            redirectUri: input.redirectUri,
            state: Redacted.value(input.state),
            createdAtMs: input.createdAtMs,
            expiresAtMs: input.expiresAtMs,
            consumedAtMs: null,
          });
          await transaction.setAlarm(input.expiresAtMs);

          return true;
        }),
      catch: () => failure("createAttempt"),
    });

    if (!created)
      return yield* Effect.fail(
        new OAuthError({ operation: "createAttempt", reason: "invalid-input" }),
      );
  });

  const consumeAttempt = Effect.fn("OAuthStateStore.consumeAttempt")(function* (
    input: ConsumeAuthorizationState,
  ) {
    const now = yield* Clock.currentTimeMillis;

    return yield* Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction): Promise<OAuthStateOutcome> => {
          const stored: unknown = await transaction.get("authorization-attempt");
          const parsedStored = parseStoredAttempt(stored);

          if (Option.isNone(parsedStored)) return "invalid";
          const attempt = parsedStored.value;

          if (attempt.consumedAtMs !== null) return "consumed";

          if (now >= attempt.expiresAtMs) return "expired";

          if (
            Redacted.value(attempt.state) !== Redacted.value(input.state) ||
            attempt.provider !== input.provider ||
            attempt.redirectUri !== input.redirectUri
          )
            return "mismatch";
          await transaction.put("authorization-attempt", {
            ...attempt,
            state: Redacted.value(attempt.state),
            consumedAtMs: now,
          });

          return "ok";
        }),
      catch: () => failure("consumeAttempt"),
    });
  });

  const expireAttempt = Effect.fn("OAuthStateStore.expireAttempt")(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction) => {
          const stored: unknown = await transaction.get("authorization-attempt");
          const parsed = parseStoredAttempt(stored);

          // Malformed historical state is preserved for operator repair, never overwritten.
          if (Option.isNone(parsed)) return;

          if (now < parsed.value.expiresAtMs) {
            await transaction.setAlarm(parsed.value.expiresAtMs);

            return;
          }

          await transaction.delete("authorization-attempt");
          await transaction.deleteAlarm();
        }),
      catch: () => failure("expireAttempt"),
    });
  });

  return OAuthStateStore.of({ createAttempt, consumeAttempt, expireAttempt });
});

/** OAuth native storage is acquired only in the Durable Object runtime phase. */
export const oauthStateStoreLayerWithoutDependencies = Layer.effect(
  OAuthStateStore,
  makeOAuthStateStore,
);
