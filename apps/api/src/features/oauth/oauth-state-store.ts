import {
  ConsumeAuthorizationState,
  OAuthAuthorizationAttempt,
  OAuthError,
  type OAuthOperation,
  type OAuthStateOutcome,
} from "@cf-twitch/contracts/oauth";
import type { OAuthProvider } from "@cf-twitch/contracts/provider";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Clock, Context, Data, Effect, Layer, Option, Redacted, Ref, Schema } from "effect";

/** Native storage key that retains the historical authorization-attempt record. */
const oauthAttemptStorageKey = "authorization-attempt";

/** Longest permitted lifetime of one authorization attempt. */
const oauthAttemptLifetimeMs = 600_000;

const StoredAuthorizationAttempt = Schema.Struct({
  ...OAuthAuthorizationAttempt.fields,
  consumedAtMs: Schema.OptionFromNullOr(OAuthAuthorizationAttempt.fields.createdAtMs),
});

type StoredAuthorizationAttempt = typeof StoredAuthorizationAttempt.Type;

const parseStoredAttempt = Schema.decodeUnknownOption(StoredAuthorizationAttempt);

// Values encoded here were either decoded by this codec or validated by the HTTP payload schema,
// and timestamps come from Clock, so encoding cannot fail. A failure would reject the native
// transaction and surface as an `OAuthError` with reason `persistence`.
const encodeStoredAttempt = Schema.encodeSync(StoredAuthorizationAttempt);

const isOAuthAttemptWindowValid = (input: OAuthAuthorizationAttempt): boolean =>
  input.expiresAtMs > input.createdAtMs &&
  input.expiresAtMs - input.createdAtMs <= oauthAttemptLifetimeMs;

const unconsumedAttempt = (input: OAuthAuthorizationAttempt): StoredAuthorizationAttempt => ({
  provider: input.provider,
  redirectUri: input.redirectUri,
  state: input.state,
  createdAtMs: input.createdAtMs,
  expiresAtMs: input.expiresAtMs,
  consumedAtMs: Option.none(),
});

/** One-use consumption decision shared by native storage and the in-memory test store. */
const decideOAuthAttemptConsumption = (
  stored: Option.Option<StoredAuthorizationAttempt>,
  input: ConsumeAuthorizationState,
  now: number,
): readonly [OAuthStateOutcome, Option.Option<StoredAuthorizationAttempt>] => {
  if (Option.isNone(stored)) return ["invalid", Option.none()];
  const attempt = stored.value;

  if (Option.isSome(attempt.consumedAtMs)) return ["consumed", Option.none()];

  if (now >= attempt.expiresAtMs) return ["expired", Option.none()];

  if (
    Redacted.value(attempt.state) !== Redacted.value(input.state) ||
    attempt.provider !== input.provider ||
    attempt.redirectUri !== input.redirectUri
  )
    return ["mismatch", Option.none()];

  return ["ok", Option.some({ ...attempt, consumedAtMs: Option.some(now) })];
};

/** Expiry alarm decision shared by native storage and the in-memory test store. */
type OAuthAttemptExpiry = Data.TaggedEnum<{
  Preserve: {};
  Reschedule: { readonly atMs: number };
  Delete: {};
}>;

const OAuthAttemptExpiry = Data.taggedEnum<OAuthAttemptExpiry>();

const decideOAuthAttemptExpiry = (
  stored: Option.Option<StoredAuthorizationAttempt>,
  now: number,
): OAuthAttemptExpiry => {
  // Malformed historical state is preserved for operator repair, never overwritten.
  if (Option.isNone(stored)) return OAuthAttemptExpiry.Preserve();

  if (now < stored.value.expiresAtMs)
    return OAuthAttemptExpiry.Reschedule({ atMs: stored.value.expiresAtMs });

  return OAuthAttemptExpiry.Delete();
};

const oauthStateStoreFailure = (
  operation: OAuthOperation,
  reason: OAuthError["reason"],
  provider: Option.Option<OAuthProvider>,
) => new OAuthError({ operation, reason, provider });

/** Store of one OAuth authorization attempt, providing one-use state authority for a single state value. */
export interface IOAuthStateStore {
  /**
   * Records a new authorization attempt and schedules its expiry.
   *
   * @returns Nothing, or fails with `OAuthError` reason `attempt-window-invalid` when expiry is not within ten minutes of creation, `attempt-already-exists` when this state already has an attempt, or `persistence` when storage fails.
   */
  readonly createAttempt: (input: OAuthAuthorizationAttempt) => Effect.Effect<void, OAuthError>;
  /**
   * Consumes the attempt once when state, provider and redirect URI all match.
   *
   * @returns The consumption outcome, or fails with `OAuthError` reason `persistence` when storage fails.
   */
  readonly consumeAttempt: (
    input: ConsumeAuthorizationState,
  ) => Effect.Effect<OAuthStateOutcome, OAuthError>;
  /**
   * Deletes an expired attempt, or reschedules the alarm when the attempt has not yet expired.
   *
   * @returns Nothing, or fails with `OAuthError` reason `persistence` when storage fails.
   */
  readonly expireAttempt: () => Effect.Effect<void, OAuthError>;
}

/** Service that holds one OAuth authorization attempt, keyed historically as `authorization-attempt`. */
export class OAuthStateStore extends Context.Service<OAuthStateStore, IOAuthStateStore>()(
  "@cf-twitch/OAuthStateStore",
) {}

