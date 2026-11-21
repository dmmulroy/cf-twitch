---
name: decoder-matches-encoded-input
subject: Calls to typed Schema decoders such as `Schema.decodeEffect`.
requirement: A typed decoder receives input whose type already matches the
  codec's declared `Encoded` type. When the source representation differs, the
  code uses an honest boundary decode or a real representation transformation,
  such as a string-encoded schema for configured strings.
purpose: Keeps the decoder's input type truthful instead of forcing it with a cast.
---
A raw `string` is not the encoded union of `Schema.Literals(...)`:

```ts
const InfrastructureStage = Schema.String.check(
  Schema.isPattern(/^(development|production)$/u),
).pipe(Schema.brand("InfrastructureStage"));

const decodeInfrastructureStage = Schema.decodeEffect(InfrastructureStage);
```