import { SqliteClient } from "@effect/sql-sqlite-node";
import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  EventId,
  IsoTimestamp,
  RedemptionId,
  SpotifyTrackId,
  ViewerId,
} from "@cf-twitch/contracts/identity";
import { SongRequestSuccessEvent } from "@cf-twitch/contracts/domain-event";
import { historicalAchievementStatements } from "./achievements-historical.fixture.ts";
import { achievementsLayer } from "./achievements-database.ts";
import { Achievements } from "./achievements-service.ts";

it.effect(
  "adopts the complete historical SQL state, not just the Agent live-stream projection",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      for (const statement of historicalAchievementStatements) yield* sql.unsafe(statement);
      const timestamp = IsoTimestamp.make("2026-04-07T14:00:00Z");
      const id = EventId.make("00000000-0000-4000-8000-000000000001");
      yield* sql`INSERT INTO user_achievements(id,user_id,user_display_name,achievement_id,progress,unlocked_at,announcement_state,event_id) VALUES ('progress','viewer','Viewer','first_request',1,${timestamp},'pending',NULL)`;
      yield* sql`INSERT INTO user_streaks(user_id,user_display_name,session_streak,longest_streak,last_request_at,session_started_at) VALUES ('viewer','Viewer',2,7,${timestamp},${timestamp})`;
      yield* sql`INSERT INTO event_history(id,event_type,user_id,user_display_name,event_id,timestamp,metadata) VALUES (${id},'song_request_success','viewer','Viewer',${id},${timestamp},'{}')`;
      yield* sql`INSERT INTO achievement_stream_session(singleton_id,status,stream_id,started_at,transition_at) VALUES (1,'online','historical-stream',${timestamp},${timestamp})`;
      yield* sql`INSERT INTO achievement_unlock_outbox(effect_id,event_id,user_id,user_display_name,achievement_id,achievement_name,achievement_description,category,metric_state,announcement_state,announcement_attempts,created_at,updated_at)
 VALUES (${`${id}:first_request`},${id},'viewer','Viewer','first_request','First Timer','Request your first song','song_request','claimed','sending',2,${timestamp},${timestamp})`;
      yield* Effect.gen(function* () {
        const achievements = yield* Achievements;
        expect(yield* achievements.getDebugTableCounts()).toEqual({
          definitions: 13,
          userAchievements: 1,
          unlockedAchievements: 1,
          userStreaks: 1,
          eventHistory: 1,
        });
        expect(
          (yield* achievements.getUnlockedAchievements({ userDisplayName: "Viewer" }))[0],
        ).toMatchObject({ id: "first_request", unlockedAt: timestamp });
        yield* achievements.handleEvent(
          SongRequestSuccessEvent.make({
            id,
            type: "song_request_success",
            v: 1,
            source: "SongRequestSagaDO",
            timestamp,
            correlationId: Option.none(),
            userId: ViewerId.make("viewer"),
            userDisplayName: "Viewer",
            sagaId: RedemptionId.make("historical"),
            trackId: SpotifyTrackId.make("track"),
          }),
        );
        expect(yield* sql`SELECT session_streak,longest_streak FROM user_streaks`).toEqual([
          { session_streak: 2, longest_streak: 7 },
        ]);
        expect(
          yield* sql`SELECT status,stream_id,transition_at FROM achievement_stream_session`,
        ).toEqual([{ status: "online", stream_id: "historical-stream", transition_at: timestamp }]);
        expect(
          yield* sql`SELECT metric_state,announcement_state,announcement_attempts FROM achievement_unlock_outbox`,
        ).toEqual([
          { metric_state: "claimed", announcement_state: "uncertain", announcement_attempts: 2 },
        ]);
      }).pipe(Effect.provide(achievementsLayer));
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
);
