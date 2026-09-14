# Anti-slop provenance

## Full plugin update

Updated from [`dmmulroy/anti-slop`](https://github.com/dmmulroy/anti-slop), commit
`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`. The refreshed skill bundle was verified
byte-for-byte against that commit before merging. The recoverable merge base is the
prior bundled snapshot at this repository's commit
`7d4dbb9e9ce4d4e587f2345ac33f794e2f26003d`; the upstream revision behind that older
snapshot remains unknown.

Installed entrypoints:

- `tools/oxlint/anti-slop/index.ts`
- `tools/oxlint/anti-slop/effect/index.ts`

All incoming rules and behavior were adopted, including allowing borrowed property names
such as `external.shape`. The generic array-pipeline and accumulator-copy rules, their
native `oxc/no-accumulating-spread` companion, and all Effect rules are enabled at error
severity in `vite.config.ts`.

Intentional local deviations are behavior-preserving refactors needed by this repository's
strict TypeScript configuration and cyclomatic-complexity ceiling of 20. Those source files
remain byte-identical between the installed tree and
`.agents/skills/install-anti-slop/assets/anti-slop/`. Project-only aggregate RuleTester and
complexity-policy coverage remains under `tools/oxlint/`.

The compatible `oxlint` and `@oxlint/plugins` development dependencies remain pinned at
`1.80.0`; this update required no dependency or lockfile change. No incoming changes are
deferred.

Verification after adoption and application cleanup: `pnpm verify` passed all required
formatting, lint, architecture, OpenAPI, type, unit/tooling, and local-workerd checks;
`pnpm exec vp check` also passed. Two consecutive lint-fix/format passes left the diff
unchanged.

## Readable spacing adoption

Selected update from [dmmulroy/anti-slop PR #43](https://github.com/dmmulroy/anti-slop/pull/43), commit `5a4b759`:

- `src/rules/require-readable-spacing.ts`
- `src/vendor/eslint-stylistic/` (including MIT license and nested upstream provenance)

These files are copied unchanged into this installation and the bundled skill assets. The entrypoints register the new rule; `vite.config.ts` enables it. Consumer regression coverage lives in `../readable-spacing-policy.test.ts`.

This is an additive adoption, not a wholesale upstream upgrade. Existing local rules, complexity adaptations, ignores, and configuration are preserved. The source revision of the older installed files has not been established by this change; do not treat `5a4b759` as their baseline.
