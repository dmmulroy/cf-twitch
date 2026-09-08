import { SqliteClient } from "@effect/sql-sqlite-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter } from "effect/unstable/http";
import { TwitchAdminApi } from "@cf-twitch/contracts/twitch-api";
import { EventBusError } from "@cf-twitch/contracts/event-bus";
import { AchievementId } from "@cf-twitch/contracts/achievement";
import { commandsDatabaseLayerWithoutDependencies } from "../commands/commands-database.ts";
import { EventBusAdministration } from "../events/event-bus-service.ts";
import { Achievements } from "../achievements/achievements-service.ts";
import { Raffle } from "../raffle/raffle-service.ts";
import { SongQueue } from "../song-queue/song-queue.ts";
import { TwitchConfiguration } from "../../runtime/twitch-configuration.ts";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { twitchAdminHandlersLayer } from "./twitch-admin-handlers.ts";
import { httpTestConfiguration } from "./http-test-fixtures.ts";

const deliveredEventId = "00000000-0000-4000-8000-000000000001";
const retainedEventId = "00000000-0000-4000-8000-000000000002";
const missingEventId = "00000000-0000-4000-8000-000000000003";
const adminApi = HttpApi.make("TwitchHttpApi").add(TwitchAdminApi);
const withAdmin = <A, E, R>(
  test: (fetch: (request: Request) => Promise<Response>) => Effect.Effect<A, E, R>,
) => {
  const layers = Layer.mergeAll(
    commandsDatabaseLayerWithoutDependencies.pipe(
      Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
    ),
    Layer.succeed(TwitchConfiguration, httpTestConfiguration),
    Layer.mock(EventBusAdministration, {
      listPending: ({ limit, offset }) =>
        Effect.succeed({ items: [], totalCount: 0, limit, offset }),
      listDeadLetters: ({ limit, offset }) =>
        Effect.succeed({ items: [], totalCount: 0, limit, offset }),
      replayDeadLetter: ({ eventId }) =>
        eventId === missingEventId
          ? Effect.fail(
              new EventBusError({
                operation: "replayDeadLetter",
                reason: "event_not_found",
                eventId: Option.some(eventId),
              }),
            )
          : Effect.succeed({
              success: eventId === deliveredEventId,
              eventId,
              error:
                eventId === deliveredEventId ? Option.none() : Option.some("Consumer unavailable"),
            }),
      deleteDeadLetter: ({ eventId }) =>
        eventId === missingEventId
          ? Effect.fail(
              new EventBusError({
                operation: "deleteDeadLetter",
                reason: "event_not_found",
                eventId: Option.some(eventId),
              }),
            )
          : Effect.void,
    }),
    Layer.mock(Achievements, {
      getDefinitions: () => Effect.succeed([]),
      getUnlockedAchievements: () => Effect.succeed([]),
      resetOneTimeAchievements: ({ userDisplayName }) =>
        Effect.succeed({
          deleted: Option.isNone(userDisplayName) ? 2 : 0,
          achievementIds: [Schema.decodeSync(AchievementId)("close_call")],
        }),
      getDebugTableCounts: () =>
        Effect.succeed({
          definitions: 13,
          userAchievements: 0,
          unlockedAchievements: 0,
          userStreaks: 0,
          eventHistory: 0,
        }),
      getDebugUserSnapshot: ({ userDisplayName }) =>
        Effect.succeed({
          requestedUser: userDisplayName,
          normalizedUser: userDisplayName.toLowerCase(),
          exactUserAchievementRows: 0,
          caseInsensitiveUserAchievementRows: 0,
          exactUnlockedRows: 0,
          caseInsensitiveUnlockedRows: 0,
          exactStreakRows: 0,
          caseInsensitiveStreakRows: 0,
          exactEventHistoryRows: 0,
          caseInsensitiveEventHistoryRows: 0,
          recentEvents: [],
          similarUsers: [],
        }),
    }),
    Layer.mock(SongQueue, { getUserRequestCountByDisplayName: () => Effect.succeed(0) }),
    Layer.mock(Raffle, { getUserStatsByDisplayName: () => Effect.succeed(Option.none()) }),
  );
  const api = HttpApiBuilder.layer(adminApi).pipe(
    Layer.provide(twitchAdminHandlersLayer),
    Layer.provide(layers),
    Layer.provide(cloudflareHttpServerLayer),
  );
  return Effect.acquireUseRelease(
    Effect.sync(() => HttpRouter.toWebHandler(api, { disableLogger: true })),
    ({ handler }) => test(handler),
    ({ dispose }) => Effect.promise(dispose),
  );
};
const adminRequest = (path: string, method = "GET", body?: Schema.Json) => {
  const init: RequestInit = {
    method,
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`https://worker.test/api/admin${path}`, init);
};

