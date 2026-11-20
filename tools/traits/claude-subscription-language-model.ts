import { Effect, Layer, Match, Option, type PlatformError, Schema, Stream } from "effect";
import { AiError, IdGenerator, LanguageModel, type Prompt, type Response, Tool } from "effect/ai";
import { toCodecAnthropic } from "effect/ai/AnthropicStructuredOutput";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Claude Code effort levels the CLI accepts for `--effort`. */
export type ClaudeCliEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** How the Claude subscription language model runs the Claude Code CLI. */
export interface ClaudeSubscriptionLanguageModelOptions {
  /** Claude model id or CLI alias, such as `claude-opus-5-5`. */
  readonly model: string;
  /** Effort level for every request. */
  readonly effort?: ClaudeCliEffort | undefined;
  /** Claude Code executable: a path or a name on `PATH`. Defaults to `claude`. */
  readonly command?: string | undefined;
}

/** One Claude Code CLI run: its arguments, standard input, and environment. */
export interface ClaudeCliInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Runs the Claude Code CLI and returns its standard output. */
export type ClaudeCliRunner = (
  invocation: ClaudeCliInvocation,
) => Effect.Effect<string, PlatformError.PlatformError>;

/**
 * Environment variables that move the Claude Code CLI off the subscription login: an API key or
 * token, a gateway, or another model provider. Removed so requests always use the subscription.
 * The list is pi-claude-cli's (Claude Code's documented names).
 */
const SUBSCRIPTION_OVERRIDE_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
] as const;

/**
 * Child environment: the subscription login, no project memory, no Claude.ai MCP servers, no
 * telemetry or update checks, and no host request-body overrides. `undefined` removes a variable
 * from the inherited environment.
 */
const CLAUDE_CLI_ENVIRONMENT = {
  ...Object.fromEntries(SUBSCRIPTION_OVERRIDE_ENV_VARS.map((name) => [name, undefined])),
  CLAUDE_CODE_EXTRA_BODY: undefined,
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
} satisfies ClaudeCliInvocation["env"];

/**
 * CLI arguments for one non-interactive request: JSON output, no tools, no MCP servers, no user
 * or project settings, no slash commands, and no saved session. `jsonSchema` turns on Claude
 * Code's structured output; `systemPrompt` replaces Claude Code's own system prompt.
 */
export const toClaudeCliArguments = (request: {
  readonly model: string;
  readonly effort: ClaudeCliEffort | undefined;
  readonly systemPrompt: Option.Option<string>;
  readonly jsonSchema: Option.Option<unknown>;
}): ReadonlyArray<string> => [
  "-p",
  "--output-format",
  "json",
  "--model",
  request.model,
  ...(request.effort === undefined ? [] : ["--effort", request.effort]),
  ...Option.match(request.systemPrompt, {
    onNone: () => [],
    onSome: (systemPrompt) => ["--system-prompt", systemPrompt],
  }),
  ...Option.match(request.jsonSchema, {
    onNone: () => [],
    onSome: (jsonSchema) => ["--json-schema", JSON.stringify(jsonSchema)],
  }),
  "--tools",
  "",
  "--strict-mcp-config",
  "--setting-sources",
  "",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--no-chrome",
];

/** Why a prompt cannot be sent through the Claude Code CLI. */
type UnsupportedPromptPart = { readonly role: string; readonly part: string };

/**
 * Renders a prompt for one CLI request: system messages become the system prompt, and the
 * conversation becomes standard input. A single user message is sent as-is; longer conversations
 * are labeled by speaker. Fails with the first part the CLI cannot carry (files, reasoning, tool
 * calls and results).
 */
export const renderClaudeCliPrompt = (
  prompt: Prompt.Prompt,
): Effect.Effect<
  { readonly systemPrompt: Option.Option<string>; readonly stdin: string },
  UnsupportedPromptPart
