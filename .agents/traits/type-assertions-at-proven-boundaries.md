---
name: type-assertions-at-proven-boundaries
subject: Type assertions, `any`, and non-null assertions in TypeScript.
requirement: Type information comes from preserved types, parsing, typed
  constructors, explicit optionality, or branching on established domain state.
  A single, non-chained type assertion appears only at the smallest unavoidable
  platform boundary where the runtime invariant is already established and
  TypeScript cannot express it, with the upstream limitation, runtime evidence,
  and focused verification documented beside it.
applicability: Chained assertions such as `as unknown as T` or `as any as T`,
  ordinary `any`, non-null assertions, and assertions following our own widening
  are review blockers.
purpose: Prevents code from fabricating type evidence after discarding it.
---
Governing rule: preserve evidence already established, create evidence by parsing truly unknown input at its boundary, and never fabricate evidence with an assertion after throwing it away.

A clean lint result does not replace this provenance review: lint rules see syntax, not where a value came from.