describe("administrator HTTP with real SQLite command registry", () => {
  it.live(
    "creates, patches, snapshots and deletes through external HTTP without losing null wire fields",
    () =>
      withAdmin((fetch) =>
        Effect.gen(function* () {
          const create = yield* Effect.promise(() =>
            fetch(
              adminRequest("/commands", "POST", {
                name: "integration",
                description: "HTTP integration",
                category: "info",
                responseType: "static",
                permission: "everyone",
                initialValue: "A test value",
              }),
            ),
          );
          expect(create.status).toBe(201);
          expect(yield* Effect.promise(() => create.json())).toMatchObject({
            name: "integration",
            enabled: true,
            counterSourceName: null,
            writePermission: null,
          });
          const patch = yield* Effect.promise(() =>
            fetch(adminRequest("/commands/integration", "PATCH", { enabled: false })),
          );
          expect(patch.status).toBe(200);
          expect(yield* Effect.promise(() => patch.json())).toMatchObject({ enabled: false });
          const snapshot = yield* Effect.promise(() =>
            fetch(adminRequest("/commands/debug/snapshot")),
          );
          expect(snapshot.status).toBe(200);
          expect(yield* Effect.promise(() => snapshot.json())).toMatchObject({
            commands: expect.arrayContaining([
              expect.objectContaining({
                name: "integration",
                value: "A test value",
                counter: null,
              }),
            ]),
          });
          const deletion = yield* Effect.promise(() =>
            fetch(adminRequest("/commands/integration", "DELETE")),
          );
          expect(deletion.status).toBe(200);
          expect(yield* Effect.promise(() => deletion.json())).toEqual({
            message: "Command deleted",
            command: "integration",
          });
          const missing = yield* Effect.promise(() =>
            fetch(adminRequest("/commands/integration", "DELETE")),
          );
          expect(missing.status).toBe(404);
          expect(yield* Effect.promise(() => missing.json())).toMatchObject({
            code: "CommandNotFoundError",
          });
        }),
      ),
  );

  it.live(
    "preserves precise conflicts and rejects unknown, empty and incomplete command patches",
    () =>
      withAdmin((fetch) =>
        Effect.gen(function* () {
          const duplicate = yield* Effect.promise(() =>
            fetch(
              adminRequest("/commands", "POST", {
                name: "keyboard",
                description: "Duplicate",
                category: "info",
                responseType: "static",
                permission: "everyone",
              }),
            ),
          );
          expect(duplicate.status).toBe(409);
          expect(yield* Effect.promise(() => duplicate.json())).toMatchObject({
            code: "CommandAlreadyExistsError",
          });
          for (const patch of [{ enable: false }, {}, { responseType: "computed" }]) {
            const response = yield* Effect.promise(() =>
              fetch(adminRequest("/commands/keyboard", "PATCH", patch)),
            );
            expect(response.status).toBe(400);
          }
        }),
      ),
  );

  it.live("preserves replay-failed 200, missing 404, pagination and reset envelopes", () =>
    withAdmin((fetch) =>
      Effect.gen(function* () {
        const pending = yield* Effect.promise(() =>
          fetch(adminRequest("/event-bus/pending?limit=4&offset=2")),
        );
        expect(yield* Effect.promise(() => pending.json())).toEqual({
          items: [],
          totalCount: 0,
          limit: 4,
          offset: 2,
        });
        const delivered = yield* Effect.promise(() =>
          fetch(adminRequest(`/dlq/${deliveredEventId}/replay`, "POST")),
        );
        expect(yield* Effect.promise(() => delivered.json())).toEqual({
          message: "Event replayed successfully",
          eventId: deliveredEventId,
        });
        const retained = yield* Effect.promise(() =>
          fetch(adminRequest(`/dlq/${retainedEventId}/replay`, "POST")),
        );
        expect(retained.status).toBe(200);
        expect(yield* Effect.promise(() => retained.json())).toEqual({
          message: "Replay failed - event remains in DLQ",
          eventId: retainedEventId,
          error: "Consumer unavailable",
        });
        for (const [path, method] of [
          [`/dlq/${missingEventId}/replay`, "POST"],
          [`/dlq/${missingEventId}`, "DELETE"],
        ] as const) {
          expect((yield* Effect.promise(() => fetch(adminRequest(path, method)))).status).toBe(404);
        }
        const reset = yield* Effect.promise(() =>
          fetch(adminRequest("/achievements/reset-one-time", "POST")),
        );
        expect(yield* Effect.promise(() => reset.json())).toEqual({
          message: "One-time achievements reset",
          deleted: 2,
          achievementIds: ["close_call"],
          user: "all",
        });
        const absent = yield* Effect.promise(() =>
          fetch(adminRequest("/achievements/reset-one-time?user=Missing", "POST")),
        );
        expect(absent.status).toBe(404);
      }),
    ),
  );

  it.live("returns achievement diagnostics and the no-records stats preview", () =>
    withAdmin((fetch) =>
      Effect.gen(function* () {
        const counts = yield* Effect.promise(() =>
          fetch(adminRequest("/achievements/debug/counts")),
        );
        expect(yield* Effect.promise(() => counts.json())).toMatchObject({ definitions: 13 });
        const snapshot = yield* Effect.promise(() =>
          fetch(adminRequest("/achievements/debug/user/Viewer")),
        );
        expect(yield* Effect.promise(() => snapshot.json())).toMatchObject({
          requestedUser: "Viewer",
          normalizedUser: "viewer",
          recentEvents: [],
        });
        const preview = yield* Effect.promise(() => fetch(adminRequest("/debug/stats/%40Viewer")));
        expect(yield* Effect.promise(() => preview.json())).toMatchObject({
          targetUser: "Viewer",
          noStatsForTargetUser: true,
          chatMessage:
            "No records found for @Viewer yet — no songs, achievements, or raffle stats.",
        });
      }),
    ),
  );
});
