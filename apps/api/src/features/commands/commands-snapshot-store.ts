import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { Context, Effect, Layer, Option, Ref, Schema, Semaphore } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import {
  ChatCommandDefinition,
  ChatCommandValue,
  CommandAliasConflictError,
  CommandInvalidDefinitionError,
  CommandsDbError,
  CommandsStateParseError,
  type ChatCommandName,
  type ChatCommandOperation,
} from "@cf-twitch/contracts/chat-command";
import { IsoTimestamp, NonNegativeInt } from "@cf-twitch/contracts/identity";

const StoredCommandValue = Schema.Struct({
  value: ChatCommandValue,
  updatedAt: IsoTimestamp,
  updatedBy: Schema.OptionFromNullOr(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  ),
});

const StoredCommandCounter = Schema.Struct({ count: NonNegativeInt, updatedAt: IsoTimestamp });

const CommandMutationReceipt = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("update"), fingerprint: Schema.NonEmptyString }),
  Schema.Struct({
    kind: Schema.Literal("counter"),
    fingerprint: Schema.NonEmptyString,
    resultingCount: NonNegativeInt,
  }),
]);

/** Mutation receipt that lets an EventSub redelivery replay its original command change. */
export type CommandMutationReceipt = typeof CommandMutationReceipt.Type;

const ReceiptKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

// Retain the original Agent snapshot representation to make the state transition lossless.
const CommandsSnapshot = Schema.Struct({
  revision: NonNegativeInt,
  commandsByName: Schema.Record(Schema.String, ChatCommandDefinition),
  valuesByName: Schema.Record(Schema.String, StoredCommandValue),
  countersByName: Schema.Record(Schema.String, StoredCommandCounter),
  mutationReceiptsByOperationId: Schema.Record(ReceiptKey, CommandMutationReceipt),
  appliedMigrations: Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  ),
});

/** Whole command registry graph: definitions, shared values, counters, receipts, and applied default migrations. */
export type CommandsSnapshot = typeof CommandsSnapshot.Type;

const LegacyCommandsSnapshot = Schema.Struct({
  ...CommandsSnapshot.fields,
  mutationReceiptsByOperationId: Schema.optionalKey(
    CommandsSnapshot.fields.mutationReceiptsByOperationId,
  ),
  appliedMigrations: Schema.optionalKey(CommandsSnapshot.fields.appliedMigrations),
  legacyImportCompleted: Schema.optionalKey(Schema.Boolean),
  migrationReport: Schema.optionalKey(Schema.Json),
});

const decodeSnapshotJson = Schema.decodeEffect(Schema.fromJsonString(CommandsSnapshot), {
  onExcessProperty: "error",
});

const decodeLegacySnapshotJson = Schema.decodeEffect(
  Schema.fromJsonString(LegacyCommandsSnapshot),
  { onExcessProperty: "error" },
);

const encodeSnapshotJson = Schema.encodeEffect(Schema.fromJsonString(CommandsSnapshot));

const decodeStateRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ state: Schema.String })),
);

const decodeTableRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ name: Schema.String })),
);

/** Empty registry graph used before the first bootstrap or legacy import. */
export const emptyCommandsSnapshot: CommandsSnapshot = {
  revision: 0,
  commandsByName: {},
  valuesByName: {},
  countersByName: {},
  mutationReceiptsByOperationId: {},
  appliedMigrations: [],
};

/**
 * Returns the stored name of the command whose value or counter a command reads.
 *
 * @returns The source command name, or `Option.none()` when a computed command keeps no counter source.
 */
export const commandSourceName = (command: ChatCommandDefinition): Option.Option<ChatCommandName> =>
  command.responseType === "computed"
    ? command.counterSourceName
    : Option.some(command.valueSourceName);

