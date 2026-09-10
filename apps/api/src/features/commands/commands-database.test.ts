import { SqliteClient } from "@effect/sql-sqlite-node";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Effect, Layer, Option, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ChatCommandName, CreateChatCommandInput } from "@cf-twitch/contracts/chat-command";
import { EventSubMessageId } from "@cf-twitch/contracts/identity";
import { Commands } from "./commands.ts";
import { commandsDatabaseLayerWithoutDependencies } from "./commands-database.ts";
import { defaultCommandMigrationIds } from "./command-defaults.ts";

const name = (value: string) => ChatCommandName.make(value);

const operation = (value: string) => Option.some(EventSubMessageId.make(value));

const sqliteLayer = SqliteClient.layer({ filename: ":memory:" });

const commandsLayer = commandsDatabaseLayerWithoutDependencies.pipe(Layer.provide(sqliteLayer));

const createInput = Schema.decodeUnknownSync(CreateChatCommandInput);

const dynamicInput = (command: string) =>
  createInput({
    name: command,
    description: "Runtime note",
    category: "info",
    responseType: "dynamic",
    permission: "everyone",
    initialValue: "initial",
  });

const actor = { displayName: "ModeratorViewer", permission: "moderator" } as const;

const parseStoredRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ state: Schema.String })),
);

const legacyCommand = {
  name: "runtime",
  description: "Runtime definition",
  category: "stats",
  responseType: "computed",
  permission: "vip",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  aliases: ["rt"],
  valueSourceName: null,
  counterSourceName: "runtime",
  handlerKey: "skillissue",
  outputTemplate: null,
  emptyResponse: null,
  writePermission: null,
};

const legacyState = {
  revision: 44,
  commandsByName: { runtime: legacyCommand },
  valuesByName: {},
  countersByName: { runtime: { count: 73, updatedAt: "2026-01-01T00:00:00.000Z" } },
  mutationReceiptsByOperationId: {
    "old-message": {
      kind: "counter",
      fingerprint: JSON.stringify({ kind: "counter", commandName: "runtime", increment: 1 }),
      resultingCount: 73,
    },
  },
  appliedMigrations: defaultCommandMigrationIds,
  legacyImportCompleted: true,
  migrationReport: { importedCommands: 1 },
};

