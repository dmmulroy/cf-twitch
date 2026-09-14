# Rewrite quality audit — historical record

These are review outcomes from the rewrite and its follow-up cleanup on 2026-09-05, not additional engineering rules. Current conventions live in [architecture](architecture.md), dated check results in [verification](verification.md#recorded-verification), and incomplete acceptance in the [ledger](capability-parity.md#acceptance-status).

## Full-tree review

Ten standards reviewers covered a 280-file snapshot; an independent compatibility reviewer examined the same tree. Generated lockfile content was integrity-checked rather than line-reviewed. Review compared actual Overseer/R10 guidance and the pinned APIs with public and durable behavior.

| Concern              | Correction                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain evidence      | Unified raffle invariants, retained branded identities/Option values, and made errors own stable messages.                                                             |
| Service boundaries   | Removed repeated validation of established inputs while retaining HTTP/provider/SQL/native-state parsing.                                                              |
| Failure translation  | Preserved tagged errors, interruption, workflow halts and malformed-response versus transport distinctions.                                                            |
| Telemetry            | Tested safe request/span/report context with Redacted causes; removed OAuth query reflection and secret-bearing HTTP metadata.                                         |
| Durable recovery     | Preserved corrupt Event Bus payloads in DLQ, independent retry/expiry deadlines, token schedule evidence, source-time stream ordering and uncertain provider outcomes. |
| Invocation ownership | Corrected client memoization lifetime; EventSub acknowledgment ends after durable acceptance/alarm setup rather than dispatch.                                         |
| Tests/tooling        | Added actual RuleTester coverage, parsed TypeScript imports structurally, and verified remote commit/response-loss and interrupted-send behavior.                      |

## Data-flow and complexity follow-up

Seven implementation owners and an independent reviewer compared changes against the pre-cleanup worktree; another read-only review checked lint-plugin semantics.

- Retained shared codecs became unary and representation-specific. Eight unused parser exports and one encoder export were removed.
- Across the same 127 production source files, explicit `Schema.decodeUnknownEffect` sites fell from 96 to 48; all unknown-decoder variants fell from 103 to 53. This is historical audit evidence, not a count target.
- Actual runtime work removed included repeated viewer projection parsing, raffle response/count construction checks, duplicate command/workflow reads, and two EventSub body-validation passes. Token JSON codecs moved into the SQL row parser.
- Stream reads now select codecs from storage provenance. Corrupt current checkpoints and malformed tagged/boolean legacy hybrids fail without erasing raw evidence or committing migration writes.
- The root-linted maximum classic complexity fell from 41 to 19 under the new ceiling of 20. Architecture tooling fell from 28 to 11; maintained anti-slop sources from 27 to 18. The [policy tests](../tools/oxlint/complexity-policy.test.ts) verify root enforcement and both distribution copies.

Review caught and corrected two regressions during cleanup: removing the raffle receipt's required cross-field refinement, and extracting HTTP summaries behind generic types that discarded known domain/error types. Lower decoder counts and smaller functions did not establish correctness by themselves.

## Decisions worth revisiting only with new evidence

- Generated command-client union branches remained because the pinned overloads require narrowing; the local source comment records the constraint.
- The public API contract retained one composition/generation owner; size alone did not justify splitting it.
- EventSub management did not gain an extra single-consumer service solely to satisfy a stylistic abstraction preference.
- Additional provider-wire brands were deferred where no application identity crossing justified them.
- Transactions, outboxes, leases, tombstones and explicit uncertainty remained because they carry recovery evidence.
- Installed plugin sources and installer assets intentionally have separate physical copies for distribution. Project-specific tests remain outside the bundle.

For proposed additional lint and documentation work, consult [prevention analysis](slop-prevention.md). Those recommendations are separate from installed policy.
