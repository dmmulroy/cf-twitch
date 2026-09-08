---
name: install-anti-slop
description: Install anti-slop Oxlint rules in a JavaScript or TypeScript repository. Use for first-time setup, rule configuration, or migration of an existing local plugin; include Effect rules when the repository directly uses Effect.
---

# Install anti-slop

Integrate the bundled plugin with the repository's package manager and root lint policy. Preserve unrelated work. Choose installation or migration before copying files.

## 1. Establish the target

Read repository instructions, Git status, package-manager declarations/lockfiles, root lint/format configuration, and any existing anti-slop sources. Package-manager metadata may live in `packageManager` or `devEngines.packageManager`.

Choose one branch:

- **Install:** the intended plugin directory is absent.
- **Configure:** existing sources already match the intended distribution; retain them.
- **Migrate:** compare existing sources with this skill's `assets/anti-slop/`, identify local customizations and obsolete files, and back up the existing directory before replacement. Keep project-specific rules under their own plugin owner.

**Complete when:** the destination, configuration owner, package manager, branch, and preservation/replacement decisions are explicit. An unexplained local customization blocks replacement.

## 2. Establish compatible dependencies

If the repository depends on Oxlint, inspect its installed version and use exactly the same version of `@oxlint/plugins`. If neither is present, query current published versions and select a matching compatible pair. Pin both as development dependencies; use the existing package manager and preserve unrelated dependency ranges.

**Complete when:** package metadata and the lockfile resolve a matching `oxlint`/`@oxlint/plugins` pair, or the compatibility failure is reported as a blocker.

## 3. Copy or retain the sources

For installation, run from the target repository:

```sh
node <skill-directory>/scripts/install.mjs
```

The default destination is `tools/oxlint/anti-slop/`; pass another relative destination when the repository has an established layout. For reviewed migration, add `--force` only after the comparison and backup in step 1. The script copies over existing files; separately account for obsolete files rather than assuming copying removes them. Configuration-only work skips copying.

**Complete when:** intended shipped files match the distribution, local customizations have an explicit home, and every removed or retained obsolete file is accounted for.

## 4. Configure the active policy

Read [configuration reference](references/oxlint-configuration.md) for the repository's native Oxlint or Vite+ branch. Register the generic plugin, enable its exported rules, and protect installed tooling from ordinary application lint/format passes. Add the Effect branch only for a direct Effect dependency or explicit user request.

**Complete when:** the active root configuration registers the intended plugins, enables every applicable exported rule at error severity, preserves existing policy, and applies the appropriate lint/format ignores.

## 5. Verify and report

Run root lint and typecheck; for Vite+, also run its complete check command. Fix owned violations when cleanup/migration was requested. Preserve rule strength while correcting types and boundaries; otherwise report the findings without claiming a passing installation.

**Complete when:** required checks pass, or each failure is reported with its command and blocked scope. Report the installed path, resolved versions, configuration changes, and any remaining limitations. Review the final diff for unrelated changes before finishing.
