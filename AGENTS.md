# CF Twitch agent guide

Preserve viewer-facing behavior, durable evidence, and uncertainty about external side effects. Keep production deployments, namespace adoption/transfers, and live-provider mutations behind separate explicit authorization; local verification does not authorize them.

## Read for the task

- **Terminology:** before changing domain behavior or names, read [CONTEXT.md](CONTEXT.md).
- **Implementation:** before changing services, schemas, persistence, runtime composition, or telemetry, read the relevant sections of [architecture](docs/architecture.md).
- **Compatibility:** before changing public responses, workflow ordering, or replay semantics, read the matching requirement and evidence row in [capability parity](docs/capability-parity.md).
- **Migration:** before changing stored representations, read the owner's notes linked from the [storage inventory](docs/production-cutover.md#storage-inventory).
- **Verification:** before choosing checks or reporting completion, read [verification](docs/verification.md). Run `pnpm verify` from the repository root after implementation changes.
- **Cutover:** before planning production traffic, adoption, transfer, or rollback, read the [production gate](docs/production-cutover.md).
- **Tooling policy:** when evaluating new anti-slop rules or parser guardrails, read the [prevention proposals](docs/slop-prevention.md); proposals are not installed policy.
- **Historical rationale:** when revisiting a cleanup decision, consult the [quality audit](docs/quality-audit.md).

## Working agreements

- Concurrent agents have explicit file ownership; coordinate before editing another owner's files.
- Trace each changed input to its producer. Preserve established domain types; validate only at a real boundary or when establishing additional invariants.
- Inspect pinned dependencies and root lint configuration rather than copying APIs or thresholds from memory. Implementation conventions and runtime constraints belong in the architecture document.
- Completion requires the relevant acceptance evidence, passing required checks, and an explicit account of remaining gaps. Keep local results distinct from production approval.

For setup and the source map, use [README.md](README.md).
