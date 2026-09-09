import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { Effect, Layer, Option, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import { RedemptionId } from "@cf-twitch/contracts/identity";
import {
  RaffleClosestRecord,
  RaffleDistance,
  RaffleError,
  RaffleLeaderboardEntry,
  type RaffleRecordResult,
  RaffleRoll,
  RecordRaffleRoll,
} from "@cf-twitch/contracts/raffle";
import { Raffle } from "./raffle-service.ts";
import { RaffleRandom, raffleRandomLayer } from "./raffle-random.ts";

const RaffleStoredRow = Schema.Struct({
  ...RecordRaffleRoll.fields,
  distance: RaffleDistance,
  isWinner: Schema.Literals([0, 1]),
  isNewRecord: Schema.Literals([0, 1]),
});

const parseStoredRolls = Schema.decodeUnknownEffect(Schema.Array(RaffleStoredRow));

const refineStoredRoll = Schema.decodeEffect(RaffleRoll);

const parseLeaderboard = Schema.decodeUnknownEffect(Schema.Array(RaffleLeaderboardEntry));

const parseTombstones = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: RedemptionId })),
);

const parseClosest = Schema.decodeUnknownEffect(Schema.Array(RaffleClosestRecord));

const parseBest = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ distance: Schema.NullOr(Schema.Int) })),
);

