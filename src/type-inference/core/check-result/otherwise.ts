import type { BinaryExpression, Expression } from "../../../ast.js";
import { unwrap } from "../../../expression-children.js";
import type { Item } from "../items.js";
import type { StaticRule } from "../result.js";

// V30 §18 (#1072): whether an `otherwise`'s fallback can run.

/**
 * Whether a left read's answer proves it never `null`. An unknown kind (external, opaque, a stopped read's) proves
 * nothing, as a value of unknown type gets no warning (V30 §18). A possible kind proves as a
 * definite one does: the question is whether `null` can be there, not whether every kind is certain. `null` (no answer
 * at the read) proves nothing. (A function is outside the candidate's slice, so no left side here depends on a
 * parameter.)
 */
export function provesNonNull(items: readonly Item[] | null): boolean {
  if (items === null) return false;
  const kinds = items.filter((item) => item.tag !== "empty");
  return kinds.length > 0 && kinds.every((item) => item.tag !== "null" && item.tag !== "unknown");
}

/** Whether `expression` is an `otherwise`. */
function isOtherwise(expression: Expression): expression is BinaryExpression {
  return expression.kind === "binaryExpression" && expression.operator === "otherwise";
}

/**
 * Each chain of `otherwise` among `expressions`, its links from the inside out: a chain's root is an `otherwise` no other
 * `otherwise` holds as its left side without parentheses, and a part in parentheses is a value of its own, as in
 * `(a otherwise b) otherwise c` (the current checker's chain).
 */
export function otherwiseChains(expressions: readonly Expression[]): BinaryExpression[][] {
  const inner = new Set<Expression>();
  for (const expression of expressions) if (isOtherwise(expression)) inner.add(expression.left);
  const chains: BinaryExpression[][] = [];
  for (const expression of expressions) {
    if (!isOtherwise(expression) || inner.has(expression)) continue;
    const chain: BinaryExpression[] = [];
    // (from the root inward, then reversed once: linear in the chain's links)
    for (let link: Expression = expression; isOtherwise(link); link = link.left) chain.push(link);
    chains.push(chain.reverse());
  }
  return chains;
}

/**
 * The warning's rule for a chain whose link `first` is the first with a left side proved never `null`: what it names
 * (the left side, each fallback from there), and for an element read by index as that link's left side, the kind of
 * collection it reads (`collection`), so the warning names `get` with a `default:` (V30 §18, owner decision on #850).
 */
export function unusedFallbackRule(
  chain: readonly BinaryExpression[],
  first: number,
  collection: (object: Expression) => "list" | "dict" | null,
): StaticRule & { readonly rule: "unused-fallback" } {
  const link = chain[first]!;
  const read = unwrap(link.left);
  return {
    rule: "unused-fallback",
    subject: codeText(link.left),
    fallbacks: chain.slice(first).map((part) => fallbackText(part.right)),
    read:
      read.kind === "indexExpression" && first === 0
        ? {
            kind: collection(read.object),
            object: codeText(read.object),
            index: codeText(read.index),
          }
        : null,
  };
}

/** A fallback as code for a fix that shows it, also `true`, `false`, `null` and `[]`. */
function fallbackText(expression: Expression): string | null {
  const node = unwrap(expression);
  if (node.kind === "booleanLiteral") return String(node.value);
  if (node.kind === "nullLiteral") return "null";
  if (node.kind === "listLiteral" && node.elements.length === 0) return "[]";
  return codeText(expression);
}

/** A one-line text literal without `${...}`, as written, else `null`. */
function plainText(expression: Expression): string | null {
  const literal = unwrap(expression);
  if (literal.kind !== "stringLiteral" || literal.form !== "singleLine") return null;
  let text = "";
  for (const part of literal.parts) {
    if (part.kind !== "stringText") return null;
    text += part.raw;
  }
  return text;
}

/**
 * An expression as code for a fix that shows it: literals, names, members, element reads, calls and operators; `null`
 * for another expression and for one longer than a message shows (60 characters, six levels), as the current checker
 * shows it.
 */
