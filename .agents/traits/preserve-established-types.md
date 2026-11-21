---
name: preserve-established-types
subject: Parameter types, return types, variables, and intermediate
  representations of values whose type is already known.
requirement: Code preserves the strongest meaningful domain, application,
  library, or platform type available for a value through function boundaries
  and intermediate steps. `unknown`, `object`, generic records, and hand-written
  structural approximations appear only for values that genuinely cross an
  untrusted runtime boundary.
applicability: Values created by our code, returned by a typed API, or already
  parsed are known values. Genuinely untrusted values include parsed JSON, HTTP
  or RPC input, persistence, configuration, files, queues, platform APIs, and
  untyped third-party callbacks.
purpose: Keeps the compiler checking evidence that has already been established.
---
```ts
// Preserves the type supplied by the owning library.
const transformOperation = (operation: OpenApiOperation): OpenApiOperation => {
  // ...
};
```

Before introducing a broad type, identify the value's provenance, search the owning module or library for its type or schema, and use `satisfies` or explicit return types to check new values without widening them.