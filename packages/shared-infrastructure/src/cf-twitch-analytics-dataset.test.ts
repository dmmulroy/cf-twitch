import * as Alchemy from "alchemy";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

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
      const production = yield* resolveDatasetForStage("prod");

      assert.notStrictEqual(local.dataset, test.dataset);
      assert.notStrictEqual(local.dataset, production.dataset);
      assert.notStrictEqual(test.dataset, production.dataset);
    }),
  );
});
