import { Effect, Exit, Option, Schema } from "effect";
import { LanguageModel, Prompt } from "effect/ai";
import { describe, expect, it } from "vite-plus/test";

import {
  type ClaudeCliInvocation,
  makeClaudeSubscriptionLanguageModel,
  renderClaudeCliPrompt,
  toClaudeCliArguments,
} from "./claude-subscription-language-model.ts";

/** A result shaped like `claude -p --output-format json` prints (claude 2.1.327). */
const cliResult = (fields: {
  readonly is_error?: boolean;
  readonly result?: string;
  readonly structured_output?: Schema.Json;
  readonly api_error_status?: number;
}) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    usage: {
      input_tokens: 2,
      cache_creation_input_tokens: 1127,
      cache_read_input_tokens: 0,
      output_tokens: 69,
    },
    ...fields,
  });

/** Runs `program` against a model whose CLI runner records each invocation and prints `stdout`. */
const runWithCli = <A, E>(
  stdout: string,
  program: Effect.Effect<A, E, LanguageModel.LanguageModel>,
) => {
  const invocations: Array<ClaudeCliInvocation> = [];

  return makeClaudeSubscriptionLanguageModel(
    (invocation) => {
      invocations.push(invocation);

      return Effect.succeed(stdout);
    },
    { model: "claude-opus-5-5", effort: "medium" },
  ).pipe(
    Effect.flatMap((model) =>
      program.pipe(Effect.provideService(LanguageModel.LanguageModel, model), Effect.exit),
    ),
    Effect.map((exit) => ({ exit, invocations })),
    Effect.runPromise,
  );
};

const Split = Schema.Struct({ traits: Schema.Array(Schema.String) });

const splitPrompt = Prompt.make([
  { role: "system", content: "Split the text into standalone rules." },
  { role: "user", content: [{ type: "text", text: "Use Option and never use null." }] },
]);

describe("toClaudeCliArguments", () => {
  it("runs one isolated, non-interactive request", () => {
    const args = toClaudeCliArguments({
      model: "claude-opus-5-5",
      effort: "medium",
      systemPrompt: Option.some("Be brief."),
      jsonSchema: Option.some({ type: "object" }),
    });

    expect(args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--model",
      "claude-opus-5-5",
      "--effort",
      "medium",
      "--system-prompt",
      "Be brief.",
      "--json-schema",
      '{"type":"object"}',
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--disable-slash-commands",
      "--no-session-persistence",
      "--no-chrome",
    ]);
  });
});

describe("renderClaudeCliPrompt", () => {
  it("sends system messages as the system prompt and a single user message as-is", async () => {
    const rendered = await Effect.runPromise(renderClaudeCliPrompt(splitPrompt));
    expect(rendered).toEqual({
      systemPrompt: Option.some("Split the text into standalone rules."),
      stdin: "Use Option and never use null.",
    });
  });

  it("labels each turn of a longer conversation", async () => {
    const rendered = await Effect.runPromise(
      renderClaudeCliPrompt(
        Prompt.make([
          { role: "user", content: [{ type: "text", text: "First." }] },
          { role: "assistant", content: [{ type: "text", text: "Noted." }] },
          { role: "user", content: [{ type: "text", text: "Second." }] },
        ]),
      ),
    );

    expect(rendered.stdin).toBe("User:\nFirst.\n\nAssistant:\nNoted.\n\nUser:\nSecond.");
    expect(rendered.systemPrompt).toEqual(Option.none());
  });
});

describe("makeClaudeSubscriptionLanguageModel", () => {
  it("generates an object from the CLI's structured output", async () => {
    const { exit, invocations } = await runWithCli(
      cliResult({ structured_output: { traits: ["Use Option.", "Never use null."] } }),
      LanguageModel.generateObject({ prompt: splitPrompt, schema: Split }),
    );

    expect(Exit.isSuccess(exit) && exit.value.value).toEqual({
      traits: ["Use Option.", "Never use null."],
    });
    const [invocation] = invocations;
    expect(invocation?.command).toBe("claude");
    expect(invocation?.stdin).toBe("Use Option and never use null.");
    expect(invocation?.args).toContain("--json-schema");
    expect(invocation?.env).toMatchObject({
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
      CLAUDE_CODE_USE_BEDROCK: undefined,
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    });
  });

  it("generates text from the CLI's result without a schema", async () => {
    const { exit, invocations } = await runWithCli(
      cliResult({ result: "Hello." }),
      LanguageModel.generateText({ prompt: "Say hello." }),
    );

    expect(Exit.isSuccess(exit) && exit.value.text).toBe("Hello.");
    expect(invocations[0]?.args).not.toContain("--json-schema");
  });

  it("maps a CLI API error to an AiError reason by status", async () => {
    const { exit } = await runWithCli(
      cliResult({ is_error: true, result: "Model not found.", api_error_status: 404 }),
      LanguageModel.generateText({ prompt: "Hi." }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("Claude Code CLI request failed: Model not found.");
  });

  it("suggests signing in when the CLI fails without an API status", async () => {
    const { exit } = await runWithCli(
      cliResult({ is_error: true, result: "Not logged in." }),
      LanguageModel.generateText({ prompt: "Hi." }),
    );

    expect(JSON.stringify(exit)).toContain("run `claude auth login`");
  });

  it("reports output that is not a CLI JSON result", async () => {
    const { exit } = await runWithCli("not json", LanguageModel.generateText({ prompt: "Hi." }));
    expect(JSON.stringify(exit)).toContain("Claude Code CLI did not print a JSON result");
  });
});
