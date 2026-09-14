# Shared infrastructure

This package owns deployment-stage policy, cryptographic local-test identities, and the stage-owned Analytics Engine descriptor. Importing a descriptor does not deploy it; the consuming Stack owns resource lifecycle. Application services remain in the app.

When changing stage policy or a binding descriptor, inspect the corresponding source under `src/` and its consuming Stack in `apps/api/alchemy.run.ts`. Preserve environment identity across the descriptor, test-stage generator, and Stack; a package boundary is not resource isolation.

For isolated execution and provider controls, use [local workerd verification](../../docs/verification.md#local-workerd-harness). Production resource decisions require the [cutover gate](../../docs/production-cutover.md).
