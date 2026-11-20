---
name: jsdoc-on-exports
subject: JSDoc coverage of exported JavaScript and TypeScript declarations.
requirement: Every exported declaration, and every public method and property of
  an exported class, has a `/** ... */` JSDoc comment directly on its own
  declaration.
applicability: Re-exports (`export { x } from`) and `export *` are covered by
  the original declaration's comment. A type that shares its name with a schema
  value (`export type X = typeof X.Type`) is a separate declaration and has its
  own comment.
purpose: Puts the caller-visible facts where a search for the symbol lands.
---
Write each comment once, in explicit words, rather than with inheritance tags such as `@inheritDoc`. Document an exported object field when its meaning goes beyond its name and type. Private code earns a comment when safe maintenance depends on a non-obvious purpose, invariant, domain rule, side effect, trade-off, or safety justification.

```ts
/** Schema for a sighting's geotag. */
export const SightingLocation = Schema.Struct({ latitude: Schema.Number, longitude: Schema.Number });

/** Where a sighting was geotagged. */
export type SightingLocation = typeof SightingLocation.Type;
```