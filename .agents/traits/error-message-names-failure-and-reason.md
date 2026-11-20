---
name: error-message-names-failure-and-reason
subject: Error messages in typed errors, rendered errors, and public error responses.
requirement: Each error message names the operation or outcome that failed and
  states the most specific safe reason the application knows.
applicability: Applies whenever the application has classified the cause. A
  generic message is acceptable only when no classified cause exists.
purpose: Lets a human or agent understand what happened and why without reading
  traces or source.
---
Good: `Workspace workspace_… was not found. Check the Workspace ID and try again.`

Avoid: `Something went wrong.`