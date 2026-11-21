import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { Effect, Option, Schema } from "effect";

import {
  alchemyRuntimeInfrastructureStageConfig,
  parseCfTwitchInfrastructureStage,
} from "./cf-twitch-infrastructure-stage.ts";

/** Operations that can fail while resolving the cf-twitch Analytics Engine dataset. */
export const CfTwitchAnalyticsDatasetOperation = Schema.Literals([
  "resolveCfTwitchAnalyticsDataset",
]);

/** Operation that failed while resolving the cf-twitch Analytics Engine dataset. */
export type CfTwitchAnalyticsDatasetOperation = typeof CfTwitchAnalyticsDatasetOperation.Type;

/**
 * Classified reasons the cf-twitch Analytics Engine dataset cannot be resolved.
 *
 * **Details**
 *
 * `StageSettingInvalid` means Alchemy's `ALCHEMY_PHASE` or `ALCHEMY_STAGE` setting is missing or
 * is not a permitted stage at hosted runtime. `StageNotPermitted` means the planning Stage is not
 * a permitted cf-twitch stage.
 */
export const CfTwitchAnalyticsDatasetFailureReason = Schema.Literals([
  "StageSettingInvalid",
  "StageNotPermitted",
]);

/** Classified reason the cf-twitch Analytics Engine dataset cannot be resolved. */
export type CfTwitchAnalyticsDatasetFailureReason =
  typeof CfTwitchAnalyticsDatasetFailureReason.Type;

/** Error returned when the stage that names the cf-twitch Analytics Engine dataset is unusable. */
export class CfTwitchAnalyticsDatasetError extends Schema.TaggedError<CfTwitchAnalyticsDatasetError>()(
  "CfTwitchAnalyticsDatasetError",
  {
    operation: CfTwitchAnalyticsDatasetOperation,
    reason: CfTwitchAnalyticsDatasetFailureReason,
  },
) {
  /** Operator guidance naming the unusable stage source. */
  override get message(): string {
    return this.reason === "StageSettingInvalid"
      ? "CF Twitch Analytics dataset stage setting is missing or invalid at Worker runtime. Redeploy the Worker through its Alchemy Stack so ALCHEMY_STAGE is set."
      : "CF Twitch Analytics dataset stage is not permitted. Use production, local, dev_<name>, or a unique test-<id> stage.";
  }
}

/**
 * Effect that creates the stage-owned Analytics Engine binding descriptor for the cf-twitch Worker.
 *
 * **Details**
 *
 * At hosted runtime the stage comes from Alchemy's `ALCHEMY_STAGE` setting; during planning it
 * comes from the Alchemy `Stage` service. The physical dataset is `cf-twitch-<stage>`.
 *
 * @returns The `ANALYTICS` dataset binding, or fails with `CfTwitchAnalyticsDatasetError` when the
 *   runtime stage setting is unusable (`StageSettingInvalid`) or the planning stage is not
 *   permitted (`StageNotPermitted`).
 * @throws A defect when planning runs without the Alchemy `Stage` service.
 */
export const cfTwitchAnalyticsDataset = Effect.gen(function* () {
  const phase = yield* Alchemy.ALCHEMY_PHASE;

  const stage =
    phase === "runtime"
      ? yield* alchemyRuntimeInfrastructureStageConfig
      : yield* Effect.serviceOption(Alchemy.Stage).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.die(
                  "CF Twitch Analytics dataset planning requires the Alchemy Stage service. Resolve the dataset inside an Alchemy Stack.",
                ),
              onSome: (plannedStage) =>
                parseCfTwitchInfrastructureStage(plannedStage).pipe(
                  Effect.catchTag("SchemaError", () =>
                    Effect.fail(
                      new CfTwitchAnalyticsDatasetError({
                        operation: "resolveCfTwitchAnalyticsDataset",
                        reason: "StageNotPermitted",
                      }),
                    ),
                  ),
                ),
            }),
          ),
        );

  return yield* Cloudflare.AnalyticsEngine.Dataset("ANALYTICS", {
    dataset: `cf-twitch-${stage}`,
  });
}).pipe(
  Effect.catchTag("ConfigError", () =>
    Effect.fail(
      new CfTwitchAnalyticsDatasetError({
        operation: "resolveCfTwitchAnalyticsDataset",
        reason: "StageSettingInvalid",
      }),
    ),
  ),
);
