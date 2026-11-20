import { SqliteClient } from "@effect/sql-sqlite-do";
import * as Cloudflare from "@alchemy.run/cloudflare";
import type { HttpEffect } from "alchemy/Http";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { cloudflareHttpServerLayer } from "../../runtime/cloudflare-http-server.ts";
import { commandsLayer } from "./commands.ts";
import { CommandsHttpApi } from "./commands-http-api.ts";
import { commandsHttpHandlersLayerWithoutDependencies } from "./commands-http-handlers.ts";

/** Handlers the commands Durable Object exposes to Alchemy. */
interface CommandsServerContract {
  /** Serves the versioned internal commands HTTP API. */
  readonly fetch: HttpEffect;
}

/** Durable Object namespace for the commands registry; the physical `CommandsDO` class name stays stable and no namespace transfer is automatic. */
export class CommandsServer extends Cloudflare.DurableObject<
  CommandsServer,
  CommandsServerContract
>()("CommandsDO") {}

/**
 * Layer that registers `CommandsDO` and builds its handlers in the Durable Object runtime phase.
 *
 * **Details**
 *
 * SQL acquisition, migration, legacy import, and default bootstrap run only in the runtime phase,
 * before any HTTP request is served.
 *
 * @throws Dies during Durable Object startup when the registry cannot be migrated, imported, or
 * validated, so corrupt state blocks traffic instead of being reset.
 */
export const commandsServerLayerWithoutDependencies =
  CommandsServer.make<Cloudflare.DurableObjectState>(
    Effect.gen(function* () {
      const state = yield* Cloudflare.DurableObjectState;

      return Effect.gen(function* () {
        const registryLayer = commandsLayer.pipe(
          Layer.provide(SqliteClient.layer({ storage: state.raw.storage })),
        );

        const httpLayer = HttpApiBuilder.layer(CommandsHttpApi).pipe(
          Layer.provide(
            commandsHttpHandlersLayerWithoutDependencies.pipe(Layer.provide(registryLayer)),
          ),
          Layer.provide(cloudflareHttpServerLayer),
        );

        return { fetch: yield* HttpRouter.toHttpEffect(httpLayer) };
      }).pipe(Effect.orDie);
    }),
  );

/** Ready `CommandsDO` server Layer selected by `commandsClientLayer`. */
const commandsServerLayer = commandsServerLayerWithoutDependencies;

export default commandsServerLayer;
