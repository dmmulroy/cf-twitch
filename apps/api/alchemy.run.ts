import { parseCfTwitchInfrastructureStage } from "@cf-twitch/shared-infrastructure";
import * as Alchemy from "alchemy";
import type { Input } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import twitchApiWorkerLayer, { TwitchApiWorker } from "./src/runtime/twitch-worker.ts";

/** Deploy isolated stages only; production adoption requires the separately reviewed cutover procedure. */
const CfTwitchApiStack = Alchemy.Stack(
  "CfTwitch",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    yield* parseCfTwitchInfrastructureStage(stage).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.die(
          "CF Twitch stage is not permitted. Use local, dev_<name>, or a unique test-<id>; production cutover is gated.",
        ),
      ),
    );
    const worker = yield* TwitchApiWorker;
    return { url: worker.url };
  }).pipe(Effect.provide(twitchApiWorkerLayer)),
);

/** Unresolved typed Stack output used by infrastructure composition and verification tooling. */
export type CfTwitchApiStackOutput = Effect.Success<typeof CfTwitchApiStack>["output"];

/** Resolved deployment output contains only the public endpoint, never credentials. */
export type CfTwitchApiStackDeployment = Input.Resolve<CfTwitchApiStackOutput>;

export default CfTwitchApiStack;