> =>
  Effect.gen(function* () {
    const systemTexts: Array<string> = [];
    const turns: Array<{ readonly role: "user" | "assistant"; readonly text: string }> = [];

    for (const message of prompt.content) {
      if (message.role === "system") {
        systemTexts.push(message.content);
        continue;
      }

      if (message.role === "tool") {
        return yield* Effect.fail({ role: "tool", part: "tool-result" });
      }

      const texts: Array<string> = [];

      for (const part of message.content) {
        if (part.type !== "text")
          return yield* Effect.fail({ role: message.role, part: part.type });
        texts.push(part.text);
      }

      turns.push({ role: message.role, text: texts.join("\n") });
    }

    const [onlyTurn] = turns;

    const stdin =
      turns.length === 1 && onlyTurn?.role === "user"
        ? onlyTurn.text
        : turns
            .map((turn) => `${turn.role === "user" ? "User" : "Assistant"}:\n${turn.text}`)
            .join("\n\n");

    return {
      systemPrompt:
        systemTexts.length === 0 ? Option.none() : Option.some(systemTexts.join("\n\n")),
      stdin,
    };
  });

/** The `--output-format json` result Claude Code prints when a request finishes. */
const ClaudeCliResult = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("result"),
    is_error: Schema.Boolean,
    result: Schema.optional(Schema.String),
    structured_output: Schema.optional(Schema.Json),
    api_error_status: Schema.optional(Schema.NullOr(Schema.Number)),
    usage: Schema.optional(
      Schema.Struct({
        input_tokens: Schema.optional(Schema.Int),
        cache_read_input_tokens: Schema.optional(Schema.Int),
        cache_creation_input_tokens: Schema.optional(Schema.Int),
        output_tokens: Schema.optional(Schema.Int),
      }),
    ),
  }),
);

// Standard output is text, so the codec's encoded side is `string`.
const decodeClaudeCliResult = Schema.decodeEffect(ClaudeCliResult);

const MODULE = "ClaudeSubscriptionLanguageModel";

const claudeCliError = (method: string, reason: AiError.AiErrorReason) =>
  AiError.make({ module: MODULE, method, reason });

/**
 * Turns the CLI's standard output into response parts: one text part (the structured output as
 * JSON when a schema was requested) and a finish part with token usage. A result the CLI marks
 * as an error becomes an `AiError` whose reason follows the API status.
 */
export const toClaudeCliResponseParts = (
  method: string,
  stdout: string,
): Effect.Effect<Array<Response.PartEncoded>, AiError.AiError> =>
  decodeClaudeCliResult(stdout).pipe(
    Effect.mapError(() =>
      claudeCliError(
        method,
        new AiError.InvalidResponseError({
          description:
            "Claude Code CLI did not print a JSON result. Update Claude Code with `claude update` and retry; check that `claude -p` works in a terminal.",
        }),
      ),
    ),
    Effect.flatMap((result) => {
      if (result.is_error) {
        const message = result.result ?? "Claude Code CLI reported an error without a message.";
        const status = result.api_error_status ?? undefined;

        const signInHint =
          status === undefined || status === 401 || status === 403
            ? " If Claude Code is signed out, run `claude auth login`, then retry."
            : "";

        const description = `Claude Code CLI request failed: ${message}${signInHint}`;

        return Effect.fail(
          claudeCliError(
            method,
            status === undefined
              ? new AiError.InternalProviderError({ description })
              : AiError.reasonFromHttpStatus({ status, description }),
          ),
        );
      }

      const text =
        result.structured_output === undefined
          ? (result.result ?? "")
          : JSON.stringify(result.structured_output);

      const usage = result.usage;
      const cacheRead = usage?.cache_read_input_tokens ?? 0;
      const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
      const uncached = usage?.input_tokens;

      return Effect.succeed<Array<Response.PartEncoded>>([
        { type: "text", text },
        {
          type: "finish",
          reason: "stop",
          usage: {
            inputTokens: {
              uncached,
              cacheRead: usage?.cache_read_input_tokens,
              cacheWrite: usage?.cache_creation_input_tokens,
              total: uncached === undefined ? undefined : uncached + cacheRead + cacheWrite,
            },
            outputTokens: { total: usage?.output_tokens },
          },
        },
      ]);
    }),
  );

/**
 * Builds a `LanguageModel` that answers each request with one Claude Code CLI run on the
 * signed-in Claude subscription. Structured output (`generateObject`) uses `--json-schema` with
 * Anthropic's structured-output schema rules. Tools are not supported.
 */
