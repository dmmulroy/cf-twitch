---
name: jsdoc-effect-layout
subject: Structure, sections, examples, and tags of JSDoc comments.
requirement: "After the summary paragraph, JSDoc uses only these optional
  sections, in this order and only when they have useful content: `**When to
  use**` (starting with `Use when`, `Use to`, `Use as`, or `Use with`),
  `**Details**` (behavior, options, side effects, ownership, invariants),
  `**Gotchas**` (concrete edge cases, preconditions, surprising behavior), and
  `**Example** (Title)` sections with exactly one `ts` code fence each and a
  short action-phrase title. Tags come last, in the order `@deprecated`,
  `@template`, `@param`, `@returns`, `@throws`, `@default`, `@see`."
applicability: "Sections and tags are optional: a one-line summary with no
  sections is a complete comment. Comments on constants, types, and fields
  usually need no sections. `@since`, `@stability`, and `@category` are omitted
  because the workspaces are private and unversioned."
purpose: Gives every comment the same predictable shape, following Effect's own
  documentation style.
---
Add `@param`, `@returns`, and `@template` when they say something the names and types do not. `@see {@link symbol} for ...` points to semantically related APIs. Separate sections with single blank lines. What goes in `@returns` and `@throws` is covered by `jsdoc-error-documentation`.

````ts
/**
 * Parses an email address received at an external input boundary.
 *
 * **When to use**
 *
 * Use when you hold raw form or request input and need an `EmailAddress` for inner modules.
 *
 * **Details**
 *
 * Trims surrounding whitespace before validating.
 *
 * **Example** (Parsing a submitted email address)
 *
 * ```ts
 * parseEmailAddress(" coach@example.com ") // => Result.succeed("coach@example.com")
 * ```
 *
 * @param input - Raw input received from outside the application.
 * @returns The validated address, or `InvalidEmailAddress` when the input is not a single address.
 * @see {@link formatEmailAddress} for encoding the address back for display.
 */
````

A complete comment on a constant:

```ts
/** Cloudflare zone ID of `mulroy.cloud`, pinned so plans can diff records before the zone resolves. */
export const MULROY_CLOUD_ZONE_ID = CloudflareZoneId.make("…");
```