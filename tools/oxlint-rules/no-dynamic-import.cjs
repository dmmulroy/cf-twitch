"use strict";

/**
 * Local oxlint JavaScript plugin that rejects dynamic import expressions.
 *
 * @param context - Oxlint rule context used to report ImportExpression nodes.
 * @returns Plugin metadata and rule definitions for oxlint.
 */
module.exports = {
	meta: {
		name: "cf-twitch-local-rules",
		version: "1.0.0",
	},
	rules: {
		"no-dynamic-import": {
			meta: {
				type: "problem",
				docs: {
					description: "Disallow inline dynamic import() expressions; use static imports instead.",
				},
				messages: {
					noDynamicImport:
						"Do not use inline dynamic import(). Declare the dependency with a static top-level import instead.",
				},
				schema: [],
			},
			create(context) {
				return {
					ImportExpression(node) {
						context.report({
							node,
							messageId: "noDynamicImport",
						});
					},
				};
			},
		},
	},
};
