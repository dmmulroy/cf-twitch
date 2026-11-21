import { assert, expectTypeOf, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import {
  ChatCommandName,
  CommandNotFoundError,
  CommandsDbError,
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

it("tells callers to reconcile an unavailable registry mutation but simply retry a read", () => {
  const unavailable = (operation: "createCommand" | "getAllCommands") =>
    new CommandsDbError({
      operation,
      reason: "transport_unavailable",
      commandName: Option.none(),
    }).message;

  assert.strictEqual(
    unavailable("createCommand"),
    "Chat command registry could not be reached for command creation. The change may already be saved; read the command to confirm before retrying.",
  );
  assert.strictEqual(
    unavailable("getAllCommands"),
    "Chat command registry could not be reached for command listing. Retry the request in a moment.",
  );
});

it("distinguishes an unknown command from an alias where a canonical name is required", () => {
  const notFound = (reason: "unknown_command_name" | "canonical_name_required") =>
    new CommandNotFoundError({
      operation: "deleteCommand",
      reason,
      commandName: ChatCommandName.make("df"),
    }).message;

  assert.strictEqual(
    notFound("unknown_command_name"),
    "Chat command not found for command deletion: no command or alias is named df. Check the command name and try again.",
  );
  assert.strictEqual(
    notFound("canonical_name_required"),
    "Chat command alias not accepted for command deletion: df is an alias, and this change needs the canonical command name. Retry with the canonical name.",
  );
});

it.effect(
  "decodes omitted create-command fields to Option so construction applies defaults once",
  () =>
    Effect.gen(function* () {
      const input = yield* parseCreateChatCommandInput({
        name: "hello",
        description: "Says hello",
        category: "info",
        responseType: "dynamic",
        permission: "everyone",
        initialValue: "hi",
      });

      assert.deepStrictEqual(input.enabled, Option.none());
      assert.deepStrictEqual(input.aliases, Option.none());
      assert.deepStrictEqual(
        input.responseType === "dynamic" ? input.initialValue : Option.none(),
        Option.some("hi"),
      );
    }),
);
