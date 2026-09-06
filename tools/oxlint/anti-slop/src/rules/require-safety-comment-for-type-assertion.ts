import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

type TypeAssertion = ESTree.TSAsExpression | ESTree.TSTypeAssertion;

const DEFAULT_EVIDENCE_MARKERS = ["EVIDENCE"] as const;

const commentOwnerKinds = new Set([
  "DoWhileStatement",
  "ExpressionStatement",
  "ForInStatement",
  "ForOfStatement",
  "ForStatement",
  "IfStatement",
  "Property",
  "PropertyDefinition",
  "ReturnStatement",
  "SwitchStatement",
  "ThrowStatement",
  "TryStatement",
  "VariableDeclaration",
  "WhileStatement",
  "WithStatement",
]);

function isConstAssertion(node: TypeAssertion): boolean {
  return (
    node.typeAnnotation.type === "TSTypeReference" &&
    node.typeAnnotation.typeName.type === "Identifier" &&
    node.typeAnnotation.typeName.name === "const"
  );
}

function configuredSafetyMarkers(option: unknown): readonly string[] {
  if (typeof option !== "object" || option === null || !("markers" in option)) {
    return DEFAULT_EVIDENCE_MARKERS;
  }
  const configured = option.markers;
  if (!Array.isArray(configured)) return DEFAULT_EVIDENCE_MARKERS;
  const markers = configured.flatMap((marker) =>
    typeof marker === "string" && marker.trim().length > 0 ? [marker.trim()] : [],
  );
  return markers.length > 0 ? markers : DEFAULT_EVIDENCE_MARKERS;
}

function markerPattern(markers: readonly string[]): RegExp {
  const alternation = markers
    .map((marker) => marker.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`))
    .join("|");
  return new RegExp(
    String.raw`(?:^|[^\p{L}\p{N}_])(?:${alternation})\s*:\s*(?:\*\s*)*[\p{L}\p{N}]`,
    "u",
  );
}

function hasEvidenceImmediatelyBefore(
  sourceCode: SourceCode,
  owner: ESTree.Node,
  pattern: RegExp,
): boolean {
  return sourceCode
    .getCommentsBefore(owner)
    .some(
      (comment) =>
        comment.end <= owner.start &&
        sourceCode.text.slice(comment.end, owner.start).trim().length === 0 &&
        pattern.test(comment.value),
    );
}

function immediateCommentOwner(node: TypeAssertion): ESTree.Node | null {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== "Program") {
    if (commentOwnerKinds.has(current.type)) return current;
    if (
      current.type === "ArrowFunctionExpression" ||
      current.type === "FunctionDeclaration" ||
      current.type === "FunctionExpression"
    ) {
      return null;
    }
    current = current.parent;
  }
  return null;
}

function hasEvidenceComment(sourceCode: SourceCode, node: TypeAssertion, pattern: RegExp): boolean {
  if (hasEvidenceImmediatelyBefore(sourceCode, node, pattern)) return true;
  const owner = immediateCommentOwner(node);
  if (owner === null) return false;
  if (hasEvidenceImmediatelyBefore(sourceCode, owner, pattern)) return true;
  const exportDeclaration = owner.parent;
  return (
    exportDeclaration !== null &&
    exportDeclaration.type === "ExportNamedDeclaration" &&
    exportDeclaration.declaration === owner &&
    hasEvidenceImmediatelyBefore(sourceCode, exportDeclaration, pattern)
  );
}

/** Require every non-const type assertion to state the invariant TypeScript cannot express. */
export const requireSafetyCommentForTypeAssertionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require attached EVIDENCE for every TypeScript type assertion except const assertions.",
    },
    messages: {
      missingSafetyComment:
        "This type assertion has no attached `{{marker}}:` explanation. State the factual evidence immediately before the assertion or its containing statement.",
    },
    schema: [
      {
        type: "object",
        properties: {
          markers: {
            type: "array",
            items: { type: "string", minLength: 1 },
            minItems: 1,
            uniqueItems: true,
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ markers: ["EVIDENCE"] }],
  },
  createOnce(context) {
    const patterns = new Map<string, RegExp>();

    const checkAssertion = (node: TypeAssertion) => {
      if (isConstAssertion(node)) return;
      const markers = configuredSafetyMarkers(context.options?.[0]);
      const patternKey = markers.join("\u0000");
      const pattern = patterns.get(patternKey) ?? markerPattern(markers);
      patterns.set(patternKey, pattern);
      if (hasEvidenceComment(context.sourceCode, node, pattern)) return;
      context.report({
        node,
        messageId: "missingSafetyComment",
        data: { marker: markers[0] ?? DEFAULT_EVIDENCE_MARKERS[0] },
      });
    };

    return { TSAsExpression: checkAssertion, TSTypeAssertion: checkAssertion };
  },
});
