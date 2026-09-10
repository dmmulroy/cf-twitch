import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import {
	collectTypeEnvironmentNode,
	createTypeAliasEnvironment,
	resolvedTypeMatches,
	type TypeAliasEnvironment,
} from "../shared/type-alias-resolution.ts";

/** Ban named aliases that merely conceal TypeScript's unknown top type. */
export const noUnknownTypeAliasesRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow type aliases whose resolved type is unknown; unknown must remain visible at an allowed boundary.",
		},
		messages: {
			unknownAlias:
				"Type alias `{{alias}}` hides `unknown`. Keep `unknown` explicit at the parsing boundary or on an allowed `cause` field; otherwise use the parsed owner type.",
		},
	},
	createOnce(context) {
		const environment: TypeAliasEnvironment = createTypeAliasEnvironment();
		const pendingAliases: ESTree.TSTypeAliasDeclaration[] = [];

		const resolvesToUnknown = (type: ESTree.TSType): boolean =>
			resolvedTypeMatches(type, environment, (resolved, matches) => {
				if (resolved.type === "TSUnknownKeyword") return true;
				if (resolved.type === "TSParenthesizedType") {
					return matches(resolved.typeAnnotation);
				}
				return resolved.type === "TSUnionType" && resolved.types.some(matches);
			});

		return {
			TSTypeAliasDeclaration(node) {
				collectTypeEnvironmentNode(node, environment);
				pendingAliases.push(node);
			},
			TSInterfaceDeclaration: (node) => collectTypeEnvironmentNode(node, environment),
			TSEnumDeclaration: (node) => collectTypeEnvironmentNode(node, environment),
			ClassDeclaration: (node) => collectTypeEnvironmentNode(node, environment),
			ClassExpression: (node) => collectTypeEnvironmentNode(node, environment),
			ImportSpecifier: (node) => collectTypeEnvironmentNode(node, environment),
			ImportDefaultSpecifier: (node) => collectTypeEnvironmentNode(node, environment),
			ImportNamespaceSpecifier: (node) => collectTypeEnvironmentNode(node, environment),
			TSInferType: (node) => collectTypeEnvironmentNode(node, environment),
			"Program:exit"() {
				for (const node of pendingAliases) {
					if (!resolvesToUnknown(node.typeAnnotation)) continue;
					context.report({
						node: node.id,
						messageId: "unknownAlias",
						data: { alias: node.id.name },
					});
				}
			},
		};
	},
});
