import { SqliteMigrator } from "@effect/sql-sqlite-do";
import { Clock, Effect, Layer, Option, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import {
  ChatCommandDefinition,
  ChatCommandName,
  ChatCommandValue,
  CommandAliasConflictError,
  CommandAlreadyExistsError,
  CommandInputParseError,
  CommandInvalidDefinitionError,
  CommandNotFoundError,
  CommandNotUpdateableError,
  CommandUpdatePermissionDeniedError,
  CommandsDbError,
  CommandsStateParseError,
  parseCreateChatCommandInput,
  type CreateChatCommandInput,
  type CommandsError,
} from "@cf-twitch/contracts/chat-command";
import { IsoTimestamp, NonNegativeInt } from "@cf-twitch/contracts/identity";
import { Commands, type ICommands } from "./commands.ts";
import {
  createDefaultCommandInputs,
  defaultCommandMigrationIds,
  defaultCommandMigrations,
} from "./command-defaults.ts";
import { hasCommandPermission } from "./command-permissions.ts";

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
type CommandsSnapshot = typeof CommandsSnapshot.Type;
const LegacyCommandsSnapshot = Schema.Struct({
  ...CommandsSnapshot.fields,
  mutationReceiptsByOperationId: Schema.optionalKey(
    CommandsSnapshot.fields.mutationReceiptsByOperationId,
  ),
  appliedMigrations: Schema.optionalKey(CommandsSnapshot.fields.appliedMigrations),
  legacyImportCompleted: Schema.optionalKey(Schema.Boolean),
  migrationReport: Schema.optionalKey(Schema.Json),
});
const parseSnapshotJson = Schema.decodeEffect(Schema.fromJsonString(CommandsSnapshot), {
  onExcessProperty: "error",
});
const parseLegacySnapshotJson = Schema.decodeEffect(Schema.fromJsonString(LegacyCommandsSnapshot), {
  onExcessProperty: "error",
});
const encodeSnapshotJson = Schema.encodeEffect(Schema.fromJsonString(CommandsSnapshot));
const encodeDefinition = Schema.encodeEffect(ChatCommandDefinition);
const decodeUpdatedDefinition = Schema.decodeEffect(Schema.toCodecJson(ChatCommandDefinition), {
  onExcessProperty: "error",
});
const refineTimestamp = Schema.decodeEffect(IsoTimestamp);
const parseRows = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ state: Schema.String })));
const parseTableRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ name: Schema.String })),
);
const commandNow = Effect.flatMap(Clock.currentTimeMillis, (now) =>
  refineTimestamp(new Date(now).toISOString()),
);
const persistenceErrors = <A, R>(
  operation: Effect.Effect<A, CommandsError | SqlError.SqlError | Schema.SchemaError, R>,
): Effect.Effect<A, CommandsError, R> =>
  operation.pipe(
    Effect.catchTags({
      SqlError: () => Effect.fail(new CommandsDbError({ operation: "Commands database" })),
      SchemaError: () =>
        Effect.fail(new CommandsStateParseError({ operation: "Commands rehydrate" })),
    }),
  );
const counterStorageName = (command: ChatCommandDefinition): ChatCommandName =>
  command.responseType === "computed"
    ? Option.getOrElse(command.counterSourceName, () => command.name)
    : command.name;
const resolveCommand = (state: CommandsSnapshot, name: string): ChatCommandDefinition | undefined =>
  (Object.hasOwn(state.commandsByName, name) ? state.commandsByName[name] : undefined) ??
  Object.values(state.commandsByName).find((command) =>
    command.aliases.some((alias) => alias === name),
  );
const commandValue = (
  state: CommandsSnapshot,
  command: ChatCommandDefinition,
): Option.Option<string> =>
  command.valueSourceName === null
    ? Option.none()
    : Option.fromNullishOr(state.valuesByName[command.valueSourceName]?.value);
