import { cfTwitchInfrastructureStageConfig } from "@cf-twitch/shared-infrastructure";
import { expect } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import {
  IsoTimestamp,
  RedemptionId,
  SpotifyTrackId,
  ViewerId,
} from "@cf-twitch/contracts/identity";
import { Effect, Option } from "effect";
import { RequestHistoryQuery, SongQueueLimit } from "@cf-twitch/contracts/song-queue";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { SongQueueHttpApi } from "../song-queue-http-api.ts";
import { songQueueScenarioStack } from "./song-queue-scenario-worker.ts";

const stage = Effect.runSync(cfTwitchInfrastructureStageConfig);

const songQueueLimit = (value: number): SongQueueLimit => SongQueueLimit.make(value);

const { test } = Test.make({ providers: Cloudflare.providers(), adopt: false, dev: true, stage });

test.provider(
  "song queue physical DO SQL and execution-scoped HTTP client preserve attribution across requests",
  (stack) =>
    Effect.gen(function* () {
      const deployed = yield* stack.deploy(songQueueScenarioStack);
      yield* Effect.gen(function* () {
        const client = yield* HttpApiClient.makeWith(SongQueueHttpApi, {
          baseUrl: deployed.url,
          httpClient: yield* HttpClient.HttpClient,
        });

        const eventId = RedemptionId.make(crypto.randomUUID());

        const input = {
          eventId,
          track: {
            id: SpotifyTrackId.make("localtrack"),
            name: "Local track",
            artists: ["Local artist"],
            album: "Local album",
            albumCoverUrl: Option.none<string>(),
          },
          requesterUserId: ViewerId.make("viewer"),
          requesterDisplayName: "Local viewer",
          requestedAt: IsoTimestamp.make(new Date().toISOString()),
        };

        yield* client.songQueue.persistRequest({ payload: input }).pipe(Effect.scoped);
        yield* client.songQueue.persistRequest({ payload: input }).pipe(Effect.scoped);

        const queue = yield* client.songQueue
          .getSongQueue({ payload: { limit: songQueueLimit(10) } })
          .pipe(Effect.scoped);

        expect(queue.totalCount).toBe(2);
        expect(queue.tracks).toMatchObject([{ source: "user", eventId }, { source: "autoplay" }]);
        expect(yield* client.songQueue.getCurrentlyPlaying().pipe(Effect.scoped)).toEqual({
          track: Option.none(),
          position: 0,
        });
        expect(
          (yield* client.songQueue
            .getRequestHistory({
              payload: RequestHistoryQuery.make({
                limit: songQueueLimit(10),
                offset: 0,
                since: Option.none(),
                until: Option.none(),
              }),
            })
            .pipe(Effect.scoped)).totalCount,
        ).toBe(0);
        yield* client.songQueue.deleteRequest({ payload: { eventId } }).pipe(Effect.scoped);
        yield* client.songQueue.refreshQueue().pipe(Effect.scoped);

        const compensated = yield* client.songQueue
          .getSongQueue({ payload: { limit: songQueueLimit(10) } })
          .pipe(Effect.scoped);

        expect(compensated.tracks.every((track) => track.source === "autoplay")).toBe(true);
      }).pipe(Effect.provide(FetchHttpClient.layer));
    }),
);