const validateCommandDefinitions = Effect.fn("CommandsSnapshotStore.validateCommandDefinitions")(
  function* (state: CommandsSnapshot, operation: ChatCommandOperation) {
    const aliasOwners = new Map<string, ChatCommandName>();

    for (const [storedName, command] of Object.entries(state.commandsByName)) {
      if (command.name !== storedName)
        return yield* new CommandsStateParseError({
          operation,
          reason: "stored_references_invalid",
        });

      for (const alias of command.aliases) {
        const owner = aliasOwners.get(alias);

        if (owner !== undefined)
          return yield* new CommandAliasConflictError({
            operation,
            reason: owner === command.name ? "alias_repeated" : "alias_owned_by_another_command",
            commandName: command.name,
            alias,
            ownerCommandName: owner,
          });

        if (Object.hasOwn(state.commandsByName, alias))
          return yield* new CommandAliasConflictError({
            operation,
            reason: "alias_matches_command_name",
            commandName: command.name,
            alias,
            ownerCommandName: alias,
          });
        aliasOwners.set(alias, command.name);
      }

      const source = commandSourceName(command);

      if (Option.isSome(source) && !Object.hasOwn(state.commandsByName, source.value))
        return yield* new CommandInvalidDefinitionError({
          operation,
          reason: "missing_source_command",
          commandName: command.name,
          sourceCommandName: source,
        });
    }
  },
);

// Values and counters are owned by a command; an orphan means the graph was not pruned atomically.
const validateCommandValueOwners = Effect.fn("CommandsSnapshotStore.validateCommandValueOwners")(
  function* (state: CommandsSnapshot, operation: ChatCommandOperation) {
    const valueNames = [...Object.keys(state.valuesByName), ...Object.keys(state.countersByName)];

    if (valueNames.some((name) => !Object.hasOwn(state.commandsByName, name)))
      return yield* new CommandsStateParseError({ operation, reason: "stored_references_invalid" });
  },
);

/**
 * Checks the registry's cross-field reference graph before a snapshot is saved.
 *
 * **Details**
 *
 * Aliases must be unique and distinct from canonical names, every value or counter source must
 * exist, stored keys must match command names, and values or counters must belong to a command.
 *
 * @returns Nothing, or fails with `CommandAliasConflictError` for alias collisions,
 * `CommandInvalidDefinitionError` for a missing source command, and `CommandsStateParseError`
 * when stored keys or orphan values show the graph was not pruned.
 */
export const validateCommandsSnapshotReferences = Effect.fn(
  "CommandsSnapshotStore.validateCommandsSnapshotReferences",
)(function* (state: CommandsSnapshot, operation: ChatCommandOperation) {
  yield* validateCommandDefinitions(state, operation);
  yield* validateCommandValueOwners(state, operation);
});

/** Result of one atomic registry change: the caller's result and the snapshot to save, if any. */
export interface CommandsSnapshotChange<A> {
  /** Value returned to the caller after the change commits. */
  readonly result: A;
  /** Snapshot to save, or `Option.none()` when the change only read or replayed a receipt. */
  readonly next: Option.Option<CommandsSnapshot>;
}

/** Failures the snapshot store reports while reading stored registry state. */
export type CommandsSnapshotReadError = CommandsDbError | CommandsStateParseError;

/** Failures the snapshot store reports while validating and saving a changed registry graph. */
export type CommandsSnapshotWriteError =
  | CommandsSnapshotReadError
  | CommandAliasConflictError
  | CommandInvalidDefinitionError;

/** Atomic whole-graph persistence for the chat command registry. */
export interface ICommandsSnapshotStore {
  /**
   * Reads the current registry snapshot.
   *
   * @returns The snapshot, or fails with `CommandsDbError` when storage is unavailable and
   * `CommandsStateParseError` when the snapshot is missing or its stored data is invalid.
   */
  readonly read: (
    operation: ChatCommandOperation,
  ) => Effect.Effect<CommandsSnapshot, CommandsSnapshotReadError>;
  /**
   * Runs one read-modify-write change atomically and saves its validated next snapshot.
   *
   * @returns The change's result, or fails with the change's own error, `CommandsSnapshotReadError`
   * when the current snapshot cannot be read, and an alias or definition error when the next
   * snapshot has an invalid reference graph. Nothing is saved when any step fails.
   */
  readonly update: <A, E>(
    operation: ChatCommandOperation,
    change: (state: CommandsSnapshot) => Effect.Effect<CommandsSnapshotChange<A>, E>,
  ) => Effect.Effect<A, E | CommandsSnapshotWriteError>;
  /**
   * Imports or creates the first snapshot, applies the startup change, and saves it atomically.
   *
   * **Details**
   *
   * Starts from the saved snapshot when one exists, otherwise from the legacy Agent snapshot, and
   * otherwise from `emptyCommandsSnapshot`. Invalid stored or legacy data blocks startup instead of
   * resetting the registry.
   *
   * @returns Nothing, or fails with the change's own error and `CommandsSnapshotWriteError` when
   * stored, legacy, or resulting state is invalid or storage is unavailable.
   */
  readonly initialize: <E>(
    change: (state: CommandsSnapshot) => Effect.Effect<CommandsSnapshot, E>,
  ) => Effect.Effect<void, E | CommandsSnapshotWriteError>;
}

