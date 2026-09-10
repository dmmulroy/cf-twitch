import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

import {
  collectTypeEnvironmentNode,
  createTypeAliasEnvironment,
  resolvedTypeMatches,
  type TypeAliasEnvironment,
} from "../shared/type-alias-resolution.ts";

type FunctionWithReturnType =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

/** Ban function contracts that return unknown instead of a parsed domain type. */
export const noUnknownReturnsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow functions whose explicit return contract is unknown or Promise<unknown>.",
    },
    messages: {
      unknownReturn:
        "This function exposes `unknown` to its caller. Parse the value at its boundary and return a named domain type.",
    },
  },
  createOnce(context) {
    const environment: TypeAliasEnvironment = createTypeAliasEnvironment();
    const pendingFunctions: FunctionWithReturnType[] = [];

    const resolvesToUnknown = (type: ESTree.TSType): boolean =>
      resolvedTypeMatches(type, environment, (resolved, matches) => {
        if (resolved.type === "TSUnknownKeyword") return true;
        if (resolved.type === "TSParenthesizedType") {
          return matches(resolved.typeAnnotation);
        }
        if (resolved.type === "TSUnionType") return resolved.types.some(matches);
        if (
          resolved.type !== "TSTypeReference" ||
          resolved.typeName.type !== "Identifier" ||
          (resolved.typeName.name !== "Promise" &&
            resolved.typeName.name !== "PromiseLike")
        ) {
          return false;
        }
        const value = resolved.typeArguments?.params[0];
        return value !== undefined && matches(value);
      });

    const checkReturnType = (node: FunctionWithReturnType) => {
      const annotation = node.returnType;
      if (annotation === null || annotation === undefined) return;
      if (!resolvesToUnknown(annotation.typeAnnotation)) return;
      context.report({ node: annotation.typeAnnotation, messageId: "unknownReturn" });
    };

    return {
      ArrowFunctionExpression: (node) => pendingFunctions.push(node),
      FunctionDeclaration: (node) => pendingFunctions.push(node),
      FunctionExpression: (node) => pendingFunctions.push(node),
      TSCallSignatureDeclaration: (node) => pendingFunctions.push(node),
      TSConstructSignatureDeclaration: (node) => pendingFunctions.push(node),
      TSConstructorType: (node) => pendingFunctions.push(node),
      TSDeclareFunction: (node) => pendingFunctions.push(node),
      TSEmptyBodyFunctionExpression: (node) => pendingFunctions.push(node),
      TSFunctionType: (node) => pendingFunctions.push(node),
      TSMethodSignature: (node) => pendingFunctions.push(node),
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
        for (const owner of pendingFunctions) checkReturnType(owner);
      },
    };
  },
});