export const makeClaudeSubscriptionLanguageModel = (
  run: ClaudeCliRunner,
  options: ClaudeSubscriptionLanguageModelOptions,
) => {
  const generate = (method: string, providerOptions: LanguageModel.ProviderOptions) =>
    Effect.gen(function* () {
      if (providerOptions.tools.length > 0) {
        return yield* Effect.fail(
          claudeCliError(
            method,
            new AiError.InvalidRequestError({
              parameter: "tools",
              description:
                "The Claude subscription language model runs Claude Code without tools. Send the request without tools.",
            }),
          ),
        );
      }

      const rendered = yield* renderClaudeCliPrompt(providerOptions.prompt).pipe(
        Effect.mapError((unsupported) =>
          claudeCliError(
            method,
            new AiError.InvalidRequestError({
              parameter: "prompt",
              description: `The Claude subscription language model sends text only; a ${unsupported.role} message contains a ${unsupported.part} part. Send text parts only.`,
            }),
          ),
        ),
      );

      const responseFormat = providerOptions.responseFormat;

      const jsonSchema =
        responseFormat.type === "json"
          ? Option.some(
              yield* Effect.try({
                try: () =>
                  Tool.getJsonSchemaFromSchema(responseFormat.schema, {
                    transformer: toCodecAnthropic,
                  }),
                catch: (error) =>
                  claudeCliError(
                    method,
                    new AiError.UnsupportedSchemaError({
                      description: error instanceof Error ? error.message : String(error),
                    }),
                  ),
              }),
            )
          : Option.none();

      const stdout = yield* run({
        command: options.command ?? "claude",
        args: toClaudeCliArguments({
          model: options.model,
          effort: options.effort,
          systemPrompt: rendered.systemPrompt,
          jsonSchema,
        }),
        stdin: rendered.stdin,
        env: CLAUDE_CLI_ENVIRONMENT,
      }).pipe(
        Effect.mapError((error) =>
          claudeCliError(
            method,
            new AiError.InternalProviderError({
              description: `Could not run the Claude Code CLI (${options.command ?? "claude"}): ${error.message}. Install Claude Code, make sure it is on PATH, and restart Traits.`,
            }),
          ),
        ),
      );

      return yield* toClaudeCliResponseParts(method, stdout);
    }).pipe(Effect.withSpan(`${MODULE}.${method}`, { attributes: { model: options.model } }));

  return LanguageModel.make({
    codecTransformer: toCodecAnthropic,
    generateText: (providerOptions) => generate("generateText", providerOptions),
    // The CLI answers in one piece, so the stream replays the finished response.
    streamText: (providerOptions) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const parts = yield* generate("streamText", providerOptions);
          const id = yield* (yield* IdGenerator.IdGenerator).generateId();

          return Stream.fromIterable(
            parts.flatMap((part) =>
              Match.value(part).pipe(
                Match.when({ type: "text" }, (textPart): Array<Response.StreamPartEncoded> => [
                  { type: "text-start", id },
                  { type: "text-delta", id, delta: textPart.text },
                  { type: "text-end", id },
                ]),
                Match.when({ type: "finish" }, (finishPart): Array<Response.StreamPartEncoded> => [
                  finishPart,
                ]),
                Match.orElse((): Array<Response.StreamPartEncoded> => []),
              ),
            ),
          );
        }),
      ),
  });
};

/** Runs the CLI with the contextual process spawner; the prompt is written to standard input. */
const spawnClaudeCli = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  ((invocation) =>
    spawner.string(
      ChildProcess.make(invocation.command, invocation.args, {
        env: invocation.env,
        extendEnv: true,
        stdin: Stream.make(new TextEncoder().encode(invocation.stdin)),
      }),
    )) satisfies ClaudeCliRunner;

/**
 * Layer that provides a `LanguageModel` backed by the Claude Code CLI on your Claude Pro or Max
 * subscription.
 *
 * **When to use**
 *
 * Use when you want Traits to draft traits with a Claude subscription instead of an Anthropic
 * API key.
 *
 * **Details**
 *
 * Every request is one `claude -p` run: no tools, no MCP servers, no settings or project memory,
 * and no saved session. Claude Code owns the login; this layer never reads credentials, and it
 * removes the environment variables that would move the CLI onto an API key or another provider.
 *
 * **Gotchas**
 *
 * Needs `claude` on `PATH` and a subscription login (`claude auth login`). Requests use the
 * subscription's usage limits, not API credits.
 */
export const claudeSubscriptionLanguageModelLayer = (
  options: ClaudeSubscriptionLanguageModelOptions,
) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
      makeClaudeSubscriptionLanguageModel(spawnClaudeCli(spawner), options),
    ),
  );