const initialized = (state: CommandsSnapshot): boolean =>
  state.revision > 0 ||
  Object.keys(state.commandsByName).length > 0 ||
  Object.keys(state.valuesByName).length > 0 ||
  Object.keys(state.countersByName).length > 0;

const emptyCommandsSnapshot: CommandsSnapshot = {
  revision: 0,
  commandsByName: {},
  valuesByName: {},
  countersByName: {},
  mutationReceiptsByOperationId: {},
  appliedMigrations: [],
};

const parseCommandReferences = Effect.fn("Commands.parseCommandReferences")(function* (
  state: CommandsSnapshot,
) {
  const aliases = new Map<string, string>();
  for (const [name, command] of Object.entries(state.commandsByName)) {
    if (command.name !== name)
      return yield* new CommandInvalidDefinitionError({
        commandName: name,
        reason: "Chat command stored key mismatch",
      });
    for (const alias of command.aliases) {
      const owner = aliases.get(alias);
      if (owner !== undefined || Object.hasOwn(state.commandsByName, alias))
        return yield* new CommandAliasConflictError({ alias, owner: owner ?? alias });
      aliases.set(alias, name);
    }
    const source =
      command.responseType === "computed"
        ? Option.getOrNull(command.counterSourceName)
        : command.valueSourceName;
    if (source !== null && !Object.hasOwn(state.commandsByName, source))
      return yield* new CommandInvalidDefinitionError({
        commandName: name,
        reason: `Chat command missing source: ${source}`,
      });
  }
  for (const name of [...Object.keys(state.valuesByName), ...Object.keys(state.countersByName)]) {
    if (!Object.hasOwn(state.commandsByName, name))
      return yield* new CommandInvalidDefinitionError({
        commandName: name,
        reason: "Chat command stored value or counter has no command",
      });
  }
});

const pruneCommandState = (state: CommandsSnapshot): CommandsSnapshot => {
  const commands = Object.values(state.commandsByName);
  const values = new Set<string>(
    commands.flatMap((command) =>
      command.valueSourceName === null ? [] : [command.valueSourceName],
    ),
  );
  const counters = new Set<string>(commands.map(counterStorageName));
  return {
    ...state,
    valuesByName: Object.fromEntries(
      Object.entries(state.valuesByName).filter(([name]) => values.has(name)),
    ),
    countersByName: Object.fromEntries(
      Object.entries(state.countersByName).filter(([name]) => counters.has(name)),
    ),
  };
};

const buildCommandDefinition = (
  input: CreateChatCommandInput,
  now: typeof IsoTimestamp.Type,
): ChatCommandDefinition => {
  const base = {
    name: input.name,
    description: input.description,
    category: input.category,
    permission: input.permission,
    enabled: input.enabled ?? true,
    createdAt: input.createdAt ?? now,
    aliases: input.aliases ?? [],
  };
  if (input.responseType === "computed")
    return {
      ...base,
      responseType: "computed",
      valueSourceName: null,
      counterSourceName: Option.fromNullishOr(input.counterSourceName),
      handlerKey: input.handlerKey,
      outputTemplate: null,
      emptyResponse: null,
      writePermission: null,
    };
  const stored = {
    ...base,
    valueSourceName: input.valueSourceName ?? input.name,
    counterSourceName: null,
    handlerKey: null,
    outputTemplate: input.outputTemplate ?? "{value}",
    emptyResponse: input.emptyResponse ?? `${input.name} info is not available.`,
  };
  return input.responseType === "static"
    ? { ...stored, responseType: "static", writePermission: null }
    : { ...stored, responseType: "dynamic", writePermission: input.writePermission ?? "moderator" };
};
const addCommandToState = (
  state: CommandsSnapshot,
  input: CreateChatCommandInput,
  now: typeof IsoTimestamp.Type,
): CommandsSnapshot => {
  const command = buildCommandDefinition(input, now);
  return pruneCommandState({
    ...state,
    commandsByName: { ...state.commandsByName, [command.name]: command },
    valuesByName:
      input.responseType !== "computed" &&
      input.initialValue !== undefined &&
      command.valueSourceName !== null
        ? {
            ...state.valuesByName,
            [command.valueSourceName]: {
              value: input.initialValue,
              updatedAt: now,
              updatedBy: Option.none(),
            },
          }
        : state.valuesByName,
    countersByName:
      input.responseType === "computed" &&
      input.counterSourceName !== undefined &&
      input.initialCounter !== undefined
        ? {
            ...state.countersByName,
            [input.counterSourceName]: { count: input.initialCounter, updatedAt: now },
          }
        : state.countersByName,
  });
};
const appendReceipt = (
  state: CommandsSnapshot,
  operationId: Option.Option<string>,
  receipt: typeof CommandMutationReceipt.Type,
): CommandsSnapshot["mutationReceiptsByOperationId"] =>
  Option.match(operationId, {
    onNone: () => state.mutationReceiptsByOperationId,
    onSome: (id) =>
      Object.fromEntries(
        Object.entries({ ...state.mutationReceiptsByOperationId, [id]: receipt }).slice(-5000),
      ),
  });
