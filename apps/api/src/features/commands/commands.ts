import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import {
  ChatCommandDefinition,
  CommandAlreadyExistsError,
  CommandInputParseError,
  CommandInvalidDefinitionError,
  CommandNotFoundError,
  CommandNotUpdateableError,
  CommandUpdatePermissionDeniedError,
  CommandsStateParseError,
  parseCreateChatCommandInput,
  type ChatCommandDebugSnapshot,
  type ChatCommandName,
  type ChatCommandOperation,
  type ChatCommandPermission,
  type ChatCommandSelector,
  type ChatCommandWithValue,
  type CommandsError,
  type CreateChatCommandInput,
  type IncrementChatCommandCounter,
  type UpdateChatCommandRequest,
  type UpdateChatCommandValue,
} from "@cf-twitch/contracts/chat-command";
import { IsoTimestamp, type EventSubMessageId } from "@cf-twitch/contracts/identity";
import {
  createDefaultCommandInputs,
  defaultCommandMigrationIds,
  defaultCommandMigrations,
} from "./command-defaults.ts";
import { hasCommandPermission } from "./command-permissions.ts";
import {
  CommandsSnapshotStore,
  commandSourceName,
  commandsSnapshotStoreLayer,
  commandsSnapshotStoreTestLayer,
  type CommandMutationReceipt,
  type CommandsSnapshot,
} from "./commands-snapshot-store.ts";

/** Chat command registry: definitions, aliases, shared values, counters, and replayable mutations. */
export interface ICommands {
  /**
   * Returns the command named by a canonical name or alias.
   *
   * @returns The definition, or fails with `CommandNotFoundError` when no command or alias has the
   * name, and with `CommandsDbError`, `CommandsInvalidResponseError`, or `CommandsStateParseError`
   * when the registry cannot be read.
   */
  readonly getCommand: (
    input: typeof ChatCommandSelector.Type,
  ) => Effect.Effect<ChatCommandDefinition, CommandsError>;
  /**
   * Returns every command definition, enabled or not.
   *
   * @returns The definitions, or fails with a registry read error when the registry cannot be read.
   */
  readonly getAllCommands: () => Effect.Effect<readonly ChatCommandDefinition[], CommandsError>;
  /**
   * Returns the enabled commands a viewer with the given permission may run.
   *
   * @returns The definitions, or fails with a registry read error when the registry cannot be read.
   */
  readonly getEnabledCommandsByPermission: (input: {
    readonly permission: ChatCommandPermission;
  }) => Effect.Effect<readonly ChatCommandDefinition[], CommandsError>;
  /**
   * Returns the shared stored value a command renders.
   *
   * @returns The value, `Option.none()` when the name is unknown, the command is computed, or no
   * value is stored, or fails with a registry read error when the registry cannot be read.
   */
  readonly getCommandValue: (
    input: typeof ChatCommandSelector.Type,
  ) => Effect.Effect<Option.Option<string>, CommandsError>;
  /**
   * Returns a command together with its shared stored value.
   *
   * @returns The command and value, or fails with `CommandNotFoundError` when no command or alias has
   * the name, and with a registry read error when the registry cannot be read.
   */
  readonly getCommandWithValue: (
    input: typeof ChatCommandSelector.Type,
  ) => Effect.Effect<ChatCommandWithValue, CommandsError>;
  /**
   * Returns every enabled command together with its shared stored value.
   *
   * @returns The commands and values, or fails with a registry read error when the registry cannot be read.
   */
  readonly getEnabledCommandsWithValues: () => Effect.Effect<
    readonly ChatCommandWithValue[],
    CommandsError
  >;
  /**
   * Creates a command and its optional initial value or counter in one atomic change.
   *
   * @returns The created definition, or fails with `CommandAlreadyExistsError` when the name is
   * already a command or alias, `CommandAliasConflictError` or `CommandInvalidDefinitionError` when
   * its aliases or source command are invalid, and a registry error when storage is unavailable.
   */
  readonly createCommand: (
    input: CreateChatCommandInput,
  ) => Effect.Effect<ChatCommandDefinition, CommandsError>;
  /**
   * Applies a definition patch to a command named by its canonical name.
   *
   * @returns The updated definition, or fails with `CommandNotFoundError` for an unknown name or an
   * alias, `CommandInvalidDefinitionError` for an incomplete response-type change or missing source,
   * `CommandAliasConflictError` for alias collisions, and a registry error when storage is unavailable.
   */
  readonly updateCommand: (
    input: typeof UpdateChatCommandRequest.Type,
  ) => Effect.Effect<ChatCommandDefinition, CommandsError>;
  /**
   * Deletes a command, every command that reads from it, and their unreferenced values and counters.
   *
   * @returns Nothing, or fails with `CommandNotFoundError` for an unknown name or an alias, and a
   * registry error when storage is unavailable.
   */
  readonly deleteCommand: (
    input: typeof ChatCommandSelector.Type,
  ) => Effect.Effect<void, CommandsError>;
  /**
   * Stores a dynamic command's value after checking the actor's current write permission.
   *
   * **Details**
   *
   * A repeated operation ID with identical input replays without changing state or re-checking
   * permission. The latest 5,000 operation IDs are retained.
   *
   * @returns Nothing, or fails with `CommandInputParseError` when the operation ID was used with
   * different input, `CommandNotFoundError`, `CommandNotUpdateableError` for non-dynamic commands,
   * `CommandUpdatePermissionDeniedError`, and a registry error when storage is unavailable.
   */
  readonly updateCommandValue: (
    input: typeof UpdateChatCommandValue.Type,
  ) => Effect.Effect<void, CommandsError>;
  /**
   * Returns the current count stored for a command's counter source.
   *
   * @returns The count, `0` when nothing has been counted, or fails with `CommandNotFoundError` and
   * registry read errors.
   */
  readonly getCommandCounter: (
    input: typeof ChatCommandSelector.Type,
  ) => Effect.Effect<number, CommandsError>;
  /**
   * Adds to a command's counter, replaying the original result for a repeated operation ID.
   *
   * @returns The resulting count, or fails with `CommandInputParseError` when the operation ID was
   * used with different input, `CommandNotFoundError`, and a registry error when storage is unavailable.
   */
  readonly incrementCommandCounter: (
    input: typeof IncrementChatCommandCounter.Type,
  ) => Effect.Effect<number, CommandsError>;
  /**
   * Returns definitions, values, counters, totals, and revision for diagnostics.
   *
   * @returns The snapshot, or fails with a registry read error when the registry cannot be read.
   */
  readonly getDebugSnapshot: () => Effect.Effect<ChatCommandDebugSnapshot, CommandsError>;
}

