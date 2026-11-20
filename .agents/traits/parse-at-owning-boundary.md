---
name: parse-at-owning-boundary
subject: Handling of external or persisted input such as request payloads,
  database rows, environment strings, files, browser storage, queue messages,
  and vendor records.
requirement: The adapter that owns the boundary decodes untrusted input once,
  with a schema, into the strongest meaningful domain or application type, and
  owns the resulting parse errors. Domain modules and application services
  accept only parsed values, and data leaving the application is encoded back
  into the exact external representation the boundary requires.
applicability: Values that a typed platform API returns, such as D1 result
  metadata, R2 object metadata, DOM elements, `File` objects, and Cloudflare
  request properties, are already typed by the platform and are not untrusted
  records.
purpose: Establishes runtime integrity at one place and keeps boundary
  representations out of inner modules.
---
Boundaries in this repo include Worker `fetch` request bodies and route segments, D1 rows, `Config` values, `localStorage` and `data-*` attributes, and vendor HTTP responses. TypeScript declarations and SQL generic annotations describe expected shapes; they do not prove them at runtime. Parsing produces a validated value, not a boolean followed by the original record.

```ts
const decodeCreateIssueCommand = Schema.decodeUnknownEffect(CreateIssueCommand);

const command = yield* decodeCreateIssueCommand(requestBody);
return yield* issueService.createIssue(command);
```