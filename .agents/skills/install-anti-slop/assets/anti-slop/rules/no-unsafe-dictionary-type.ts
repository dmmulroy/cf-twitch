import { defineRule } from "@oxlint/plugins";

import {
	classifyUnsafeDictionary,
	classifyUnsafeDictionaryValue,
	collectDictionaryTypeEnvironmentNode,
	createTypeEnvironment,
	type TypeEnvironment,
} from "../shared/dictionary-types.ts";
import { visibleTypeAlias } from "../shared/type-alias-resolution.ts";

import type { ESTree } from "@oxlint/plugins";

const typeNodeKinds: ReadonlySet<string> = new Set([
	"JSDocNonNullableType",
	"JSDocNullableType",
	"JSDocUnknownType",
	"TSAnyKeyword",
	"TSArrayType",
	"TSBigIntKeyword",
	"TSBooleanKeyword",
	"TSConditionalType",
	"TSConstructorType",
	"TSFunctionType",
	"TSImportType",
	"TSIndexedAccessType",
	"TSInferType",
	"TSIntersectionType",
	"TSIntrinsicKeyword",
	"TSLiteralType",
	"TSMappedType",
	"TSNamedTupleMember",
	"TSNeverKeyword",
	"TSNullKeyword",
	"TSNumberKeyword",
	"TSObjectKeyword",
	"TSParenthesizedType",
	"TSStringKeyword",
	"TSSymbolKeyword",
	"TSTemplateLiteralType",
	"TSThisType",
	"TSTupleType",
	"TSTypeLiteral",
	"TSTypeOperator",
	"TSTypePredicate",
	"TSTypeQuery",
	"TSTypeReference",
	"TSUndefinedKeyword",
	"TSUnionType",
	"TSUnknownKeyword",
	"TSVoidKeyword",
]);

function isTypeNode(node: ESTree.Node): node is ESTree.TSType {
	return typeNodeKinds.has(node.type);
}

function typeReferenceName(type: ESTree.TSTypeReference): string | null {
	return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

function isInsideTypeAliasDeclaration(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (current.type === "TSTypeAliasDeclaration") return true;
		current = current.parent;
	}
	return false;
}

function isPlainAliasConsumerUse(node: ESTree.TSType, environment: TypeEnvironment): boolean {
	if (node.type !== "TSTypeReference" || node.typeArguments?.params.length) return false;
	const name = typeReferenceName(node);
	return (
		name !== null &&
		visibleTypeAlias(name, node, environment.typeAliases) !== null &&
		!isInsideTypeAliasDeclaration(node)
	);
}

function isInsideTypeParameterConstraint(node: ESTree.TSType): boolean {
	let child: ESTree.Node = node;
	let parent: ESTree.Node | null = child.parent;
	while (parent !== null && parent.type !== "Program") {
		if (parent.type === "TSTypeParameter" && parent.constraint === child) return true;
		child = parent;
		parent = child.parent;
	}
	return false;
}

function shouldReportType(node: ESTree.TSType, environment: TypeEnvironment): boolean {
	if (isInsideTypeParameterConstraint(node)) return false;
	if (isPlainAliasConsumerUse(node, environment)) return false;
	if (classifyUnsafeDictionary(node, environment) === null) return false;
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isTypeNode(current) && classifyUnsafeDictionary(current, environment) !== null)
			return false;
		current = current.parent;
	}
	return true;
}

/** Disallow object-dictionary contracts whose direct value type is an unsafe escape hatch. */
export const noUnsafeDictionaryTypeRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow object-dictionary contracts whose direct value type is unknown, any, object, {}, or a union/alias containing one of those escape hatches.",
		},
		messages: {
			unsafeDictionary:
				"This dictionary's {{value}} value type gives callers no concrete value contract. Use an owner/schema-derived value type; parse external payloads before insertion.",
		},
	},
	createOnce(context) {
		const environment: TypeEnvironment = createTypeEnvironment();
		const pendingTypes: ESTree.TSType[] = [];
		const pendingIndexSignatures: ESTree.TSIndexSignature[] = [];
		const report = (node: ESTree.Node, value: string) => {
			context.report({ node, messageId: "unsafeDictionary", data: { value } });
		};
		const reportIfUnsafe = (node: ESTree.TSType) => {
			if (!shouldReportType(node, environment)) return;
			const unsafe = classifyUnsafeDictionary(node, environment);
			if (unsafe === null) return;
			report(node, unsafe.unsafeValue);
		};

		return {
			TSTypeReference: (node) => pendingTypes.push(node),
			TSTypeLiteral: (node) => pendingTypes.push(node),
			TSMappedType: (node) => pendingTypes.push(node),
			TSIndexSignature: (node) => pendingIndexSignatures.push(node),
			TSTypeAliasDeclaration: (node) =>
				collectDictionaryTypeEnvironmentNode(node, environment),
			TSInterfaceDeclaration: (node) =>
				collectDictionaryTypeEnvironmentNode(node, environment),
			TSEnumDeclaration: (node) => collectDictionaryTypeEnvironmentNode(node, environment),
			ClassDeclaration: (node) => collectDictionaryTypeEnvironmentNode(node, environment),
			ClassExpression: (node) => collectDictionaryTypeEnvironmentNode(node, environment),
			ImportSpecifier: (node) => collectDictionaryTypeEnvironmentNode(node, environment),
			ImportDefaultSpecifier: (node) =>
				collectDictionaryTypeEnvironmentNode(node, environment),
			ImportNamespaceSpecifier: (node) =>
				collectDictionaryTypeEnvironmentNode(node, environment),
			TSInferType: (node) => collectDictionaryTypeEnvironmentNode(node, environment),
			"Program:exit"() {
				for (const node of pendingTypes) reportIfUnsafe(node);
				for (const node of pendingIndexSignatures) {
					if (node.typeAnnotation === null || node.parent.type === "TSTypeLiteral") continue;
					const unsafe = classifyUnsafeDictionaryValue(
						node.typeAnnotation.typeAnnotation,
						environment,
					);
					if (unsafe !== null) report(node, unsafe.unsafeValue);
				}
			},
		};
	},
});
