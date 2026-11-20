---
name: typed-error-context
subject: Typed error classes in application code.
requirement: Each typed error carries a tagged-error discriminant, the operation
  that failed, and a classified reason as structured fields, plus the safe
  domain identifiers the failing code already knows.
applicability: Error classes declared only inside test files are exempt.
purpose: Lets traces, logs, and recovery logic use typed data instead of parsing prose.
---
Add further fields when they apply: field violations and accepted constraints for caller-correctable input, retryability or recovery guidance, a request identifier at public boundaries, and the underlying cause when it helps diagnosis and is safe to keep.

```ts
export class SightingsDatabaseError extends Data.TaggedError("SightingsDatabaseError")<{
  readonly operation: BirdSightingsRepositoryOperation;
  readonly reason: "QueryFailed" | "StoredRowInvalid";
  readonly sightingId: Option.Option<SightingId>;
  readonly message: string;
  readonly cause: unknown;
}> {}
```