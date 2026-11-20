import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** Migration that adopts the baseline raffle tables and view, failing with `SqlError` on a pre-baseline schema. */
const adoptRaffleSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  for (const table of ["rolls", "raffle_roll_receipts"]) {
    yield* sql`CREATE TABLE IF NOT EXISTS ${sql(table)} (
 id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL CHECK(length(user_id)>0), display_name TEXT NOT NULL CHECK(length(display_name)>0),
 roll INTEGER NOT NULL CHECK(roll BETWEEN 1 AND 10000), winning_number INTEGER NOT NULL CHECK(winning_number BETWEEN 1 AND 10000),
 distance INTEGER NOT NULL CHECK(distance = abs(roll-winning_number)), is_winner INTEGER NOT NULL CHECK(is_winner = (distance=0)),
 is_new_record INTEGER NOT NULL CHECK(is_new_record IN (0,1) AND NOT(is_winner=1 AND is_new_record=1)), rolled_at TEXT NOT NULL)`;
  }

  // Receipt evidence survives compensation so a delayed workflow cannot draw again or resurrect a removed roll.
  yield* sql`INSERT OR IGNORE INTO raffle_roll_receipts SELECT * FROM rolls`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_rolls_user_id ON rolls(user_id)`;
  yield* sql`CREATE VIEW IF NOT EXISTS raffle_leaderboard AS
 WITH aggregates AS (SELECT user_id, COUNT(*) total_rolls, SUM(is_winner) total_wins, MAX(rolled_at) last_rolled_at FROM rolls GROUP BY user_id),
 closest AS (SELECT DISTINCT user_id, FIRST_VALUE(distance) OVER w closest_distance, FIRST_VALUE(roll) OVER w closest_roll,
 FIRST_VALUE(winning_number) OVER w closest_winning_number FROM rolls WHERE is_winner=0 WINDOW w AS (PARTITION BY user_id ORDER BY distance ASC)),
 latest AS (SELECT DISTINCT user_id, FIRST_VALUE(display_name) OVER (PARTITION BY user_id ORDER BY rolled_at DESC) display_name FROM rolls)
 SELECT a.user_id,l.display_name,a.total_rolls,a.total_wins,c.closest_distance,c.closest_roll,c.closest_winning_number,a.last_rolled_at
 FROM aggregates a JOIN latest l ON a.user_id=l.user_id LEFT JOIN closest c ON a.user_id=c.user_id`;
  // Fails closed on pre-baseline databases missing immutable record evidence.
  yield* sql`SELECT is_new_record FROM rolls LIMIT 0`;
});

/** Migration that adds compensation tombstones, failing with `SqlError` when the table cannot be created. */
const fenceRaffleCompensation = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS raffle_compensated_rolls (id TEXT PRIMARY KEY NOT NULL)`;
});

/**
 * Migration loader that adopts the baseline raffle SQL and adds compensation tombstones.
 *
 * **Details**
 *
 * Adoption never deletes roll evidence. A pre-baseline database without `is_new_record` fails closed
 * rather than recomputing historical record decisions: running the loader with `SqliteMigrator.run`
 * then fails with `MigrationError` or `SqlError`.
 */
export const raffleMigrationLoader = SqliteMigrator.fromRecord({
  "1_adopt_raffle_sql": adoptRaffleSchema,
  "2_fence_raffle_compensation": fenceRaffleCompensation,
});
