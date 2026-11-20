---
name: public-error-redaction
subject: Response bodies that public adapters (HTTP handlers, RPC endpoints)
  build for failed requests.
requirement: Public error responses contain only data that is safe for the
  caller, and keep useful safe context such as the operation and the requested
  domain identifier.
applicability: Credentials, access assertions, JWT claims, raw request bodies,
  SQL, stack traces, private causes, and vendor response bodies are unsafe for
  public output; they belong in logs. Internal typed errors and client code that
  displays an API's public message are not public adapters.
purpose: Gives callers a useful error while protecting secrets and internals.
---
Compliant: the cause goes to the log, the body carries safe fields.

```ts
Effect.logError("Sightings database unavailable", { operation, error: error.message }).pipe(
  Effect.as(publicErrorResponse(503, { code: "SightingStorageUnavailable", operation, message, details: {}, requestId, retryable: true })),
);
```

Violation: `details: { cause: String(error), sql }`.