const seedLegacyState = (state: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE cf_agents_state (id TEXT PRIMARY KEY, state TEXT)`;
    yield* sql`INSERT INTO cf_agents_state (id, state) VALUES ('cf_state_row_id', ${state})`;
  });

describe("Commands SQL authority", () => {
  it.effect(
    "treats prototype-shaped command names and operation identities as ordinary own keys",
    () =>
      Effect.gen(function* () {
        const commands = yield* Commands;
        yield* commands.createCommand(dynamicInput("constructor"));
        yield* commands.updateCommandValue({
          name: name("constructor"),
          value: "safe",
          actor,
          operationId: operation("__proto__"),
        });
        yield* commands.updateCommandValue({
          name: name("constructor"),
          value: "safe",
          actor,
          operationId: operation("__proto__"),
        });
        expect(yield* commands.getCommandValue({ name: name("constructor") })).toEqual(
          Option.some("safe"),
        );
        yield* commands.deleteCommand({ name: name("constructor") });
        expect(
          yield* commands.getCommand({ name: name("constructor") }).pipe(Effect.result),
        ).toMatchObject({ failure: { _tag: "CommandNotFoundError" } });
      }).pipe(Effect.provide(commandsLayer)),
  );
  it.effect("bootstraps all 37 exact defaults, alias and shared topic source", () =>
    Effect.gen(function* () {
      const commands = yield* Commands;
      expect((yield* commands.getAllCommands()).map((command) => command.name)).toEqual([
        "keyboard",
        "socials",
        "github",
        "twitter",
        "schedule",
        "font",
        "dotfiles",
        "today",
        "project",
        "plan",
        "herdr",
        "hex",
        "achievements",
        "stats",
        "raffle-leaderboard",
        "commands",
        "update",
        "song",
        "queue",
        "functor",
        "location",
        "ocaml",
        "lurk",
        "youtube",
        "unlurk",
        "errors",
        "vibes",
        "neovim",
        "dict",
        "beam",
        "linux",
        "time",
        "leak",
        "skillissue",
        "truth",
        "job",
        "browser",
      ]);
      expect((yield* commands.getCommand({ name: name("df") })).name).toBe("dotfiles");
      expect(yield* commands.getCommandValue({ name: name("today") })).toEqual(Option.some(""));
      expect(yield* commands.getCommandValue({ name: name("hex") })).toEqual(
        Option.some("I am using Hex by Kit Langton: https://hex.kitlangton.com/"),
      );
      expect(yield* commands.getCommandValue({ name: name("herdr") })).toEqual(
        Option.some("Herdr: https://herdr.dev/"),
      );
      expect((yield* commands.getCommand({ name: name("project") })).valueSourceName).toBe("today");
      expect(yield* commands.getDebugSnapshot()).toMatchObject({
        revision: 1,
        initialized: true,
        totals: { total: 37, enabled: 37 },
      });
      const defaults = yield* commands.getDebugSnapshot();
      expect({
        ...defaults,
        commands: defaults.commands.map((entry) => ({
          ...entry,
          command: { ...entry.command, createdAt: "<bootstrap instant>" },
        })),
      }).toMatchSnapshot();
    }).pipe(Effect.provide(commandsLayer)),
  );

  it.effect(
    "creates a runtime command and atomically updates its shared value through an alias",
    () =>
      Effect.gen(function* () {
        const commands = yield* Commands;
        yield* commands.createCommand(dynamicInput("runtime"));
        yield* commands.updateCommand({ name: name("runtime"), patch: { aliases: [name("rt")] } });
        yield* commands.updateCommandValue({
          name: name("rt"),
          value: "updated",
          actor,
          operationId: Option.none(),
        });
        expect(yield* commands.getCommandWithValue({ name: name("runtime") })).toMatchObject({
          value: Option.some("updated"),
        });
        yield* commands.updateCommandValue({
          name: name("project"),
          value: "shared",
          actor,
          operationId: Option.none(),
        });
        expect(yield* commands.getCommandValue({ name: name("today") })).toEqual(
          Option.some("shared"),
        );
      }).pipe(Effect.provide(commandsLayer)),
  );

  it.effect(
    "rejects duplicate names, alias collisions, duplicate aliases and missing sources without partial writes",
    () =>
      Effect.gen(function* () {
        const commands = yield* Commands;
        const before = yield* commands.getDebugSnapshot();
        const duplicate = yield* commands.createCommand(dynamicInput("df")).pipe(Effect.result);
        expect(duplicate).toMatchObject({ failure: { _tag: "CommandAlreadyExistsError" } });

        for (const aliases of [
          [name("keyboard")],
          [name("df")],
          [name("dupe"), name("dupe")],
          [name("today")],
        ]) {
          expect(
            yield* commands
              .updateCommand({ name: name("today"), patch: { aliases } })
              .pipe(Effect.result),
          ).toMatchObject({ failure: { _tag: "CommandAliasConflictError" } });
        }

        const missing = yield* commands
          .createCommand({
            ...dynamicInput("missing-source"),
            responseType: "dynamic",
            valueSourceName: name("missing"),
            initialValue: "do not write",
          })
          .pipe(Effect.result);

        expect(missing).toMatchObject({ failure: { _tag: "CommandInvalidDefinitionError" } });
        expect(yield* commands.getDebugSnapshot()).toEqual(before);
      }).pipe(Effect.provide(commandsLayer)),
  );

  it.effect(
    "rejects incomplete response transitions and accepts complete transitions while pruning obsolete state",
    () =>
      Effect.gen(function* () {
        const commands = yield* Commands;
        expect(
          yield* commands
            .updateCommand({ name: name("today"), patch: { responseType: "computed" } })
            .pipe(Effect.result),
        ).toMatchObject({ failure: { _tag: "CommandInvalidDefinitionError" } });
        yield* commands.deleteCommand({ name: name("project") });
        yield* commands.updateCommand({
          name: name("today"),
          patch: {
            responseType: "computed",
            valueSourceName: null,
            counterSourceName: name("today"),
            handlerKey: "time",
            outputTemplate: null,
            emptyResponse: null,
            writePermission: null,
          },
        });
        expect(yield* commands.getCommandValue({ name: name("today") })).toEqual(Option.none());
        expect(
          yield* commands.incrementCommandCounter({
            name: name("today"),
            increment: 3,
            operationId: Option.none(),
          }),
        ).toBe(3);
      }).pipe(Effect.provide(commandsLayer)),
  );

  it.effect("rechecks current write permission inside the transaction, not stale metadata", () =>
    Effect.gen(function* () {
      const commands = yield* Commands;
      yield* commands.getCommand({ name: name("today") });
      yield* commands.updateCommand({
        name: name("today"),
        patch: { writePermission: "broadcaster" },
      });
      expect(
        yield* commands
          .updateCommandValue({
            name: name("today"),
            value: "denied",
            actor,
            operationId: operation("denied"),
          })
          .pipe(Effect.result),
      ).toMatchObject({
        failure: { _tag: "CommandUpdatePermissionDeniedError", requiredPermission: "broadcaster" },
      });
      expect(yield* commands.getCommandValue({ name: name("today") })).toEqual(Option.some(""));
      yield* commands.updateCommandValue({
        name: name("today"),
        value: "allowed",
        actor: { ...actor, permission: "broadcaster" },
        operationId: operation("denied"),
      });
      expect(yield* commands.getCommandValue({ name: name("today") })).toEqual(
        Option.some("allowed"),
      );
      expect(
        yield* commands
          .updateCommandValue({
            name: name("keyboard"),
            value: "no",
            actor,
            operationId: Option.none(),
          })
          .pipe(Effect.result),
      ).toMatchObject({ failure: { _tag: "CommandNotUpdateableError" } });
    }).pipe(Effect.provide(commandsLayer)),
  );

  it.effect(
    "recursively deletes value and counter dependents and requires canonical admin names",
    () =>
      Effect.gen(function* () {
        const commands = yield* Commands;
        yield* commands.createCommand({
          ...dynamicInput("grandchild"),
          responseType: "dynamic",
          valueSourceName: name("project"),
        });
        yield* commands.createCommand(
          createInput({
            name: "counter-child",
            description: "Dependent",
            category: "stats",
            permission: "everyone",
            responseType: "computed",
            counterSourceName: "grandchild",
            handlerKey: "skillissue",
          }),
        );
        expect(
          yield* commands.deleteCommand({ name: name("df") }).pipe(Effect.result),
        ).toMatchObject({ failure: { _tag: "CommandNotFoundError" } });
        yield* commands.deleteCommand({ name: name("today") });

        for (const missing of ["today", "project", "grandchild", "counter-child"])
          expect(
            yield* commands.getCommand({ name: name(missing) }).pipe(Effect.result),
          ).toMatchObject({ failure: { _tag: "CommandNotFoundError" } });
      }).pipe(Effect.provide(commandsLayer)),
  );

  it.effect(
    "filters read permissions and disabled commands while administrative reads retain them",
    () =>
      Effect.gen(function* () {
        const commands = yield* Commands;
        yield* commands.updateCommand({ name: name("keyboard"), patch: { enabled: false } });

        const available = yield* commands.getEnabledCommandsByPermission({
          permission: "everyone",
        });

        expect(
          available.some(
            (command) =>
              command.name === "keyboard" ||
              command.name === "skillissue" ||
              command.name === "update",
          ),
        ).toBe(false);
        expect((yield* commands.getEnabledCommandsWithValues()).length).toBe(36);
        expect((yield* commands.getAllCommands()).length).toBe(37);
      }).pipe(Effect.provide(commandsLayer)),
  );

  it.effect(
    "deduplicates concurrent counter mutations and rejects different-input operation reuse",
    () =>
      Effect.gen(function* () {
        const commands = yield* Commands;

        const input = {
          name: name("skillissue"),
          increment: 1,
          operationId: operation("same-message"),
        };

        expect(
          yield* Effect.all(
            [commands.incrementCommandCounter(input), commands.incrementCommandCounter(input)],
            { concurrency: "unbounded" },
          ),
        ).toEqual([1, 1]);
        expect(
          yield* commands.incrementCommandCounter({ ...input, increment: 2 }).pipe(Effect.result),
        ).toMatchObject({ failure: { _tag: "CommandInputParseError" } });
        expect(
          yield* commands
            .updateCommandValue({
              name: name("today"),
              value: "different mutation",
              actor,
              operationId: input.operationId,
            })
            .pipe(Effect.result),
        ).toMatchObject({ failure: { _tag: "CommandInputParseError" } });
        expect(yield* commands.getCommandCounter({ name: name("skillissue") })).toBe(1);
      }).pipe(Effect.provide(commandsLayer)),
  );

  it.effect(
    "replaying a value receipt never overwrites a later update, even after permission changes",
    () =>
      Effect.gen(function* () {
        const commands = yield* Commands;

        const input = {
          name: name("today"),
          value: "first",
          actor,
          operationId: operation("first"),
        };

        yield* commands.updateCommandValue(input);
        yield* commands.updateCommandValue({
          ...input,
          value: "second",
          operationId: operation("second"),
        });
        yield* commands.updateCommand({
          name: name("today"),
          patch: { writePermission: "broadcaster" },
        });
        yield* commands.updateCommandValue(input);
        expect(yield* commands.getCommandValue({ name: name("today") })).toEqual(
          Option.some("second"),
        );
        expect(
          yield* commands.updateCommandValue({ ...input, value: "tampered" }).pipe(Effect.result),
        ).toMatchObject({ failure: { _tag: "CommandInputParseError" } });
      }).pipe(Effect.provide(commandsLayer)),
  );

  it.effect(
    "imports historical Agent state losslessly and does not replay applied migrations on restart",
    () =>
      Effect.gen(function* () {
        yield* seedLegacyState(JSON.stringify(legacyState));

        const inspect = Effect.gen(function* () {
          const commands = yield* Commands;
          expect((yield* commands.getAllCommands()).length).toBe(1);
          expect((yield* commands.getCommand({ name: name("rt") })).name).toBe("runtime");
          expect(
            yield* commands.incrementCommandCounter({
              name: name("runtime"),
              increment: 1,
              operationId: operation("old-message"),
            }),
          ).toBe(73);
          expect(yield* commands.getDebugSnapshot()).toMatchObject({ revision: 44 });
        });

        yield* inspect.pipe(
          Effect.provide(commandsDatabaseLayerWithoutDependencies, { local: true }),
        );
        yield* inspect.pipe(
          Effect.provide(commandsDatabaseLayerWithoutDependencies, { local: true }),
        );
        const sql = yield* SqlClient.SqlClient;

        const source = yield* parseStoredRows(
          yield* sql`SELECT state FROM cf_agents_state WHERE id = 'cf_state_row_id'`,
        );

        expect(source[0]?.state).toBe(JSON.stringify(legacyState));
      }).pipe(Effect.provide(sqliteLayer)),
  );

  it.effect("applies only missing additive migrations and retains runtime replacements", () =>
    Effect.gen(function* () {
      yield* seedLegacyState(
        JSON.stringify({
          ...legacyState,
          appliedMigrations: [],
          commandsByName: {
            runtime: legacyCommand,
            herdr: { ...legacyCommand, name: "herdr", aliases: [], counterSourceName: "runtime" },
          },
        }),
      );

      const inspect = Effect.gen(function* () {
        const commands = yield* Commands;
        expect((yield* commands.getCommand({ name: name("herdr") })).responseType).toBe("computed");
        expect(yield* commands.getCommandValue({ name: name("plan") })).toEqual(
          Option.some("Plannotator: https://plannotator.ai"),
        );
        expect((yield* commands.getAllCommands()).map((command) => command.name)).toEqual([
          "runtime",
          "herdr",
          "plan",
          "hex",
        ]);
        expect(yield* commands.getDebugSnapshot()).toMatchObject({ revision: 45 });
      });

      yield* inspect.pipe(
        Effect.provide(commandsDatabaseLayerWithoutDependencies, { local: true }),
      );
      yield* inspect.pipe(
        Effect.provide(commandsDatabaseLayerWithoutDependencies, { local: true }),
      );
    }).pipe(Effect.provide(sqliteLayer)),
  );

  it.effect(
    "blocks startup on corrupt JSON, invalid references and alias collisions instead of bootstrapping",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedLegacyState("{broken");

        for (const state of [
          "{broken",
          JSON.stringify({
            ...legacyState,
            commandsByName: { runtime: { ...legacyCommand, counterSourceName: "absent" } },
          }),
          JSON.stringify({
            ...legacyState,
            commandsByName: { runtime: { ...legacyCommand, aliases: ["runtime"] } },
          }),
        ]) {
          yield* sql`UPDATE cf_agents_state SET state = ${state} WHERE id = 'cf_state_row_id'`;

          const result = yield* Effect.gen(function* () {
            yield* Commands;
          }).pipe(
            Effect.provide(commandsDatabaseLayerWithoutDependencies, { local: true }),
            Effect.result,
          );

          expect(Result.isFailure(result)).toBe(true);
          expect(yield* parseStoredRows(yield* sql`SELECT state FROM commands_snapshot`)).toEqual(
            [],
          );
        }
      }).pipe(Effect.provide(sqliteLayer)),
  );

  it.effect(
    "does not recreate defaults after the administrator deletes every command and restarts",
    () =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const commands = yield* Commands;
          let all = yield* commands.getAllCommands();

          while (all.length > 0) {
            const first = all[0];

            if (first !== undefined) yield* commands.deleteCommand({ name: first.name });
            all = yield* commands.getAllCommands();
          }
        }).pipe(Effect.provide(commandsDatabaseLayerWithoutDependencies, { local: true }));
        yield* Effect.gen(function* () {
          const commands = yield* Commands;
          expect(yield* commands.getAllCommands()).toEqual([]);
          expect((yield* commands.getDebugSnapshot()).initialized).toBe(true);
        }).pipe(Effect.provide(commandsDatabaseLayerWithoutDependencies, { local: true }));
      }).pipe(Effect.provide(sqliteLayer)),
  );

  it.effect("fails closed when already-migrated SQL data becomes corrupt", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const commands = yield* Commands;
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE commands_snapshot SET state = '{broken' WHERE singleton = 1`;
        expect(yield* commands.getAllCommands().pipe(Effect.result)).toMatchObject({
          failure: { _tag: "CommandsStateParseError" },
        });
      }).pipe(Effect.provide(commandsDatabaseLayerWithoutDependencies));
    }).pipe(Effect.provide(sqliteLayer)),
  );

  it.effect(
    "retains exactly the latest 5000 receipts across imported state and subsequent mutations",
    () =>
      Effect.gen(function* () {
        const receipts = Object.fromEntries(
          Array.from({ length: 5000 }, (_, index) => [
            `message-${index}`,
            {
              kind: "counter",
              fingerprint: JSON.stringify({
                kind: "counter",
                commandName: "runtime",
                increment: 1,
              }),
              resultingCount: index + 1,
            },
          ]),
        );

        yield* seedLegacyState(
          JSON.stringify({ ...legacyState, mutationReceiptsByOperationId: receipts }),
        );
        yield* Effect.gen(function* () {
          const commands = yield* Commands;
          expect(
            yield* commands.incrementCommandCounter({
              name: name("runtime"),
              increment: 1,
              operationId: operation("message-4999"),
            }),
          ).toBe(5000);
          expect(
            yield* commands.incrementCommandCounter({
              name: name("runtime"),
              increment: 1,
              operationId: operation("new-message"),
            }),
          ).toBe(74);
          // The oldest identity was evicted, so replay is intentionally a new mutation.
          expect(
            yield* commands.incrementCommandCounter({
              name: name("runtime"),
              increment: 1,
              operationId: operation("message-0"),
            }),
          ).toBe(75);
          expect(
            yield* commands.incrementCommandCounter({
              name: name("runtime"),
              increment: 1,
              operationId: operation("message-2"),
            }),
          ).toBe(3);
        }).pipe(Effect.provide(commandsDatabaseLayerWithoutDependencies));
      }).pipe(Effect.provide(sqliteLayer)),
  );
});
