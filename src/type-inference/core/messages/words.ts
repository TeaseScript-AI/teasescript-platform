import type { Expression } from "../../../ast.js";
import { parse } from "../../../parser.js";
import {
  CHOICE_ELEMENT_RULE,
  CHOICE_OPTION_RULE,
  CHOICE_VALUE_RULE,
} from "../../../choice-rules.js";
import { SORT_RULE } from "../../../list-methods.js";
import { FOR_SOURCE_RULE, REPEAT_COUNT_RULE } from "../../../loop-rules.js";
import { LIST_INDEX_RULE, logicalOperandRule } from "../../../operand-rules.js";
import { JOIN_RULE } from "../../../shown-text-rules.js";
import { argumentFix } from "../../../text-operations.js";
import { VALUE_KINDS } from "../../../value-kinds.js";
import { propertyName } from "../program.js";
import type { ItemTag } from "../items.js";
import type { DiagnosticRule } from "../result.js";

// The kinds in words: how a message names types, values, paths and operands, and a subject's own code.

export type Known = Exclude<ItemTag, "unknown" | "empty">;

export function known(kinds: readonly ItemTag[]): Known[] {
  return [...new Set(kinds)].filter(
    (kind): kind is Known => kind !== "unknown" && kind !== "empty",
  );
}

/** Words in a list: `a`, `a or b`, `a, b, or c`. */
export function either(words: readonly string[]): string {
  return words.length < 3
    ? words.join(" or ")
    : `${words.slice(0, -1).join(", ")}, or ${words.at(-1)!}`;
}

/** The kinds a sentence names: a whole number among numbers is one of them (V30 §2). */
export function named(kinds: readonly ItemTag[]): Known[] {
  const found = known(kinds);
  return found.includes("number") ? found.filter((kind) => kind !== "integer") : found;
}

/** Kinds as one value is described: `a whole number (integer)`, `text (string) or null`. */
export function described(kinds: readonly ItemTag[]): string {
  const found = named(kinds);
  return found.length === 0
    ? "a value of another type"
    : either(found.map((kind) => VALUE_KINDS[kind].description));
}

/** Kinds as many values are described: `whole numbers`, `texts or null`. */
export function plural(kinds: readonly ItemTag[]): string {
  const found = named(kinds);
  return found.length === 0
    ? "values of one type"
    : either(found.map((kind) => (kind === "null" ? "null" : VALUE_KINDS[kind].plural)));
}

/**
 * Kinds as a written type (V30 §13), as the current checker writes one: `integer`, `integer | string`, `integer?`;
 * `null` where a list, set or dict among them has no written element type.
 */
export function typeText(kinds: readonly ItemTag[]): string | null {
  const found = named(kinds);
  const unwritten = (kind: Known): boolean =>
    !VALUE_KINDS[kind].written || (VALUE_KINDS[kind].type === "parts" && kind !== "object");
  if (found.length === 0 || found.some(unwritten)) return null;
  const values = found.filter((kind) => kind !== "null");
  if (values.length === 0) return "null";
  if (values.length < found.length && values.length === 1) return `${values[0]!}?`;
  return [...values, ...(values.length < found.length ? ["null"] : [])].join(" | ");
}

/** A collection's written type of elements of `element` (V30 §13): `integer[]`, `(integer | string) set`. */
export function collectionText(collection: "list" | "set" | "dict", element: string): string {
  const written = element.includes(" | ") ? `(${element})` : element;
  return collection === "list" ? `${written}[]` : `${written} ${collection}`;
}

/** The text of a plain variable, which a test narrows (ADR 0021 rule 5), else `null`. */
export function variable(text: string): string | null {
  return expressionKind(text) === "identifier" ? text : null;
}

/**
 * Whether a text is a stable path as written, on one line (TABLE §13 N1): a variable followed by properties, fixed
 * indexes or keys, or indexes and keys held in plain variables; not `.random`, a call or a computed index. It is the
 * only subject a fix's example names, so code that reads it again reads the same value (#1195, the lead after Astra r1
 * and r2). Any other subject, a literal or another expression, gets its fix's sentence alone; a name is never taken
 * from another declaration or from the place's facts.
 */
