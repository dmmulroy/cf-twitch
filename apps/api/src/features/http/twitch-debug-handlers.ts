import { Clock, Effect, Option, Result, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpServerResponse } from "effect/http";
import { TwitchHttpApi, type TwitchHttpOperation } from "@cf-twitch/contracts/twitch-api";
import { IsoTimestamp } from "@cf-twitch/contracts/identity";
import { StreamLifecycleState } from "@cf-twitch/contracts/stream";
import { RaffleLeaderboardEntry } from "@cf-twitch/contracts/raffle";
import { SongQueueLimit } from "@cf-twitch/contracts/song-queue";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { StreamLifecycleClient } from "../stream/stream-lifecycle.ts";
import { TwitchService } from "../providers/twitch-service.ts";
import { SongQueue } from "../song-queue/song-queue.ts";
import { Raffle } from "../raffle/raffle-service.ts";
import {
  HttpBoundaryError,
  encodeHttpResponse,
  handleHttpBoundary,
  invalidHttpServiceResponse,
  parseHttpLeaderboardQuery,
  requireHttpAdministrator,
} from "./http-boundary.ts";
import {
  type HttpServiceAccess,
  raffleHttpFailure,
  streamLifecycleHttpFailure,
  twitchProviderHttpFailure,
} from "./http-service-failures.ts";

const decodeTimestamp = Schema.decodeEffect(IsoTimestamp);

const encodeStreamState = Schema.encodeEffect(StreamLifecycleState);

const debugSongQueueLimit = SongQueueLimit.make(5);

const reconcileChange = (summary: string): HttpServiceAccess => ({
  kind: "change",
  summary,
  reconcile: "Read the stream state with GET /api/debug/stream-state before retrying.",
});

/**
 * Layer that serves authenticated Stream Lifecycle and Keyboard Raffle diagnostics.
 *
 * **Details**
 *
 * Reconciliation replays same-state effects and preserves Twitch's authoritative start
 * timestamp. Status aggregates partial component failures into a 200 body.
 */
