# How these repositories use `VISION.md`

_Reviewed 2026-07-10 from repository files and first-party GitHub history._

## Summary

A root-level `VISION.md` is not a GitHub standard or executable configuration file. In these repositories it is a short, maintainer-owned product and contribution policy: it says what the project is trying to become, what tradeoffs must be preserved, and which proposed changes are routine versus direction-setting.

Its practical role is to move recurring maintainer judgment out of individual issues and PR comments into versioned repository context. Humans and coding agents can use it as a scope/triage filter before implementing or reviewing a change. It complements rather than replaces:

- `README.md`: what the project is and how to use it
- `CONTRIBUTING.md` / `AGENTS.md`: how to work in the repository
- `SECURITY.md`: vulnerability policy and security details
- roadmap/issues: concrete scheduled work

## Shared writing pattern

The examples use plain Markdown and mostly follow this shape:

1. **One-sentence identity** — what the product is and whom it serves.
2. **Desired properties and boundaries** — the qualities future work must preserve.
3. **Positive scope** — changes that fit or should merge routinely.
4. **Escalation/negative scope** — changes requiring discussion, sign-off, or rejection for now.
5. **Decision criteria** — tests, live proof, compatibility, privacy, security, complexity, or maintenance burden.

They are terse, concrete, and written as present-tense policy rather than aspirational marketing. The best bullets describe observable proposal characteristics (new dependency, broad refactor, bespoke UI, breaking scripts), making the document useful during PR triage. “For now” language keeps boundaries revisable rather than pretending they are permanent laws.

## Repository comparison

### CodexBar

