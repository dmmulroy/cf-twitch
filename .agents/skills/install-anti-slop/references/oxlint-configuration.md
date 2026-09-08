# Anti-slop configuration

Use this reference during the configuration step of [installation](../SKILL.md). Select the native Oxlint or Vite+ placement below; Effect activation is a separate branch.

## Generic plugin

Register the installed generic entrypoint, adjusting the path if a different destination was selected:

```json
{
  "jsPlugins": [{ "name": "anti-slop", "specifier": "./tools/oxlint/anti-slop/index.ts" }]
}
```

The installed `index.ts` is the authority for available rule names; the bundled [entrypoint](../assets/anti-slop/index.ts) describes this distribution. Read its `rules` keys and add each as `anti-slop/<rule-name>: "error"` to the active configuration. Merge entries with existing plugins/rules rather than replacing policy or maintaining a second rule-name catalog in this document.

## Configuration placement

| Host                                     | Placement                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native `oxlint.config.*` or `.oxlintrc*` | Register under `jsPlugins`, enable under `rules`, and merge `ignorePatterns`.                                                                                   |
| Vite+                                    | Register under `lint.jsPlugins`, enable under `lint.rules`, and merge `lint.ignorePatterns`. Merge matching tooling patterns into `fmt.ignorePatterns` as well. |

Keep existing ignores. Add the installed plugin path and the repository's actual local-agent/generated-tooling directories, such as `.agents/**`, `.pi/**`, or `.alchemy` state. Select directories individually so owned source in other dot-directories remains checked. Configuration paths are relative to the owning configuration; verify root execution rather than relying on app-local defaults.

## Effect activation

Enable this branch when Effect is a direct package-manifest dependency or the user explicitly requests Effect rules. A transitive lockfile entry alone does not establish application ownership.

```json
{
  "jsPlugins": [
    {
      "name": "anti-slop-effect",
      "specifier": "./tools/oxlint/anti-slop/effect/index.ts"
    }
  ]
}
```

Read the installed Effect entrypoint's `rules` keys and enable each under `anti-slop-effect/<rule-name>` at error severity. The bundled [Effect entrypoint](../assets/anti-slop/effect/index.ts) is the distribution reference.

The service-constructor import rule covers relative project imports; package-alias imports remain a limitation. State that limit in the result rather than presenting a clean lint run as complete semantic enforcement.

## Configuration check

Verify that every applicable exported rule has a matching error-level configuration entry, plugin paths resolve from the root configuration, and installed tooling is excluded from application lint/format without hiding owned source. Return to the skill's verification step for actual lint/typecheck results.
