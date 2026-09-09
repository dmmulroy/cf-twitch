# Anti-slop provenance

## Readable spacing adoption

Selected update from [dmmulroy/anti-slop PR #43](https://github.com/dmmulroy/anti-slop/pull/43), commit `5a4b759`:

- `src/rules/require-readable-spacing.ts`
- `src/vendor/eslint-stylistic/` (including MIT license and nested upstream provenance)

These files are copied unchanged into this installation and the bundled skill assets. The entrypoints register the new rule; `vite.config.ts` enables it. Consumer regression coverage lives in `../readable-spacing-policy.test.ts`.

This is an additive adoption, not a wholesale upstream upgrade. Existing local rules, complexity adaptations, ignores, and configuration are preserved. The source revision of the older installed files has not been established by this change; do not treat `5a4b759` as their baseline.
