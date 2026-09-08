import { ProviderError, ProviderTokens } from "@cf-twitch/contracts/provider";
import { Clock, Context, Effect, Layer, Option, Redacted, Semaphore } from "effect";
import {
  ProviderTokenDatabase,
  TokenProviderIdentity,
  type ProviderTokenState,
} from "./provider-token-database.ts";
import { ProviderTokenExchange } from "./provider-token-exchange.ts";

/** Token alarm adapter owns Cloudflare alarm scheduling; SQL persists the repairable intent. */
export interface IProviderTokenAlarm {
  readonly setAlarm: (atMs: number) => Effect.Effect<void, ProviderError>;
  readonly deleteAlarm: () => Effect.Effect<void, ProviderError>;
}
/** Durable token alarm capability provided only inside a running token Durable Object. */
export class ProviderTokenAlarm extends Context.Service<ProviderTokenAlarm, IProviderTokenAlarm>()(
  "@cf-twitch/ProviderTokenAlarm",
) {}
/** One physical provider token lifecycle shares in-flight refresh work across public callers. */
export interface IProviderTokenLifecycle {
  readonly getValidToken: () => Effect.Effect<Redacted.Redacted<string>, ProviderError>;
  readonly setTokens: (tokens: ProviderTokens) => Effect.Effect<void, ProviderError>;
  readonly onStreamOnline: () => Effect.Effect<void, ProviderError>;
  readonly onStreamOffline: () => Effect.Effect<void, ProviderError>;
  readonly refreshTokenTick: () => Effect.Effect<void, ProviderError>;
}
/** Stream-aware refresh lifecycle with a five minute expiry safety buffer. */
export class ProviderTokenLifecycle extends Context.Service<
  ProviderTokenLifecycle,
  IProviderTokenLifecycle
>()("@cf-twitch/ProviderTokenLifecycle") {}
const refreshBufferMs = 300_000;

/** Construct token lifecycle after SQL initialization, repairing any persisted alarm intent. */
export const makeProviderTokenLifecycle = Effect.gen(function* () {
  const database = yield* ProviderTokenDatabase;
  const exchange = yield* ProviderTokenExchange;
  const alarm = yield* ProviderTokenAlarm;
  const provider = yield* TokenProviderIdentity;
  const lock = yield* Semaphore.make(1);
  const failure = (kind: ProviderError["kind"], operation: string) =>
    new ProviderError({ provider, operation, kind, status: 0, retryAfterMs: Option.none() });
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
                if (error.kind === "reauthorization-required") {
                  yield* persist({
                    ...current,
                    authorizationStatus: "reauthorization-required",
                    refreshRetryCount: 0,
                    nextRefreshAtMs: Option.none(),
                  });
                } else {
                  const shortRetry =
                    (error.kind === "network" || error.kind === "rate-limited") &&
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
/** Token lifecycle preserves SQL, HTTP exchange, alarm and physical identity requirements. */
export const providerTokenLifecycleLayerWithoutDependencies = Layer.effect(
  ProviderTokenLifecycle,
  makeProviderTokenLifecycle,
);
