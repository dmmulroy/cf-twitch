import { definePlugin } from "@oxlint/plugins";

import { noResultTypeAliasRule } from "./better-result-rules/no-result-type-alias.ts";

/** Oxlint rules for correct and idiomatic better-result usage. */
const betterResultPlugin = definePlugin({
	meta: { name: "better-result" },
	rules: {
		"no-result-type-alias": noResultTypeAliasRule,
	},
});

export default betterResultPlugin;
