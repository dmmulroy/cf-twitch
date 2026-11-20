import { parseCfTwitchInfrastructureStage } from "@cf-twitch/shared-infrastructure";
import * as Alchemy from "alchemy";
import type { Input } from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect } from "effect";
import twitchApiWorkerLayer, { TwitchApiWorker } from "./src/runtime/twitch-worker.ts";

/**
 * Alchemy Stack that deploys the exact production stage or isolated stages without adopting existing resources.
 *
 * **Gotchas**
 *
 * An unpermitted stage name stops planning with a defect before any resource is declared.
 */
export const CfTwitchApiStack = Alchemy.Stack(
  "CfTwitch",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    yield* parseCfTwitchInfrastructureStage(stage).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.die(
          "CF Twitch stage is not permitted. Use production, local, dev_<name>, or a unique test-<id>.",
        ),
      ),
    );
    const worker = yield* TwitchApiWorker;

    return { url: worker.url };
  }).pipe(Effect.provide(twitchApiWorkerLayer)),
);

/** Unresolved typed Stack output used by infrastructure composition and verification tooling. */
export type CfTwitchApiStackOutput = Effect.Success<typeof CfTwitchApiStack>["output"];

/** Resolved deployment output, which contains only the public endpoint and never credentials. */
export type CfTwitchApiStackDeployment = Input.Resolve<CfTwitchApiStackOutput>;

export default CfTwitchApiStack;