export function stablePath(text: string): boolean {
  const fixed = (index: Expression): boolean =>
    index.kind === "identifier" ||
    index.kind === "numberLiteral" ||
    (index.kind === "unaryExpression" &&
      index.operator === "-" &&
      index.operand.kind === "numberLiteral") ||
    (index.kind === "stringLiteral" && index.parts.every((part) => part.kind === "stringText"));
  const stable = (expression: Expression): boolean =>
    expression.kind === "identifier" ||
    (expression.kind === "propertyAccessExpression" &&
      expression.property.name !== "random" &&
      stable(expression.object)) ||
    (expression.kind === "indexExpression" && fixed(expression.index) && stable(expression.object));
  const parsed = parsedExpression(text);
  return parsed !== null && ownText(text) && stable(parsed.expression);
}

/** The literals whose type is their own: a number (also negated), text, `true`/`false`, null, a quantity, a regex. */
const LITERALS: ReadonlySet<Expression["kind"]> = new Set([
  "numberLiteral",
  "stringLiteral",
  "booleanLiteral",
  "nullLiteral",
  "durationLiteral",
  "unitExpression",
  "angleExpression",
  "regexLiteral",
]);

/** Whether a text is a literal, by the language's own parser. */
export function isLiteral(text: string): boolean {
  const expression = parsedExpression(text)?.expression;
  if (expression === undefined) return false;
  return expression.kind === "unaryExpression"
    ? expression.operator === "-" && expression.operand.kind === "numberLiteral"
    : LITERALS.has(expression.kind);
}

/** The expressions a member may follow without parentheses. */
export const POSTFIX: ReadonlySet<Expression["kind"]> = new Set([
  "identifier",
  "propertyAccessExpression",
  "indexExpression",
  "callExpression",
  "parenthesizedExpression",
  "stringLiteral",
  "booleanLiteral",
  "nullLiteral",
  "listLiteral",
  "objectLiteral",
  "setLiteral",
  "dictLiteral",
]);

/** The expressions an operator may stand beside without parentheses: a postfix one, a number, a quantity. */
export const OPERANDS: ReadonlySet<Expression["kind"]> = new Set([
  ...POSTFIX,
  "numberLiteral",
  "durationLiteral",
  "unitExpression",
  "angleExpression",
]);

/** The kind of expression code is, by the language's own parser (its binding, whatever its spacing); `null` if none. */
export function expressionKind(code: string): Expression["kind"] | null {
  return parsedExpression(code)?.expression.kind ?? null;
}

/** Code as an operand of an operator or `otherwise` a fix writes: in parentheses unless it binds tighter. */
export function operandText(code: string): string {
  const kind = expressionKind(code);
  return kind !== null && OPERANDS.has(kind) ? code : `(${code})`;
}

/** Code as the receiver of a member a fix writes: in parentheses unless it binds tighter. */
export function receiverText(code: string): string {
  const kind = expressionKind(code);
  return kind !== null && POSTFIX.has(kind) ? code : `(${code})`;
}

/**
 * A path below a place in words (D2: source text, never code the source does not hold): its properties as code after
 * the place's own (`'box.a.n'`), and each element or dict value step in words (`'n' of an element of 'xs'`). `root`: the
 * place's code, or words for a place the source has no name for (`its elements`); `steps`: a key's steps, a property
 * named as an internal step quoted (`propertyStep`), so `x.element` stays a property.
 */
export function pathPhrase(
  root: { readonly code: string } | { readonly words: string },
  steps: readonly string[],
): string {
  let phrase = "words" in root ? root.words : null;
  let chain = "code" in root ? root.code : "";
  const named = (): string =>
    chain === "" ? phrase! : phrase === null ? `'${chain}'` : `'${chain}' of ${phrase}`;
  for (const step of steps)
    if (step === "element" || step === "entry") {
      phrase = `${step === "entry" ? "a value" : "an element"} of ${named()}`;
      chain = "";
    } else {
      const name = propertyName(step);
      chain = chain === "" ? name : chain + "." + name;
    }
  return named();
}

/** A member as its sentence names it: `property 'n'`, `method 'add'`, `elements`. */
export function memberNoun(member: string): string {
  if (!member.startsWith(".")) return "elements";
  return member.endsWith("()")
    ? `method '${member.slice(1, -2)}'`
    : `property '${member.slice(1)}'`;
}

/** Whether a member's use sets a property: a store's `use` also marks a method that changes its value, and an element. */
export function setsProperty(rule: DiagnosticRule): boolean {
  return (
    rule.rule === "member" &&
    rule.use === "store" &&
    rule.member.startsWith(".") &&
    !rule.member.endsWith("()")
  );
}

export function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What `${...}` shows (compile error `TSV042`). */
export const SHOWN_RULE =
  "It shows text, numbers, true, false, null, durations, angles, date and time values, script references, and " +
  "regexes, and selects one element of a list.";

export const SORT_ONE_TYPE = "sort() sorts elements of one type";

