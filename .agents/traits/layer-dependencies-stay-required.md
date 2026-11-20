---
name: layer-dependencies-stay-required
subject: Layers and framework builders that depend on contextual Effect services.
requirement: A Layer that depends on a contextual Effect service yields that
  service inside the Effect that builds its implementation and keeps it in the
  Layer's requirement channel until a composition root selects an implementation
  with `Layer.provide`. The module exports the Layer value rather than a factory
  that takes the service as a plain argument.
applicability: Plain arguments remain appropriate for parsed request or domain
  values, external constructor options, and genuinely higher-order capabilities
  that are not Effect services. Tests provide a faithful implementation Layer to
  the dependency-preserving Layer under test.
purpose: Keeps dependency selection at the composition root and visible in types.
---
```ts
export const bookkeeperHttpHandlersLayer = HttpApiBuilder.group(BookkeeperHttpApi, "bookkeeper", (handlers) =>
  Effect.gen(function* () {
    const database = yield* BookkeeperDatabase;
    return handlers.handle("getWorkspace", ({ params }) => database.getWorkspace(params.workspaceId));
  }),
);
```