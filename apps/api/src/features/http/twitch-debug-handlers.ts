import { Clock, Effect, Option, Result, Schema } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HttpServerResponse } from "effect/http";
import {
  TwitchDebugStatusResponse,
  TwitchHttpApi,
  TwitchStreamReconciliationResponse,
  type TwitchHttpOperation,
} from "@cf-twitch/contracts/twitch-api";
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
  parseHttpLeaderboardQuery,
  requireHttpAdministrator,
} from "./http-boundary.ts";
import {
  type HttpServiceAccess,
  raffleHttpFailure,
  songQueueHttpFailure,
  streamLifecycleHttpFailure,
  twitchProviderHttpFailure,
} from "./http-service-failures.ts";

const decodeIsoTimestamp = Schema.decodeEffect(IsoTimestamp);

const debugSongQueueLimit = SongQueueLimit.make(5);

const reconcileChange: HttpServiceAccess = {
  kind: "change",
  reconcile: "Read the stream state with GET /api/debug/stream-state before retrying.",
};

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
                }),
              );

            if (Result.isFailure(providerResult))
              return yield* Effect.fail(
                twitchProviderHttpFailure(providerResult.failure, "getStreamInfo", Option.none()),
              );
            const before = beforeResult.success;
            const provider = providerResult.success;
            let action: TwitchStreamReconciliationResponse["action"] = "noop";

            if (Option.isSome(provider)) {
              yield* stream
                .markOnline({ streamId: provider.value.id, startedAt: provider.value.startedAt })
                .pipe(
                  Effect.catchTag("StreamLifecycleError", (error) =>
                    Effect.fail(streamLifecycleHttpFailure(error, reconcileChange)),
                  ),
                );

              if (!before.isLive) action = "set_online";
            } else {
              const now = yield* Clock.currentTimeMillis;

              // An ISO string produced by Date always satisfies IsoTimestamp; a decode failure would be a defect.
              const endedAt = yield* decodeIsoTimestamp(new Date(now).toISOString()).pipe(
                Effect.orDie,
              );

              yield* stream
                .markOffline({ endedAt })
                .pipe(
                  Effect.catchTag("StreamLifecycleError", (error) =>
                    Effect.fail(streamLifecycleHttpFailure(error, reconcileChange)),
                  ),
                );

              if (before.isLive) action = "set_offline";
            }

            let queueWarmup: TwitchStreamReconciliationResponse["queueWarmup"] = "not_needed";

            if (action === "set_online") {
              const warmup = yield* queue.getCurrentlyPlaying().pipe(Effect.result);
              queueWarmup = Result.isSuccess(warmup) ? "ok" : "error";
            }

            const after = yield* stream.getState().pipe(Effect.result);

            if (Result.isFailure(after))
              return yield* Effect.fail(
                new HttpBoundaryError({
                  operation: "callService",
                  status: 500,
                  failure: {
                    code: "StreamReconciliationUnconfirmed",
                    message: `Stream reconciliation unconfirmed: the ${action} reconciliation finished, but the final state could not be read (${after.failure.reason}). Read the stream state with GET /api/debug/stream-state.`,
                    details: { action, before },
                    retryable: false,
                  },
                }),
              );

            return yield* encodeHttpResponse(
              "streamLifecycle",
              TwitchStreamReconciliationResponse,
              {
                action,
                queueWarmup,
                before,
                after: after.success,
                twitch: {
                  isLive: Option.isSome(provider),
                  startedAt: Option.map(provider, (value) => value.startedAt),
                  viewerCount: Option.map(provider, (value) => value.viewerCount),
                  title: Option.map(provider, (value) => value.title),
                  gameName: Option.map(provider, (value) => value.gameName),
                },
              },
            );
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
            const streamInfo = Result.isSuccess(provider) ? provider.success : Option.none();

            return yield* encodeHttpResponse("streamLifecycle", TwitchDebugStatusResponse, {
              timestamp: new Date(now).toISOString(),
              stream: Result.isSuccess(state)
                ? {
                    ok: true,
                    isLive: Option.some(state.success.isLive),
                    startedAt: state.success.startedAt,
                    peakViewerCount: Option.some(state.success.peakViewerCount),
                    error: Option.none(),
                  }
                : {
                    ok: false,
                    isLive: Option.none(),
                    startedAt: Option.none(),
                    peakViewerCount: Option.none(),
                    error: Option.some(
                      streamLifecycleHttpFailure(state.failure, { kind: "repeatable" }).message,
                    ),
                  },
              twitch: {
                ok: Result.isSuccess(provider),
                isLive: Result.isSuccess(provider)
                  ? Option.some(Option.isSome(streamInfo))
                  : Option.none(),
                startedAt: Option.map(streamInfo, (value) => value.startedAt),
                viewerCount: Option.map(streamInfo, (value) => value.viewerCount),
                error: Result.isFailure(provider)
                  ? Option.some(
                      twitchProviderHttpFailure(provider.failure, "getStreamInfo", Option.none())
                        .message,
                    )
                  : Option.none(),
              },
              songQueue: Result.isSuccess(songs)
                ? {
                    ok: true,
                    queueLength: Option.some(songs.success.totalCount),
                    error: Option.none(),
                  }
                : {
                    ok: false,
                    queueLength: Option.none(),
                    error: Option.some(
                      songQueueHttpFailure(songs.failure, { kind: "repeatable" }).message,
                    ),
                  },
            });
          }),
        ),
      );
  }),
);