const raffleMigration = Effect.gen(function* () {
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

const raffleCompensationMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS raffle_compensated_rolls (id TEXT PRIMARY KEY NOT NULL)`;
});

const raffleMigrationLoader = SqliteMigrator.fromRecord({
  "1_adopt_raffle_sql": raffleMigration,
  "2_fence_raffle_compensation": raffleCompensationMigration,
});

const raffleFailure = (operation: string) =>
  Effect.mapError((error: Schema.SchemaError | SqlError.SqlError | RaffleError) =>
    error._tag === "RaffleError"
      ? error
      : new RaffleError({
          operation,
          reason: error._tag === "SchemaError" ? "invalid_stored_data" : "persistence_unavailable",
        }),
  );

/** Acquires raffle SQL at runtime and adopts the baseline tables without deleting evidence. */
export const makeRaffle = Effect.gen(function* () {
  yield* SqliteMigrator.run({ loader: raffleMigrationLoader, table: "raffle_effect_migrations" });
  const sql = yield* SqlClient.SqlClient;
  const random = yield* RaffleRandom;

  const findReceipt = Effect.fn("Raffle.findReceipt")(function* (id: RedemptionId) {
    const rows = yield* parseStoredRolls(
      yield* sql`SELECT id,user_id AS userId,display_name AS displayName,roll,winning_number AS winningNumber,distance,is_winner AS isWinner,is_new_record AS isNewRecord,rolled_at AS rolledAt FROM raffle_roll_receipts WHERE id=${id}`,
    );

    const row = rows[0];

    if (!row) return Option.none<RaffleRoll>();

    return Option.some(
      yield* refineStoredRoll({
        ...row,
        isWinner: row.isWinner === 1,
        isNewRecord: row.isNewRecord === 1,
      }),
    );
  });

  const ensureNotCompensated = Effect.fn("Raffle.ensureNotCompensated")(function* (
    id: RedemptionId,
  ) {
    const rows = yield* parseTombstones(
      yield* sql`SELECT id FROM raffle_compensated_rolls WHERE id=${id}`,
    );

    if (rows.length > 0)
      return yield* new RaffleError({ operation: "createRoll", reason: "compensated" });
  });

  const insertRoll = Effect.fn("Raffle.insertRoll")(function* (input: RecordRaffleRoll) {
    const best = yield* parseBest(
      yield* sql`SELECT MIN(distance) distance FROM rolls WHERE distance>0`,
    );

    const distance = RaffleDistance.make(Math.abs(input.roll - input.winningNumber));
    const previous = best[0]?.distance;

    const isNewRecord =
      distance > 0 && (previous === null || previous === undefined || distance < previous);

    const roll = RaffleRoll.make({
      id: input.id,
      userId: input.userId,
      displayName: input.displayName,
      roll: input.roll,
      winningNumber: input.winningNumber,
      rolledAt: input.rolledAt,
      distance,
      isWinner: distance === 0,
      isNewRecord,
    });

    const values = {
      id: roll.id,
      user_id: roll.userId,
      display_name: roll.displayName,
      roll: roll.roll,
      winning_number: roll.winningNumber,
      distance,
      is_winner: roll.isWinner ? 1 : 0,
      is_new_record: isNewRecord ? 1 : 0,
      rolled_at: roll.rolledAt,
    };

    yield* sql`INSERT INTO rolls ${sql.insert(values)}`;
    yield* sql`INSERT INTO raffle_roll_receipts ${sql.insert(values)}`;

    return { roll } satisfies RaffleRecordResult;
  });

  const recordRoll = Effect.fn("Raffle.recordRoll")(function* (input: RecordRaffleRoll) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* findReceipt(input.id);

        if (Option.isSome(existing)) {
          const roll = existing.value;

          if (
            roll.userId !== input.userId ||
            roll.displayName !== input.displayName ||
            roll.roll !== input.roll ||
            roll.winningNumber !== input.winningNumber ||
            roll.rolledAt !== input.rolledAt
          )
            return yield* new RaffleError({
              operation: "recordRoll",
              reason: "idempotency_conflict",
            });

          return { roll } satisfies RaffleRecordResult;
        }

        yield* ensureNotCompensated(input.id);

        return yield* insertRoll(input);
      }),
    );
  }, raffleFailure("recordRoll"));

  const getOrCreateRoll = Effect.fn("Raffle.getOrCreateRoll")(function* (
    input: Omit<RecordRaffleRoll, "roll" | "winningNumber">,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* findReceipt(input.id);

        if (Option.isSome(existing)) {
          const roll = existing.value;

          if (
            roll.userId !== input.userId ||
            roll.displayName !== input.displayName ||
            roll.rolledAt !== input.rolledAt
          )
            return yield* new RaffleError({
              operation: "getOrCreateRoll",
              reason: "idempotency_conflict",
            });

          return { roll } satisfies RaffleRecordResult;
        }

        yield* ensureNotCompensated(input.id);
        const roll = yield* random.drawNumber();
        const winningNumber = yield* random.drawNumber();

        return yield* insertRoll({ ...input, roll, winningNumber });
      }),
    );
  }, raffleFailure("getOrCreateRoll"));

  const leaderboardColumns = sql.literal(
    "user_id AS userId, display_name AS displayName, total_rolls AS totalRolls, total_wins AS totalWins, closest_distance AS closestDistance, closest_roll AS closestRoll, closest_winning_number AS closestWinningNumber, last_rolled_at AS lastRolledAt",
  );

  return Raffle.of({
    recordRoll,
    getOrCreateRoll,
    deleteRollById: Effect.fn("Raffle.deleteRollById")(function* (input) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT OR IGNORE INTO raffle_compensated_rolls(id) VALUES (${input.rollId})`;
          yield* sql`DELETE FROM rolls WHERE id=${input.rollId}`;
        }),
      );
    }, raffleFailure("deleteRollById")),
    getLeaderboard: Effect.fn("Raffle.getLeaderboard")(function* (input) {
      const order =
        input.sortBy === "rolls"
          ? sql.literal("total_rolls DESC")
          : input.sortBy === "wins"
            ? sql.literal("total_wins DESC")
            : sql.literal("closest_distance ASC NULLS LAST");

      return yield* parseLeaderboard(
        yield* sql`SELECT ${leaderboardColumns} FROM raffle_leaderboard ORDER BY ${order}, user_id ASC LIMIT ${Option.getOrElse(input.limit, () => 10)}`,
      );
    }, raffleFailure("getLeaderboard")),
    getUserStats: Effect.fn("Raffle.getUserStats")(function* (input) {
      const rows = yield* parseLeaderboard(
        yield* sql`SELECT ${leaderboardColumns} FROM raffle_leaderboard WHERE user_id=${input.userId} LIMIT 1`,
      );

      return Option.fromNullishOr(rows[0]);
    }, raffleFailure("getUserStats")),
    getUserStatsByDisplayName: Effect.fn("Raffle.getUserStatsByDisplayName")(function* (input) {
      const rows = yield* parseLeaderboard(
        yield* sql`SELECT ${leaderboardColumns} FROM raffle_leaderboard WHERE display_name=${input.displayName} LIMIT 1`,
      );

      return Option.fromNullishOr(rows[0]);
    }, raffleFailure("getUserStatsByDisplayName")),
    getClosestRecord: Effect.fn("Raffle.getClosestRecord")(function* () {
      const rows = yield* parseClosest(
        yield* sql`SELECT user_id AS userId,display_name AS displayName,closest_distance AS distance FROM raffle_leaderboard WHERE closest_distance>0 ORDER BY closest_distance,user_id LIMIT 1`,
      );

      return Option.fromNullishOr(rows[0]);
    }, raffleFailure("getClosestRecord")),
  });
});

/** Provides raffle persistence with explicit SQL and secure randomness requirements. */
export const raffleLayerWithoutDependencies = Layer.effect(Raffle, makeRaffle);

/** Provides raffle persistence with Web Crypto; SQL remains instance scoped. */
export const raffleLayer = raffleLayerWithoutDependencies.pipe(Layer.provide(raffleRandomLayer));
