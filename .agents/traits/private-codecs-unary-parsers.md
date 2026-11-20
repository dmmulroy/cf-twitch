---
name: private-codecs-unary-parsers
subject: Reusable Schema codecs and the parsers exported from their owning modules.
requirement: Reusable codecs are instantiated once, privately, beside their
  owning schemas. When a consumer outside the owner needs to parse, the module
  exports a domain-named unary parser whose parameter is the codec's actual
  `Encoded` type, rather than the generated `Schema.decode*` function.
applicability: Directly exporting a generated decoder is acceptable only when
  parse options are an intentional part of a genuinely low-level codec API.
purpose: Gives callers a narrow, discoverable application API without leaking
  library parse options.
---
```ts
const decodeInfrastructureStage = Schema.decodeEffect(InfrastructureStage);

/** Parses a validated infrastructure stage from its configured string representation. */
export const parseInfrastructureStage = (
  input: string,
): Effect.Effect<InfrastructureStage, Schema.SchemaError> => decodeInfrastructureStage(input);
```