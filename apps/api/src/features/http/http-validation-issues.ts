import { Option, Predicate, Schema, type SchemaAST, type SchemaIssue } from "effect";

const issuePath = Schema.Array(Schema.Union([Schema.String, Schema.Number]));

const issueBase = { path: issuePath, message: Schema.String };

const literalValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);

const publicIssue = Schema.Union([
  Schema.Struct({
    ...issueBase,
    code: Schema.Literal("invalid_type"),
    expected: Schema.String,
    format: Schema.optionalKey(Schema.Literal("safeint")),
    received: Schema.optionalKey(Schema.Literals(["NaN", "Infinity"])),
  }),
  Schema.Struct({
    ...issueBase,
    code: Schema.Literal("too_small"),
    origin: Schema.Literals(["number", "int", "string", "array"]),
    minimum: Schema.Number,
    inclusive: Schema.Literal(true),
    note: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...issueBase,
    code: Schema.Literal("too_big"),
    origin: Schema.Literals(["number", "int", "string", "array"]),
    maximum: Schema.Number,
    inclusive: Schema.Literal(true),
    note: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    ...issueBase,
    code: Schema.Literal("invalid_value"),
    values: Schema.Array(literalValue),
  }),
  Schema.Struct({
    ...issueBase,
    code: Schema.Literal("unrecognized_keys"),
    keys: Schema.Array(Schema.String),
  }),
  Schema.Struct({ ...issueBase, code: Schema.Literal("custom") }),
  Schema.Struct({
    ...issueBase,
    code: Schema.Literal("invalid_format"),
    origin: Schema.Literal("string"),
    format: Schema.Literals(["regex", "datetime"]),
    pattern: Schema.String,
  }),
  Schema.Struct({
    ...issueBase,
    code: Schema.Literal("invalid_union"),
    errors: Schema.Array(Schema.Never),
    note: Schema.Literal("No matching discriminator"),
    discriminator: Schema.Literal("responseType"),
  }),
]);

type PublicIssue = typeof publicIssue.Type;

type IssuePath = typeof issuePath.Type;

type CommandInputValue = Schema.Json | undefined;

const filterMetadata = Schema.Union([
  Schema.Struct({
    id: Schema.Literal("effect/schema/isMinLength"),
    payload: Schema.Struct({ minLength: Schema.Number }),
  }),
  Schema.Struct({
    id: Schema.Literal("effect/schema/isMaxLength"),
    payload: Schema.Struct({ maxLength: Schema.Number }),
  }),
  Schema.Struct({
    id: Schema.Literal("effect/schema/isGreaterThanOrEqualTo"),
    payload: Schema.Struct({ minimum: Schema.Number }),
  }),
  Schema.Struct({
    id: Schema.Literal("effect/schema/isLessThanOrEqualTo"),
    payload: Schema.Struct({ maximum: Schema.Number }),
  }),
  Schema.Struct({
    id: Schema.Literal("effect/schema/isPattern"),
    payload: Schema.Struct({ source: Schema.String, flags: Schema.String }),
  }),
  Schema.Struct({
    id: Schema.Literals(["effect/schema/isInt", "effect/schema/isFinite"]),
    payload: Schema.Null,
  }),
]);

const parseFilterMetadata = Schema.decodeUnknownOption(filterMetadata);

const parseLiteral = Schema.decodeUnknownOption(literalValue);

const parseMessage = Schema.decodeUnknownOption(Schema.String);

const isJsonArray = Schema.is(Schema.Array(Schema.Json));

const isJsonObject = Schema.is(Schema.Record(Schema.String, Schema.Json));

const receivedType = (input: CommandInputValue): string =>
  input === undefined
    ? "undefined"
    : input === null
      ? "null"
      : isJsonArray(input)
        ? "array"
        : Predicate.isString(input)
          ? "string"
          : Predicate.isNumber(input)
            ? "number"
            : Predicate.isBoolean(input)
              ? "boolean"
              : "object";

const typeIssue = (expected: string, input: CommandInputValue, path: IssuePath): PublicIssue => ({
  expected,
  code: "invalid_type",
  path,
  message: `Invalid input: expected ${expected}, received ${receivedType(input)}`,
});

const enumIssue = (
  values: readonly (typeof literalValue.Type)[],
  path: IssuePath,
): PublicIssue => ({
  code: "invalid_value",
  values,
  path,
  message:
    values.length === 1
      ? `Invalid input: expected ${JSON.stringify(values[0])}`
      : `Invalid option: expected one of ${values.map((value) => JSON.stringify(value)).join("|")}`,
});

