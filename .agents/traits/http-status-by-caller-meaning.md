---
name: http-status-by-caller-meaning
subject: HTTP status codes chosen for error responses in application endpoints.
requirement: "Each error response uses the status that matches what the failure
  means to the caller: 400 for malformed or invalid request data the caller can
  correct, 401 when the request could not be authenticated, 404 for a
  syntactically valid but unknown resource identity, 405 for an unsupported
  method, 409 when current resource state conflicts with the operation, 415 for
  an unsupported media type, 500 for an internal invariant or non-transient
  internal failure, and 503 when a required capability is temporarily
  unavailable."
applicability: The concrete public `HttpApi` owns each endpoint's exact statuses
  and error schemas. Infrastructure such as Cloudflare Access may reject
  requests before they reach the application contract.
purpose: Lets callers react to a status without knowing which implementation failed.
---
