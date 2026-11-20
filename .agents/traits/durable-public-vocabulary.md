---
name: durable-public-vocabulary
subject: Names, public documentation, UI copy, and rendered error messages.
requirement: Text written for users and callers uses the domain words its
  readers know and would search for. Ticket names, migration phases, internal
  storage fields, framework or runtime mechanics, and planning language appear
  only in text written for maintainers and operators.
applicability: Maintainer and operator text includes code comments, internal
  JSDoc, logs, and runbooks; it may record history such as which Stack a
  resource was adopted from. A message that asks the caller to correct a request
  field may name that field. Stable public codes and identifiers keep their
  names.
purpose: Keeps public text meaningful after the project's internal history changes.
---
Public: `This sighting was not found. Check the link and try again.`

Leaks internals: `Row not found in table bird_sightings (D1 SQLITE_ERROR).`

Fine for operators: `/** Adopts the Worker previously owned by the MulroyCloudR2Proxy Stack. */`