const checkReceipt = Effect.fn("Commands.checkReceipt")(function* (
  state: CommandsSnapshot,
  operationId: Option.Option<string>,
  fingerprint: string,
) {
  const receipt = Option.flatMap(operationId, (id) =>
    Object.hasOwn(state.mutationReceiptsByOperationId, id)
      ? Option.fromNullishOr(state.mutationReceiptsByOperationId[id])
      : Option.none(),
  );
  if (Option.isSome(receipt) && receipt.value.fingerprint !== fingerprint)
    return yield* new CommandInputParseError({
      operation: "Commands mutation",
    });
  return receipt;
});
const requireCommand = Effect.fn("Commands.requireCommand")(function* (
  state: CommandsSnapshot,
  name: string,
  mode: "canonical" | "alias",
) {
  const command =
    mode === "canonical"
      ? Object.hasOwn(state.commandsByName, name)
        ? state.commandsByName[name]
        : undefined
      : resolveCommand(state, name);
  return command ?? (yield* new CommandNotFoundError({ commandName: name }));
});

const commandsMigrationLoader = SqliteMigrator.fromRecord({
  "1_create_commands_snapshot": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE commands_snapshot (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state TEXT NOT NULL)`;
  }),
});

/** Construct SQL-backed commands and migrate the baseline Agent snapshot before serving traffic. */
export const makeCommandsDatabase = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* SqliteMigrator.run({
    loader: commandsMigrationLoader,
    table: "commands_schema_migrations",
  });
  const readState = Effect.fn("Commands.readState")(function* () {
    const rows = yield* parseRows(
      yield* sql`SELECT state FROM commands_snapshot WHERE singleton = 1`,
    );
    const row = rows[0];
    if (row === undefined)
      return yield* new CommandsStateParseError({ operation: "Commands snapshot missing" });
    const state = yield* parseSnapshotJson(row.state);
    yield* parseCommandReferences(state);
    return state;
  });
  const persistState = Effect.fn("Commands.persistState")(function* (state: CommandsSnapshot) {
    yield* parseCommandReferences(state);
    const encoded = yield* encodeSnapshotJson(state);
    yield* sql`INSERT INTO commands_snapshot (singleton, state) VALUES (1, ${encoded}) ON CONFLICT(singleton) DO UPDATE SET state = excluded.state`;
  });
  const readLegacyState = Effect.fn("Commands.readLegacyState")(function* () {
    const tables = yield* parseTableRows(
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_agents_state'`,
    );
    if (tables.length === 0) return emptyCommandsSnapshot;
    const rows = yield* parseRows(
      yield* sql`SELECT state FROM cf_agents_state WHERE id = 'cf_state_row_id'`,
    );
    const row = rows[0];
    if (row === undefined) return emptyCommandsSnapshot;
    const parsed = yield* parseLegacySnapshotJson(row.state);
    const state: CommandsSnapshot = {
      revision: parsed.revision,
      commandsByName: parsed.commandsByName,
      valuesByName: parsed.valuesByName,
      countersByName: parsed.countersByName,
      mutationReceiptsByOperationId: parsed.mutationReceiptsByOperationId ?? {},
      appliedMigrations: parsed.appliedMigrations ?? [],
    };
    yield* parseCommandReferences(state);
    return state;
  });
  const readStateForMigration = Effect.fn("Commands.readStateForMigration")(function* () {
    const rows = yield* parseRows(
      yield* sql`SELECT state FROM commands_snapshot WHERE singleton = 1`,
    );
    const row = rows[0];
    if (row === undefined) return yield* readLegacyState();
    const state = yield* parseSnapshotJson(row.state);
    yield* parseCommandReferences(state);
    return state;
  });
  const installDefaultCommands = Effect.fn("Commands.installDefaultCommands")(function* (
    state: CommandsSnapshot,
    now: typeof IsoTimestamp.Type,
  ) {
    if (initialized(state)) return state;
    let initializedState: CommandsSnapshot = {
      ...state,
      revision: 1,
      appliedMigrations: [...defaultCommandMigrationIds],
    };
    for (const raw of createDefaultCommandInputs(now)) {
      const input = yield* parseCreateChatCommandInput(raw);
      initializedState = addCommandToState(initializedState, input, now);
    }
    return initializedState;
  });
  const applyDefaultCommandMigrations = Effect.fn("Commands.applyDefaultCommandMigrations")(
    function* (state: CommandsSnapshot, now: typeof IsoTimestamp.Type) {
      const pending = defaultCommandMigrations.filter(
        (migration) => !state.appliedMigrations.includes(migration.id),
      );
      let migratedState = state;
      for (const migration of pending) {
        if (migration.kind === "create") {
          const input = yield* parseCreateChatCommandInput(migration.createInput(now));
          if (resolveCommand(migratedState, input.name) === undefined)
            migratedState = addCommandToState(migratedState, input, now);
        } else {
          const command = resolveCommand(migratedState, migration.commandName);
          if (
            command !== undefined &&
            resolveCommand(migratedState, migration.alias) === undefined
          ) {
            migratedState = {
              ...migratedState,
              commandsByName: {
                ...migratedState.commandsByName,
                [command.name]: {
                  ...command,
                  aliases: [...command.aliases, migration.alias],
                },
              },
            };
          }
        }
        migratedState = {
          ...migratedState,
          appliedMigrations: [...migratedState.appliedMigrations, migration.id],
        };
      }
      return pending.length === 0
        ? migratedState
        : { ...migratedState, revision: migratedState.revision + 1 };
    },
  );
  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const now = yield* commandNow;
        const stored = yield* readStateForMigration();
        const initializedState = yield* installDefaultCommands(stored, now);
        yield* persistState(yield* applyDefaultCommandMigrations(initializedState, now));
      }),
    )
    .pipe(persistenceErrors);

  const getCommand: ICommands["getCommand"] = Effect.fn("Commands.getCommand")(function* ({
    name,
  }) {
    return yield* requireCommand(yield* readState(), name, "alias");
  }, persistenceErrors);
  const getAllCommands: ICommands["getAllCommands"] = Effect.fn("Commands.getAllCommands")(
    function* () {
      return Object.values((yield* readState()).commandsByName);
    },
    persistenceErrors,
  );
  const getEnabledCommandsByPermission: ICommands["getEnabledCommandsByPermission"] = Effect.fn(
    "Commands.getEnabledCommandsByPermission",
  )(function* ({ permission }) {
    return (yield* getAllCommands()).filter(
      (command) => command.enabled && hasCommandPermission(permission, command.permission),
    );
  });
  const getCommandValue: ICommands["getCommandValue"] = Effect.fn("Commands.getCommandValue")(
    function* ({ name }) {
      const state = yield* readState();
      const command = resolveCommand(state, name);
      return command === undefined ? Option.none() : commandValue(state, command);
    },
    persistenceErrors,
  );
  const getCommandWithValue: ICommands["getCommandWithValue"] = Effect.fn(
    "Commands.getCommandWithValue",
  )(function* ({ name }) {
    const state = yield* readState();
    const command = yield* requireCommand(state, name, "alias");
    return { command, value: commandValue(state, command) };
  }, persistenceErrors);
  const getEnabledCommandsWithValues: ICommands["getEnabledCommandsWithValues"] = Effect.fn(
    "Commands.getEnabledCommandsWithValues",
  )(function* () {
    const state = yield* readState();
    return Object.values(state.commandsByName)
      .filter((command) => command.enabled)
      .map((command) => ({ command, value: commandValue(state, command) }));
  }, persistenceErrors);
  const createCommand: ICommands["createCommand"] = Effect.fn("Commands.createCommand")(function* (
    input,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const state = yield* readState();
        if (resolveCommand(state, input.name) !== undefined)
          return yield* new CommandAlreadyExistsError({ commandName: input.name });
        const now = yield* commandNow;
        const next = addCommandToState(state, input, now);
        yield* persistState({ ...next, revision: state.revision + 1 });
        return buildCommandDefinition(input, now);
      }),
    );
  }, persistenceErrors);
  const updateCommand: ICommands["updateCommand"] = Effect.fn("Commands.updateCommand")(function* ({
    name,
    patch,
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const state = yield* readState();
        const existing = yield* requireCommand(state, name, "canonical");
        const mergedDefinition = {
          ...(yield* encodeDefinition(existing)),
          ...patch,
        };
        const updated = yield* decodeUpdatedDefinition(mergedDefinition).pipe(
          Effect.mapError(
            () =>
              new CommandInvalidDefinitionError({
                commandName: name,
                reason: "Chat command response transition is incomplete or contradictory",
              }),
          ),
        );
        yield* persistState(
          pruneCommandState({
            ...state,
            revision: state.revision + 1,
            commandsByName: { ...state.commandsByName, [name]: updated },
          }),
        );
        return updated;
      }),
    );
  }, persistenceErrors);
  const deleteCommand: ICommands["deleteCommand"] = Effect.fn("Commands.deleteCommand")(function* ({
    name,
  }) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const state = yield* readState();
        yield* requireCommand(state, name, "canonical");
        const deleted = new Set<string>([name]);
        let added = true;
        while (added) {
          added = false;
          for (const command of Object.values(state.commandsByName)) {
            const source =
              command.responseType === "computed"
                ? Option.getOrNull(command.counterSourceName)
                : command.valueSourceName;
            if (!deleted.has(command.name) && source !== null && deleted.has(source)) {
              deleted.add(command.name);
              added = true;
            }
          }
        }
        yield* persistState(
          pruneCommandState({
            ...state,
            revision: state.revision + 1,
            commandsByName: Object.fromEntries(
              Object.entries(state.commandsByName).filter(([key]) => !deleted.has(key)),
            ),
          }),
        );
      }),
    );
  }, persistenceErrors);
  const updateCommandValue: ICommands["updateCommandValue"] = Effect.fn(
    "Commands.updateCommandValue",
  )(function* (input) {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const state = yield* readState();
        const fingerprint = JSON.stringify({
          kind: "update",
          commandName: input.name,
          value: input.value,
          actor: input.actor,
        });
        const receipt = yield* checkReceipt(state, input.operationId, fingerprint);
        if (Option.isSome(receipt)) {
          if (receipt.value.kind === "update") return;
          return yield* new CommandInputParseError({
            operation: "updateCommandValue",
          });
        }
        const command = yield* requireCommand(state, input.name, "alias");
        if (command.responseType !== "dynamic")
          return yield* new CommandNotUpdateableError({
            commandName: input.name,
            responseType: command.responseType,
          });
        if (!hasCommandPermission(input.actor.permission, command.writePermission))
          return yield* new CommandUpdatePermissionDeniedError({
            commandName: input.name,
            requiredPermission: command.writePermission,
          });
        yield* persistState({
          ...state,
          revision: state.revision + 1,
          valuesByName: {
            ...state.valuesByName,
            [command.valueSourceName]: {
              value: input.value,
              updatedAt: yield* commandNow,
              updatedBy: Option.some(input.actor.displayName),
            },
          },
          mutationReceiptsByOperationId: appendReceipt(state, input.operationId, {
            kind: "update",
            fingerprint,
          }),
        });
      }),
    );
  }, persistenceErrors);
  const getCommandCounter: ICommands["getCommandCounter"] = Effect.fn("Commands.getCommandCounter")(
    function* ({ name }) {
      const state = yield* readState();
      const command = yield* requireCommand(state, name, "alias");
      return state.countersByName[counterStorageName(command)]?.count ?? 0;
    },
    persistenceErrors,
  );
  const incrementCommandCounter: ICommands["incrementCommandCounter"] = Effect.fn(
    "Commands.incrementCommandCounter",
  )(function* (input) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const state = yield* readState();
        const fingerprint = JSON.stringify({
          kind: "counter",
          commandName: input.name,
          increment: input.increment,
        });
        const receipt = yield* checkReceipt(state, input.operationId, fingerprint);
        if (Option.isSome(receipt)) {
          if (receipt.value.kind === "counter") return receipt.value.resultingCount;
          return yield* new CommandInputParseError({
            operation: "incrementCommandCounter",
          });
        }
        const command = yield* requireCommand(state, input.name, "alias");
        const source = counterStorageName(command);
        const count = (state.countersByName[source]?.count ?? 0) + input.increment;
        yield* persistState({
          ...state,
          revision: state.revision + 1,
          countersByName: {
            ...state.countersByName,
            [source]: { count, updatedAt: yield* commandNow },
          },
          mutationReceiptsByOperationId: appendReceipt(state, input.operationId, {
            kind: "counter",
            fingerprint,
            resultingCount: count,
          }),
        });
        return count;
      }),
    );
  }, persistenceErrors);
  const getDebugSnapshot: ICommands["getDebugSnapshot"] = Effect.fn("Commands.getDebugSnapshot")(
    function* () {
      const state = yield* readState();
      const commands = Object.values(state.commandsByName);
      return {
        commands: commands.map((command) => ({
          command,
          value: commandValue(state, command),
          counter:
            command.responseType === "computed"
              ? Option.fromNullishOr(state.countersByName[counterStorageName(command)]?.count)
              : Option.none<number>(),
        })),
        totals: {
          total: commands.length,
          enabled: commands.filter((command) => command.enabled).length,
          static: commands.filter((command) => command.responseType === "static").length,
          dynamic: commands.filter((command) => command.responseType === "dynamic").length,
          computed: commands.filter((command) => command.responseType === "computed").length,
        },
        revision: state.revision,
        initialized: initialized(state),
      };
    },
    persistenceErrors,
  );
  return Commands.of({
    getCommand,
    getAllCommands,
    getEnabledCommandsByPermission,
    getCommandValue,
    getCommandWithValue,
    getEnabledCommandsWithValues,
    createCommand,
    updateCommand,
    deleteCommand,
    updateCommandValue,
    getCommandCounter,
    incrementCommandCounter,
    getDebugSnapshot,
  });
});

/** SQL registry layer must be acquired only in the Durable Object's inner runtime Effect. */
export const commandsDatabaseLayerWithoutDependencies = Layer.effect(
  Commands,
  makeCommandsDatabase,
);
