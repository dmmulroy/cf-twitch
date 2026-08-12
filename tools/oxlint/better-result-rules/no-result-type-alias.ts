import { defineRule } from "@oxlint/plugins";

/** Disallow renaming the declaration-merged Result symbol to ResultType. */
export const noResultTypeAliasRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow importing Result as ResultType because Result is available in both value and type positions.",
		},
		messages: {
			resultTypeAlias:
				"Do not import `Result` as `ResultType`. `Result` is both an object and a type due to TypeScript declaration merging, so import and use `Result` directly in both value and type positions.",
		},
	},
	create(context) {
		return {
			ImportSpecifier(node) {
				if (
					node.imported.type === "Identifier" &&
					node.imported.name === "Result" &&
					node.local.name === "ResultType"
				) {
					context.report({ node, messageId: "resultTypeAlias" });
				}
			},
		};
	},
});
