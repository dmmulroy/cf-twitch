import * as Alchemy from "alchemy";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";

import { cfTwitchAnalyticsDataset } from "./cf-twitch-analytics-dataset.ts";

const resolveDatasetForStage = (stage: string) =>
  cfTwitchAnalyticsDataset.pipe(Effect.provideService(Alchemy.Stage, stage));

describe("cf-twitch Analytics Engine dataset", () => {
  it.effect("uses the Worker binding name and stage-owned physical name", () =>
    Effect.gen(function* () {
      const dataset = yield* resolveDatasetForStage("test-run123");

      assert.strictEqual(dataset.name, "ANALYTICS");
      assert.strictEqual(dataset.dataset, "cf-twitch-test-run123");
    }),
  );

  it.effect("keeps local, test, and production dataset names separate", () =>
    Effect.gen(function* () {
      const local = yield* resolveDatasetForStage("local");
      const test = yield* resolveDatasetForStage("test-run123");
      const production = yield* resolveDatasetForStage("production");

      assert.notStrictEqual(local.dataset, test.dataset);
      assert.notStrictEqual(local.dataset, production.dataset);
      assert.notStrictEqual(test.dataset, production.dataset);
    }),
  );

  it.effect("uses Alchemy's hosted runtime stage binding without the planning Stage service", () =>
    Effect.gen(function* () {
      const dataset = yield* cfTwitchAnalyticsDataset;

      assert.strictEqual(dataset.dataset, "cf-twitch-production");
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime", ALCHEMY_STAGE: "production" }),
        ),
      ),
    ),
  );

  it.effect("rejects a planning stage that is not a permitted cf-twitch stage", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(resolveDatasetForStage("prod"));

      assert.strictEqual(error._tag, "CfTwitchAnalyticsDatasetError");
      assert.strictEqual(error.operation, "resolveCfTwitchAnalyticsDataset");
      assert.strictEqual(error.reason, "StageNotPermitted");
    }),
  );

  it.effect("rejects a hosted runtime whose Alchemy stage setting is not permitted", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(cfTwitchAnalyticsDataset);

      assert.strictEqual(error.reason, "StageSettingInvalid");
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime", ALCHEMY_STAGE: "prod" }),
        ),
      ),
    ),
  );
});
