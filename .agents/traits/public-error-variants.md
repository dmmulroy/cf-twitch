---
name: public-error-variants
subject: Schemas or types that define the public error responses of HTTP or
  other external contracts.
requirement: Public error schemas are discriminated unions whose variants each
  pair a literal `code` with a variant-specific `details` schema.
purpose: Makes the code and its details agree by construction and keeps the
  public contract precise.
---
```ts
const RouteNotFoundPublicError = Schema.Struct({ code: Schema.Literal("RouteNotFound"), details: Schema.Struct({ path: Schema.String }) /* … */ });
export const PublicError = Schema.Union([RouteNotFoundPublicError, MethodNotAllowedPublicError]);
```

Avoid one struct with `code: Schema.String` and an unrestricted `details` record.