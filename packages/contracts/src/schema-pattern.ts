import { Schema, SchemaAST } from "effect";

/**
 * Validates a string pattern and documents it in generated JSON Schema / OpenAPI.
 *
 * Effect 4.1 exports `Schema.isPattern` to JSON Schema only for `u`-flag RegExps, but the flag also
 * appears in public validation messages. This keeps the original RegExp, and so the original messages.
 */
export const isOpenApiPattern = (regExp: RegExp): SchemaAST.Filter<string> =>
  Schema.isPattern(regExp, { toJsonSchema: () => ({ pattern: regExp.source }) });
