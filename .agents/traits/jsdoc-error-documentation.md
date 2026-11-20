---
name: jsdoc-error-documentation
subject: How JSDoc documents the failures of functions and methods.
requirement: A function or method that returns errors by value (an `Effect`,
  `Result`, `Either`, or similar) names those errors and when they occur in
  `@returns`. A function or method that can throw or reject anywhere in its call
  stack has `@throws` naming what is thrown and when.
purpose: "Tells callers how each failure reaches them: as a value to handle, or
  as an exception or rejection to catch."
---
Returned by value:

```ts
/**
 * Parses a sighting ID from a route segment.
 *
 * @returns The sighting ID, or fails with `SchemaError` when the segment is not a valid ID.
 */
export const parseSightingId = (input: string): Effect.Effect<SightingId, Schema.SchemaError> => decodeSightingId(input);
```

Thrown somewhere in the call stack:

```ts
/**
 * Reads the deploy configuration file.
 *
 * @throws {SyntaxError} When the file is not valid JSON.
 */
export const readDeployConfig = (raw: string): DeployConfig => JSON.parse(raw);
```

An Effect that can also die from a thrown error or rejected promise in its call stack documents both: the typed failures in `@returns`, and the throw or rejection in `@throws`.