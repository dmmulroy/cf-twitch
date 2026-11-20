import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect, Option } from "effect";

import {
  alchemyRuntimeInfrastructureStageConfig,
  parseCfTwitchInfrastructureStage,
} from "./cf-twitch-infrastructure-stage.ts";

/** Creates the stage-owned Analytics Engine binding descriptor for the cf-twitch Worker. */
export const cfTwitchAnalyticsDataset = Effect.gen(function* () {
  const phase = yield* Alchemy.ALCHEMY_PHASE;

  const stage =
    phase === "runtime"
      ? yield* alchemyRuntimeInfrastructureStageConfig
      : yield* Effect.serviceOption(Alchemy.Stage).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.die("CF Twitch Analytics dataset planning requires Alchemy Stage"),
              onSome: parseCfTwitchInfrastructureStage,
            }),
          ),
        );

  return yield* Cloudflare.AnalyticsEngine.Dataset("ANALYTICS", {
    dataset: `cf-twitch-${stage}`,
  });
});
