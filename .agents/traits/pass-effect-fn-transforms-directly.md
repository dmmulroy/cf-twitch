---
name: pass-effect-fn-transforms-directly
subject: Whole-function transforms passed to `Effect.fn`.
requirement: When a whole-function transform is already a pipeable combinator,
  it is passed directly to `Effect.fn`.
applicability: A callback transform is appropriate when composing multiple
  combinators or when the transform needs the original function arguments.
purpose: Avoids redundant wrappers around combinators.
---
```ts
const registerWorkspace = Effect.fn("BookkeeperClient.registerWorkspace")(
  function* (workspace: BookkeeperWorkspace) {
    return yield* client.registerWorkspace(workspace);
  },
  Effect.catchTags({ /* ... */ }),
);
```

Rather than `(effect) => effect.pipe(Effect.catchTags({ ... }))`.