/** Service for atomic chat command registry snapshot persistence. */
export class CommandsSnapshotStore extends Context.Service<
  CommandsSnapshotStore,
  ICommandsSnapshotStore
>()("@cf-twitch/CommandsSnapshotStore") {}

const commandsMigrationLoader = SqliteMigrator.fromRecord({
  "1_create_commands_snapshot": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE commands_snapshot (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state TEXT NOT NULL)`;
  }),
});

const storageUnavailable = (operation: ChatCommandOperation) => () =>
  new CommandsDbError({ operation, reason: "storage_unavailable", commandName: Option.none() });

const storedStateInvalid =
  (operation: ChatCommandOperation, reason: CommandsStateParseError["reason"]) => () =>
    new CommandsStateParseError({ operation, reason });

// Stored reference violations are corrupt data, not caller-correctable conflicts.
const parseStoredReferences = (
  state: CommandsSnapshot,
  operation: ChatCommandOperation,
  reason: "stored_references_invalid" | "legacy_snapshot_invalid",
) =>
  validateCommandsSnapshotReferences(state, operation).pipe(
    Effect.catchTags({
      CommandAliasConflictError: storedStateInvalid(operation, reason),
      CommandInvalidDefinitionError: storedStateInvalid(operation, reason),
      CommandsStateParseError: storedStateInvalid(operation, reason),
    }),
  );

/**
 * Creates the SQLite snapshot store after running its table migration.
 *
 * **Details**
 *
 * Must run only inside the Durable Object's runtime phase, where its SQL client is available. The
 * legacy `cf_agents_state` row is read but never modified.
 *
 * @returns The store, or fails with `MigrationError` or `SqlError` when the table migration fails.
 */
export const makeCommandsSnapshotStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* SqliteMigrator.run({
    loader: commandsMigrationLoader,
    table: "commands_schema_migrations",
  });

  const selectSnapshotRow = (operation: ChatCommandOperation) =>
    sql`SELECT state FROM commands_snapshot WHERE singleton = 1`.pipe(
      Effect.flatMap(decodeStateRows),
      Effect.catchTags({
        SqlError: () => Effect.fail(storageUnavailable(operation)()),
        SchemaError: () => Effect.fail(storedStateInvalid(operation, "stored_snapshot_invalid")()),
      }),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const parseStoredSnapshot = Effect.fn("CommandsSnapshotStore.parseStoredSnapshot")(function* (
    stateJson: string,
    operation: ChatCommandOperation,
  ) {
    const state = yield* decodeSnapshotJson(stateJson).pipe(
      Effect.mapError(storedStateInvalid(operation, "stored_snapshot_invalid")),
    );

    yield* parseStoredReferences(state, operation, "stored_references_invalid");

    return state;
  });

  const readLegacySnapshot = Effect.fn("CommandsSnapshotStore.readLegacySnapshot")(function* () {
    const operation = "initializeRegistry";
    const legacyInvalid = storedStateInvalid(operation, "legacy_snapshot_invalid");

    const tables =
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_state'`.pipe(
        Effect.mapError(storageUnavailable(operation)),
        Effect.flatMap((rows) => decodeTableRows(rows).pipe(Effect.mapError(legacyInvalid))),
      );

    if (tables.length === 0) return emptyCommandsSnapshot;

    const rows = yield* sql`SELECT state FROM cf_agents_state WHERE id = 'cf_state_row_id'`.pipe(
      Effect.mapError(storageUnavailable(operation)),
      Effect.flatMap((rows) => decodeStateRows(rows).pipe(Effect.mapError(legacyInvalid))),
    );

    const row = rows[0];

    if (row === undefined) return emptyCommandsSnapshot;
    const parsed = yield* decodeLegacySnapshotJson(row.state).pipe(Effect.mapError(legacyInvalid));

    const state: CommandsSnapshot = {
      revision: parsed.revision,
      commandsByName: parsed.commandsByName,
      valuesByName: parsed.valuesByName,
      countersByName: parsed.countersByName,
      mutationReceiptsByOperationId: parsed.mutationReceiptsByOperationId ?? {},
      appliedMigrations: parsed.appliedMigrations ?? [],
    };

    yield* parseStoredReferences(state, operation, "legacy_snapshot_invalid");

    return state;
  });

  const persistSnapshot = Effect.fn("CommandsSnapshotStore.persistSnapshot")(function* (
    state: CommandsSnapshot,
    operation: ChatCommandOperation,
  ) {
    yield* validateCommandsSnapshotReferences(state, operation);

    const encoded = yield* encodeSnapshotJson(state).pipe(
      Effect.mapError(storedStateInvalid(operation, "snapshot_encoding_failed")),
    );

    yield* sql`INSERT INTO commands_snapshot (singleton, state) VALUES (1, ${encoded}) ON CONFLICT(singleton) DO UPDATE SET state = excluded.state`.pipe(
      Effect.mapError(storageUnavailable(operation)),
    );
  });

  // The transaction boundary itself can fail to begin or commit; the change has not been confirmed.
  const inTransaction = <A, E>(
    operation: ChatCommandOperation,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | CommandsDbError> =>
    sql
      .withTransaction(effect)
      .pipe(
        Effect.catchIf(SqlError.isSqlError, () => Effect.fail(storageUnavailable(operation)())),
      );

  const read: ICommandsSnapshotStore["read"] = Effect.fn("CommandsSnapshotStore.read")(
    function* (operation) {
      const row = yield* selectSnapshotRow(operation);

      if (Option.isNone(row))
        return yield* new CommandsStateParseError({ operation, reason: "snapshot_missing" });

      return yield* parseStoredSnapshot(row.value.state, operation);
    },
  );

  const update: ICommandsSnapshotStore["update"] = (operation, change) =>
    inTransaction(
      operation,
      Effect.gen(function* () {
        const changed = yield* change(yield* read(operation));

        if (Option.isSome(changed.next)) yield* persistSnapshot(changed.next.value, operation);

        return changed.result;
      }),
    );

  const initialize: ICommandsSnapshotStore["initialize"] = (change) =>
    inTransaction(
      "initializeRegistry",
      Effect.gen(function* () {
        const row = yield* selectSnapshotRow("initializeRegistry");

        const stored = Option.isSome(row)
          ? yield* parseStoredSnapshot(row.value.state, "initializeRegistry")
          : yield* readLegacySnapshot();

        yield* persistSnapshot(yield* change(stored), "initializeRegistry");
      }),
    );

  return CommandsSnapshotStore.of({ read, update, initialize });
});