function codeText(expression: Expression, depth = 0): string | null {
  if (depth > 6) return null;
  const child = (node: Expression): string | null => codeText(node, depth + 1);
  const all = (nodes: readonly (string | null)[]): nodes is readonly string[] =>
    nodes.every((node) => node !== null);
  let text: string | null = null;
  switch (expression.kind) {
    case "numberLiteral":
      text = expression.raw;
      break;
    case "identifier":
      text = expression.name;
      break;
    case "durationLiteral":
      text = `${expression.amount.raw} ${expression.calendar ? "calendar " : ""}${expression.unit}`;
      break;
    case "stringLiteral": {
      const plain = plainText(expression);
      text = plain === null ? null : `"${plain}"`;
      break;
    }
    case "propertyAccessExpression": {
      const object = child(expression.object);
      text = object === null ? null : `${object}.${expression.property.name}`;
      break;
    }
    case "parenthesizedExpression": {
      const inner = child(expression.expression);
      text = inner === null ? null : `(${inner})`;
      break;
    }
    case "indexExpression": {
      const parts = [child(expression.object), child(expression.index)];
      text = all(parts) ? `${parts[0]}[${parts[1]}]` : null;
      break;
    }
    case "unitExpression": {
      const operand = child(expression.operand);
      text =
        operand === null
          ? null
          : `${operand} ${expression.calendar ? "calendar " : ""}${expression.unit}`;
      break;
    }
    case "unaryExpression": {
      const operand = child(expression.operand);
      text =
        operand === null
          ? null
          : `${expression.operator === "not" ? "not " : expression.operator}${operand}`;
      break;
    }
    case "binaryExpression": {
      const parts = [child(expression.left), child(expression.right)];
      text = all(parts) ? `${parts[0]} ${expression.operator} ${parts[1]}` : null;
      break;
    }
    case "rangeExpression": {
      const parts = [child(expression.start), child(expression.end)];
      text = all(parts) ? `${parts[0]}${expression.inclusive ? "..=" : ".."}${parts[1]}` : null;
      break;
    }
    case "callExpression": {
      if (expression.arguments.length > 6) return null;
      const parts = [
        child(expression.callee),
        ...expression.arguments.map((argument) => {
          const value = child(argument.value);
          return value === null || argument.kind === "positionalArgument"
            ? value
            : `${argument.name.name}: ${value}`;
        }),
      ];
      text = all(parts) ? `${parts[0]}(${parts.slice(1).join(", ")})` : null;
      break;
    }
  }
  return text !== null && text.length <= 60 ? text : null;
}

/** The sentence of the warning (the current checker's, V30 §18). */
export function unusedFallbackMessage(
  rule: StaticRule & { readonly rule: "unused-fallback" },
): string {
  const holder = rule.subject === null ? "This value" : `'${rule.subject}'`;
  const one = rule.fallbacks.length === 1;
  const removed = rule.fallbacks.every((text) => text !== null)
    ? `'${rule.fallbacks.map((text) => `otherwise ${text}`).join(" ")}'`
    : null;
  let fix = one
    ? `Remove ${removed ?? "'otherwise' and the fallback after it"}.`
    : `Remove ${removed ?? "each 'otherwise' with its fallback"}.`;
  const read = rule.read;
  if (read !== null && read.kind !== null)
    fix = `Reading ${read.kind === "list" ? "a position the list" : "a key the dict"} does not have is an error, not null. ${
      read.object !== null && read.index !== null && rule.fallbacks[0] !== null
        ? `For a fallback there, write '${read.object}.get(${read.index}, default: ${rule.fallbacks[0]})'.`
        : "For a fallback there, use get with 'default:' instead."
    }`;
  return `${holder} is never null here, so ${one ? "the fallback after 'otherwise' is" : "the fallbacks after 'otherwise' are"} never used. ${fix}`;
}
