---
name: public-error-envelope
subject: Response bodies that public adapters (HTTP handlers, RPC endpoints)
  build for failed requests.
requirement: Every public error response carries a stable `code`, an
  operation-specific `message`, variant-specific `details`, a correlation
  `requestId`, and a truthful `retryable` value.
purpose: Lets callers branch on the code, read the message, and correlate the
  failure with logs.
---
```ts
{ code: "RouteNotFound", operation: "routeRequest", message: "No route matches /x. Use POST /session.",
  details: { path: "/x" }, requestId: "8f1c…", retryable: false }
```