/** Layer that provides the SQLite snapshot store and keeps its Durable Object SQL client requirement visible. */
export const commandsSnapshotStoreLayerWithoutDependencies = Layer.effect(
  CommandsSnapshotStore,
  makeCommandsSnapshotStore,
);

/** Production snapshot store Layer; the SQL client is a Durable Object runtime binding supplied by `CommandsServer`. */
export const commandsSnapshotStoreLayer = commandsSnapshotStoreLayerWithoutDependencies;

/**
 * Layer that provides an in-memory snapshot store with the same atomicity and reference validation as SQLite.
 *
 * **Details**
 *
 * Starts without a saved snapshot, so `initialize` begins from `emptyCommandsSnapshot`. A failed
 * change leaves the previous snapshot untouched.
 */
export const commandsSnapshotStoreTestLayer = Layer.effect(
  CommandsSnapshotStore,
  Effect.gen(function* () {
    const saved = yield* Ref.make(Option.none<CommandsSnapshot>());
    const permit = yield* Semaphore.make(1);

    const read: ICommandsSnapshotStore["read"] = (operation) =>
      Ref.get(saved).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new CommandsStateParseError({ operation, reason: "snapshot_missing" })),
            onSome: Effect.succeed,
          }),
        ),
      );

    const save = (state: CommandsSnapshot, operation: ChatCommandOperation) =>
      validateCommandsSnapshotReferences(state, operation).pipe(
        Effect.andThen(Ref.set(saved, Option.some(state))),
      );

    return CommandsSnapshotStore.of({
      read,
      update: (operation, change) =>
        permit.withPermit(
          Effect.gen(function* () {
            const changed = yield* change(yield* read(operation));

            if (Option.isSome(changed.next)) yield* save(changed.next.value, operation);

            return changed.result;
          }),
        ),
      initialize: (change) =>
        permit.withPermit(
          Effect.gen(function* () {
            const current = Option.getOrElse(yield* Ref.get(saved), () => emptyCommandsSnapshot);
            yield* save(yield* change(current), "initializeRegistry");
          }),
        ),
    });
  }),
);
