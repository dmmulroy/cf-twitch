---
name: error-message-gives-way-forward
subject: Error messages shown to callers, operators, or agents, written in
  application source.
requirement: "Each error message ends with one way forward: correct the
  identified input and retry, retry the same logical operation when that is
  safe, inspect or reconcile the named resource when the outcome is uncertain,
  or contact support with the request identifier."
applicability: Test assertions that quote or match messages are not subjects.
purpose: Turns a failure into a next action instead of a dead end.
---
Way forward: `The session request must be empty or JSON like {"hours": 4}. Fix the body and send it again.`

Dead end: `Invalid session request.`