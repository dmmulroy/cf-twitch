import { describe, it } from "@effect/vitest";
import { RuleTester } from "oxlint/plugins-dev";

import { noManualEffectErrorTagRule } from "./effect/rules/no-manual-effect-error-tag.ts";
import { noManualTagComparisonRule } from "./effect/rules/no-manual-tag-comparison.ts";
import { noManualTaggedConstructionRule } from "./effect/rules/no-manual-tagged-construction.ts";
import { noServiceConstructorImportsRule } from "./effect/rules/no-service-constructor-imports.ts";
import { preferEffectMatchRule } from "./effect/rules/prefer-effect-match.ts";
import { noArrayFilterMapRule } from "./rules/no-array-filter-map.ts";
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noConditionalEmptyObjectSpreadRule } from "./rules/no-conditional-empty-object-spread.ts";
import { noKnownValueWideningRule } from "./rules/no-known-value-widening.ts";
import { noModuleMockingRule } from "./rules/no-module-mocking.ts";
import { noObjectParametersRule } from "./rules/no-object-parameters.ts";
import { noReduceAccumulatorCopyRule } from "./rules/no-reduce-accumulator-copy.ts";
import { noReflectApplyRule } from "./rules/no-reflect-apply.ts";
import { noReflectGetRule } from "./rules/no-reflect-get.ts";
import { noRuntimeTypeofRule } from "./rules/no-runtime-typeof.ts";
import { noForbiddenTermInSymbolNamesRule } from "./rules/no-shape-in-symbol-names.ts";
import { noUnknownParametersRule } from "./rules/no-unknown-parameters.ts";
import { noUnknownReturnsRule } from "./rules/no-unknown-returns.ts";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.ts";
import { noUnsafeDictionaryTypeRule } from "./rules/no-unsafe-dictionary-type.ts";
import { noWidenThenAssertRule } from "./rules/no-widen-then-assert.ts";
import { requireSafetyCommentForTypeAssertionRule } from "./rules/require-safety-comment-for-type-assertion.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const typescriptRuleTester = new RuleTester({
  languageOptions: { parserOptions: { lang: "ts" }, sourceType: "module" },
});

typescriptRuleTester.run("no-array-filter-map", noArrayFilterMapRule, {
  valid: ["const users = []; users.values().filter(active).map(email).toArray();"],
  invalid: [
    {
      code: "const users = []; users.filter(active).map(email);",
      errors: [{ messageId: "arrayFilterMap" }],
    },
  ],
});

typescriptRuleTester.run("no-reduce-accumulator-copy", noReduceAccumulatorCopyRule, {
  valid: ["items.reduce((acc, item) => { acc.push(item); return acc; }, []);"],
  invalid: [
    {
      code: "items.reduce((acc, item) => Object.assign({}, acc, item), {});",
      errors: [{ messageId: "accumulatorCopy" }],
    },
  ],
});

typescriptRuleTester.run("no-chained-type-assertions", noChainedTypeAssertionsRule, {
  valid: ["const value = { count: 1 } as const;"],
  invalid: [
    {
      code: "const value = ({ count: 1 } as unknown) as { count: number };",
      errors: [{ messageId: "chained" }],
    },
  ],
});

typescriptRuleTester.run("no-conditional-empty-object-spread", noConditionalEmptyObjectSpreadRule, {
  valid: ["const value = { enabled: condition ? true : undefined };"],
  invalid: [
    {
      code: "const value = { ...(condition ? { enabled: true } : {}) };",
      errors: [{ messageId: "avoid" }],
    },
  ],
});

typescriptRuleTester.run("no-known-value-widening", noKnownValueWideningRule, {
  valid: [
    "type Precise = { readonly count: number }; const value = { count: 1 } satisfies Precise;",
    "type Unknown = string; const value: Unknown = 'known';",
  ],
  invalid: [
    {
      code: "type Broad = unknown; const value: Broad = { count: 1 };",
      errors: [{ messageId: "widening" }],
    },
  ],
});

typescriptRuleTester.run("no-module-mocking", noModuleMockingRule, {
  valid: ["const vi = { mock: () => undefined }; vi.mock();"],
  invalid: [
    {
      code: "vi.mock('./dependency.ts');",
      errors: [{ messageId: "moduleMock" }],
    },
    {
      code: "import { vi as testApi } from 'vitest'; testApi.mock('./dependency.ts');",
      errors: [{ messageId: "moduleMock" }],
    },
  ],
});

typescriptRuleTester.run("no-object-parameters", noObjectParametersRule, {
  valid: ["type Input = { readonly id: string }; const read = (input: Input) => input.id;"],
  invalid: [
    {
      code: "type Broad = object; const read = (input: Broad) => input;",
      errors: [{ messageId: "objectParameter" }],
    },
  ],
});

typescriptRuleTester.run("no-reflect-apply", noReflectApplyRule, {
  valid: ["const Reflect = { apply: () => undefined }; Reflect.apply();"],
  invalid: [
    {
      code: "Reflect.apply(operation, undefined, []);",
      errors: [{ messageId: "reflectApply" }],
    },
    {
      code: "((Reflect))['apply'](operation, undefined, []);",
      errors: [{ messageId: "reflectApply" }],
    },
  ],
});

