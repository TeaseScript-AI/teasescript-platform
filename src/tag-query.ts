import type {
  Expression,
  StringLiteral,
  TagComparisonOperator,
  TagListOption,
  TagQueryStep,
} from "./ast.js";
import type { SourceSpan } from "./source.js";
import { normalizeTagName } from "./tags.js";

const TAG_LIST_OPTIONS: readonly string[] = ["all", "none", "any"];
const COMPARISON_OPERATORS: readonly string[] = ["==", "!=", "<", "<=", ">", ">="];

export function isTagListOption(name: string): name is TagListOption {
  return TAG_LIST_OPTIONS.includes(name);
}

function isTagComparisonOperator(operator: string): operator is TagComparisonOperator {
  return COMPARISON_OPERATORS.includes(operator);
}

const QUERY_FORM =
  'Inside a tag query, write tags in quotes and combine them with and, or, not, and comparisons such as "punishment" > 3.';

/**
 * Converts a parsed predicate such as `("bedroom" or "bathroom") and "punishment" > minimum` to postfix steps. A quoted
 * name tests a tag; a quoted name before a comparison reads the tag's number, compared with an ordinary expression.
 * Returns `null` after reporting the first part that is not a tag predicate, or at a quoted name that is `recovered`
 * from an error already reported.
 */
export function tagPredicateSteps(
  expression: Expression,
  report: (message: string, span: SourceSpan) => void,
  recovered: (literal: StringLiteral) => boolean,
): TagQueryStep[] | null {
  const steps: TagQueryStep[] = [];
  // An explicit stack instead of recursion, because predicates may nest as deeply as the parser allows.
  const pending: { readonly node: Expression; readonly combine: boolean }[] = [
    { node: expression, combine: false },
  ];
  while (pending.length > 0) {
    const { node, combine } = pending.pop()!;
    if (node.kind === "parenthesizedExpression") {
      pending.push({ node: node.expression, combine: false });
    } else if (
      (node.kind === "binaryExpression" && (node.operator === "and" || node.operator === "or")) ||
      (node.kind === "unaryExpression" && node.operator === "not")
    ) {
      if (combine) {
        steps.push({ kind: node.kind === "unaryExpression" ? "not" : node.operator });
        continue;
      }
      pending.push({ node, combine: true });
      if (node.kind === "unaryExpression") {
        pending.push({ node: node.operand, combine: false });
      } else {
        pending.push({ node: node.right, combine: false }, { node: node.left, combine: false });
      }
    } else if (node.kind === "stringLiteral") {
      const name = queryTagName(node, report, recovered);
      if (name === null) return null;
      steps.push({ kind: "tag", name, span: node.span });
    } else if (node.kind === "binaryExpression" && isTagComparisonOperator(node.operator)) {
      let tag = node.left;
      while (tag.kind === "parenthesizedExpression") tag = tag.expression;
      if (tag.kind !== "stringLiteral") {
        report(
          tag.kind === "identifier"
            ? `Write the tag name in quotes: "${tag.name}".`
            : 'Write the quoted tag name before the comparison, such as "punishment" > 3.',
          tag.span,
        );
        return null;
      }
      const name = queryTagName(tag, report, recovered);
      if (name === null) return null;
      steps.push({
        kind: "tagCompare",
        name,
        operator: node.operator,
        bound: node.right,
        span: node.span,
      });
    } else {
      report(
        node.kind === "identifier" ? `Write the tag name in quotes: "${node.name}".` : QUERY_FORM,
        node.span,
      );
      return null;
    }
  }
  return steps;
}

function queryTagName(
  literal: StringLiteral,
  report: (message: string, span: SourceSpan) => void,
  recovered: (literal: StringLiteral) => boolean,
): string | null {
  // The literal already reported an error inside an interpolation.
  if (recovered(literal)) return null;
  if (literal.form !== "singleLine" || literal.parts.some((part) => part.kind !== "stringText")) {
    report(
      "Write a tag name in a query out in full. For computed names, use all:, none:, or any: with a list.",
      literal.span,
    );
    return null;
  }
  const text = literal.parts.map((part) => (part.kind === "stringText" ? part.value : "")).join("");
  const colon = text.indexOf(":");
  if (colon !== -1) {
    report(
      `Compare the tag's number instead, such as "${text.slice(0, colon).trim()}" == ${text.slice(colon + 1).trim()}.`,
      literal.span,
    );
    return null;
  }
  const name = normalizeTagName(text);
  if (name === null) {
    report(
      `'${text}' is not a tag name: use lowercase letters a–z, digits, and hyphens.`,
      literal.span,
    );
  }
  return name;
}

/**
 * Evaluates postfix steps for one candidate. `leaf` gives a tag test, comparison, or tag list as true, false, or
 * `null` when unknown; the result is then unknown only if the known parts do not decide it. Steps must form one
 * complete postfix expression, or be empty, which matches every candidate.
 */
export function evaluateTagSteps<Step extends { readonly kind: string }>(
  steps: readonly Step[],
  leaf: (step: Step) => boolean | null,
): boolean | null {
  const values: (boolean | null)[] = [];
  for (const step of steps) {
    if (step.kind === "not") {
      const value = values.pop()!;
      values.push(value === null ? null : !value);
    } else if (step.kind === "and" || step.kind === "or") {
      const right = values.pop()!;
      const left = values.pop()!;
      const decisive = step.kind === "or";
      values.push(
        left === decisive || right === decisive
          ? decisive
          : left === null || right === null
            ? null
            : !decisive,
      );
    } else {
      values.push(leaf(step));
    }
  }
  return steps.length === 0 ? true : values[0]!;
}

/** Whether tags with these names and numbers pass a tag list option; an empty list passes every candidate. */
export function passesTagList(
  option: TagListOption,
  names: readonly string[],
  tags: ReadonlyMap<string, number | null>,
): boolean {
  if (option === "all") return names.every((name) => tags.has(name));
  if (option === "none") return !names.some((name) => tags.has(name));
  return names.length === 0 || names.some((name) => tags.has(name));
}

/** Compares a candidate's number for a tag with a bound; a missing tag or a tag without a number never passes. */
export function compareTagValue(
  value: number | null | undefined,
  operator: TagComparisonOperator,
  bound: number,
): boolean {
  if (value === null || value === undefined) return false;
  switch (operator) {
    case "==":
      return value === bound;
    case "!=":
      return value !== bound;
    case "<":
      return value < bound;
    case "<=":
      return value <= bound;
    case ">":
      return value > bound;
    case ">=":
      return value >= bound;
  }
}
