import { Clock, Effect, Option, Schema } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpServerResponse } from "effect/unstable/http";
import { TwitchHttpApi } from "@cf-twitch/contracts/twitch-api";
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

const decodeTimestamp = Schema.decodeEffect(IsoTimestamp);

const encodeStreamState = Schema.encodeEffect(StreamLifecycleState);

const failure = (error: string) => () => new HttpBoundaryError({ status: 500, error });

const debugSongQueueLimit = SongQueueLimit.make(5);

/** Debug reconciliation replays same-state effects and preserves Twitch's authoritative start timestamp. */
export const twitchDebugHandlersLayer = HttpApiBuilder.group(TwitchHttpApi, "debug", (handlers) =>
  Effect.gen(function* () {
    const configuration = yield* TwitchConfiguration;
    const stream = yield* StreamLifecycleClient;
    const twitch = yield* TwitchService;
    const queue = yield* SongQueue;
    const raffle = yield* Raffle;

    const admin = <R>(
      effect: Effect.Effect<HttpServerResponse.HttpServerResponse, HttpBoundaryError, R>,
    ) =>
      requireHttpAdministrator(configuration.administratorSecret, "Debug API").pipe(
        Effect.andThen(effect),
        handleHttpBoundary,
      );

    return handlers
      .handleRaw("streamState", () =>
        admin(
          stream.getState().pipe(
            Effect.mapError(failure("Failed to fetch stream state")),
            Effect.flatMap((value) => encodeHttpResponse(StreamLifecycleState, value)),
          ),
        ),
      )
      .handleRaw("raffleLeaderboardDebug", () =>
        admin(
          Effect.gen(function* () {
            const { limit, sortBy } = yield* parseHttpLeaderboardQuery();

            const value = yield* raffle
              .getLeaderboard({ limit: Option.some(limit), sortBy })
              .pipe(
                Effect.mapError(
                  (error) => new HttpBoundaryError({ status: 500, error: error.message }),
                ),
              );

            return yield* encodeHttpResponse(Schema.Array(RaffleLeaderboardEntry), value);
          }),
        ),
      )
      .handleRaw("reconcileStream", () =>
        admin(
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

            if (beforeResult._tag === "Failure")
              return yield* Effect.fail(
                new HttpBoundaryError({
                  status: 500,
                  error: "Failed to fetch current stream state",
                }),
              );

            if (providerResult._tag === "Failure")
              return yield* Effect.fail(
                new HttpBoundaryError({
                  status: 500,
                  error: "Failed to fetch Twitch stream status",
                }),
              );
            const before = beforeResult.success;
            const provider = providerResult.success;
            let action: "noop" | "set_online" | "set_offline" = "noop";

            if (Option.isSome(provider)) {
              yield* stream
                .markOnline({ streamId: provider.value.id, startedAt: provider.value.startedAt })
                .pipe(Effect.mapError(failure("Failed to reconcile online stream state")));

              if (!before.isLive) action = "set_online";
            } else {
              const now = yield* Clock.currentTimeMillis;

              const endedAt = yield* decodeTimestamp(new Date(now).toISOString()).pipe(
                Effect.orDie,
              );

              yield* stream
                .markOffline({ endedAt })
                .pipe(Effect.mapError(failure("Failed to reconcile offline stream state")));

              if (before.isLive) action = "set_offline";
            }

            let queueWarmup: "not_needed" | "ok" | "error" = "not_needed";

            if (action === "set_online") {
              const warmup = yield* queue.getCurrentlyPlaying().pipe(Effect.result);
              queueWarmup = warmup._tag === "Success" ? "ok" : "error";
            }

            const after = yield* stream.getState().pipe(Effect.result);

            const encodedBefore = yield* encodeStreamState(before).pipe(
              Effect.mapError(failure("Invalid service response")),
            );

            if (after._tag === "Failure")
              return HttpServerResponse.jsonUnsafe(
                {
                  error: "Reconciliation completed but failed to read final state",
                  action,
                  before: encodedBefore,
                },
                { status: 500 },
              );

            const encodedAfter = yield* encodeStreamState(after.success).pipe(
              Effect.mapError(failure("Invalid service response")),
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
              stream:
                state._tag === "Success"
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
              twitch:
                provider._tag === "Success"
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
              songQueue:
                songs._tag === "Success"
                  ? { ok: true, queueLength: songs.success.totalCount, error: null }
                  : { ok: false, queueLength: null, error: songs.failure.message },
            });
          }),
        ),
      );
  }),
);