/**
 * C13: the conversion that turns an argument of one known kind into what its method takes (the text methods' own fix,
 * `argumentFix`), or a set or a range into a list.
 */
export function argumentFixOf(
  rule: Extract<DiagnosticRule, { rule: "argument" }>,
  kinds: readonly ItemTag[],
  text: string,
): string {
  const kind = known(kinds).length === 1 ? known(kinds)[0] : undefined;
  const { takes } = rule;
  if (kind === undefined) return "";
  if (takes === "list" || takes === "collection")
    return kind === "range" || (kind === "set" && takes === "list") ? ` ${listCopyFix(text)}` : "";
  return argumentFix(
    { name: rule.parameter, kind: takes === "integer" ? "count" : takes },
    kind === "string" || kind === "integer" || kind === "number" || kind === "boolean"
      ? kind
      : null,
  );
}

/** A range or a set where a list is needed, copied into one in words (#1268: no code that does not compile there). */
export function listCopyFix(text: string): string {
  return `Copy '${text}' into a list with the toList method first.`;
}

/**
 * Whom a TSV029 sentence names: the operand, or the property a choice object it holds returns (`'w.value'`, the text
 * of an element of `'ws'`), never the object.
 */
export function choiceSubject(
  rule: Extract<DiagnosticRule, { rule: "choice" }>,
  text: string,
): string {
  if (rule.member === undefined) return `'${text}'`;
  return rule.within === true
    ? `the ${rule.member} of an element of '${text}'`
    : `'${text}.${rule.member}'`;
}

/** The ordered types a sort may mix, in words: `both numbers and text`, `numbers, text, and durations`. */
export function mixedTypes(families: readonly ItemTag[]): string {
  const words = named(families).map((kind) =>
    kind === "string" ? "text" : kind === "null" ? "null" : VALUE_KINDS[kind].plural,
  );
  return words.length === 2
    ? `both ${words[0]!} and ${words[1]!}`
    : `${words.slice(0, -1).join(", ")}, and ${words.at(-1)!}`;
}

/** The rule an operand's kinds break: the first part of its consumer's sentence; `text`, the operand as written. */
export function operandRule(rule: DiagnosticRule, text: string): string {
  switch (rule.rule) {
    case "count":
      return rule.use === "repeat"
        ? REPEAT_COUNT_RULE
        : rule.use === "index" || rule.use === "get"
          ? LIST_INDEX_RULE
          : `${rule.use}() needs a whole number (integer)`;
    case "boolean":
      return rule.operator === null
        ? "A condition must be true or false (boolean)"
        : rule.operator === "not"
          ? "'not' needs true or false (boolean)"
          : logicalOperandRule(rule.operator === "and" ? "and" : "or");
    case "operator":
      return `'${rule.operator}' needs ${described(rule.domain)}`;
    case "key":
      return "A dict key is text (string)";
    case "iterable":
      return rule.entries
        ? "A 'for' loop with a key and a value goes through a dict"
        : FOR_SOURCE_RULE;
    case "argument":
      return `${rule.callee}() needs ${described(rule.domain)} for '${rule.parameter}'`;
    case "elements":
      return rule.callee === "join" ? JOIN_RULE : SORT_RULE;
    case "choice":
      return rule.part === "value"
        ? CHOICE_VALUE_RULE
        : rule.part === "option"
          ? CHOICE_OPTION_RULE
          : CHOICE_ELEMENT_RULE;
    // (the operand in its own '${…}', which is no placeholder, #1268)
    case "shown":
      return rule.element
        ? `'\${${text}}' shows one element of a list as text`
        : `'\${${text}}' shows its value as text`;
    default:
      throw new Error(`The rule '${rule.rule}' has no operand rule.`);
  }
}

/** An expression the source parsed from code, read as the initializer of a `let`, with the offset its code starts at. */
export function parsedExpression(
  code: string,
): { readonly expression: Expression; readonly at: number } | null {
  const prefix = "let fix = ";
  const parsed = parse(`${prefix}${code}\nexit\n`);
  const statement = parsed.program.statements[0];
  if (parsed.diagnostics.length > 0 || statement?.kind !== "letStatement") return null;
  const { span } = statement.initializer;
  return span.start.offset === prefix.length && span.end.offset === prefix.length + code.length
    ? { expression: statement.initializer, at: prefix.length }
    : null;
}

/** Whether a subject's own text may stand in a fix's code: on one line, and without a comment. */
export function ownText(code: string): boolean {
  return !/[\n\r]|\/\/|\/\*/.test(code);
}