[Current `VISION.md`](https://github.com/steipete/CodexBar/blob/main/VISION.md) defines CodexBar as a menu-bar control surface for provider usage, limits, spend, status, and reset windows. It protects fast refreshes, local/privacy-first data handling, and shared provider-driven UI.

Its structure is almost entirely a merge-policy matrix:

- **Merge by Default:** bounded bug fixes, performance work without excessive complexity, provider/model support that follows existing extension patterns, small UX changes, and docs.
- **Needs Sign-Off:** new features, dependencies/toolchain changes, broad refactors, maintenance complexity, sensitive auth/storage/release/privacy changes, and providers requiring new host APIs, bespoke UI, broad filesystem access, or unclear auth/privacy behavior.

This makes `VISION.md` an explicit delegation boundary: maintainers can let patterned, low-risk work flow while reserving product, architecture, and trust-boundary decisions.

Evidence of operational use:

- It was introduced in maintainer commit [`docs: add merge vision`](https://github.com/steipete/CodexBar/commit/d8b6892aa7ecfb9267c302655b6cbaa6d35e219b).
- The repository’s documentation link checker includes `VISION.md` as a checked root document ([source](https://github.com/steipete/CodexBar/blob/main/Scripts/check-documentation-links.mjs)).
- A later design note explicitly invokes “`VISION.md` requires sign-off for new features” to explain why notification product choices should be reviewed separately ([source](https://github.com/steipete/CodexBar/blob/main/docs/superpowers/specs/2026-07-01-predictive-pace-warning-notifications-design.md)).

### gogcli

[Current `VISION.md`](https://github.com/openclaw/gogcli/blob/main/VISION.md) defines `gog` as a pragmatic Google Workspace CLI for humans and agents. Its north star is common operations with stable/scriptable output, predictable safety controls, and composability—not complete Google API coverage.

Its sections map directly to contribution triage:

- **What Fits:** bugs, small primitives in supported areas, explicit/JSON/dry-run agent workflows, memorable human commands, incremental Workspace support, and auth/reliability improvements.
- **Discuss First:** new products or API surfaces, broad refactors, niche/speculative work, script-breaking behavior, dependencies/background machinery, and behavior that cannot be live-tested when live API behavior is the point.
- **Merge Bar:** review, tests, user-visible docs/changelog updates, and live Google proof; blocked testing must name the exact missing account/access/credential.

This is both a scope guardrail and a definition of sufficient evidence. It prevents “supports a huge API” from turning into “must expose everything,” and makes compatibility and live-provider validation first-class review criteria.

Evidence of operational use:

- It was introduced in maintainer commit [`docs: add project vision`](https://github.com/openclaw/gogcli/commit/a2df2ec728240dcdc20a67e83606d16dbee67627).
- The addition is recorded in the repository [changelog](https://github.com/openclaw/gogcli/blob/main/CHANGELOG.md).
- A repository-wide search shows no other direct `VISION.md` reference at review time, so its strongest evidenced use is as human/agent policy, not automated enforcement. Live test commands documented in the [README](https://github.com/openclaw/gogcli/blob/main/README.md) provide the mechanism for its live-proof requirement.

### ClawHub link: important caveat

The supplied [ClawHub `VISION.md`](https://github.com/openclaw/clawhub/blob/main/VISION.md) is titled **“OpenClaw Vision”** and describes the OpenClaw assistant/core, not ClawHub itself. ClawHub’s [README](https://github.com/openclaw/clawhub/blob/main/README.md) separately defines ClawHub as OpenClaw’s public skill registry and prominently links this file as “Vision.” This is not a GitHub redirect or repository rename: the clone’s canonical remote is `openclaw/clawhub`, and the root file itself contains OpenClaw ecosystem/core policy.

The document is broader and more narrative than the other two. It includes:

- product origin and goal
- ordered current/next priorities
- security philosophy
- architecture and distribution boundaries for plugins, memory, skills, and MCP
- setup philosophy and the TypeScript rationale
- a **What We Will Not Merge (For Now)** list

Operationally, it routes optional capabilities out of OpenClaw core: new skills should go to ClawHub first, plugins should normally live in their own packages/repositories, and MCP should remain decoupled where the described bridge is sufficient. Thus ClawHub surfaces an ecosystem-level policy that explains *why ClawHub exists as an extension distribution path*, but it is not a focused vision for development of the ClawHub registry application.

Evidence:

- ClawHub’s README directly links `VISION.md` in its top navigation ([source](https://github.com/openclaw/clawhub/blob/main/README.md#L19-L24)).
- Its history includes explicit edits to refine priorities/security, clarify MCP policy, and cross-link README and vision ([history](https://api.github.com/repos/openclaw/clawhub/commits?path=VISION.md&per_page=100)).
- The canonical [OpenClaw `VISION.md`](https://github.com/openclaw/openclaw/blob/main/VISION.md) is a newer, expanded version of substantially the same document, reinforcing that ClawHub’s copy is ecosystem/core vision rather than ClawHub-specific registry policy.

## Why keep one

A useful `VISION.md`:

- reduces repeated “does this belong?” debates
- gives contributors an early no/discuss/yes signal before they invest in implementation
- makes maintainer taste and risk tolerance legible to coding agents
- protects nonfunctional requirements such as privacy, safety, compatibility, simplicity, and maintenance cost
- explains architectural seams—especially what belongs in core versus plugins, packages, or another repository
- provides stable, reviewable policy that evolves through Git history

It should not become a duplicate README, detailed architecture specification, issue backlog, or immutable manifesto.

## Reusable template

```md
# Vision

[Project] is [product/category] for [users].
It should [outcome], while preserving [3–5 defining qualities].
It does not aim to [important non-goal].

## What Fits / Merge by Default

- [Bounded, patterned work]
- [Existing extension points]
- [Reliability/security/docs improvements]

## Discuss First / Needs Sign-Off

- [New product or API surface]
- [Breaking behavior]
- [Dependencies, broad refactors, or ongoing machinery]
- [Privacy/security/data/auth implications]
- [Work that cannot be validated]

## Merge Bar

[Required tests, docs, compatibility evidence, live proof, rollout, etc.]

## Not Now

- [Explicitly routed or deferred categories]

These are current guardrails; strong evidence and maintainer agreement may change them.
```

The key is specificity: name the exact characteristics that alter the merge decision, not generic values such as “high quality” or “good UX.”
