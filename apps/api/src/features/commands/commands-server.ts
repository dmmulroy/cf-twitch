import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "alchemy/Cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { commandsDatabaseLayerWithoutDependencies } from "./commands-database.ts";
import { CommandsHttpApi } from "./commands-http-api.ts";
import { commandsHttpHandlersLayerWithoutDependencies } from "./commands-http-handlers.ts";

interface CommandsServerContract {
  readonly fetch: HttpEffect;
}

/** Physical CommandsDO class name remains stable; no production namespace transfer is automatic. */
export class CommandsServer extends Cloudflare.DurableObject<
  CommandsServer,
  CommandsServerContract
>()("CommandsDO") {}

/** Runtime-only SQL acquisition validates and imports historical state before exposing HTTP. */
export const commandsServerLayerWithoutDependencies = CommandsServer.make<never>(
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;

    return Effect.gen(function* () {
      const databaseLayer = commandsDatabaseLayerWithoutDependencies.pipe(
        Layer.provide(SqliteClient.layer({ storage: state.raw.storage })),
      );

      const httpLayer = HttpApiBuilder.layer(CommandsHttpApi).pipe(
        Layer.provide(
          commandsHttpHandlersLayerWithoutDependencies.pipe(Layer.provide(databaseLayer)),
        ),
        Layer.provide(cloudflareHttpServerLayer),
      );

      return { fetch: yield* HttpRouter.toHttpEffect(httpLayer) };
    }).pipe(Effect.orDie);
  }),
);

/** Ready Commands Durable Object server layer selected by the HTTP client. */
const commandsServerLayer = commandsServerLayerWithoutDependencies;

export default commandsServerLayer;
