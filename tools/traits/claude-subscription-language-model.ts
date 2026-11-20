import { Effect, Layer, Match, Option, type PlatformError, Schema, Stream } from "effect";
import { AiError, IdGenerator, LanguageModel, type Prompt, type Response, Tool } from "effect/ai";
import { toCodecAnthropic } from "effect/ai/AnthropicStructuredOutput";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Claude Code effort levels the CLI accepts for `--effort`. */
export type ClaudeCliEffort = "low" | "medium" | "high" | "xhigh" | "max";

/** Settings for how the Claude subscription language model runs the Claude Code CLI. */
export interface ClaudeSubscriptionLanguageModelOptions {
  /** Claude model id or CLI alias, such as `claude-opus-5-5`. */
  readonly model: string;
  /** Effort level for every request; `none` keeps the CLI's default effort. */
  readonly effort: Option.Option<ClaudeCliEffort>;
  /** Claude Code executable: a path or a name on `PATH`; `none` runs `claude`. */
  readonly command: Option.Option<string>;
}

/** One Claude Code CLI run: its arguments, standard input, and environment. */
export interface ClaudeCliInvocation {
  /** Executable to spawn: a path or a name on `PATH`. */
  readonly command: string;
  /** Arguments produced by `toClaudeCliArguments`. */
  readonly args: ReadonlyArray<string>;
  /** Rendered prompt written to the CLI's standard input. */
  readonly stdin: string;
  /**
   * Environment overrides for the child process, in the process spawner's representation.
   *
   * **Details**
   *
   * An `undefined` value removes that variable from the inherited environment.
   */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/**
 * Function type for running the Claude Code CLI and returning its standard output.
 *
 * **Details**
 *
 * Implementations fail with `PlatformError` when the CLI cannot be spawned or its output cannot
 * be read.
 */
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
 * Returns the CLI arguments for one non-interactive request.
 *
 * **Details**
 *
 * Requests JSON output with no tools, no MCP servers, no user or project settings, no slash
 * commands, and no saved session. `jsonSchema` turns on Claude Code's structured output;
 * `systemPrompt` replaces Claude Code's own system prompt.
 */
export const toClaudeCliArguments = (request: {
  readonly model: string;
  readonly effort: Option.Option<ClaudeCliEffort>;
  readonly systemPrompt: Option.Option<string>;
  readonly jsonSchema: Option.Option<unknown>;
}): ReadonlyArray<string> => [
  "-p",
  "--output-format",
  "json",
  "--model",
  request.model,
  ...Option.match(request.effort, {
    onNone: () => [],
    onSome: (effort) => ["--effort", effort],
  }),
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

/** Error returned when a prompt contains a part the Claude Code CLI cannot carry. */
export class ClaudeCliPromptError extends Schema.TaggedError<ClaudeCliPromptError>()(
  "ClaudeCliPromptError",
  {
    operation: Schema.Literals(["renderClaudeCliPrompt"]),
    reason: Schema.Literals(["UnsupportedPromptPart"]),
    /** Role of the message that holds the unsupported part, such as `user` or `tool`. */
    role: Schema.String,
    /** Prompt part type the CLI cannot carry, such as `file` or `tool-result`. */
    part: Schema.String,
  },
) {
  /** Caller guidance naming the unsupported part. */
  override get message(): string {
    return `Claude Code CLI prompt contains an unsupported ${this.part} part in a ${this.role} message. Send text parts only.`;
  }
}

/**
 * Renders a prompt for one CLI request.
 *
 * **Details**
 *
 * System messages become the system prompt, and the conversation becomes standard input. A single
 * user message is sent as-is; longer conversations are labeled by speaker.
 *
 * @returns The system prompt and standard input, or fails with `ClaudeCliPromptError` at the
 *   first part the CLI cannot carry (files, reasoning, tool calls and results).
 */
export const renderClaudeCliPrompt = (
  prompt: Prompt.Prompt,
): Effect.Effect<
  { readonly systemPrompt: Option.Option<string>; readonly stdin: string },
  ClaudeCliPromptError
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
        return yield* Effect.fail(
          new ClaudeCliPromptError({
            operation: "renderClaudeCliPrompt",
            reason: "UnsupportedPromptPart",
            role: "tool",
            part: "tool-result",
          }),
        );
      }

      const texts: Array<string> = [];

      for (const part of message.content) {
        if (part.type !== "text")
          return yield* Effect.fail(
            new ClaudeCliPromptError({
              operation: "renderClaudeCliPrompt",
              reason: "UnsupportedPromptPart",
              role: message.role,
              part: part.type,
            }),
          );
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
    result: Schema.OptionFromOptionalKey(Schema.String),
    structured_output: Schema.OptionFromOptionalKey(Schema.Json),
    api_error_status: Schema.OptionFromOptionalNullOr(Schema.Number),
    usage: Schema.OptionFromOptionalKey(
      Schema.Struct({
        input_tokens: Schema.OptionFromOptionalKey(Schema.Int),
        cache_read_input_tokens: Schema.OptionFromOptionalKey(Schema.Int),
        cache_creation_input_tokens: Schema.OptionFromOptionalKey(Schema.Int),
        output_tokens: Schema.OptionFromOptionalKey(Schema.Int),
      }),
    ),
  }),
);

