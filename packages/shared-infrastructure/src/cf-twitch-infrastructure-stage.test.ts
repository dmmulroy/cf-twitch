import { NodeCrypto } from "@effect/platform-node";
import { assert, describe, expectTypeOf, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import {
  generateIsolatedCfTwitchTestStage,
  parseCfTwitchInfrastructureStage,
} from "./cf-twitch-infrastructure-stage.ts";

describe("cf-twitch infrastructure stage policy", () => {
  it("exposes a unary string parser without configurable schema options", () => {
    expectTypeOf<Parameters<typeof parseCfTwitchInfrastructureStage>>().toEqualTypeOf<
      [input: string]
    >();
  });

  it.effect("accepts isolated local, personal, and test stages", () =>
    Effect.gen(function* () {
      yield* parseCfTwitchInfrastructureStage("local");
      yield* parseCfTwitchInfrastructureStage("dev_example");
      yield* parseCfTwitchInfrastructureStage("test-abc123");
    }),
  );

  it.effect("rejects production and malformed stages", () =>
    Effect.gen(function* () {
      assert.isTrue(Option.isNone(yield* Effect.option(parseCfTwitchInfrastructureStage("prod"))));
      assert.isTrue(
        Option.isNone(yield* Effect.option(parseCfTwitchInfrastructureStage("production"))),
      );
      assert.isTrue(
        Option.isNone(yield* Effect.option(parseCfTwitchInfrastructureStage("test_bad"))),
      );
    }),
  );

  it.effect("generates distinct schema-valid test stages", () =>
    Effect.gen(function* () {
      const first = yield* generateIsolatedCfTwitchTestStage();
      const second = yield* generateIsolatedCfTwitchTestStage();

      assert.match(first, /^test-[a-z0-9]{32}$/);
      assert.notStrictEqual(first, second);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
