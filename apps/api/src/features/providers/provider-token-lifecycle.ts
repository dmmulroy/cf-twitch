import {
  ProviderError,
  ProviderTokens,
  type ProviderFailureReason,
  type ProviderOperation,
} from "@cf-twitch/contracts/provider";
import { Clock, Context, Effect, Layer, Option, Redacted, Semaphore } from "effect";
import {
  ProviderTokenAlarm,
  providerTokenAlarmLayer,
  providerTokenAlarmTestLayer,
} from "./provider-token-alarm.ts";
import {
  ProviderTokenDatabase,
  providerTokenDatabaseLayer,
  providerTokenDatabaseTestLayer,
} from "./provider-token-database.ts";
import {
  ProviderTokenExchange,
  providerTokenExchangeTestLayer,
} from "./provider-token-exchange.ts";
import { ProviderTokenIdentity } from "./provider-token-identity.ts";
import type { ProviderTokenState } from "./provider-token-state.ts";

/**
 * Stream-aware token lifecycle of one physical provider token Durable Object.
 *
 * **Details**
 *
 * Tokens are usable until five minutes before expiry. Refresh happens only while the stream is live and is shared by concurrent callers.
 */
export interface IProviderTokenLifecycle {
  /**
   * Returns a usable access token, refreshing it first when it is inside the expiry buffer and the stream is live.
   *
   * @returns The access token, or fails with `ProviderError` reason `not-configured` before authorization, `reauthorization-required` after revocation, `offline` when the token needs refresh while the stream is offline, or a refresh or storage failure.
   */
  readonly getValidToken: () => Effect.Effect<Redacted.Redacted<string>, ProviderError>;
  /**
   * Accepts newly authorized tokens, keeping the stored refresh token and scopes when the provider omitted them.
   *
   * @returns Nothing, or fails with `ProviderError` reason `reauthorization-required` when no refresh token is available, or a storage failure.
   */
  readonly setTokens: (tokens: ProviderTokens) => Effect.Effect<void, ProviderError>;
  /**
   * Marks the stream live, schedules proactive refresh, and validates a configured token.
   *
   * @returns Nothing, or fails with the `ProviderError` of the token validation or storage.
   */
  readonly onStreamOnline: () => Effect.Effect<void, ProviderError>;
  /**
   * Marks the stream offline and cancels scheduled refresh.
   *
   * @returns Nothing, or fails with `ProviderError` reason `persistence` or `stored-state-invalid` when storage fails.
   */
  readonly onStreamOffline: () => Effect.Effect<void, ProviderError>;
  /**
   * Runs the scheduled refresh delivered by the token alarm.
   *
   * @returns Nothing, or fails with the `ProviderError` of the refresh or storage.
   */
  readonly refreshTokenTick: () => Effect.Effect<void, ProviderError>;
}

/** Service that runs the stream-aware refresh lifecycle of one provider's tokens with a five minute expiry safety buffer. */
export class ProviderTokenLifecycle extends Context.Service<
  ProviderTokenLifecycle,
  IProviderTokenLifecycle
>()("@cf-twitch/ProviderTokenLifecycle") {}

const refreshBufferMs = 300_000;

/**
 * Creates the token lifecycle after storage initialization, repairing any persisted alarm intent.
 *
 * @returns The lifecycle, or fails with `ProviderError` when the stored state cannot be read or the alarm cannot be rescheduled.
 */
