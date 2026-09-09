import { SqliteClient } from "@effect/sql-sqlite-node";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import { Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiClient } from "effect/unstable/httpapi";
import { ChatCommandName } from "@cf-twitch/contracts/chat-command";
import { EventSubMessageId } from "@cf-twitch/contracts/identity";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { commandsDatabaseLayerWithoutDependencies } from "./commands-database.ts";
import { CommandsHttpApi } from "./commands-http-api.ts";
import { commandsHttpHandlersLayerWithoutDependencies } from "./commands-http-handlers.ts";

const httpLayer = HttpApiBuilder.layer(CommandsHttpApi).pipe(
  Layer.provide(
    commandsHttpHandlersLayerWithoutDependencies.pipe(
      Layer.provide(
        commandsDatabaseLayerWithoutDependencies.pipe(
          Layer.provide(SqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
    ),
  ),
  Layer.provide(cloudflareHttpServerLayer),
);

const server = Effect.acquireRelease(
  Effect.sync(() => HttpRouter.toWebHandler(httpLayer, { disableLogger: true })),
  (server) => Effect.promise(() => server.dispose()),
);

const parseErrorBody = Schema.decodeUnknownEffect(Schema.Struct({ _tag: Schema.String }));

describe("Commands real HTTP API", () => {
  it.effect(
    "roundtrips schemas, Options, atomic mutations and typed conflicts using the generated HTTP client",
    () =>
      Effect.gen(function* () {
        const app = yield* server;

        const fetchLayer = FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.succeed(FetchHttpClient.Fetch, (input, init) =>
              app.handler(new Request(input, init)),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const httpClient = yield* HttpClient.HttpClient;

          const client = yield* HttpApiClient.makeWith(CommandsHttpApi, {
            baseUrl: "http://commands.test",
            httpClient,
          });

          expect((yield* client.commands.getAllCommands()).length).toBe(37);
          const today = ChatCommandName.make("today");

          const update = {
            name: today,
            value: "HTTP update",
            actor: { displayName: "Mod", permission: "moderator" as const },
            operationId: Option.some(EventSubMessageId.make("http-message")),
          };

          yield* client.commands.updateCommandValue({ payload: update });
          yield* client.commands.updateCommandValue({ payload: update });
          expect(
            yield* client.commands.getCommandValue({
              payload: { name: ChatCommandName.make("project") },
            }),
          ).toEqual(Option.some("HTTP update"));
          expect(
            yield* client.commands
              .updateCommandValue({ payload: { ...update, value: "conflict" } })
              .pipe(Effect.result),
          ).toMatchObject({ failure: { _tag: "CommandInputParseError" } });

          const created = yield* client.commands.createCommand({
            payload: {
              name: ChatCommandName.make("runtime"),
              description: "HTTP runtime",
              category: "stats",
              permission: "everyone",
              responseType: "computed",
              handlerKey: "time",
              counterSourceName: ChatCommandName.make("runtime"),
              initialCounter: 2,
            },
          });

          expect(created).toMatchObject({ counterSourceName: Option.some("runtime") });
          expect(
            yield* client.commands.incrementCommandCounter({
              payload: { name: created.name, increment: 3, operationId: Option.none() },
            }),
          ).toBe(5);
          yield* client.commands.deleteCommand({ payload: { name: created.name } });
          expect(
            yield* client.commands
              .getCommand({ payload: { name: created.name } })
              .pipe(Effect.result),
          ).toMatchObject({
            failure: { _tag: "CommandNotFoundError", message: "Command not found: runtime" },
          });
        }).pipe(Effect.provide(fetchLayer));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects unknown create fields, contradictory variants, malformed names and empty patches at HTTP boundary",
    () =>
      Effect.gen(function* () {
        const app = yield* server;

        const requests = [
          {
            method: "POST",
            path: "/v1/commands",
            body: {
              name: "bad",
              description: "Bad",
              category: "info",
              permission: "everyone",
              responseType: "computed",
              handlerKey: "time",
              initialValue: "must not disappear",
            },
          },
          {
            method: "POST",
            path: "/v1/commands",
            body: {
              name: "bad",
              description: "Bad",
              category: "info",
              permission: "everyone",
              responseType: "static",
              surprise: true,
            },
          },
          { method: "PATCH", path: "/v1/commands", body: { name: "today", patch: {} } },
          {
            method: "PATCH",
            path: "/v1/commands",
            body: { name: "today", patch: { enable: false } },
          },
          { method: "POST", path: "/v1/commands/lookup", body: { name: "Bad Name" } },
          {
            method: "POST",
            path: "/v1/commands/counter/increment",
            body: { name: "skillissue", increment: 101, operationId: null },
          },
        ];

        for (const input of requests) {
          const response = yield* Effect.promise(() =>
            app.handler(
              new Request(`http://commands.test${input.path}`, {
                method: input.method,
                headers: { "content-type": "application/json" },
                body: JSON.stringify(input.body),
              }),
            ),
          );

          expect(response.status).toBe(400);
        }

        const response = yield* Effect.promise(() =>
          app.handler(
            new Request("http://commands.test/v1/commands", {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ name: "today", patch: { responseType: "computed" } }),
            }),
          ),
        );

        const error = yield* parseErrorBody(yield* Effect.promise(() => response.json()));
        expect(error._tag).toBe("CommandInvalidDefinitionError");
      }).pipe(Effect.scoped),
  );
});
