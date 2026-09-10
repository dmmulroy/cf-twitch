import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import {
	functionParameterBindingName,
	functionParameterTypeAnnotation,
} from "../shared/function-parameters.ts";
import {
	collectTypeEnvironmentNode,
	createTypeAliasEnvironment,
	resolvedTypeMatches,
	type TypeAliasEnvironment,
} from "../shared/type-alias-resolution.ts";
type ParameterOwner =
	| ESTree.ArrowFunctionExpression
	| ESTree.Function
	| ESTree.TSCallSignatureDeclaration
	| ESTree.TSConstructSignatureDeclaration
	| ESTree.TSConstructorType
	| ESTree.TSFunctionType
	| ESTree.TSMethodSignature;

/** Ban the broad object type on function inputs, including local aliases to object. */
export const noObjectParametersRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow object function parameters; inputs must use an owner-provided type and be parsed at their boundary.",
		},
		messages: {
			objectParameter:
				"Parameter `{{parameter}}` uses the broad `object` type. Accept a named owner type; parse external input at its boundary before calling this function.",
		},
	},
	createOnce(context) {
		const environment: TypeAliasEnvironment = createTypeAliasEnvironment();
		const pendingOwners: ParameterOwner[] = [];

		const resolvesToObject = (type: ESTree.TSType): boolean =>
			resolvedTypeMatches(type, environment, (resolved, matches) => {
				if (resolved.type === "TSObjectKeyword") return true;
				if (resolved.type === "TSParenthesizedType") {
					return matches(resolved.typeAnnotation);
				}
				return (
					resolved.type === "TSUnionType" && resolved.types.some(matches)
				);
			});

		const checkParameters = (node: ParameterOwner) => {
			for (const parameter of node.params) {
				const annotation = functionParameterTypeAnnotation(parameter);
				if (annotation === null || annotation === undefined) continue;
				if (!resolvesToObject(annotation.typeAnnotation)) continue;
				context.report({
					node: annotation.typeAnnotation,
					messageId: "objectParameter",
					data: { parameter: functionParameterBindingName(parameter, context.sourceCode) },
				});
			}
		};

		return {
			ArrowFunctionExpression: (node) => pendingOwners.push(node),
			FunctionDeclaration: (node) => pendingOwners.push(node),
			FunctionExpression: (node) => pendingOwners.push(node),
			TSCallSignatureDeclaration: (node) => pendingOwners.push(node),
			TSConstructSignatureDeclaration: (node) => pendingOwners.push(node),
			TSConstructorType: (node) => pendingOwners.push(node),
			TSDeclareFunction: (node) => pendingOwners.push(node),
			TSEmptyBodyFunctionExpression: (node) => pendingOwners.push(node),
			TSFunctionType: (node) => pendingOwners.push(node),
			TSMethodSignature: (node) => pendingOwners.push(node),
			TSTypeAliasDeclaration: (node) => collectTypeEnvironmentNode(node, environment),
			TSInterfaceDeclaration: (node) => collectTypeEnvironmentNode(node, environment),
			TSEnumDeclaration: (node) => collectTypeEnvironmentNode(node, environment),
			ClassDeclaration: (node) => collectTypeEnvironmentNode(node, environment),
			ClassExpression: (node) => collectTypeEnvironmentNode(node, environment),
			ImportSpecifier: (node) => collectTypeEnvironmentNode(node, environment),
			ImportDefaultSpecifier: (node) => collectTypeEnvironmentNode(node, environment),
			ImportNamespaceSpecifier: (node) => collectTypeEnvironmentNode(node, environment),
			TSInferType: (node) => collectTypeEnvironmentNode(node, environment),
			"Program:exit"() {
				for (const owner of pendingOwners) checkParameters(owner);
			},
		};
	},
});