const boundsIssue = (
  origin: "number" | "string" | "array",
  direction: "minimum" | "maximum",
  bound: number,
  path: IssuePath,
): PublicIssue => {
  const message = `${direction === "minimum" ? "Too small" : "Too big"}: expected ${origin}${origin === "number" ? " to be " : " to have "}${direction === "minimum" ? ">=" : "<="}${bound}${origin === "string" ? " characters" : origin === "array" ? " items" : ""}`;

  return direction === "minimum"
    ? { origin, code: "too_small", minimum: bound, inclusive: true, path, message }
    : { origin, code: "too_big", maximum: bound, inclusive: true, path, message };
};

/** Numeric query diagnostics preserve coercion, safe-integer and range evidence without echoing raw input. */
export const formatHttpNumberIssues = (
  value: number,
  path: IssuePath,
  minimum: number,
  maximum: number,
): readonly PublicIssue[] => {
  if (!Number.isFinite(value))
    return [
      {
        expected: "number",
        code: "invalid_type",
        received: Number.isNaN(value) ? "NaN" : "Infinity",
        path,
        message: `Invalid input: expected number, received ${Number.isNaN(value) ? "NaN" : "number"}`,
      },
    ];

  if (!Number.isInteger(value))
    return [
      {
        expected: "int",
        format: "safeint",
        code: "invalid_type",
        path,
        message: "Invalid input: expected int, received number",
      },
    ];
  const issues: PublicIssue[] = [];

  if (value < Number.MIN_SAFE_INTEGER)
    issues.push({
      code: "too_small",
      minimum: Number.MIN_SAFE_INTEGER,
      note: "Integers must be within the safe integer range.",
      origin: "int",
      inclusive: true,
      path,
      message: `Too small: expected int to be >=${Number.MIN_SAFE_INTEGER}`,
    });

  if (value > Number.MAX_SAFE_INTEGER)
    issues.push({
      code: "too_big",
      maximum: Number.MAX_SAFE_INTEGER,
      note: "Integers must be within the safe integer range.",
      origin: "int",
      inclusive: true,
      path,
      message: `Too big: expected int to be <=${Number.MAX_SAFE_INTEGER}`,
    });

  if (value < minimum) issues.push(boundsIssue("number", "minimum", minimum, path));

  if (value > maximum && maximum !== Number.MAX_SAFE_INTEGER)
    issues.push(boundsIssue("number", "maximum", maximum, path));

  return issues;
};

/** Unknown query keys remain one ordered public issue rather than one issue per key. */
export const formatHttpUnknownKeys = (
  keys: readonly string[],
  path: IssuePath = [],
): PublicIssue => ({
  code: "unrecognized_keys",
  keys,
  path,
  message: `Unrecognized key${keys.length === 1 ? "" : "s"}: ${keys.map((key) => JSON.stringify(key)).join(", ")}`,
});

/** Enum diagnostics describe allowed values without returning the rejected input. */
export const formatHttpEnumIssue = enumIssue;

// Historical datetime pattern is error response metadata, never a second parser.
const datetimePattern =
  "/^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$/";

const datetimeIssue = (path: IssuePath): PublicIssue => ({
  origin: "string",
  code: "invalid_format",
  format: "datetime",
  pattern: datetimePattern,
  path,
  message: "Invalid ISO datetime",
});

const getInputKey = (input: CommandInputValue, key: PropertyKey): CommandInputValue => {
  if (isJsonArray(input) && Predicate.isNumber(key)) return input[key];

  if (isJsonObject(input) && Predicate.isString(key)) return input[key];

  return undefined;
};

const expectedIssue = (
  ast: SchemaAST.AST | undefined,
  input: CommandInputValue,
  path: IssuePath,
): PublicIssue => {
  if (ast?._tag === "Union") {
    const nonNull = ast.types.filter((member) => member._tag !== "Null");

    if (nonNull.length === 1) return expectedIssue(nonNull[0], input, path);

    if (nonNull.every((member) => member._tag === "Literal"))
      return enumIssue(
        nonNull.flatMap((member) =>
          member._tag === "Literal" ? Option.toArray(parseLiteral(member.literal)) : [],
        ),
        path,
      );
  }

  if (ast?._tag === "Literal") return enumIssue(Option.toArray(parseLiteral(ast.literal)), path);

  return typeIssue(
    ast?._tag === "Objects"
      ? "object"
      : ast?._tag === "Arrays"
        ? "array"
        : (ast?._tag.toLowerCase() ?? "string"),
    input,
    path,
  );
};

