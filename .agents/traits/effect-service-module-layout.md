---
name: effect-service-module-layout
subject: Modules that declare new Effect services whose implementation the
  application builds.
requirement: "Each such service lives in a file named for its capability and
  declares, in order: the service interface `I<CapabilityName>`, the contextual
  service class, the constructor `make<CapabilityName>`,
  `<capabilityName>LayerWithoutDependencies`, the production
  `<capabilityName>Layer`, and `<capabilityName>TestLayer`. Both Layer names are
  exported even when the service has no production dependencies. Every exported
  symbol includes the capability name, used consistently."
applicability: Services whose implementation comes from an Alchemy binding or
  the Workers runtime (an AI Gateway, Secrets Store secret, D1, R2, or Images
  binding supplied by the Worker), Alchemy resource declarations, Workers, and
  Durable Object classes are exempt. When the service has no production
  dependencies, `<capabilityName>Layer =
  <capabilityName>LayerWithoutDependencies` is the expected production Layer.
purpose: Makes every service discoverable by name and wired the same way.
---
The test Layer crosses the same service interface as production with a complete, behaviorally honest implementation. Name symbols for the natural capability, which need not end in `Service`, and avoid `Tag`.

```ts
export interface IIssueService { readonly findIssue: (id: IssueId) => Effect.Effect<Issue, IssueNotFound> }
export class IssueService extends Context.Service<IssueService, IIssueService>()("@app/IssueService") {}
export const makeIssueService = Effect.gen(function* () { /* ... */ });
export const issueServiceLayerWithoutDependencies = Layer.effect(IssueService, makeIssueService);
export const issueServiceLayer = issueServiceLayerWithoutDependencies.pipe(Layer.provide(issueStoreLayer));
export const issueServiceTestLayer = issueServiceLayerWithoutDependencies.pipe(Layer.provide(issueStoreTestLayer));
```