import { SqliteMigrator } from "@effect/sql-sqlite-do";
import {
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Schema,
  SchemaGetter,
  SynchronizedRef,
} from "effect";
import { SqlClient, type SqlError } from "effect/sql";
import { RedemptionId, type ViewerId } from "@cf-twitch/contracts/identity";
import {
  RaffleClosestRecord,
  RaffleDistance,
  RaffleError,
  type RaffleErrorIdentifiers,
  RaffleLeaderboardEntry,
  type RaffleLeaderboardQuery,
  type RaffleOperation,
  type RaffleRecordResult,
  RaffleRoll,
  RecordRaffleRoll,
  raffleErrorIdentifiersForDisplayName,
  raffleErrorIdentifiersForRoll,
  raffleErrorIdentifiersForRollRemoval,
  raffleErrorIdentifiersForViewer,
  raffleErrorWithoutIdentifiers,
} from "@cf-twitch/contracts/raffle";
import { raffleMigrationLoader } from "./raffle-migrations.ts";
import { RaffleRandom, raffleRandomLayer, raffleRandomTestLayer } from "./raffle-random.ts";

/** Keyboard Raffle authority that owns immutable Rolls, compensation tombstones, and Raffle Leaderboard evidence. */
export interface IRaffle {
  /**
   * Records explicit historical Roll evidence, or replays the Roll already recorded for its redemption.
   *
   * @returns The recorded Roll. Fails with `RaffleError` `idempotency_conflict` when the redemption
   *   already has a Roll with different evidence, `compensated` when the redemption was cancelled,
   *   `invalid_stored_data` when stored Rolls fail validation, or `persistence_unavailable`,
   *   `invalid_response`, or `transport_unavailable` when storage or the raffle server is unavailable.
   */
  readonly recordRoll: (input: RecordRaffleRoll) => Effect.Effect<RaffleRecordResult, RaffleError>;
  /**
   * Draws and records one secure Roll per redemption, or replays the Roll already recorded for it.
   *
   * @returns The recorded Roll. Fails with `RaffleError` `idempotency_conflict` when the redemption
   *   already has a Roll for a different Viewer, display name, or time, `compensated` when the
   *   redemption was cancelled, `randomness_unavailable` when secure randomness fails, or the storage
   *   and transport reasons listed on `recordRoll`.
   */
  readonly getOrCreateRoll: (
    input: RaffleDrawRequest,
  ) => Effect.Effect<RaffleRecordResult, RaffleError>;
  /**
   * Removes a Roll from the Raffle Leaderboard and fences its redemption against later recording.
   *
   * **Details**
   *
   * The immutable receipt is retained, so a delayed workflow cannot draw again or resurrect the Roll.
   * Removing an already removed or never recorded Roll succeeds.
   *
   * @returns Nothing. Fails with `RaffleError` `persistence_unavailable`, `invalid_response`, or
   *   `transport_unavailable` when storage or the raffle server is unavailable.
   */
  readonly deleteRollById: (input: {
    readonly rollId: RedemptionId;
  }) => Effect.Effect<void, RaffleError>;
  /**
   * Ranks Viewers by active Rolls; `closest` excludes winning Rolls and lists Viewers without one last.
   *
   * @returns At most the requested number of rows. Fails with `RaffleError` `invalid_stored_data`,
   *   `persistence_unavailable`, `invalid_response`, or `transport_unavailable`.
   */
  readonly getLeaderboard: (
    input: RaffleLeaderboardQuery,
  ) => Effect.Effect<ReadonlyArray<RaffleLeaderboardEntry>, RaffleError>;
  /**
   * Returns one Viewer's Raffle Leaderboard statistics by stable Viewer ID.
   *
   * @returns The statistics, or `None` when the Viewer has no active Rolls. Fails with the same
   *   `RaffleError` reasons as `getLeaderboard`.
   */
  readonly getUserStats: (input: {
    readonly userId: ViewerId;
  }) => Effect.Effect<Option.Option<RaffleLeaderboardEntry>, RaffleError>;
  /**
   * Returns Raffle Leaderboard statistics for the Viewer whose latest display name matches exactly.
   *
   * @returns The statistics, or `None` when no Viewer's latest display name matches. Fails with the
   *   same `RaffleError` reasons as `getLeaderboard`.
   */
  readonly getUserStatsByDisplayName: (input: {
    readonly displayName: string;
  }) => Effect.Effect<Option.Option<RaffleLeaderboardEntry>, RaffleError>;
  /**
   * Returns the strictly closest stream-wide non-winning active Roll.
   *
   * @returns The record holder, or `None` when no non-winning Roll exists. Fails with the same
   *   `RaffleError` reasons as `getLeaderboard`.
   */
  readonly getClosestRecord: () => Effect.Effect<Option.Option<RaffleClosestRecord>, RaffleError>;
}

