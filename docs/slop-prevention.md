# Prevention proposals

Use this analysis when evaluating new lint, parser-API policy, or regression tooling. These proposals are not installed rules. [Architecture](architecture.md) owns current conventions, root `vite.config.ts` owns lint policy, and the [historical audit](quality-audit.md) records the cleanup that motivated these proposals.

## 1. Improve shared parser examples

For changes to shared agent standards, load the installed `coding-standards` skill and follow its `references/effect-schema-and-data.md` pointer. Pair its valid unknown-input example with known-encoded and established-domain examples. Apply the same distinction to Overseer/R10 examples in a separately scoped change.

The failure was overgeneralizing a boundary example despite an existing type-preservation rule. Directly exporting a typed decoder still exposes incidental parse options. The [stage parser](../packages/shared-infrastructure/src/cf-twitch-infrastructure-stage.ts) demonstrates a private codec behind a narrow unary API; [architecture's provenance table](architecture.md#provenance) owns the local decision rule and review checklist.

**Acceptance:** shared examples distinguish all provenance cases and expose only application-required inputs; existing guidance and examples agree.

## 2. Pilot native unnecessary-condition lint

A root-config probe after the 2026-09-05 cleanup found an intentional constant loop in unbiased raffle sampling, plus redundant literal, undefined, and subprocess-output checks. This makes native `typescript/no-unnecessary-condition` a useful candidate.

Evaluate `allowConstantLoopConditions: true`, then review remaining diagnostics against the producer and pinned library contracts. Type declarations alone do not make external runtime data trustworthy. Add fixtures for intentional loops and already-parsed domain values before enabling the rule.

**Acceptance:** every diagnostic has an honest correction or a documented rule limitation, and genuine boundary validation remains intact. This rule detects impossible guards, not repeated parsing or persistence-format selection.

## 3. Enforce narrow exported codec APIs

Candidate: `anti-slop-effect/no-exported-schema-decoder-factory`. Detect direct exports of Schema-generated decoder functions, including export-list aliases, because those factories expose library parse options as application API.

Resolve Effect import aliases and exported bindings rather than matching identifier text. RuleTester should cover direct exports, renamed Schema imports, export-list aliases, unrelated same-name functions, and accepted private-codec/unary-wrapper pairs. Consider encoders under the same policy if their application surfaces have the same problem. Choosing the correct input type requires provenance knowledge, so offer a diagnostic rather than an autofix.

**Acceptance:** the rule catches the previous stage-parser API without reporting unrelated factories. Its scope distinguishes application APIs from deliberately low-level boundary codecs and agrees with the existing unknown-input rule. Reconcile shared examples before enabling it broadly.

## 4. Extend semantic and type regressions

Keep real SQLite corruption/recovery tests as the authority for storage behavior. Useful targeted additions are:

- **Stream precedence:** adding valid lower-priority legacy fields cannot rescue malformed higher-priority evidence; retain positive tagged/boolean imports.
- **Raffle refinements:** independently corrupt distance, winner status, and winner/new-record compatibility at both receipt and event boundaries. Construct invalid cases independently of the schema whose refinement might be removed.
- **EventSub prototype evidence:** omit an own `subscription` and supply only `__proto__.subscription` through an actual own JSON key; expect rejection.
- **Parser inference:** assert the complete public function type—input, arity, result, error and Effect requirements—where parameter-only tests leave a meaningful gap.

**Acceptance:** focused tests fail under the corresponding deliberate regression, such as restoring parser-failure fallback, weakening one raffle invariant, or letting a body tag override authenticated headers. Use targeted probes before adopting a general mutation-testing framework; keep production interfaces determined by application needs.

## 5. Audit unused workspace exports

Ordinary unused-variable checks cannot identify exported-but-unused parser helpers. Start with consumer review of private workspace exports, distinguishing production imports from declaration/test-only hits. If unused APIs recur, evaluate a workspace-aware tool or a narrow extension to the existing import inventory.

Account for re-exports, namespace/type-only imports, dynamic entrypoints and external consumers. A strict unused-arguments probe found only test destructuring cases; it would not have caught forwarded library parse options.

**Acceptance:** the audit identifies actual consumerless APIs without confusing package entrypoints or dynamic uses with dead code. Prefer existing tooling over a bespoke general dependency analyzer.

## Enforcement boundaries

- **Runtime evidence:** unknown decoders remain appropriate for raw SQL, native storage, bodies and opaque metadata. Decoder-count reductions do not measure correctness or runtime work removed.
- **AST evidence:** installed `@oxlint/plugins` exposes syntax and scopes, but its `parserServices` is empty. Root typechecking does not give JavaScript plugins an inferred-type checker. Keep any known-literal decoder rule experimental and conservative.
- **Semantic evidence:** repeated reads, validation, transaction ordering and additional refinements need data-flow review and observable tests. Identical-looking calls may enforce different boundaries.
- **Cohesion:** constructors, optionality, generic helpers and dispatch tables earn their place through actual consumers and precise types. Retain the current complexity policy rather than lowering it merely to force more extraction.
