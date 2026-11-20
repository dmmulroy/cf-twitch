---
name: explicit-tagged-error-translation
subject: Code that translates or recovers from expected Effect failures with
  `_tag` discriminants, including public adapters that map internal errors to a
  public contract.
requirement: Translation handles each known source error by its tag with
  `Effect.catchTag` or `Effect.catchTags`, passes an already-correct application
  error through by failing with the same value, and leaves unhandled tags in the
  inferred error channel so a new failure type produces a type error until its
  policy is chosen.
applicability: "`Effect.mapError` suits an error channel that intentionally has
  one meaning, with no tag-specific policy lost. Errors from non-Effect code
  without a `_tag` (rejections from a promise library, DOM exceptions) may be
  classified with `instanceof` where they enter Effect."
purpose: Forces an explicit decision about classification, message, status,
  context, and recovery for every new failure.
---
```ts
operation.pipe(
  Effect.catchTags({
    RegisterWorkspaceError: (error) => Effect.fail(error),
    SchemaError: () =>
      Effect.fail(new RegisterWorkspaceError({ reason: "StoredDataInvalid", message: "Bookkeeper failed to register Workspace" })),
    SqlError: () =>
      Effect.fail(new RegisterWorkspaceError({ reason: "PersistenceFailed", message: "Bookkeeper failed to register Workspace" })),
  }),
);
```