/** Service tag shared by the SQL raffle authority and its Durable Object HTTP client. */
export class Raffle extends Context.Service<Raffle, IRaffle>()("@cf-twitch/Raffle") {}

/** Input for drawing a new Roll: the Roll evidence without its numbers, which the raffle draws. */
export type RaffleDrawRequest = Omit<RecordRaffleRoll, "roll" | "winningNumber">;

const RaffleStoredRow = Schema.Struct({
  ...RecordRaffleRoll.fields,
  distance: RaffleDistance,
  isWinner: Schema.Literals([0, 1]),
  isNewRecord: Schema.Literals([0, 1]),
});

/** Codec between a stored Roll row, whose flags SQLite keeps as 0 or 1, and a validated `RaffleRoll`. */
const StoredRaffleRoll = Schema.toEncoded(RaffleStoredRow).pipe(
  Schema.decodeTo(RaffleRoll, {
    decode: SchemaGetter.transform((row) => ({
      ...row,
      isWinner: row.isWinner === 1,
      isNewRecord: row.isNewRecord === 1,
    })),
    encode: SchemaGetter.transform((roll) => ({
      ...roll,
      isWinner: roll.isWinner ? 1 : 0,
      isNewRecord: roll.isNewRecord ? 1 : 0,
    })),
  }),
);

const parseStoredRolls = Schema.decodeUnknownEffect(Schema.Array(StoredRaffleRoll));

const encodeStoredRoll = Schema.encodeEffect(StoredRaffleRoll);

const recordRaffleRollEquivalence = Schema.toEquivalence(RecordRaffleRoll);

const parseLeaderboard = Schema.decodeUnknownEffect(Schema.Array(RaffleLeaderboardEntry));

const parseTombstones = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ id: RedemptionId })),
);

const parseClosest = Schema.decodeUnknownEffect(Schema.Array(RaffleClosestRecord));

/** Parses `MIN(distance)` over active non-winning Rolls; SQLite returns `null` when there are none. */
const parseBest = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ distance: Schema.NullOr(Schema.Int) })),
);

/**
 * Returns an `Effect.fn` transform that translates raffle storage failures into `RaffleError`.
 *
 * `identify` derives the error's safe identifiers from the operation's own arguments. An existing
 * `RaffleError` passes through unchanged; any other failure type is a compile error until classified.
 *
 * @returns A transform whose effect fails only with `RaffleError`: `invalid_stored_data` for
 *   `SchemaError` and `persistence_unavailable` for `SqlError`.
 */
const translateRaffleStorageErrors =
  <Args extends ReadonlyArray<unknown>>(
    operation: RaffleOperation,
    identify: (...args: Args) => RaffleErrorIdentifiers,
  ) =>
  <A>(
    effect: Effect.Effect<A, RaffleError | Schema.SchemaError | SqlError.SqlError>,
    ...args: Args
  ): Effect.Effect<A, RaffleError> => {
    const identifiers = identify(...args);

    return effect.pipe(
      Effect.catchTags({
        RaffleError: (error) => Effect.fail(error),
        SchemaError: () =>
          Effect.fail(
            new RaffleError({ operation, reason: "invalid_stored_data", ...identifiers }),
          ),
        SqlError: () =>
          Effect.fail(
            new RaffleError({ operation, reason: "persistence_unavailable", ...identifiers }),
          ),
      }),
    );
  };

/** Builds a new Roll from its drawn numbers, deciding its record status against the current best Distance. */
const deriveRaffleRoll = (
  input: RecordRaffleRoll,
  bestDistance: Option.Option<number>,
): RaffleRoll => {
  const distance = RaffleDistance.make(Math.abs(input.roll - input.winningNumber));

  return RaffleRoll.make({
    id: input.id,
    userId: input.userId,
    displayName: input.displayName,
    roll: input.roll,
    winningNumber: input.winningNumber,
    rolledAt: input.rolledAt,
    distance,
    isWinner: distance === 0,
    isNewRecord:
      distance > 0 &&
      Option.match(bestDistance, { onNone: () => true, onSome: (best) => distance < best }),
  });
};

