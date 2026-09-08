import type { ESTree } from "@oxlint/plugins";

import type { TypeAliasEnvironment } from "./type-alias-resolution.ts";

function collectConditionalInferNames(
	conditional: ESTree.TSConditionalType,
	environment: TypeAliasEnvironment,
	names: Set<string>,
): void {
	for (const inferred of environment.inferredTypes) {
		let current: ESTree.Node | null = inferred;
		while (current !== null && current !== conditional.extendsType) {
			current = current.parent;
		}
		if (current === conditional.extendsType) {
			names.add(inferred.typeParameter.name.name);
		}
	}
}

/** Collect type binders that are in scope at a node and can shadow module aliases. */
export function lexicalTypeParameterNames(
	node: ESTree.Node,
	environment: TypeAliasEnvironment,
): ReadonlySet<string> {
	const names = new Set<string>();
	let descendant: ESTree.Node = node;
	let current: ESTree.Node | null = node;
	while (current !== null && current.type !== "Program") {
		if ("typeParameters" in current) {
			for (const parameter of current.typeParameters?.params ?? []) {
				names.add(parameter.name.name);
			}
		}
		if (
			current.type === "TSMappedType" &&
			(descendant === current.nameType || descendant === current.typeAnnotation)
		) {
			names.add(current.key.name);
		}
		if (current.type === "TSConditionalType" && descendant === current.trueType) {
			collectConditionalInferNames(current, environment, names);
		}
		descendant = current;
		current = current.parent;
	}
	return names;
}