export const makeProviderTokenLifecycle = Effect.gen(function* () {
  const database = yield* ProviderTokenDatabase;
  const exchange = yield* ProviderTokenExchange;
  const alarm = yield* ProviderTokenAlarm;
  const provider = yield* ProviderTokenIdentity;
  const lock = yield* Semaphore.make(1);

  const failure = (reason: ProviderFailureReason, operation: ProviderOperation) =>
    new ProviderError({
      provider,
      operation,
      reason,
      status: Option.none(),
      retryAfterMs: Option.none(),
    });

  const syncAlarm = Effect.fn("ProviderTokenLifecycle.syncAlarm")((state: ProviderTokenState) =>
    Option.isSome(state.nextRefreshAtMs)
      ? alarm.setAlarm(state.nextRefreshAtMs.value)
      : alarm.deleteAlarm(),
  );

  const persist = Effect.fn("ProviderTokenLifecycle.persist")(function* (
    state: ProviderTokenState,
  ) {
    yield* database.writeState(state);
    yield* syncAlarm(state);
  });

  const acceptTokens = Effect.fn("ProviderTokenLifecycle.acceptTokens")(function* (
    input: ProviderTokens,
  ) {
    const state = yield* database.readState();

    const refreshToken = Option.orElse(input.refreshToken, () =>
      Option.flatMap(state.token, (token) => token.refreshToken),
    );

    if (Option.isNone(refreshToken)) {
      yield* persist({
        ...state,
        authorizationStatus: "reauthorization-required",
        refreshRetryCount: 0,
        nextRefreshAtMs: Option.none(),
      });

      return yield* Effect.fail(failure("reauthorization-required", "setTokens"));
    }

    const now = yield* Clock.currentTimeMillis;

    const token = {
      ...input,
      refreshToken,
      scopes:
        input.scopes.length === 0 && Option.isSome(state.token)
          ? state.token.value.scopes
          : input.scopes,
      expiresAtMs: now + input.expiresIn * 1000,
    };

    yield* persist({
      ...state,
      token: Option.some(token),
      authorizationStatus: "authorized",
      refreshRetryCount: 0,
      nextRefreshAtMs: state.isStreamLive
        ? Option.some(Math.max(now + 1000, token.expiresAtMs - refreshBufferMs))
        : Option.none(),
    });

    return token.accessToken;
  });

  const refresh = yield* Effect.cachedWithTTL(
    lock
      .withPermit(
        Effect.gen(function* () {
          const state = yield* database.readState();

          if (state.authorizationStatus === "reauthorization-required")
            return yield* Effect.fail(failure("reauthorization-required", "refreshToken"));

          if (!state.isStreamLive) return yield* Effect.fail(failure("offline", "refreshToken"));
          // A caller may have observed the old expiry before a different refresh committed.
          // Recheck under the same lock as token replacement, not only before memo lookup.
          const now = yield* Clock.currentTimeMillis;

          if (Option.isSome(state.token) && now < state.token.value.expiresAtMs - refreshBufferMs)
            return state.token.value.accessToken;
          const refreshToken = Option.flatMap(state.token, (token) => token.refreshToken);

          const refreshed = Option.isSome(refreshToken)
            ? exchange
                .refreshAccessToken({ provider, refreshToken: refreshToken.value })
                .pipe(Effect.flatMap(acceptTokens))
            : Effect.fail(failure("reauthorization-required", "refreshToken"));

          return yield* refreshed.pipe(
            Effect.catchTag("ProviderError", (error) =>
              Effect.gen(function* () {
                const current = yield* database.readState();

                if (error.reason === "reauthorization-required") {
                  yield* persist({
                    ...current,
                    authorizationStatus: "reauthorization-required",
                    refreshRetryCount: 0,
                    nextRefreshAtMs: Option.none(),
                  });
                } else {
                  const shortRetry =
                    (error.reason === "network" || error.reason === "rate-limited") &&
                    current.refreshRetryCount < 3;

                  const delayMs = shortRetry ? 60_000 * 2 ** current.refreshRetryCount : 600_000;
                  const now = yield* Clock.currentTimeMillis;
                  yield* persist({
                    ...current,
                    refreshRetryCount: shortRetry ? current.refreshRetryCount + 1 : 0,
                    nextRefreshAtMs: current.isStreamLive
                      ? Option.some(now + delayMs)
                      : Option.none(),
                  });
                }

                return yield* Effect.fail(error);
              }),
            ),
          );
        }),
      )
      .pipe(Effect.uninterruptible),
    0,
  );

  const getValidToken = Effect.fn("ProviderTokenLifecycle.getValidToken")(function* () {
    const state = yield* database.readState();

    if (state.authorizationStatus === "reauthorization-required")
      return yield* Effect.fail(failure("reauthorization-required", "getValidToken"));

    if (Option.isNone(state.token))
      return yield* Effect.fail(failure("not-configured", "getValidToken"));
    const now = yield* Clock.currentTimeMillis;

    if (now < state.token.value.expiresAtMs - refreshBufferMs) return state.token.value.accessToken;

    if (!state.isStreamLive) return yield* Effect.fail(failure("offline", "getValidToken"));

    return yield* refresh;
  });

  const setTokens = Effect.fn("ProviderTokenLifecycle.setTokens")((tokens: ProviderTokens) =>
    lock.withPermit(acceptTokens(tokens)).pipe(Effect.asVoid, Effect.uninterruptible),
  );

  const onStreamOnline = Effect.fn("ProviderTokenLifecycle.onStreamOnline")(function* () {
    const configured = yield* lock.withPermit(
      Effect.gen(function* () {
        const state = yield* database.readState();
        const now = yield* Clock.currentTimeMillis;

        const nextRefreshAtMs =
          state.authorizationStatus === "authorized" && Option.isSome(state.token)
            ? Option.some(Math.max(now + 1000, state.token.value.expiresAtMs - refreshBufferMs))
            : Option.none<number>();

        yield* persist({ ...state, isStreamLive: true, nextRefreshAtMs });

        return (
          Option.isSome(state.token) || state.authorizationStatus === "reauthorization-required"
        );
      }),
    );

    if (configured) yield* getValidToken();
  });

  const onStreamOffline = Effect.fn("ProviderTokenLifecycle.onStreamOffline")(() =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const state = yield* database.readState();
          yield* persist({
            ...state,
            isStreamLive: false,
            refreshRetryCount: 0,
            nextRefreshAtMs: Option.none(),
          });
        }),
      )
      .pipe(Effect.uninterruptible),
  );

  const refreshTokenTick = Effect.fn("ProviderTokenLifecycle.refreshTokenTick")(function* () {
    const state = yield* database.readState();

    if (
      !state.isStreamLive ||
      Option.isNone(state.token) ||
      state.authorizationStatus !== "authorized"
    ) {
      yield* alarm.deleteAlarm();

      return;
    }

    yield* refresh;
  });

  const restored = yield* database.readState();
  yield* syncAlarm(restored);

  return ProviderTokenLifecycle.of({
    getValidToken,
    setTokens,
    onStreamOnline,
    onStreamOffline,
    refreshTokenTick,
  });
});

/** Layer that provides the token lifecycle with database, exchange, alarm and provider identity requirements visible. */
export const providerTokenLifecycleLayerWithoutDependencies = Layer.effect(
  ProviderTokenLifecycle,
  makeProviderTokenLifecycle,
);

/**
 * Production token lifecycle Layer that selects SQL storage and native alarms.
 *
 * **Details**
 *
 * Leaves `ProviderTokenExchange` required: the token server captures exchange during outer initialization and bridges it into the Durable Object runtime phase.
 */
export const providerTokenLifecycleLayer = providerTokenLifecycleLayerWithoutDependencies.pipe(
  Layer.provide([providerTokenDatabaseLayer, providerTokenAlarmLayer]),
);

/** Layer that provides the token lifecycle over in-memory storage, alarm and provider exchange for the provider named by `ProviderTokenIdentity`. */
export const providerTokenLifecycleTestLayer = providerTokenLifecycleLayerWithoutDependencies.pipe(
  Layer.provide([
    providerTokenDatabaseTestLayer,
    providerTokenAlarmTestLayer,
    providerTokenExchangeTestLayer,
  ]),
);