/** Service for the chat command registry, backed by SQLite in `CommandsDO` and by HTTP in Worker callers. */
export class Commands extends Context.Service<Commands, ICommands>()("@cf-twitch/Commands") {}

const refineTimestamp = Schema.decodeEffect(IsoTimestamp);

const encodeDefinition = Schema.encodeEffect(ChatCommandDefinition);

const decodeUpdatedDefinition = Schema.decodeEffect(Schema.toCodecJson(ChatCommandDefinition), {
  onExcessProperty: "error",
});

const maximumRetainedReceipts = 5000;

// Clock output is always a valid ISO instant; a refinement failure would be a runtime defect.
const commandNow = Clock.currentTimeMillis.pipe(
  Effect.flatMap((now) => refineTimestamp(new Date(now).toISOString())),
  Effect.orDie,
);

// Registry records are plain objects keyed by untrusted names, so only own properties count.
const ownEntry = <A>(record: Readonly<Record<string, A>>, key: string): Option.Option<A> =>
  Object.hasOwn(record, key) ? Option.fromNullishOr(record[key]) : Option.none();

const counterStorageName = (command: ChatCommandDefinition): ChatCommandName =>
  Option.getOrElse(
    command.responseType === "computed" ? command.counterSourceName : Option.none(),
    () => command.name,
  );

const resolveCommand = (
  state: CommandsSnapshot,
  name: string,
): Option.Option<ChatCommandDefinition> =>
  Option.orElse(ownEntry(state.commandsByName, name), () =>
    Option.fromNullishOr(
      Object.values(state.commandsByName).find((command) =>
        command.aliases.some((alias) => alias === name),
      ),
    ),
  );

const commandValue = (
  state: CommandsSnapshot,
  command: ChatCommandDefinition,
): Option.Option<string> =>
  command.responseType === "computed"
    ? Option.none()
    : Option.map(ownEntry(state.valuesByName, command.valueSourceName), (stored) => stored.value);