typescriptRuleTester.run("no-reflect-get", noReflectGetRule, {
  valid: ["const Reflect = { get: () => undefined }; Reflect.get();"],
  invalid: [
    {
      code: "Reflect.get(value, 'field');",
      errors: [{ messageId: "reflectGet" }],
    },
  ],
});

typescriptRuleTester.run("no-runtime-typeof", noRuntimeTypeofRule, {
  valid: ["const available = typeof optionalBinding !== 'undefined';"],
  invalid: [
    {
      code: "const stringValue = typeof value === 'string';",
      errors: [{ messageId: "runtimeTypeof" }],
    },
  ],
});

typescriptRuleTester.run("no-shape-in-symbol-names", noForbiddenTermInSymbolNamesRule, {
  valid: ["const value = external.shape;"],
  invalid: [
    {
      code: "const shape = external['shape'];",
      errors: [{ messageId: "forbiddenSymbolName" }],
    },
  ],
});

typescriptRuleTester.run("no-unknown-parameters", noUnknownParametersRule, {
  valid: ["const enrich = (cause: unknown) => cause;"],
  invalid: [
    {
      code: "const read = (input: unknown) => input;",
      errors: [{ messageId: "unknownParameter" }],
    },
  ],
});

typescriptRuleTester.run("no-unknown-returns", noUnknownReturnsRule, {
  valid: ["const read = (): string => 'known';"],
  invalid: [
    {
      code: "type Broad = unknown; const read = (): Broad => 'known';",
      errors: [{ messageId: "unknownReturn" }],
    },
  ],
});

typescriptRuleTester.run("no-unknown-type-aliases", noUnknownTypeAliasesRule, {
  valid: [
    "type Known = string;",
    "type Unknown = string; type Infer<T> = T extends infer Unknown ? Unknown : never;",
  ],
  invalid: [
    {
      code: "type Broad = unknown; type Hidden = Broad;",
      errors: [{ messageId: "unknownAlias" }, { messageId: "unknownAlias" }],
    },
  ],
});

typescriptRuleTester.run("no-unsafe-dictionary-type", noUnsafeDictionaryTypeRule, {
  valid: [
    "type Dictionary = Readonly<Record<string, string>>;",
    "type Record<K, V> = { readonly value: V }; type Owned = Record<string, unknown>;",
    "type Broad = unknown; type Mapped = { [Broad in 'key']: Broad };",
    "type Broad = unknown; type Infer<T> = T extends infer Broad ? Record<string, Broad> : never;",
  ],
  invalid: [
    {
      code: "type Dictionary = Readonly<Record<string, unknown>>;",
      errors: [{ messageId: "unsafeDictionary" }],
    },
  ],
});

typescriptRuleTester.run("no-widen-then-assert", noWidenThenAssertRule, {
  valid: ["const precise = { count: 1 }; const count = precise.count;"],
  invalid: [
    {
      code: "const broad: unknown = { count: 1 }; const precise = broad as { count: number };",
      errors: [{ messageId: "widenThenAssert" }],
    },
  ],
});

typescriptRuleTester.run(
  "require-safety-comment-for-type-assertion",
  requireSafetyCommentForTypeAssertionRule,
  {
    valid: [
      "// SAFETY: The framework establishes the branded value.\nconst value = source as Branded;",
    ],
    invalid: [
      {
        code: "const value = source as Branded;",
        errors: [{ messageId: "missingSafetyComment" }],
      },
    ],
  },
);

typescriptRuleTester.run("no-manual-effect-error-tag", noManualEffectErrorTagRule, {
  valid: ['Effect.catchTag("NotFound", recover);'],
  invalid: [
    {
      code: 'Effect.catchAll((error) => error._tag === "NotFound" ? recover : fail);',
      errors: [{ messageId: "tag" }],
    },
  ],
});

typescriptRuleTester.run("no-manual-tag-comparison", noManualTagComparisonRule, {
  valid: ['Predicate.isTagged("Ready")(value);'],
  invalid: [
    {
      code: 'value._tag === "Ready";',
      errors: [{ messageId: "manualComparison" }],
    },
  ],
});

typescriptRuleTester.run("no-manual-tagged-construction", noManualTaggedConstructionRule, {
  valid: ["Ready.make({ value });"],
  invalid: [
    {
      code: 'const value = { _tag: "Ready", payload };',
      errors: [{ messageId: "manualConstruction" }],
    },
  ],
});

typescriptRuleTester.run("prefer-effect-match", preferEffectMatchRule, {
  valid: ['kind === "a" ? first : fallback;'],
  invalid: [
    {
      code: 'kind === "a" ? first : kind === "b" ? second : fallback;',
      errors: [{ messageId: "preferMatch" }],
    },
  ],
});

typescriptRuleTester.run("no-service-constructor-imports", noServiceConstructorImportsRule, {
  valid: [
    { code: "import { makeService } from 'library';", filename: "runtime.ts" },
    { code: "import { makeService } from './service.ts';", filename: "service.test.ts" },
  ],
  invalid: [
    {
      code: "import { makeService } from './service.ts';",
      filename: "runtime.ts",
      errors: [{ messageId: "serviceConstructorImport" }],
    },
  ],
});