/** Returns whether a replayed draw request matches the Roll already recorded for its redemption. */
const raffleDrawRequestMatches = (roll: RaffleRoll, input: RaffleDrawRequest): boolean =>
  roll.userId === input.userId &&
  roll.displayName === input.displayName &&
  roll.rolledAt === input.rolledAt;

const raffleConflict = (operation: RaffleOperation, identifiers: RaffleErrorIdentifiers) =>
  new RaffleError({ operation, reason: "idempotency_conflict", ...identifiers });

const raffleCompensated = (operation: RaffleOperation, identifiers: RaffleErrorIdentifiers) =>
  new RaffleError({ operation, reason: "compensated", ...identifiers });

/**
 * Effect that builds the SQL raffle authority over the Durable Object's SQLite storage.
 *
 * **Details**
 *
 * Runs the raffle migrations before returning, adopting baseline tables without deleting evidence.
 * Every recording runs in one transaction that writes the active Roll and its immutable receipt.
 *
 * @returns The authority. Fails with `MigrationError` or `SqlError` when the migrations cannot run,
 *   including when a pre-baseline database without record evidence is rejected.
 */
export const makeRaffle = Effect.gen(function* () {
  yield* SqliteMigrator.run({ loader: raffleMigrationLoader, table: "raffle_effect_migrations" });
  const sql = yield* SqlClient.SqlClient;
  const random = yield* RaffleRandom;

  const findReceipt = Effect.fn("Raffle.findReceipt")(function* (id: RedemptionId) {
    const rows = yield* parseStoredRolls(
      yield* sql`SELECT id,user_id AS userId,display_name AS displayName,roll,winning_number AS winningNumber,distance,is_winner AS isWinner,is_new_record AS isNewRecord,rolled_at AS rolledAt FROM raffle_roll_receipts WHERE id=${id}`,
    );

    return Option.fromUndefinedOr(rows[0]);
  });

  const ensureNotCompensated = Effect.fn("Raffle.ensureNotCompensated")(function* (
    operation: RaffleOperation,
    input: RaffleDrawRequest,
  ) {
    const rows = yield* parseTombstones(
      yield* sql`SELECT id FROM raffle_compensated_rolls WHERE id=${input.id}`,
    );

    if (rows.length > 0)
      return yield* raffleCompensated(operation, raffleErrorIdentifiersForRoll(input));
  });

  const insertRoll = Effect.fn("Raffle.insertRoll")(function* (input: RecordRaffleRoll) {
    const best = yield* parseBest(
      yield* sql`SELECT MIN(distance) distance FROM rolls WHERE distance>0`,
    );

    const roll = deriveRaffleRoll(
      input,
      Option.flatMap(Option.fromUndefinedOr(best[0]), (row) => Option.fromNullOr(row.distance)),
    );

    const storedRoll = yield* encodeStoredRoll(roll);

    const values = {
      id: storedRoll.id,
      user_id: storedRoll.userId,
      display_name: storedRoll.displayName,
      roll: storedRoll.roll,
      winning_number: storedRoll.winningNumber,
      distance: storedRoll.distance,
      is_winner: storedRoll.isWinner,
      is_new_record: storedRoll.isNewRecord,
      rolled_at: storedRoll.rolledAt,
    };

    yield* sql`INSERT INTO rolls ${sql.insert(values)}`;
    yield* sql`INSERT INTO raffle_roll_receipts ${sql.insert(values)}`;

    return { roll } satisfies RaffleRecordResult;
  });

  const recordRoll = Effect.fn("Raffle.recordRoll")(
    function* (input: RecordRaffleRoll) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const existing = yield* findReceipt(input.id);

          if (Option.isSome(existing)) {
            const roll = existing.value;

            if (!recordRaffleRollEquivalence(roll, input))
              return yield* raffleConflict("recordRoll", raffleErrorIdentifiersForRoll(input));

            return { roll } satisfies RaffleRecordResult;
          }

          yield* ensureNotCompensated("recordRoll", input);

          return yield* insertRoll(input);
        }),
      );
    },
    translateRaffleStorageErrors("recordRoll", raffleErrorIdentifiersForRoll),
  );

  const getOrCreateRoll = Effect.fn("Raffle.getOrCreateRoll")(
    function* (input: RaffleDrawRequest) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const existing = yield* findReceipt(input.id);

          if (Option.isSome(existing)) {
            const roll = existing.value;

            if (!raffleDrawRequestMatches(roll, input))
              return yield* raffleConflict("getOrCreateRoll", raffleErrorIdentifiersForRoll(input));

            return { roll } satisfies RaffleRecordResult;
          }

          yield* ensureNotCompensated("getOrCreateRoll", input);
          const roll = yield* random.drawNumber();
          const winningNumber = yield* random.drawNumber();

          return yield* insertRoll({ ...input, roll, winningNumber });
        }),
      );
    },
    translateRaffleStorageErrors("getOrCreateRoll", raffleErrorIdentifiersForRoll),
  );

  const leaderboardColumns = sql.literal(
    "user_id AS userId, display_name AS displayName, total_rolls AS totalRolls, total_wins AS totalWins, closest_distance AS closestDistance, closest_roll AS closestRoll, closest_winning_number AS closestWinningNumber, last_rolled_at AS lastRolledAt",
  );

  return Raffle.of({
    recordRoll,
    getOrCreateRoll,
    deleteRollById: Effect.fn("Raffle.deleteRollById")(
      function* (input) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT OR IGNORE INTO raffle_compensated_rolls(id) VALUES (${input.rollId})`;
            yield* sql`DELETE FROM rolls WHERE id=${input.rollId}`;
          }),
        );
      },
      translateRaffleStorageErrors("deleteRollById", raffleErrorIdentifiersForRollRemoval),
    ),
    getLeaderboard: Effect.fn("Raffle.getLeaderboard")(
      function* (input) {
        const order = Match.value(input.sortBy).pipe(
          Match.when("rolls", () => sql.literal("total_rolls DESC")),
          Match.when("wins", () => sql.literal("total_wins DESC")),
          Match.orElse(() => sql.literal("closest_distance ASC NULLS LAST")),
        );

        return yield* parseLeaderboard(
          yield* sql`SELECT ${leaderboardColumns} FROM raffle_leaderboard ORDER BY ${order}, user_id ASC LIMIT ${Option.getOrElse(input.limit, () => 10)}`,
        );
      },
      translateRaffleStorageErrors("getLeaderboard", () => raffleErrorWithoutIdentifiers),
    ),
    getUserStats: Effect.fn("Raffle.getUserStats")(
      function* (input) {
        const rows = yield* parseLeaderboard(
          yield* sql`SELECT ${leaderboardColumns} FROM raffle_leaderboard WHERE user_id=${input.userId} LIMIT 1`,
        );

        return Option.fromUndefinedOr(rows[0]);
      },
      translateRaffleStorageErrors("getUserStats", raffleErrorIdentifiersForViewer),
    ),
    getUserStatsByDisplayName: Effect.fn("Raffle.getUserStatsByDisplayName")(
      function* (input) {
        const rows = yield* parseLeaderboard(
          yield* sql`SELECT ${leaderboardColumns} FROM raffle_leaderboard WHERE display_name=${input.displayName} LIMIT 1`,
        );

        return Option.fromUndefinedOr(rows[0]);
      },
      translateRaffleStorageErrors(
        "getUserStatsByDisplayName",
        raffleErrorIdentifiersForDisplayName,
      ),
    ),
    getClosestRecord: Effect.fn("Raffle.getClosestRecord")(
      function* () {
        const rows = yield* parseClosest(
          yield* sql`SELECT user_id AS userId,display_name AS displayName,closest_distance AS distance FROM raffle_leaderboard WHERE closest_distance>0 ORDER BY closest_distance,user_id LIMIT 1`,
        );

        return Option.fromUndefinedOr(rows[0]);
      },
      translateRaffleStorageErrors("getClosestRecord", () => raffleErrorWithoutIdentifiers),
    ),
  });
});

/** Layer that provides the SQL raffle authority while leaving SQL and raffle draws required. */
export const raffleLayerWithoutDependencies = Layer.effect(Raffle, makeRaffle);

/**
 * Production Layer for the SQL raffle authority with production raffle draws selected.
 *
 * **Details**
 *
 * The Durable Object's `SqlClient` and the platform `SecureRandom` stay required; the raffle server
 * supplies both inside its runtime phase.
 */
export const raffleLayer = raffleLayerWithoutDependencies.pipe(Layer.provide(raffleRandomLayer));

/** In-memory raffle state mirroring the SQL tables: active Rolls, immutable receipts, and tombstones. */
interface InMemoryRaffleState {
  readonly activeRolls: ReadonlyMap<RedemptionId, RaffleRoll>;
  readonly receipts: ReadonlyMap<RedemptionId, RaffleRoll>;
  readonly compensated: ReadonlySet<RedemptionId>;
}

const compareRaffleViewerIds = (left: RaffleLeaderboardEntry, right: RaffleLeaderboardEntry) =>
  left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0;

const compareClosestRaffleDistance = (
  left: RaffleLeaderboardEntry,
  right: RaffleLeaderboardEntry,
): number =>
  Option.match(left.closestDistance, {
    onNone: () => (Option.isNone(right.closestDistance) ? 0 : 1),
    onSome: (leftDistance) =>
      Option.match(right.closestDistance, {
        onNone: () => -1,
        onSome: (rightDistance) => leftDistance - rightDistance,
      }),
  });

/** Aggregates active Rolls into Raffle Leaderboard rows exactly as the SQL `raffle_leaderboard` view does. */
const aggregateRaffleLeaderboard = (
  rolls: ReadonlyArray<RaffleRoll>,
): ReadonlyArray<RaffleLeaderboardEntry> => {
  const byViewer = new Map<ViewerId, Array<RaffleRoll>>();

  for (const roll of rolls) byViewer.set(roll.userId, [...(byViewer.get(roll.userId) ?? []), roll]);

  return Array.from(byViewer, ([userId, viewerRolls]) => {
    const latest = viewerRolls.reduce((current, roll) =>
      roll.rolledAt > current.rolledAt ? roll : current,
    );

    const closest = Option.fromUndefinedOr(
      viewerRolls
        .filter((roll) => !roll.isWinner)
        .reduce<RaffleRoll | undefined>(
          (current, roll) =>
            current === undefined || roll.distance < current.distance ? roll : current,
          undefined,
        ),
    );

    return RaffleLeaderboardEntry.make({
      userId,
      displayName: latest.displayName,
      totalRolls: viewerRolls.length,
      totalWins: viewerRolls.filter((roll) => roll.isWinner).length,
      closestDistance: Option.map(closest, (roll) => roll.distance),
      closestRoll: Option.map(closest, (roll) => roll.roll),
      closestWinningNumber: Option.map(closest, (roll) => roll.winningNumber),
      lastRolledAt: latest.rolledAt,
    });
  });
};

const sortRaffleLeaderboard = (
  entries: ReadonlyArray<RaffleLeaderboardEntry>,
  sortBy: RaffleLeaderboardQuery["sortBy"],
): ReadonlyArray<RaffleLeaderboardEntry> =>
  [...entries].sort((left, right) => {
    const primary = Match.value(sortBy).pipe(
      Match.when("rolls", () => right.totalRolls - left.totalRolls),
      Match.when("wins", () => right.totalWins - left.totalWins),
      Match.orElse(() => compareClosestRaffleDistance(left, right)),
    );

    return primary === 0 ? compareRaffleViewerIds(left, right) : primary;
  });

/**
 * Effect that builds an in-memory raffle authority with the same replay, compensation, and ranking rules as SQL.
 *
 * Writes are serialized through one synchronized state, standing in for SQL transactions.
 *
 * @returns The authority; building it cannot fail. Its methods fail only with the replay, compensation,
 *   and randomness reasons of `RaffleError`.
 */
const makeInMemoryRaffle = Effect.gen(function* () {
  const random = yield* RaffleRandom;

  const state = yield* SynchronizedRef.make<InMemoryRaffleState>({
    activeRolls: new Map(),
    receipts: new Map(),
    compensated: new Set(),
  });

  const insertRoll = (current: InMemoryRaffleState, input: RecordRaffleRoll) => {
    const distances = Array.from(current.activeRolls.values(), (roll) => roll.distance).filter(
      (distance) => distance > 0,
    );

    const roll = deriveRaffleRoll(
      input,
      distances.length === 0 ? Option.none() : Option.some(Math.min(...distances)),
    );

    return [
      { roll } satisfies RaffleRecordResult,
      {
        ...current,
        activeRolls: new Map(current.activeRolls).set(roll.id, roll),
        receipts: new Map(current.receipts).set(roll.id, roll),
      },
    ] as const;
  };

  const readLeaderboard = Effect.map(SynchronizedRef.get(state), (current) =>
    aggregateRaffleLeaderboard(Array.from(current.activeRolls.values())),
  );

  return Raffle.of({
    recordRoll: Effect.fn("InMemoryRaffle.recordRoll")(function* (input) {
      return yield* SynchronizedRef.modifyEffect(state, (current) => {
        const existing = current.receipts.get(input.id);

        if (existing !== undefined)
          return recordRaffleRollEquivalence(existing, input)
            ? Effect.succeed([{ roll: existing } satisfies RaffleRecordResult, current] as const)
            : Effect.fail(raffleConflict("recordRoll", raffleErrorIdentifiersForRoll(input)));

        if (current.compensated.has(input.id))
          return Effect.fail(raffleCompensated("recordRoll", raffleErrorIdentifiersForRoll(input)));

        return Effect.succeed(insertRoll(current, input));
      });
    }),
    getOrCreateRoll: Effect.fn("InMemoryRaffle.getOrCreateRoll")(function* (input) {
      return yield* SynchronizedRef.modifyEffect(state, (current) =>
        Effect.gen(function* () {
          const existing = current.receipts.get(input.id);

          if (existing !== undefined) {
            if (!raffleDrawRequestMatches(existing, input))
              return yield* raffleConflict("getOrCreateRoll", raffleErrorIdentifiersForRoll(input));

            return [{ roll: existing } satisfies RaffleRecordResult, current] as const;
          }

          if (current.compensated.has(input.id))
            return yield* raffleCompensated(
              "getOrCreateRoll",
              raffleErrorIdentifiersForRoll(input),
            );

          const roll = yield* random.drawNumber();
          const winningNumber = yield* random.drawNumber();

          return insertRoll(current, { ...input, roll, winningNumber });
        }),
      );
    }),
    deleteRollById: Effect.fn("InMemoryRaffle.deleteRollById")(function* (input) {
      yield* SynchronizedRef.update(state, (current) => {
        const activeRolls = new Map(current.activeRolls);
        activeRolls.delete(input.rollId);

        return {
          ...current,
          activeRolls,
          compensated: new Set(current.compensated).add(input.rollId),
        };
      });
    }),
    getLeaderboard: Effect.fn("InMemoryRaffle.getLeaderboard")(function* (input) {
      return sortRaffleLeaderboard(yield* readLeaderboard, input.sortBy).slice(
        0,
        Option.getOrElse(input.limit, () => 10),
      );
    }),
    getUserStats: Effect.fn("InMemoryRaffle.getUserStats")(function* (input) {
      return Option.fromUndefinedOr(
        (yield* readLeaderboard).find((entry) => entry.userId === input.userId),
      );
    }),
    getUserStatsByDisplayName: Effect.fn("InMemoryRaffle.getUserStatsByDisplayName")(
      function* (input) {
        return Option.fromUndefinedOr(
          (yield* readLeaderboard).find((entry) => entry.displayName === input.displayName),
        );
      },
    ),
    getClosestRecord: Effect.fn("InMemoryRaffle.getClosestRecord")(function* () {
      // Closest ordering lists Viewers without a non-winning Roll last, so the first row holds any record.
      const [closest] = sortRaffleLeaderboard(yield* readLeaderboard, "closest");

      return Option.flatMap(Option.fromUndefinedOr(closest), (entry) =>
        Option.map(entry.closestDistance, (distance) =>
          RaffleClosestRecord.make({
            userId: entry.userId,
            displayName: entry.displayName,
            distance,
          }),
        ),
      );
    }),
  });
});

/**
 * Test Layer that provides a complete in-memory raffle authority with seeded raffle draws.
 *
 * **Details**
 *
 * It follows the SQL authority's replay, conflict, compensation, record, and ranking rules; the raffle
 * parity tests run the same journeys against both implementations. Storage failures cannot occur.
 */
export const raffleTestLayer = Layer.effect(Raffle, makeInMemoryRaffle).pipe(
  Layer.provide(raffleRandomTestLayer),
);
