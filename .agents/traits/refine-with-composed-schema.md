---
name: refine-with-composed-schema
subject: Additional validation of values that have already been parsed or are
  typed by a library.
requirement: "Additional checks on an already-typed value are a typed refinement
  from the known source type to a stronger target type. Prefer, in order: a
  composed schema built with `Schema.decodeTo` from the schema that owns the
  source type and exposed with `Schema.decodeEffect`; a typed smart constructor;
  or a typed refinement function when no source schema exists. The refinement is
  named for what it does."
purpose: Keeps refinement inputs precise so invalid call sites fail at compile
  time rather than at runtime.
---
```ts
const CompleteVendorRole = Vendor.Role.pipe(
  Schema.decodeTo(Schema.Struct({ id: Schema.String, slug: Schema.String /* ... */ })),
);

const refineCompleteVendorRole = Schema.decodeEffect(CompleteVendorRole);
// (role: Vendor.Role) => Effect.Effect<CompleteVendorRole, Schema.SchemaError>
```

Use `Schema.encodeEffect` on the same composed schema for the reverse direction. A known value is not serialized to JSON merely to be parsed back into the same type.