function formatCompositeCommandIssue(
  issue: SchemaIssue.Composite,
  input: CommandInputValue,
  path: IssuePath,
): readonly PublicIssue[] {
  if (path[0] === "createdAt" && issue.ast._tag === "String") return [datetimeIssue(path)];
  const unexpected: string[] = [];
  const issues: PublicIssue[] = [];

  for (const child of issue.issues) {
    if (child._tag === "Pointer" && child.issue._tag === "UnexpectedKey")
      unexpected.push(...child.path.map(String));
    else issues.push(...formatCommandIssue(child, input, path, issue.ast));
  }

  if (unexpected.length > 0) issues.push(formatHttpUnknownKeys(unexpected, path));

  return issues;
}

function formatAnyOfCommandIssue(
  issue: SchemaIssue.AnyOf,
  input: CommandInputValue,
  path: IssuePath,
): readonly PublicIssue[] {
  const first = issue.issues[0];

  if (path.length > 0 || !issue.ast.types.every((member) => member._tag === "Objects")) {
    if (issue.issues.length === 1 && first !== undefined)
      return formatCommandIssue(first, input, path, issue.ast);

    return [expectedIssue(issue.ast, input, path)];
  }

  if (!isJsonObject(input)) return [typeIssue("object", input, path)];

  if (issue.issues.length === 1 && first !== undefined)
    return formatCommandIssue(first, input, path);

  return [
    {
      code: "invalid_union",
      errors: [],
      note: "No matching discriminator",
      discriminator: "responseType",
      path: ["responseType"],
      message: "Invalid input",
    },
  ];
}

function formatFilterCommandIssue(
  issue: SchemaIssue.Filter,
  input: CommandInputValue,
  path: IssuePath,
  parentAst?: SchemaAST.AST,
): readonly PublicIssue[] {
  if (path[0] === "createdAt") return [datetimeIssue(path)];
  const metadata = parseFilterMetadata(issue.filter.annotations?.representation);

  if (Option.isNone(metadata)) return formatCommandIssue(issue.issue, input, path, parentAst);
  const value = metadata.value;

  const origin =
    parentAst?._tag === "Arrays" ? "array" : parentAst?._tag === "Number" ? "number" : "string";

  switch (value.id) {
    case "effect/schema/isMinLength":
      return [boundsIssue(origin, "minimum", value.payload.minLength, path)];
    case "effect/schema/isMaxLength":
      return [boundsIssue(origin, "maximum", value.payload.maxLength, path)];
    case "effect/schema/isGreaterThanOrEqualTo":
      return [boundsIssue(origin, "minimum", value.payload.minimum, path)];
    case "effect/schema/isLessThanOrEqualTo":
      return [boundsIssue(origin, "maximum", value.payload.maximum, path)];
    case "effect/schema/isPattern": {
      const pattern = `/${value.payload.source}/${value.payload.flags}`;

      return [
        {
          origin: "string",
          code: "invalid_format",
          format: "regex",
          pattern,
          path,
          message: `Invalid string: must match pattern ${pattern}`,
        },
      ];
    }

    case "effect/schema/isInt":
    case "effect/schema/isFinite":
      return Predicate.isNumber(input)
        ? formatHttpNumberIssues(input, path, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
        : formatCommandIssue(issue.issue, input, path, parentAst);
  }
}

function formatCommandIssue(
  issue: SchemaIssue.Issue,
  input: CommandInputValue,
  path: IssuePath,
  parentAst?: SchemaAST.AST,
): readonly PublicIssue[] {
  switch (issue._tag) {
    case "Pointer": {
      const key = issue.path[0];

      const childAst =
        parentAst?._tag === "Objects"
          ? parentAst.propertySignatures.find((field) => field.name === key)?.type
          : undefined;

      return formatCommandIssue(
        issue.issue,
        issue.path.reduce(getInputKey, input),
        [...path, ...issue.path.map((part) => (Predicate.isSymbol(part) ? String(part) : part))],
        childAst,
      );
    }

    case "Composite":
      return formatCompositeCommandIssue(issue, input, path);
    case "AnyOf":
      return formatAnyOfCommandIssue(issue, input, path);
    case "InvalidType":
      return [expectedIssue(issue.ast, input, path)];
    case "MissingKey":
      return [expectedIssue(parentAst, undefined, path)];
    case "Encoding":
      return formatCommandIssue(issue.issue, input, path, issue.ast);
    case "Filter":
      return formatFilterCommandIssue(issue, input, path, parentAst);
    case "InvalidValue":
      return [
        {
          code: "custom",
          path,
          message: Option.getOrElse(
            parseMessage(issue.annotations?.message),
            () => "Invalid input",
          ),
        },
      ];
    default:
      return [{ code: "custom", path, message: "Invalid input" }];
  }
}

/** Format only the concrete command schemas' failure nodes into their historical HTTP issue envelopes. */
export const formatHttpCommandIssues = (
  error: Schema.SchemaError,
  input: Schema.Json,
): readonly PublicIssue[] => formatCommandIssue(error.issue, input, []);
