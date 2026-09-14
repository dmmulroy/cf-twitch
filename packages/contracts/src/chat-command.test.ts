import { assert, expectTypeOf, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import {
  CreateChatCommandInput,
  parseChatCommandName,
  parseCreateChatCommandInput,
} from "./chat-command.ts";

it("keeps exported chat command parsers unary and representation-specific", () => {
  expectTypeOf<Parameters<typeof parseChatCommandName>>().toEqualTypeOf<[input: string]>();
  expectTypeOf<Parameters<typeof parseCreateChatCommandInput>>().toEqualTypeOf<
    [input: typeof CreateChatCommandInput.Encoded]
  >();
});

it.effect("retains strict create-command checks for typed structural subtypes", () =>
  Effect.gen(function* () {
    const input = {
      name: "hello",
      description: "Says hello",
      category: "info",
      responseType: "static",
      permission: "everyone",
      unexpected: true,
    } satisfies typeof CreateChatCommandInput.Encoded & { readonly unexpected: boolean };

    assert.isTrue(Option.isNone(yield* Effect.option(parseCreateChatCommandInput(input))));
  }),
);
