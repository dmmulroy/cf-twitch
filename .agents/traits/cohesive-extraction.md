---
name: cohesive-extraction
subject: Refactors that extract functions, modules, or helpers to reduce complexity.
requirement: Each extraction moves one cohesive responsibility, a group of steps
  that change together and can be named for what they accomplish, into a unit
  named for that responsibility. The extracted unit keeps the precise domain
  types of its inputs and outputs, its expected error types, its Effect
  requirements, any transaction boundaries, and the order in which its effects
  run.
applicability: Aliases that a project convention requires, such as
  `<capabilityName>Layer = <capabilityName>LayerWithoutDependencies` from
  `effect-service-module-layout`, are not extractions.
purpose: Makes code genuinely simpler instead of only moving complexity around.
---
Simplifying means fewer concepts for a reader to hold, not only a lower branch or line count. Forwarding helpers that pass arguments through unchanged, type parameters or options objects for callers that do not exist yet, lookup tables replacing readable conditionals, and lint suppressions move complexity rather than remove it. Find every caller before removing an option, parameter, or export.

Cohesive: one named responsibility with its real types.

```ts
const renewSubscription = Effect.fn("renewSubscription")(function* (subscription: ActiveSubscription) {
  const invoice = yield* chargeRenewal(subscription);
  return yield* recordRenewal(subscription, invoice);
});
```

Not cohesive: a forwarding helper and an options object added only to shorten the caller.

```ts
const run = (input: unknown, options: { readonly mode?: string } = {}) => process(input, options);
```