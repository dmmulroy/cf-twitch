---
name: searchable-error-messages
subject: Error messages and error codes written in application source.
requirement: Each error message begins with a specific literal description, and
  each error code is written as a complete literal, so a message or code
  observed in a log can be found by searching the source.
applicability: Test assertions that quote or match messages are not subjects.
purpose: Leads an observed failure straight back to the code that produced it.
---
Prefer `` `Webhook signature mismatch for ${id}` `` over `` `${prefix}: mismatch` ``.