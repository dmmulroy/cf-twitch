import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";

/** Creates the stage-owned Analytics Engine binding descriptor for the cf-twitch Worker. */
export const cfTwitchAnalyticsDataset: Effect.Effect<
  Cloudflare.AnalyticsEngine.Dataset,
  never,
  Alchemy.Stage
> = Effect.gen(function* () {
  const stage = yield* Alchemy.Stage;

  return yield* Cloudflare.AnalyticsEngine.Dataset("ANALYTICS", {
    dataset: `cf-twitch-${stage}`,
  });
});
