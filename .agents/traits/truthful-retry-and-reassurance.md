---
name: truthful-retry-and-reassurance
subject: Retry guidance, `retryable` values, and reassurance such as "nothing
  was changed" in errors.
requirement: Retry guidance and the `retryable` value match the operation's real
  idempotency and failure protocol, and reassurance names only effects the
  application can prove did not happen. When an operation may have partially
  completed, the error acknowledges the uncertain outcome and directs the caller
  to read or reconcile the resource.
applicability: Applies to every error that suggests retrying or claims something
  was unaffected, including errors from non-atomic operations that span
  services.
purpose: Prevents callers from creating duplicate operations or trusting a false
  claim about state.
---
Say a Workspace name was unchanged only when the failed operation could not have committed that change.