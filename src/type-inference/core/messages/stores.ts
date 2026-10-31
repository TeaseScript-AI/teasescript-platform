import type { Expression } from "../../../ast.js";
import type { SourceSite } from "../../graph.js";
import { CONVERSIONS, conversionTo } from "../../../conversions.js";
import { UNIT_OPERANDS } from "../../../duration.js";
import { ROUND_COUNT_FIX } from "../../../loop-rules.js";
import { isTemporalKind } from "../../../temporal-builtins.js";
import type { ItemTag } from "../items.js";
import type { DiagnosticRule, SiteExpectation, StoreRoot } from "../result.js";
import type { MessageSource } from "./site.js";
import {
  capitalized,
  collectionText,
  described,
  expressionKind,
  known,
  type Known,
  ownText,
  parsedExpression,
  plural,
  typeText,
} from "./words.js";
import { codeAt, type Diagnosed } from "./code-forms.js";

// The store rule's subject, its declaration and its fix, a conversion's included.

export type StoreRule = Extract<DiagnosticRule, { rule: "store" }>;

/**
 * A store's place as its sentence names it: declared with a type, or holding the type a store decided, since that
 * store's line; a collection's element or dict value as the collection itself (#1195), which contains it. `later`: the
 * deciding store comes after the warned line, so the place holds its type because of that line.
 */
export function storeSubject(rule: StoreRule, source: MessageSource, later = false): string {
  const line = rule.decider === null ? null : source.line(rule.decider);
  const since = line === null ? "" : later ? ` because of line ${line}` : ` since line ${line}`;
  const collection = elementOf(rule);
  const type = collection === null ? null : typeText(rule.type);
  if (collection !== null && type !== null)
    return `'${collection.name}' holds ${plural(rule.type)} (${collectionText(collection.kind, type)})${since}`;
  if (rule.written) return `${capitalized(rule.into)} is declared as ${described(rule.type)}`;
  return `${capitalized(rule.into)} holds ${described(rule.type)}${since}`;
}

/**
 * The collection a store's place is an element or a dict value of, where the source names it: a variable or parameter,
 * or a property path below one; with its kind, and whether it is the root itself, which a fix declares.
 */
export function elementOf(
  rule: StoreRule,
): {
  readonly name: string;
  readonly kind: "list" | "set" | "dict";
  readonly root: boolean;
} | null {
  const last = rule.steps.at(-1);
  if (
    rule.root === null ||
    rule.root.kind === "result" ||
    last === undefined ||
    !("collection" in last)
  )
    return null;
  const names = [rule.root.name];
  for (const step of rule.steps.slice(0, -1)) {
    if (!("property" in step)) return null;
    names.push(step.property);
  }
  return { name: names.join("."), kind: last.collection, root: names.length === 1 };
}

/**
 * A written type a fix names (TABLE r4.171): a form at a type's position, which reads nothing and holds no author's
 * text; `null` where it is none.
 */
export function typeAt(type: string, diagnosed: Diagnosed): string | null {
  return codeAt(
    {
      code: type,
      takes: [],
      diagnosed,
      reads: "none",
      holds: [],
      rulesOut: null,
      gives: [],
      elements: [],
      writes: false,
    },
    "type",
  );
}

/**
 * How a fix declares a store's root with the type `type` at the root (`declareAs` of the current checker): its whole
 * declaration as the source writes it, with that type, where `codeAt` proves it in the declaration's place (#1268,
 * TABLE r4.146): a statement or a parameter, its text clear of the other diagnostics, its start value the author's
 * own, read where it stands; else the declaration and the type in words. `subject`, the root as the sentence names
 * it; `null` where the type is no form (`typeAt`) or the root no declaration.
 */
export function declaration(
  root: StoreRoot | null,
  type: string,
  source: MessageSource,
  diagnosed: Diagnosed,
  subject = "it",
): string | null {
  const written = typeAt(type, diagnosed);
  if (root === null || root.kind === "result" || written === null) return null;
  const parameter = root.kind === "parameter";
  // (its text up to the name, the type, and its text from the `=` on, which no written type holds: a global's
  // `default:` stays with it)
  const text = root.site === null ? "" : source.text(root.site);
  const start = text.indexOf("=");
  const declared = `${parameter ? "" : `${root.kind} `}${root.name}: ${written}`;
  const code =
    root.site === null
      ? null
      : codeAt(
          {
            code: start === -1 ? declared : `${declared} ${text.slice(start)}`,
            takes: [],
            diagnosed,
            // (it restates the author's own declaration, its start value as written, and adds no read: TABLE r4.160,
            // r4.168)
            reads: "none",
            holds: [root.site],
            rulesOut: null,
            gives: [],
            elements: [],
            writes: false,
          },
          parameter ? "parameter" : "statement",
        );
  return code === null
    ? `declare ${parameter ? `the parameter '${root.name}'` : subject} with the type '${written}'`
    : `declare ${parameter ? "the parameter" : subject} as '${code}'`;
}

/**
 * The fix of a store of `kinds` at `at` into a place of `type`, as the current checker gives it: rounding a number into
 * a whole number; a conversion into the place's one type; for null a nullable type, else a written union (ADR 0021 rule
 * 1.1), where the place is a variable, a parameter, or an element or dict value of one; else a separate property or
 * collection for a property's or an element's values, or a separate variable.
 */
