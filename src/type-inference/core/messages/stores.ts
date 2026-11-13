import type { Expression } from "../../../ast.js";
import type { SourceSite } from "../../graph.js";
import { CONVERSIONS, conversionTo } from "../../../conversions.js";
import { UNIT_OPERANDS } from "../../../duration.js";
import { ROUND_COUNT_FIX } from "../../../loop-rules.js";
import { isTemporalKind } from "../../../temporal-builtins.js";
import type { ItemTag } from "../items.js";
import type { DiagnosticRule, SiteExpectation, StoreRoot } from "../result.js";
import { bindingsOf } from "../consumers/bindings.js";
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
 * A store's place as its sentence names it: declared with a type; a copy of a declared variable, where the source
 * proves it (`copyOf`, #2289); or holding the type a store decided, since that store's line, a copy's too where no
 * declared variable is proved; a collection's element or dict value as the collection itself (#1195), which contains
 * it. `later`: the deciding store comes after the warned line, so the place holds its type because of that line.
 */
export function storeSubject(rule: StoreRule, source: MessageSource, later = false): string {
  const line = rule.decider === null ? null : source.line(rule.decider);
  const since = line === null ? "" : later ? ` because of line ${line}` : ` since line ${line}`;
  // (a copy decides the place: a written type with the store that decided it)
  const copy = rule.written && rule.decider !== null ? copyOf(rule, source) : null;
  const why =
    copy === null
      ? since
      : ` because ${copy.form === "value" ? "it is a copy" : `its ${copy.form} are copies`} of ${copy.of}`;
  const collection = elementOf(rule, source);
  const type = collection === null ? null : typeText(rule.type);
  if (collection !== null && type !== null)
    return `'${collection.name}' holds ${plural(rule.type)} (${collectionText(collection.kind, type)})${why}`;
  if (rule.written && rule.decider === null)
    return `${capitalized(rule.into)} is declared as ${described(rule.type)}`;
  return `${capitalized(rule.into)} holds ${described(rule.type)}${why}`;
}

/**
 * The declared variable a copy-decided store's place copies, where the source proves it (#2289, #2317's closed test):
 * the deciding value is the start value of the root's own `let` or `global` declaration, which stores it alone (its
 * text after its first `=`, one trailing `;` aside, is that value), and read along the place's steps it is one read of
 * a variable or parameter with its own written type, the place's: the value itself, an object literal's property for
 * a property step, every element of a list or set literal or every value of a dict literal for the last step. `of`
 * names it as a sentence does: `'lives', declared 'integer' on line 1`. `null` where any of it is not proved. The
 * declared variable is looked up last, only for a sentence being made (`bindingsOf`).
 */
function copyOf(
  rule: StoreRule,
  source: MessageSource,
): { readonly form: "value" | "elements" | "values"; readonly of: string } | null {
  const { root, decider } = rule;
  if (
    !rule.written ||
    root === null ||
    (root.kind !== "let" && root.kind !== "global") ||
    root.site === null ||
    decider === null ||
    decider.file !== root.site.file ||
    decider.start < root.site.start ||
    decider.end > root.site.end
  )
    return null;
  const declaration = source.text(root.site);
  const start = declaration.indexOf("=");
  const value = source.text(decider);
  if (
    start === -1 ||
    declaration
      .slice(start + 1)
      .trim()
      .replace(/;$/, "")
      .trimEnd() !== value
  )
    return null;
  const parsed = parsedExpression(value);
  if (parsed === null) return null;
  let form: "value" | "elements" | "values" = "value";
  let reads: readonly Expression[] = [parsed.expression];
  for (const [index, step] of rule.steps.entries()) {
    const [expression] = reads;
    if ("property" in step) {
      const found =
        expression!.kind === "objectLiteral"
          ? expression!.properties.filter((property) => property.name.name === step.property)
          : [];
      if (found.length !== 1) return null;
      reads = [found[0]!.value];
      continue;
    }
    // (a collection's elements or values: the last step alone)
    if (index !== rule.steps.length - 1) return null;
    if (step.collection === "dict" && expression!.kind === "dictLiteral") {
      reads = expression!.entries.map((entry) => entry.value);
      form = "values";
    } else if (
      (step.collection === "list" && expression!.kind === "listLiteral") ||
      (step.collection === "set" && expression!.kind === "setLiteral")
    ) {
      reads = expression!.elements;
      form = "elements";
    } else return null;
  }
  // (a read of a variable, or a call of a function by its name: a copy of its written result, #2378)
  const nameOf = (read: Expression): string | null =>
    read.kind === "identifier"
      ? read.name
      : read.kind === "callExpression" && read.callee.kind === "identifier"
        ? `${read.callee.name}()`
        : null;
  const [first] = reads;
  const name = first === undefined ? null : nameOf(first);
  if (name === null || reads.some((read) => nameOf(read) !== name)) return null;
  const at = (offset: number): number => decider.start + offset - parsed.at;
  const binding =
    bindingsOf(rule)?.({
      file: decider.file,
      start: at(first!.span.start.offset),
      end: at(first!.span.end.offset),
    }) ?? null;
  const declared = binding === null ? null : typeText(binding.type);
  return binding === null ||
    declared === null ||
    binding.type.length !== rule.type.length ||
    binding.type.some((kind) => !rule.type.includes(kind))
    ? null
    : {
        form,
        of: `${first!.kind === "callExpression" ? "the result of " : ""}'${binding.name}', declared '${declared}' on line ${source.line(binding.site)}`,
      };
}

/**
 * The collection a store's place is an element or a dict value of, where the source names it: a variable or parameter,
 * or a property path below one; with its kind, and whether it is the root itself, which a fix declares. With `source`,
 * a dict's list a statement changes in place is named by its read (#2378).
 */
export function elementOf(
  rule: StoreRule,
  source: MessageSource | null = null,
): {
  readonly name: string;
  readonly kind: "list" | "set" | "dict";
  readonly root: boolean;
} | null {
  const last = rule.steps.at(-1);
  // (#2378: a dict's list a statement changes in place, by its read's text, as its copy twin names its copy)
  if (
    source !== null &&
    rule.fresh !== undefined &&
    rule.steps.length === rule.fresh.depth + 1 &&
    last !== undefined &&
    "collection" in last
  )
    return { name: source.text(rule.fresh.list), kind: last.collection, root: false };
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
 * A written type a fix names (docs/specifications/type-inference-accepted-record/contract.md#r4-171): a form at a
 * type's position, which reads nothing and holds no author's text; `null` where it is none.
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
 * declaration as the source writes it, with that type, where `codeAt` proves it in the declaration's place (#1268):
 * a statement or a parameter, its text clear of the other diagnostics, its start value the author's
 * own, read where it stands; else the declaration and the type in words. `subject`, the root as the sentence names
 * it, `named` as its words name it; `null` where the type is no form (`typeAt`) or the root no declaration.
 */
export function declaration(
  root: StoreRoot | null,
  type: string,
  source: MessageSource,
  diagnosed: Diagnosed,
  subject = "it",
  named = subject,
): string | null {
  const written = typeAt(type, diagnosed);
  if (root === null || root.kind === "result" || written === null) return null;
  const parameter = root.kind === "parameter";
  const code = declarationCode(root, written, source, diagnosed);
  return code === null
    ? `declare ${parameter ? `the parameter '${root.name}'` : named} with the type '${written}'`
    : `declare ${parameter ? "the parameter" : subject} as '${code}'`;
}

/** `declaration`'s code: the root's declaration as the source writes it, with the written type `written`, or `null`. */
function declarationCode(
  root: StoreRoot,
  written: string,
  source: MessageSource,
  diagnosed: Diagnosed,
): string | null {
  if (root.site === null) return null;
  const parameter = root.kind === "parameter";
  // (its text up to the name, the type, and its text from the `=` on, which no written type holds: a global's
  // `default:` stays with it)
  const text = source.text(root.site);
  const start = text.indexOf("=");
  const declared = `${parameter ? "" : `${root.kind} `}${root.name}: ${written}`;
  return codeAt(
    {
      code: start === -1 ? declared : `${declared} ${text.slice(start)}`,
      takes: [],
      diagnosed,
      // (it restates the author's own declaration, its start value as written, and adds no read)
      reads: "none",
      holds: [root.site],
      rulesOut: null,
      gives: [],
      elements: [],
      writes: false,
    },
    parameter ? "parameter" : "statement",
  );
}

/**
 * The owner's sentences (#2289) for a store of numbers into a place that holds whole numbers because a copy of a
 * variable declared `integer` decided it (`copyOf`, A4): a variable declared as a copy of that variable's value, or a
 * list, set or dict declared with elements or values that are copies of it, with the fix that declares the place with
 * `number`, the declaration as written with one type written in; `null` for any other store, whose sentence is
 * `storeSubject`'s with today's fix.
 */
export function copySentence(
  rule: StoreRule,
  kinds: readonly ItemTag[],
  source: MessageSource,
  diagnosed: Diagnosed,
): string | null {
  const { root } = rule;
  const values = rule.type.filter((kind) => kind !== "null");
  if (
    root === null ||
    values.length !== 1 ||
    values[0] !== "integer" ||
    kinds.length === 0 ||
    kinds.some((kind) => kind !== "number")
  )
    return null;
  const numbers = typeText(rule.type.map((kind) => (kind === "integer" ? "number" : kind)));
  const copy = numbers === null ? null : copyOf(rule, source);
  if (copy === null) return null;
  // (one row per form a copy reaches the place by; a form without one does not compile)
  switch (copy.form) {
    case "value": {
      // (the variable itself is the copy: no step below it)
      if (rule.steps.length > 0) return null;
      const code = typeAt(numbers!, diagnosed);
      const fix = code === null ? null : declarationCode(root, code, source, diagnosed);
      return fix === null
        ? null
        : `${capitalized(rule.into)} holds ${described(rule.type)} because it is a copy of ${copy.of}. ` +
            `To store other numbers in it, write '${fix}'.`;
    }
    case "elements":
    case "values": {
      // (the root's own list's, set's or dict's elements or values are the copies)
      const collection = elementOf(rule);
      if (collection === null || !collection.root) return null;
      const held = typeText(rule.type);
      const code = typeAt(collectionText(collection.kind, numbers!), diagnosed);
      const fix = code === null ? null : declarationCode(root, code, source, diagnosed);
      return held === null || fix === null
        ? null
        : `'${collection.name}' holds ${plural(rule.type)} (${collectionText(collection.kind, held)}) because ` +
            `its ${copy.form} are copies of ${copy.of}. To add other numbers to it, write '${fix}'.`;
    }
    default: {
      const unknown: never = copy.form;
      return unknown;
    }
  }
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
  if (rule.fresh !== undefined) return freshFix(rule, rule.fresh, both, source, diagnosed);
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
 * #2378: the fix of a store into a dict's list a statement changes in place, its copy twin's (`let t = d.values`
 * before the statement): where the twin declares its copy, the copy made first, under a name no code spells; below
 * the list's elements, the twin's separate property or collection; else a separate variable.
 */
function freshFix(
  rule: StoreRule,
  fresh: NonNullable<StoreRule["fresh"]>,
  both: string | null,
  source: MessageSource,
  diagnosed: Diagnosed,
): string {
  const below = rule.steps.slice(fresh.depth);
  const last = below.at(-1);
  if (below.length === 1 && last !== undefined && "collection" in last) {
    const type = both === null ? null : typeAt(collectionText(last.collection, both), diagnosed);
    const listed = rule.steps[fresh.depth - 1];
    if (type !== null && listed !== undefined && "property" in listed) {
      const list = source.text(fresh.list);
      return (
        ` '${list}' is a new list each time: to allow both, copy it first, as ` +
        `'let ${source.freeName(listed.property)}: ${type} = ${list}'.`
      );
    }
  }
  if (below.some((step) => "property" in step))
    return " Use a separate property for a value of another type.";
  if (last !== undefined && "collection" in last)
    return ` Use a separate ${last.collection} for values of another type.`;
  return " Use a separate variable for a value of another type.";
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