/**
 * Creates the OAuth state store over Durable Object native storage transactions.
 *
 * **Details**
 *
 * Malformed or already-consumed attempts are never reset; malformed records are preserved for operator repair.
 */
export const makeOAuthStateStore = Effect.gen(function* () {
  const state = yield* Cloudflare.DurableObjectState;
  const storage = state.raw.storage;

  const createAttempt = Effect.fn("OAuthStateStore.createAttempt")(function* (
    input: OAuthAuthorizationAttempt,
  ) {
    const provider = Option.some(input.provider);

    if (!isOAuthAttemptWindowValid(input))
      return yield* Effect.fail(
        oauthStateStoreFailure("createAttempt", "attempt-window-invalid", provider),
      );

    const created = yield* Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction) => {
          const existing: unknown = await transaction.get(oauthAttemptStorageKey);

          if (existing !== undefined) return false;
          await transaction.put(
            oauthAttemptStorageKey,
            encodeStoredAttempt(unconsumedAttempt(input)),
          );
          await transaction.setAlarm(input.expiresAtMs);

          return true;
        }),
      catch: () => oauthStateStoreFailure("createAttempt", "persistence", provider),
    });

    if (!created)
      return yield* Effect.fail(
        oauthStateStoreFailure("createAttempt", "attempt-already-exists", provider),
      );
  });

  const consumeAttempt = Effect.fn("OAuthStateStore.consumeAttempt")(function* (
    input: ConsumeAuthorizationState,
  ) {
    const now = yield* Clock.currentTimeMillis;

    return yield* Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction): Promise<OAuthStateOutcome> => {
          const stored: unknown = await transaction.get(oauthAttemptStorageKey);

          const [outcome, consumed] = decideOAuthAttemptConsumption(
            parseStoredAttempt(stored),
            input,
            now,
          );

          if (Option.isSome(consumed))
            await transaction.put(oauthAttemptStorageKey, encodeStoredAttempt(consumed.value));

          return outcome;
        }),
      catch: () =>
        oauthStateStoreFailure("consumeAttempt", "persistence", Option.some(input.provider)),
    });
  });

  const expireAttempt = Effect.fn("OAuthStateStore.expireAttempt")(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.tryPromise({
      try: () =>
        storage.transaction(async (transaction) => {
          const stored: unknown = await transaction.get(oauthAttemptStorageKey);
          await OAuthAttemptExpiry.$match(
            decideOAuthAttemptExpiry(parseStoredAttempt(stored), now),
            {
              Preserve: async () => {},
              Reschedule: ({ atMs }) => transaction.setAlarm(atMs),
              Delete: async () => {
                await transaction.delete(oauthAttemptStorageKey);
                await transaction.deleteAlarm();
              },
            },
          );
        }),
      catch: () => oauthStateStoreFailure("expireAttempt", "persistence", Option.none()),
    });
  });

  return OAuthStateStore.of({ createAttempt, consumeAttempt, expireAttempt });
});

/** Layer that provides the OAuth state store over the Durable Object state supplied by its runtime phase. */
export const oauthStateStoreLayerWithoutDependencies = Layer.effect(
  OAuthStateStore,
  makeOAuthStateStore,
);

/** Production OAuth state store Layer; native storage is a Workers runtime binding, not an application dependency. */
export const oauthStateStoreLayer = oauthStateStoreLayerWithoutDependencies;

/**
 * Layer that provides an in-memory OAuth state store for one state value.
 *
 * **Details**
 *
 * Applies the same window validation, one-use consumption and expiry decisions as native storage.
 * The expiry alarm is recorded in memory; tests invoke `expireAttempt` to simulate its delivery.
 */
export const oauthStateStoreTestLayer = Layer.effect(
  OAuthStateStore,
  Effect.gen(function* () {
    const attempt = yield* Ref.make(Option.none<StoredAuthorizationAttempt>());

    const createAttempt = Effect.fn("OAuthStateStoreTest.createAttempt")(function* (
      input: OAuthAuthorizationAttempt,
    ) {
      const provider = Option.some(input.provider);

      if (!isOAuthAttemptWindowValid(input))
        return yield* Effect.fail(
          oauthStateStoreFailure("createAttempt", "attempt-window-invalid", provider),
        );

      const created = yield* Ref.modify(attempt, (stored) =>
        Option.isSome(stored) ? [false, stored] : [true, Option.some(unconsumedAttempt(input))],
      );

      if (!created)
        return yield* Effect.fail(
          oauthStateStoreFailure("createAttempt", "attempt-already-exists", provider),
        );
    });

    const consumeAttempt = Effect.fn("OAuthStateStoreTest.consumeAttempt")(function* (
      input: ConsumeAuthorizationState,
    ) {
      const now = yield* Clock.currentTimeMillis;

      return yield* Ref.modify(attempt, (stored) => {
        const [outcome, consumed] = decideOAuthAttemptConsumption(stored, input, now);

        return [outcome, Option.isSome(consumed) ? consumed : stored];
      });
    });

    const expireAttempt = Effect.fn("OAuthStateStoreTest.expireAttempt")(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.update(attempt, (stored) =>
        OAuthAttemptExpiry.$is("Delete")(decideOAuthAttemptExpiry(stored, now))
          ? Option.none()
          : stored,
      );
    });

    return OAuthStateStore.of({ createAttempt, consumeAttempt, expireAttempt });
  }),
);