const commandCount = (state: CommandsSnapshot, command: ChatCommandDefinition): number =>
  Option.match(ownEntry(state.countersByName, counterStorageName(command)), {
    onNone: () => 0,
    onSome: (counter) => counter.count,
  });

// A positive revision records that bootstrap happened, so deleting every command never re-bootstraps.
const isInitialized = (state: CommandsSnapshot): boolean =>
  state.revision > 0 ||
  Object.keys(state.commandsByName).length > 0 ||
  Object.keys(state.valuesByName).length > 0 ||
  Object.keys(state.countersByName).length > 0;

const pruneCommandState = (state: CommandsSnapshot): CommandsSnapshot => {
  const commands = Object.values(state.commandsByName);

  const values = new Set<string>(
    commands.flatMap((command) =>
      command.responseType === "computed" ? [] : [command.valueSourceName],
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
  now: IsoTimestamp,
): ChatCommandDefinition => {
  const base = {
    name: input.name,
    description: input.description,
    category: input.category,
    permission: input.permission,
    enabled: Option.getOrElse(input.enabled, () => true),
    createdAt: Option.getOrElse(input.createdAt, () => now),
    aliases: Option.getOrElse(input.aliases, () => []),
  };

  if (input.responseType === "computed")
    return {
      ...base,
      responseType: "computed",
      valueSourceName: null,
      counterSourceName: input.counterSourceName,
      handlerKey: input.handlerKey,
      outputTemplate: null,
      emptyResponse: null,
      writePermission: null,
    };

  const stored = {
    ...base,
    valueSourceName: Option.getOrElse(input.valueSourceName, () => input.name),
    counterSourceName: null,
    handlerKey: null,
    outputTemplate: Option.getOrElse(input.outputTemplate, () => "{value}"),
    emptyResponse: Option.getOrElse(
      input.emptyResponse,
      () => `${input.name} info is not available.`,
    ),
  };

  return input.responseType === "static"
    ? { ...stored, responseType: "static", writePermission: null }
    : {
        ...stored,
        responseType: "dynamic",
        writePermission: Option.getOrElse(input.writePermission, () => "moderator"),
      };
};

const initialCommandValues = (
  state: CommandsSnapshot,
  command: ChatCommandDefinition,
  input: CreateChatCommandInput,
  now: IsoTimestamp,
): CommandsSnapshot["valuesByName"] =>
  input.responseType === "computed" ||
  command.responseType === "computed" ||
  Option.isNone(input.initialValue)
    ? state.valuesByName
    : {
        ...state.valuesByName,
        [command.valueSourceName]: {
          value: input.initialValue.value,
          updatedAt: now,
          updatedBy: Option.none(),
        },
      };

const initialCommandCounters = (
  state: CommandsSnapshot,
  input: CreateChatCommandInput,
  now: IsoTimestamp,
): CommandsSnapshot["countersByName"] =>
  input.responseType === "computed" &&
  Option.isSome(input.counterSourceName) &&
  Option.isSome(input.initialCounter)
    ? {
        ...state.countersByName,
        [input.counterSourceName.value]: { count: input.initialCounter.value, updatedAt: now },
      }
    : state.countersByName;

const addCommandToState = (
  state: CommandsSnapshot,
  input: CreateChatCommandInput,
  now: IsoTimestamp,
) => {
  const command = buildCommandDefinition(input, now);

  return {
    command,
    state: pruneCommandState({
      ...state,
      commandsByName: { ...state.commandsByName, [command.name]: command },
      valuesByName: initialCommandValues(state, command, input, now),
      countersByName: initialCommandCounters(state, input, now),
    }),
  };
};

const appendReceipt = (
  state: CommandsSnapshot,
  operationId: Option.Option<EventSubMessageId>,
  receipt: CommandMutationReceipt,
): CommandsSnapshot["mutationReceiptsByOperationId"] =>
  Option.match(operationId, {
    onNone: () => state.mutationReceiptsByOperationId,
    onSome: (id) =>
      Object.fromEntries(
        Object.entries({ ...state.mutationReceiptsByOperationId, [id]: receipt }).slice(
          -maximumRetainedReceipts,
        ),
      ),
  });

const findMatchingReceipt = Effect.fn("Commands.findMatchingReceipt")(function* (
  state: CommandsSnapshot,
  input: {
    readonly operation: ChatCommandOperation;
    readonly commandName: ChatCommandName;
    readonly operationId: Option.Option<EventSubMessageId>;
    readonly kind: CommandMutationReceipt["kind"];
    readonly fingerprint: string;
  },
) {
  const receipt = Option.flatMap(input.operationId, (id) =>
    ownEntry(state.mutationReceiptsByOperationId, id),
  );

  if (
    Option.isSome(receipt) &&
    (receipt.value.fingerprint !== input.fingerprint || receipt.value.kind !== input.kind)
  )
    return yield* new CommandInputParseError({
      operation: input.operation,
      reason: "operation_id_reused",
      commandName: Option.some(input.commandName),
      operationId: input.operationId,
    });

  return receipt;
});

const requireCommand = Effect.fn("Commands.requireCommand")(function* (
  state: CommandsSnapshot,
  name: ChatCommandName,
  input: { readonly operation: ChatCommandOperation; readonly mode: "canonical" | "alias" },
) {
  const canonical = ownEntry(state.commandsByName, name);

  if (Option.isSome(canonical)) return canonical.value;

  const aliased = resolveCommand(state, name);

  if (Option.isSome(aliased) && input.mode === "alias") return aliased.value;

  return yield* new CommandNotFoundError({
    operation: input.operation,
    reason: Option.isSome(aliased) ? "canonical_name_required" : "unknown_command_name",
    commandName: name,
  });
});

// Built-in defaults are source constants, so a parse failure is a programming defect, not stored-data corruption.
const parseDefaultCommandInput = (input: typeof CreateChatCommandInput.Encoded) =>
  parseCreateChatCommandInput(input).pipe(Effect.orDie);

const installDefaultCommands = Effect.fn("Commands.installDefaultCommands")(function* (
  state: CommandsSnapshot,
  now: IsoTimestamp,
) {
  if (isInitialized(state)) return state;

  let initializedState: CommandsSnapshot = {
    ...state,
    revision: 1,
    appliedMigrations: [...defaultCommandMigrationIds],
  };

  for (const encoded of createDefaultCommandInputs(now)) {
    const input = yield* parseDefaultCommandInput(encoded);
    initializedState = addCommandToState(initializedState, input, now).state;
  }

  return initializedState;
});

const applyDefaultCommandMigrations = Effect.fn("Commands.applyDefaultCommandMigrations")(
  function* (state: CommandsSnapshot, now: IsoTimestamp) {
    const pending = defaultCommandMigrations.filter(
      (migration) => !state.appliedMigrations.includes(migration.id),
    );

    let migratedState = state;

    for (const migration of pending) {
      if (migration.kind === "create") {
        const input = yield* parseDefaultCommandInput(migration.createInput(now));

        if (Option.isNone(resolveCommand(migratedState, input.name)))
          migratedState = addCommandToState(migratedState, input, now).state;
      } else {
        const command = resolveCommand(migratedState, migration.commandName);

        if (Option.isSome(command) && Option.isNone(resolveCommand(migratedState, migration.alias)))
          migratedState = {
            ...migratedState,
            commandsByName: {
              ...migratedState.commandsByName,
              [command.value.name]: {
                ...command.value,
                aliases: [...command.value.aliases, migration.alias],
              },
            },
          };
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

const dependentCommandNames = (
  state: CommandsSnapshot,
  name: ChatCommandName,
): ReadonlySet<string> => {
  const deleted = new Set<string>([name]);
  let added = true;

  while (added) {
    added = false;

    for (const command of Object.values(state.commandsByName)) {
      const source = commandSourceName(command);

      if (!deleted.has(command.name) && Option.isSome(source) && deleted.has(source.value)) {
        deleted.add(command.name);
        added = true;
      }
    }
  }

  return deleted;
};

const unchanged = <A>(result: A) => ({ result, next: Option.none<CommandsSnapshot>() });

const changed = <A>(result: A, next: CommandsSnapshot) => ({ result, next: Option.some(next) });

/**
 * Creates the chat command registry over the snapshot store, bootstrapping defaults once.
 *
 * **Details**
 *
 * In one atomic change, imports existing or legacy state, installs the 37 defaults only when the
 * registry was never initialized, and applies outstanding additive default migrations without
 * overwriting runtime names or aliases.
 *
 * @returns The registry, or fails with `CommandsDbError` or `CommandsStateParseError` when stored
 * or legacy state is unavailable or invalid, and with an alias or definition error when an imported
 * graph is inconsistent. It never resets invalid state to defaults.
 */
export const makeCommands = Effect.gen(function* () {
  const store = yield* CommandsSnapshotStore;

  yield* store.initialize((stored) =>
    Effect.gen(function* () {
      const now = yield* commandNow;

      return yield* applyDefaultCommandMigrations(yield* installDefaultCommands(stored, now), now);
    }),
  );

  const getCommand: ICommands["getCommand"] = Effect.fn("Commands.getCommand")(function* ({
    name,
  }) {
    const state = yield* store.read("getCommand");

    return yield* requireCommand(state, name, { operation: "getCommand", mode: "alias" });
  });

  const getAllCommands: ICommands["getAllCommands"] = Effect.fn("Commands.getAllCommands")(
    function* () {
      return Object.values((yield* store.read("getAllCommands")).commandsByName);
    },
  );

  const getEnabledCommandsByPermission: ICommands["getEnabledCommandsByPermission"] = Effect.fn(
    "Commands.getEnabledCommandsByPermission",
  )(function* ({ permission }) {
    const state = yield* store.read("getEnabledCommandsByPermission");

    return Object.values(state.commandsByName).filter(
      (command) => command.enabled && hasCommandPermission(permission, command.permission),
    );
  });

  const getCommandValue: ICommands["getCommandValue"] = Effect.fn("Commands.getCommandValue")(
    function* ({ name }) {
      const state = yield* store.read("getCommandValue");

      return Option.flatMap(resolveCommand(state, name), (command) => commandValue(state, command));
    },
  );

  const getCommandWithValue: ICommands["getCommandWithValue"] = Effect.fn(
    "Commands.getCommandWithValue",
  )(function* ({ name }) {
    const state = yield* store.read("getCommandWithValue");

    const command = yield* requireCommand(state, name, {
      operation: "getCommandWithValue",
      mode: "alias",
    });

    return { command, value: commandValue(state, command) };
  });

  const getEnabledCommandsWithValues: ICommands["getEnabledCommandsWithValues"] = Effect.fn(
    "Commands.getEnabledCommandsWithValues",
  )(function* () {
    const state = yield* store.read("getEnabledCommandsWithValues");

    return Object.values(state.commandsByName)
      .filter((command) => command.enabled)
      .map((command) => ({ command, value: commandValue(state, command) }));
  });

  const createCommand: ICommands["createCommand"] = (input) =>
    store.update("createCommand", (state) =>
      Effect.gen(function* () {
        const existing = resolveCommand(state, input.name);

        if (Option.isSome(existing))
          return yield* new CommandAlreadyExistsError({
            operation: "createCommand",
            reason: existing.value.name === input.name ? "command_name_taken" : "alias_name_taken",
            commandName: input.name,
            existingCommandName: existing.value.name,
          });

        const added = addCommandToState(state, input, yield* commandNow);

        return changed(added.command, { ...added.state, revision: state.revision + 1 });
      }),
    );

  const updateCommand: ICommands["updateCommand"] = ({ name, patch }) =>
    store.update("updateCommand", (state) =>
      Effect.gen(function* () {
        const existing = yield* requireCommand(state, name, {
          operation: "updateCommand",
          mode: "canonical",
        });

        const encodedExisting = yield* encodeDefinition(existing).pipe(
          Effect.mapError(
            () =>
              new CommandsStateParseError({
                operation: "updateCommand",
                reason: "stored_snapshot_invalid",
              }),
          ),
        );

        const updated = yield* decodeUpdatedDefinition({ ...encodedExisting, ...patch }).pipe(
          Effect.mapError(
            () =>
              new CommandInvalidDefinitionError({
                operation: "updateCommand",
                reason: "incomplete_response_transition",
                commandName: name,
                sourceCommandName: Option.none(),
              }),
          ),
        );

        return changed(
          updated,
          pruneCommandState({
            ...state,
            revision: state.revision + 1,
            commandsByName: { ...state.commandsByName, [name]: updated },
          }),
        );
      }),
    );

  const deleteCommand: ICommands["deleteCommand"] = ({ name }) =>
    store.update("deleteCommand", (state) =>
      Effect.gen(function* () {
        yield* requireCommand(state, name, { operation: "deleteCommand", mode: "canonical" });
        const deleted = dependentCommandNames(state, name);

        return changed(
          undefined,
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

  const updateCommandValue: ICommands["updateCommandValue"] = (input) =>
    store.update("updateCommandValue", (state) =>
      Effect.gen(function* () {
        // Key order is part of the stored fingerprint format; imported receipts depend on it.
        const fingerprint = JSON.stringify({
          kind: "update",
          commandName: input.name,
          value: input.value,
          actor: input.actor,
        });

        const receipt = yield* findMatchingReceipt(state, {
          operation: "updateCommandValue",
          commandName: input.name,
          operationId: input.operationId,
          kind: "update",
          fingerprint,
        });

        if (Option.isSome(receipt)) return unchanged(undefined);

        const command = yield* requireCommand(state, input.name, {
          operation: "updateCommandValue",
          mode: "alias",
        });

        if (command.responseType !== "dynamic")
          return yield* new CommandNotUpdateableError({
            operation: "updateCommandValue",
            reason: command.responseType === "static" ? "static_response" : "computed_response",
            commandName: input.name,
          });

        if (!hasCommandPermission(input.actor.permission, command.writePermission))
          return yield* new CommandUpdatePermissionDeniedError({
            operation: "updateCommandValue",
            reason: "write_permission_required",
            commandName: input.name,
            requiredPermission: command.writePermission,
            actorPermission: input.actor.permission,
          });

        return changed(undefined, {
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

  const getCommandCounter: ICommands["getCommandCounter"] = Effect.fn("Commands.getCommandCounter")(
    function* ({ name }) {
      const state = yield* store.read("getCommandCounter");

      const command = yield* requireCommand(state, name, {
        operation: "getCommandCounter",
        mode: "alias",
      });

      return commandCount(state, command);
    },
  );

  const incrementCommandCounter: ICommands["incrementCommandCounter"] = (input) =>
    store.update("incrementCommandCounter", (state) =>
      Effect.gen(function* () {
        // Key order is part of the stored fingerprint format; imported receipts depend on it.
        const fingerprint = JSON.stringify({
          kind: "counter",
          commandName: input.name,
          increment: input.increment,
        });

        const receipt = yield* findMatchingReceipt(state, {
          operation: "incrementCommandCounter",
          commandName: input.name,
          operationId: input.operationId,
          kind: "counter",
          fingerprint,
        });

        if (Option.isSome(receipt) && receipt.value.kind === "counter")
          return unchanged(receipt.value.resultingCount);

        const command = yield* requireCommand(state, input.name, {
          operation: "incrementCommandCounter",
          mode: "alias",
        });

        const source = counterStorageName(command);
        const count = commandCount(state, command) + input.increment;

        return changed(count, {
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
      }),
    );

  const getDebugSnapshot: ICommands["getDebugSnapshot"] = Effect.fn("Commands.getDebugSnapshot")(
    function* () {
      const state = yield* store.read("getDebugSnapshot");
      const commands = Object.values(state.commandsByName);

      return {
        commands: commands.map((command) => ({
          command,
          value: commandValue(state, command),
          counter:
            command.responseType === "computed"
              ? Option.map(
                  ownEntry(state.countersByName, counterStorageName(command)),
                  (counter) => counter.count,
                )
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
        initialized: isInitialized(state),
      };
    },
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

/** Layer that provides the chat command registry and keeps its snapshot store requirement visible. */
export const commandsLayerWithoutDependencies = Layer.effect(Commands, makeCommands);

/**
 * Production SQLite-backed registry Layer used inside `CommandsDO`.
 *
 * **Details**
 *
 * Still requires the Durable Object's SQL client, which exists only in the runtime phase. Worker
 * callers select `commandsClientLayer` instead.
 */
export const commandsLayer = commandsLayerWithoutDependencies.pipe(
  Layer.provide(commandsSnapshotStoreLayer),
);

/** Layer that provides the registry over an in-memory snapshot store, bootstrapped with the defaults. */
export const commandsTestLayer = commandsLayerWithoutDependencies.pipe(
  Layer.provide(commandsSnapshotStoreTestLayer),
);