export const twitchDebugHandlersLayer = HttpApiBuilder.group(TwitchHttpApi, "debug", (handlers) =>
  Effect.gen(function* () {
    const configuration = yield* TwitchConfiguration;
    const stream = yield* StreamLifecycleClient;
    const twitch = yield* TwitchService;
    const queue = yield* SongQueue;
    const raffle = yield* Raffle;

    const admin = <R>(
      operation: TwitchHttpOperation,
      effect: Effect.Effect<HttpServerResponse.HttpServerResponse, HttpBoundaryError, R>,
    ) =>
      requireHttpAdministrator(configuration.administratorSecret, "Debug API").pipe(
        Effect.andThen(effect),
        handleHttpBoundary(operation),
      );

    return handlers
      .handleRaw("streamState", () =>
        admin(
          "streamState",
          stream.getState().pipe(
            Effect.catchTag("StreamLifecycleError", (error) =>
              Effect.fail(
                streamLifecycleHttpFailure(error, {
                  kind: "repeatable",
                  summary: "Failed to fetch stream state",
                }),
              ),
            ),
            Effect.flatMap((value) =>
              encodeHttpResponse("streamLifecycle", StreamLifecycleState, value),
            ),
          ),
        ),
      )
      .handleRaw("raffleLeaderboardDebug", () =>
        admin(
          "raffleLeaderboardDebug",
          Effect.gen(function* () {
            const { limit, sortBy } = yield* parseHttpLeaderboardQuery();

            const value = yield* raffle.getLeaderboard({ limit: Option.some(limit), sortBy }).pipe(
              Effect.catchTag("RaffleError", (error) =>
                Effect.fail(
                  raffleHttpFailure(error, {
                    kind: "repeatable",
                    summary: "Failed to fetch raffle leaderboard",
                  }),
                ),
              ),
            );

            return yield* encodeHttpResponse(
              "keyboardRaffle",
              Schema.Array(RaffleLeaderboardEntry),
              value,
            );
          }),
        ),
      )
      .handleRaw("reconcileStream", () =>
        admin(
          "reconcileStream",
          Effect.gen(function* () {
            const [beforeResult, providerResult] = yield* Effect.all(
              [
                stream.getState().pipe(Effect.result),
                twitch
                  .getStreamInfo(configuration.twitch.broadcaster.displayName)
                  .pipe(Effect.result),
              ],
              { concurrency: "unbounded" },
            );

            if (Result.isFailure(beforeResult))
              return yield* Effect.fail(
                streamLifecycleHttpFailure(beforeResult.failure, {
                  kind: "repeatable",
                  summary: "Failed to fetch current stream state",
                }),
              );

            if (Result.isFailure(providerResult))
              return yield* Effect.fail(
                twitchProviderHttpFailure(providerResult.failure, "getStreamInfo", Option.none(), {
                  kind: "repeatable",
                  summary: "Failed to fetch Twitch stream status",
                }),
              );
            const before = beforeResult.success;
            const provider = providerResult.success;
            let action: "noop" | "set_online" | "set_offline" = "noop";

            if (Option.isSome(provider)) {
              yield* stream
                .markOnline({ streamId: provider.value.id, startedAt: provider.value.startedAt })
                .pipe(
                  Effect.catchTag("StreamLifecycleError", (error) =>
                    Effect.fail(
                      streamLifecycleHttpFailure(
                        error,
                        reconcileChange("Failed to reconcile online stream state"),
                      ),
                    ),
                  ),
                );

              if (!before.isLive) action = "set_online";
            } else {
              const now = yield* Clock.currentTimeMillis;

              const endedAt = yield* decodeTimestamp(new Date(now).toISOString()).pipe(
                Effect.orDie,
              );

              yield* stream
                .markOffline({ endedAt })
                .pipe(
                  Effect.catchTag("StreamLifecycleError", (error) =>
                    Effect.fail(
                      streamLifecycleHttpFailure(
                        error,
                        reconcileChange("Failed to reconcile offline stream state"),
                      ),
                    ),
                  ),
                );

              if (before.isLive) action = "set_offline";
            }

            let queueWarmup: "not_needed" | "ok" | "error" = "not_needed";

            if (action === "set_online") {
              const warmup = yield* queue.getCurrentlyPlaying().pipe(Effect.result);
              queueWarmup = Result.isSuccess(warmup) ? "ok" : "error";
            }

            const after = yield* stream.getState().pipe(Effect.result);

            const encodedBefore = yield* encodeStreamState(before).pipe(
              Effect.mapError(() =>
                invalidHttpServiceResponse("encodeResponse", "streamLifecycle"),
              ),
            );

            if (Result.isFailure(after))
              return yield* Effect.fail(
                new HttpBoundaryError({
                  operation: "callService",
                  status: 500,
                  failure: {
                    code: "StreamReconciliationUnconfirmed",
                    error: "Reconciliation completed but failed to read final state",
                    message: `Stream reconciliation unconfirmed: the ${action} reconciliation finished, but the final state could not be read (${after.failure.reason}). Read the stream state with GET /api/debug/stream-state.`,
                    details: { action, before },
                    retryable: false,
                  },
                }),
              );

            const encodedAfter = yield* encodeStreamState(after.success).pipe(
              Effect.mapError(() =>
                invalidHttpServiceResponse("encodeResponse", "streamLifecycle"),
              ),
            );

            return HttpServerResponse.jsonUnsafe({
              action,
              queueWarmup,
              before: encodedBefore,
              after: encodedAfter,
              twitch: Option.match(provider, {
                onNone: () => ({
                  isLive: false,
                  startedAt: null,
                  viewerCount: null,
                  title: null,
                  gameName: null,
                }),
                onSome: (value) => ({
                  isLive: true,
                  startedAt: value.startedAt,
                  viewerCount: value.viewerCount,
                  title: value.title,
                  gameName: value.gameName,
                }),
              }),
            });
          }),
        ),
      )
      .handleRaw("debugStatus", () =>
        admin(
          "debugStatus",
          Effect.gen(function* () {
            const [state, provider, songs] = yield* Effect.all(
              [
                stream.getState().pipe(Effect.result),
                twitch
                  .getStreamInfo(configuration.twitch.broadcaster.displayName)
                  .pipe(Effect.result),
                queue.getSongQueue({ limit: debugSongQueueLimit }).pipe(Effect.result),
              ],
              { concurrency: "unbounded" },
            );

            const now = yield* Clock.currentTimeMillis;

            return HttpServerResponse.jsonUnsafe({
              timestamp: new Date(now).toISOString(),
              stream: Result.isSuccess(state)
                ? {
                    ok: true,
                    isLive: state.success.isLive,
                    startedAt: Option.getOrNull(state.success.startedAt),
                    peakViewerCount: state.success.peakViewerCount,
                    error: null,
                  }
                : {
                    ok: false,
                    isLive: null,
                    startedAt: null,
                    peakViewerCount: null,
                    error: state.failure.message,
                  },
              twitch: Result.isSuccess(provider)
                ? Option.match(provider.success, {
                    onNone: () => ({
                      ok: true,
                      isLive: false,
                      startedAt: null,
                      viewerCount: null,
                      error: null,
                    }),
                    onSome: (value) => ({
                      ok: true,
                      isLive: true,
                      startedAt: value.startedAt,
                      viewerCount: value.viewerCount,
                      error: null,
                    }),
                  })
                : {
                    ok: false,
                    isLive: null,
                    startedAt: null,
                    viewerCount: null,
                    error: provider.failure.message,
                  },
              songQueue: Result.isSuccess(songs)
                ? { ok: true, queueLength: songs.success.totalCount, error: null }
                : { ok: false, queueLength: null, error: songs.failure.message },
            });
          }),
        ),
      );
  }),
);