export function storeFix(
  rule: StoreRule,
  kinds: readonly ItemTag[],
  text: string,
  at: SourceSite,
  source: MessageSource,
  diagnosed: Diagnosed,
): string {
  if (rule.type.includes("integer") && kinds.includes("number")) return ROUND_COUNT_FIX;
  const values = known(kinds);
  const place = known(rule.type).filter((kind) => kind !== "null");
  const conversion = conversionFix(rule, place, values, text, at, diagnosed);
  if (conversion !== "") return conversion;
  const nullOnly = values.length > 0 && values.every((kind) => kind === "null");
  const both = typeText([...rule.type, ...kinds]);
  const collection = elementOf(rule);
  // (a collection a property holds: that property's first value, as the current checker says)
  const first =
    collection === null || collection.root || both === null
      ? null
      : typeAt(collectionText(collection.kind, both), diagnosed);
  if (first !== null)
    return (
      ` To allow both, give '${collection!.name}' a first value of type '${first}', ` +
      "such as a variable declared with that type."
    );
  if (rule.steps.some((step) => "property" in step))
    return " Use a separate property for a value of another type.";
  if (rule.steps.length > 0 && collection === null) {
    const last = rule.steps.at(-1)!;
    return ` Use a separate ${"collection" in last ? last.collection : "list"} for values of another type.`;
  }
  const written =
    both === null ? null : collection === null ? both : collectionText(collection.kind, both);
  const declared = written === null ? null : declaration(rule.root, written, source, diagnosed);
  // (null into an element widens the element's type, which the current checker calls both)
  if (declared !== null)
    return ` To allow ${nullOnly && collection === null ? "null" : "both"}, ${declared}.`;
  const result = rule.root?.kind === "result" && both !== null ? typeAt(both, diagnosed) : null;
  if (result !== null) return ` To return both, declare its result type as '${result}'.`;
  return nullOnly
    ? " Use a separate variable for null."
    : " Use a separate variable for a value of another type.";
}

/**
 * The conversion of a store's value at `at` into the place's one type (`place`), as the current checker gives it
 * (`conversionFix`): a number a unit (V30 §13), into an element too; and into a variable, a parameter, a result or a
 * property, text a date or a time with its conversion, and a number or a truth value shown as text; else "". Each code
 * form stands in place of the stored value, where the diagnostic sits, and is offered where `codeAt` proves it there:
 * the value of a kind the conversion takes (a date's text one it reads, Codex r3), and its result one the place takes.
 */
function conversionFix(
  rule: StoreRule,
  place: readonly Known[],
  values: readonly Known[],
  text: string,
  at: SourceSite,
  diagnosed: Diagnosed,
): string {
  const [type] = place;
  if (type === undefined || place.length > 1 || values.length === 0) return "";
  // (the place's written or decided type; a conversion writes no value of its own)
  const site: SiteExpectation = {
    takes: rule.type,
    binds: "whole",
    elements: "unproved",
    divides: "unproved",
  };
  const converted = (
    code: string,
    subject: readonly ItemTag[],
    takes: readonly ItemTag[],
    gives: readonly ItemTag[] = [type],
  ) =>
    codeAt(
      {
        code,
        takes: [{ subject, takes, held: false }],
        diagnosed,
        reads: "own",
        holds: [at],
        rulesOut: null,
        gives,
        elements: [],
        writes: false,
      },
      site,
    );
  if (
    (type === "duration" || type === "angle") &&
    values.every((kind) => kind === "integer" || kind === "number")
  ) {
    if (!ownText(text)) return " Put the expression in parentheses with a unit after them.";
    const kind = expressionKind(text);
    const operand =
      kind === "numberLiteral" || (kind !== null && UNIT_OPERANDS.has(kind)) ? text : `(${text})`;
    const code = converted(`${operand} ${type === "duration" ? "s" : "deg"}`, values, [
      "integer",
      "number",
    ]);
    return code === null
      ? " Give the number a unit."
      : ` Give the number a unit, such as '${code}'.`;
  }
  const last = rule.steps.at(-1);
  if (last !== undefined && "collection" in last) return "";
  const conversion = isTemporalKind(type) ? conversionTo(type) : undefined;
  if (conversion !== undefined && values.every((kind) => kind === "string")) {
    const entry = CONVERSIONS[conversion];
    const literal = textLiteral(text);
    const reads =
      literal !== null && entry.takes === "value" && entry.textProblem(literal) === undefined;
    const code = converted(`${conversion}(${text})`, reads ? values : [], ["string"]);
    return code === null
      ? ` Convert the text with the ${conversion} function.`
      : ` Convert the text with '${code}'.`;
  }
  if (
    type === "string" &&
    values.every((kind) => kind === "integer" || kind === "number" || kind === "boolean")
  ) {
    // (#1213's decided text: the value in `${...}` in place, read once, where `codeAt` proves it there, else the advice
    // alone, #1268)
    const code = converted(`"\${${text}}"`, values, ["integer", "number", "boolean"], ["string"]);
    return code === null
      ? " To show the value as text, put it in a text."
      : ` To show '${text}' as text, write '${code}'.`;
  }
  return "";
}

/** The text a text literal without `${...}` holds, its code on one line, else `null`. */
function textLiteral(code: string): string | null {
  const expression = ownText(code) ? parsedExpression(code)?.expression : undefined;
  return expression === undefined ? null : textOf(expression);
}

/** The text a text literal expression without `${...}` holds, else `null`. */
export function textOf(expression: Expression): string | null {
  if (expression.kind !== "stringLiteral") return null;
  let text = "";
  for (const part of expression.parts) {
    if (part.kind !== "stringText") return null;
    text += part.value;
  }
  return text;
}