/** Token counts the CLI reports, each absent when the CLI omits it. */
type ClaudeCliTokenUsage = Option.Option.Value<(typeof ClaudeCliResult.Type)["usage"]>;

// Standard output is text, so the codec's encoded side is `string`.
const decodeClaudeCliResult = Schema.decodeEffect(ClaudeCliResult);

const MODULE = "ClaudeSubscriptionLanguageModel";

const claudeCliError = (method: string, reason: AiError.AiErrorReason) =>
  AiError.make({ module: MODULE, method, reason });

/**
 * Parses the CLI's standard output into response parts.
 *
 * **Details**
 *
 * Produces one text part (the structured output as JSON when a schema was requested) and a
 * finish part with token usage.
 *
 * @returns The response parts, or fails with `AiError`: `InvalidResponseError` when the output is
 *   not a CLI JSON result, or a reason that follows the API status when the CLI reports an error.
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
        const message = Option.getOrElse(
          result.result,
          () => "Claude Code CLI reported an error without a message.",
        );

        const status = result.api_error_status;

        const wayForward = Option.match(status, {
          onNone: () => "If Claude Code is signed out, run `claude auth login`, then retry.",
          onSome: (code) =>
            code === 401 || code === 403
              ? "If Claude Code is signed out, run `claude auth login`, then retry."
              : "Resolve the problem the CLI reports, then retry.",
        });

        const description = `Claude Code CLI request failed: ${message} ${wayForward}`;

        return Effect.fail(
          claudeCliError(
            method,
            Option.match(status, {
              onNone: () => new AiError.InternalProviderError({ description }),
              onSome: (code) => AiError.reasonFromHttpStatus({ status: code, description }),
            }),
          ),
        );
      }

      const text = Option.match(result.structured_output, {
        onNone: () => Option.getOrElse(result.result, () => ""),
        onSome: (structuredOutput) => JSON.stringify(structuredOutput),
      });

      const usage = result.usage;

      const tokenCount = (select: (counts: ClaudeCliTokenUsage) => Option.Option<number>) =>
        usage.pipe(Option.flatMap(select));

      const uncached = tokenCount((counts) => counts.input_tokens);
      const cacheRead = tokenCount((counts) => counts.cache_read_input_tokens);
      const cacheWrite = tokenCount((counts) => counts.cache_creation_input_tokens);

      return Effect.succeed<Array<Response.PartEncoded>>([
        { type: "text", text },
        {
          type: "finish",
          reason: "stop",
          usage: {
            // The encoded response contract represents unknown counts as `undefined`.
            inputTokens: {
              uncached: Option.getOrUndefined(uncached),
              cacheRead: Option.getOrUndefined(cacheRead),
              cacheWrite: Option.getOrUndefined(cacheWrite),
              total: Option.getOrUndefined(
                Option.map(
                  uncached,
                  (count) =>
                    count +
                    Option.getOrElse(cacheRead, () => 0) +
                    Option.getOrElse(cacheWrite, () => 0),
                ),
              ),
            },
            outputTokens: {
              total: Option.getOrUndefined(tokenCount((counts) => counts.output_tokens)),
            },
          },
        },
      ]);
    }),
  );

/**
 * Creates a `LanguageModel` that answers each request with one Claude Code CLI run on the
 * signed-in Claude subscription.
 *
 * **Details**
 *
 * Structured output (`generateObject`) uses `--json-schema` with Anthropic's structured-output
 * schema rules. Tools are not supported.
 *
 * @param run - Runner that spawns the CLI; tests pass a controlled runner.
 * @returns The language model service. Its requests fail with `AiError`: `InvalidRequestError`
 *   for tools or non-text prompt parts, `UnsupportedSchemaError` when a response schema has no
 *   JSON Schema form, `InternalProviderError` when the CLI cannot run, and the reasons documented
 *   on `toClaudeCliResponseParts`.
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
                "Claude subscription language model requests cannot include tools because Claude Code runs without tools. Send the request without tools.",
            }),
          ),
        );
      }

      const rendered = yield* renderClaudeCliPrompt(providerOptions.prompt).pipe(
        Effect.catchTag("ClaudeCliPromptError", (error) =>
          Effect.fail(
            claudeCliError(
              method,
              new AiError.InvalidRequestError({
                parameter: "prompt",
                description: error.message,
              }),
            ),
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
                      description: `Claude Code CLI cannot use the response schema: ${error instanceof Error ? error.message : String(error)}. Use a schema with a JSON Schema representation.`,
                    }),
                  ),
              }),
            )
          : Option.none();

      const command = Option.getOrElse(options.command, () => "claude");

      const stdout = yield* run({
        command,
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
              description: `Claude Code CLI could not be started with ${command}: ${error.message}. Install Claude Code, make sure it is on PATH, and restart Traits.`,
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
 *
 * @returns A Layer that requires `ChildProcessSpawner`; request failures are the `AiError`
 *   reasons documented on `makeClaudeSubscriptionLanguageModel`.
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
