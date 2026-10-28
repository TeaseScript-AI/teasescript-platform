import type { Expression } from "../../ast.js";
import { parse } from "../../parser.js";
import type { SourceSite } from "../graph.js";
import { angleUnit } from "../../angle.js";
import { CONVERSIONS, conversionTo } from "../../conversions.js";
import { DICT_METHODS, DICT_PROPERTIES, dictMethod } from "../../dict-operations.js";
import { elapsedDurationUnit, UNIT_OPERANDS } from "../../duration.js";
import { listMethod } from "../../list-methods.js";
import { FOR_SOURCE_RULE, REPEAT_COUNT_RULE, ROUND_COUNT_FIX } from "../../loop-rules.js";
import { LIST_INDEX_RULE, logicalOperandRule } from "../../operand-rules.js";
import { misspelledPropertyHint, nameList } from "../../object-properties.js";
import { interpolatedDictMessage } from "../../shown-text-rules.js";
import { PERSON_FIELDS, PLAYER } from "../../speaker-terms.js";
import {
  CALENDAR_DURATION_PARTS,
  hasTemporalField,
  isTemporalKind,
} from "../../temporal-builtins.js";
import {
  isTextMember,
  isTextMethod,
  TEXT_METHODS,
  textMemberSuggestion,
} from "../../text-operations.js";
import { hasIdentity, VALUE_KINDS } from "../../value-kinds.js";
import { REFERENCE } from "./contract.js";
import { propertyName } from "./program.js";
import type { ContextWord, ItemTag } from "./items.js";
import type {
  BudgetStop,
  ContextDetail,
  CoreCode,
  CoreDiagnostic,
  DiagnosticRule,
  NotChecked,
  StoreRoot,
  WorkPlace,
  WrittenTypeError,
} from "./result.js";

/*
 * The sentences of the coarse core's diagnostics (the port plan's D1–D3, TABLE r4.53): each diagnostic's code is its
 * rule's (D3: one code, both severities where the rule warns), and its message is a first sentence per consumer and
 * obligation, in the source's own text (D2), and the fix the current checker gives (#1195). A warning says what may go
 * wrong, that the Tease then stops at its line, the fix, and a last sentence per context word (§3.4) that says in the
 * author's terms why the value may be of another type; the word itself is never shown. Single quotes for code, no
 * semicolons, no implementation terms, and "type", never "kind" (`docs/DIAGNOSTICS.md`, "Messages").
 */

/** How a message names the source: the text at a site, the line it starts on (1-based) and its column (0-based). */
export interface MessageSource {
  readonly text: (site: SourceSite) => string;
  readonly line: (site: SourceSite) => number;
  readonly column: (site: SourceSite) => number;
}

/** The message source of a project's files: each file's text, its lines counted once, on first need. */
export function messageSource(sources: readonly string[]): MessageSource {
  const starts = new Map<number, number[]>();
  const linesOf = (file: number): number[] => {
    let found = starts.get(file);
    if (found === undefined) {
      found = [0];
      const text = sources[file] ?? "";
      for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1))
        found.push(at + 1);
      starts.set(file, found);
    }
    return found;
  };
  // the index of the last line start at or before the site, by binary search
  const lineIndex = (site: SourceSite): number => {
    const lines = linesOf(site.file);
    let low = 0;
    let high = lines.length;
    while (high - low > 1) {
      const middle = (low + high) >> 1;
      if (lines[middle]! <= site.start) low = middle;
      else high = middle;
    }
    return low;
  };
  return {
    text: (site) => (sources[site.file] ?? "").slice(site.start, site.end),
    line: (site) => lineIndex(site) + 1,
    column: (site) => site.start - linesOf(site.file)[lineIndex(site)]!,
  };
}

/** The code of a rule (D3): its one code in the registry, an error where proved and a warning where checked. */
export function codeOf(rule: DiagnosticRule): CoreCode {
  switch (rule.rule) {
    case "store":
    case "fallback":
      return "TSV041";
    case "count":
      return rule.use === "repeat" ? "TSV011" : "TSV043";
    case "shown":
      return "TSV042";
    case "iterable":
      return "TSV012";
    case "mixed":
      return "TSV044";
    default:
      return "TSV043";
  }
}

/** A diagnostic's message: its first sentence, and a warning's consequence, fix and cause after it. */
export function coreMessage(diagnostic: CoreDiagnostic, source: MessageSource): string {
  if (diagnostic.kind === "written-type") return writtenTypeMessage(diagnostic, source);
  if (diagnostic.kind === "budget") return budgetMessage(diagnostic, source);
  const text = source.text(diagnostic.site);
  const { rule, kinds } = diagnostic;
  if (diagnostic.class === "compile-error")
    return errorSentence(rule, text, kinds, source, diagnostic.site);
  const { context, detail } = diagnostic.provenance;
  // a member's context is its receiver's: `value` in `value[0]` comes from outside the script; a selection's, its
  // collection's
  const name =
    rule.rule === "member" ? rule.receiver : rule.rule === "selection" ? rule.collection : text;
  const sentences = [
    warningSentence(rule, text, kinds, source, context, detail),
    warningFix(rule, text, kinds, diagnostic.fits, detail, context, source),
  ];
  // a warning whose value has no word of its own (an exact value the rule still checks) has no cause; `later`'s first
  // sentence names the deciding line, and a member's missing property is its first sentence
  // (a member's missing property is its first sentence, and another rule's at that read repeats the member's warning)
  const missing = context === "missing" && (rule.rule === "member" || detail.direct);
  // (a literal subject has no origin of its own: its warning is its receiver's, `0` in `value.get(0, ...)`)
  const literal = rule.rule !== "member" && isLiteral(text);
  // (a speaker alone: a property store's first sentence says what happens, and a method call's fix that a speaker has
  // none, which no cause changes; Astra r3, Sol r7)
  const holder = detail.receiver?.kinds ?? kinds;
  const speaker =
    rule.rule === "member" &&
    (setsProperty(rule) || rule.member.endsWith("()")) &&
    holder.length > 0 &&
    holder.every((kind) => kind === "speaker");
  if (
    !(context === "unknown" && !detail.outside) &&
    context !== "later" &&
    !missing &&
    !speaker &&
    !literal
  )
    // a word that came with a value from another line speaks of that value's origin, never of this line's names
    sentences.push(
      detail.direct
        ? contextSentence(context, name, detail, rule.rule === "selection" ? ["empty"] : kinds)
        : // (a member's `missing` is the member's own value, from a property read elsewhere)
          originSentence(context, context === "missing" ? text : name),
    );
  return sentences.filter((sentence) => sentence !== "").join(" ");
}

// ------------------------------------------------------------------------------------------- the kinds in words

type Known = Exclude<ItemTag, "unknown" | "empty">;

function known(kinds: readonly ItemTag[]): Known[] {
  return [...new Set(kinds)].filter(
    (kind): kind is Known => kind !== "unknown" && kind !== "empty",
  );
}

/** Words in a list: `a`, `a or b`, `a, b, or c`. */
function either(words: readonly string[]): string {
  return words.length < 3
    ? words.join(" or ")
    : `${words.slice(0, -1).join(", ")}, or ${words.at(-1)!}`;
}

/** The kinds a sentence names: a whole number among numbers is one of them (V30 §2). */
function named(kinds: readonly ItemTag[]): Known[] {
  const found = known(kinds);
  return found.includes("number") ? found.filter((kind) => kind !== "integer") : found;
}

/** Kinds as one value is described: `a whole number (integer)`, `text (string) or null`. */
function described(kinds: readonly ItemTag[]): string {
  const found = named(kinds);
  return found.length === 0
    ? "a value of another type"
    : either(found.map((kind) => VALUE_KINDS[kind].description));
}

/** Kinds as many values are described: `whole numbers`, `texts or null`. */
function plural(kinds: readonly ItemTag[]): string {
  const found = named(kinds);
  return found.length === 0
    ? "values of one type"
    : either(found.map((kind) => (kind === "null" ? "null" : VALUE_KINDS[kind].plural)));
}

/**
 * Kinds as a written type (V30 §13), as the current checker writes one: `integer`, `integer | string`, `integer?`;
 * `null` where a list, set or dict among them has no written element type.
 */
function typeText(kinds: readonly ItemTag[]): string | null {
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
function collectionText(collection: "list" | "set" | "dict", element: string): string {
  const written = element.includes(" | ") ? `(${element})` : element;
  return collection === "list" ? `${written}[]` : `${written} ${collection}`;
}

/** The text of a plain variable, which a test narrows (ADR 0021 rule 5), else `null`. */
function variable(text: string): string | null {
  return expressionKind(text) === "identifier" ? text : null;
}

/**
 * Whether a text is a stable path as written, on one line (TABLE §13 N1): a variable followed by properties, fixed
 * indexes or keys, or indexes and keys held in plain variables; not `.random`, a call or a computed index. It is the
 * only subject a fix's example names, so code that reads it again reads the same value (#1195, the lead after Astra r1
 * and r2). Any other subject, a literal or another expression, gets its fix's sentence alone; a name is never taken
 * from another declaration or from the place's facts.
 */
function stablePath(text: string): boolean {
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
function isLiteral(text: string): boolean {
  const expression = parsedExpression(text)?.expression;
  if (expression === undefined) return false;
  return expression.kind === "unaryExpression"
    ? expression.operator === "-" && expression.operand.kind === "numberLiteral"
    : LITERALS.has(expression.kind);
}

/** The expressions a member may follow without parentheses. */
const POSTFIX: ReadonlySet<Expression["kind"]> = new Set([
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
const OPERANDS: ReadonlySet<Expression["kind"]> = new Set([
  ...POSTFIX,
  "numberLiteral",
  "durationLiteral",
  "unitExpression",
  "angleExpression",
]);

/** The kind of expression code is, by the language's own parser (its binding, whatever its spacing); `null` if none. */
function expressionKind(code: string): Expression["kind"] | null {
  return parsedExpression(code)?.expression.kind ?? null;
}

/** Code as an operand of an operator or `otherwise` a fix writes: in parentheses unless it binds tighter. */
function operandText(code: string): string {
  const kind = expressionKind(code);
  return kind !== null && OPERANDS.has(kind) ? code : `(${code})`;
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
function memberNoun(member: string): string {
  if (!member.startsWith(".")) return "elements";
  return member.endsWith("()")
    ? `method '${member.slice(1, -2)}'`
    : `property '${member.slice(1)}'`;
}

/** Whether a member's use sets a property: a store's `use` also marks a method that changes its value, and an element. */
function setsProperty(rule: DiagnosticRule): boolean {
  return (
    rule.rule === "member" &&
    rule.use === "store" &&
    rule.member.startsWith(".") &&
    !rule.member.endsWith("()")
  );
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What `${...}` shows (compile error `TSV042`). */
const SHOWN_RULE =
  "It shows text, numbers, true, false, null, durations, angles, date and time values, script references, and " +
  "regexes, and selects one element of a list.";

/** The rule an operand's kinds break: the first part of its consumer's sentence. */
function operandRule(rule: DiagnosticRule): string {
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
    case "shown":
      return rule.element
        ? "'${...}' shows one element of a list as text"
        : "'${...}' shows its value as text";
    default:
      throw new Error(`The rule '${rule.rule}' has no operand rule.`);
  }
}

// ------------------------------------------------------------------------------------------- first sentences

type StoreRule = Extract<DiagnosticRule, { rule: "store" }>;

/**
 * A store's place as its sentence names it: declared with a type, or holding the type a store decided, since that
 * store's line; a collection's element or dict value as the collection itself (#1195), which contains it. `later`: the
 * deciding store comes after the warned line, so the place holds its type because of that line.
 */
function storeSubject(rule: StoreRule, source: MessageSource, later = false): string {
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
function elementOf(
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
 * How a fix declares a store's root with the type `type` at the root (`declareAs` of the current checker); `subject`,
 * the root as the sentence names it.
 */
function declaration(root: StoreRoot | null, type: string, subject = "it"): string | null {
  if (root === null) return null;
  switch (root.kind) {
    case "parameter":
      return `declare the parameter as '${root.name}: ${type}${root.start === null ? "" : ` = ${root.start}`}'`;
    case "result":
      return null;
    default:
      return `declare ${subject} as '${root.kind} ${root.name}: ${type} = ...'`;
  }
}

/**
 * The fix of a store of `kinds` into a place of `type`, as the current checker gives it: rounding a number into a whole
 * number; a conversion into the place's one type; for null a nullable type, else a written union (ADR 0021 rule 1.1),
 * where the place is a variable, a parameter, or an element or dict value of one; else a separate property or
 * collection for a property's or an element's values, or a separate variable.
 */
function storeFix(rule: StoreRule, kinds: readonly ItemTag[], text: string): string {
  if (rule.type.includes("integer") && kinds.includes("number")) return ROUND_COUNT_FIX;
  const values = known(kinds);
  const place = known(rule.type).filter((kind) => kind !== "null");
  const conversion = conversionFix(rule, place, values, text);
  if (conversion !== "") return conversion;
  const nullOnly = values.length > 0 && values.every((kind) => kind === "null");
  const both = typeText([...rule.type, ...kinds]);
  const collection = elementOf(rule);
  // (a collection a property holds: that property's first value, as the current checker says)
  if (collection !== null && !collection.root && both !== null)
    return (
      ` To allow both, give '${collection.name}' a first value of type '${collectionText(collection.kind, both)}', ` +
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
  const declared = written === null ? null : declaration(rule.root, written);
  // (null into an element widens the element's type, which the current checker calls both)
  if (declared !== null)
    return ` To allow ${nullOnly && collection === null ? "null" : "both"}, ${declared}.`;
  if (rule.root?.kind === "result" && both !== null)
    return ` To return both, declare its result type as '${both}'.`;
  return nullOnly
    ? " Use a separate variable for null."
    : " Use a separate variable for a value of another type.";
}

/**
 * The conversion of a store's value into the place's one type (`place`), as the current checker gives it
 * (`conversionFix`): a number a unit (V30 §13), into an element too; and into a variable, a parameter, a result or a
 * property, text a date or a time with its conversion, and a number or a truth value shown as text; else "". Code
 * replaces the stored value, which the diagnostic sits on, whole (TABLE r4.146); the conversion is named in words
 * where the value is not code on one line, or not a text literal the conversion reads.
 */
function conversionFix(
  rule: StoreRule,
  place: readonly Known[],
  values: readonly Known[],
  text: string,
): string {
  const [type] = place;
  if (type === undefined || place.length > 1 || values.length === 0) return "";
  if (
    (type === "duration" || type === "angle") &&
    values.every((kind) => kind === "integer" || kind === "number")
  )
    return unitFix(text, type === "duration" ? "s" : "deg");
  const last = rule.steps.at(-1);
  if (last !== undefined && "collection" in last) return "";
  const conversion = isTemporalKind(type) ? conversionTo(type) : undefined;
  if (conversion !== undefined && values.every((kind) => kind === "string")) {
    // (the call only of a text the conversion reads: any other value, even one the script knows, may be one it does
    // not, which the compiler rejects, Codex r3)
    const entry = CONVERSIONS[conversion];
    const literal = textLiteral(text);
    return literal !== null && entry.takes === "value" && entry.textProblem(literal) === undefined
      ? ` Convert the text with '${conversion}(${text})'.`
      : ` Convert the text with the ${conversion} function.`;
  }
  if (
    type === "string" &&
    values.every((kind) => kind === "integer" || kind === "number" || kind === "boolean")
  )
    return stablePath(text)
      ? ` To show it as text, write '"\${${text}}"'.`
      : " To show it as text, put it in a text with '${...}'.";
  return "";
}

/**
 * A number given a unit, as the current checker writes it (V30 §13): the value's own code before the unit, in
 * parentheses unless it binds tighter (`UNIT_OPERANDS`); the advice alone where the code is not on one line.
 */
function unitFix(text: string, unit: "s" | "deg"): string {
  if (!ownText(text)) return " Put the expression in parentheses with a unit after them.";
  const kind = expressionKind(text);
  const operand =
    kind === "numberLiteral" || (kind !== null && UNIT_OPERANDS.has(kind)) ? text : `(${text})`;
  return ` Give the number a unit, such as '${operand} ${unit}'.`;
}

/**
 * A member's fix where its receiver's kind has no such member (the current checker's, `operation-checks.ts`). Code
 * replaces the member access the diagnostic sits on, whole (TABLE r4.146), and is given only where the diagnostic
 * proves it valid there: an error (`exact`), whose receiver is a stable path of the one kind the fix is for, never null
 * or unknown, and a call's elements of a type it takes. A warning's receiver may be of another type or null, so its fix
 * is in words, as is any other (Astra r2, Codex r4); `text`, the access's own code.
 */
function memberFix(
  rule: Extract<DiagnosticRule, { rule: "member" }>,
  kinds: readonly ItemTag[],
  text: string,
  exact: boolean,
): string {
  const kind = known(kinds).find((found) => found !== "null");
  if (kind === undefined) return "";
  const receiver = rule.receiver;
  const named = stablePath(receiver);
  // (code on the receiver, valid where it is of the kind `tag` alone)
  const code = (tag: ItemTag): boolean =>
    exact && named && kinds.length > 0 && kinds.every((found) => found === tag);
  if (!rule.member.startsWith("."))
    return kind === "object" ? objectIndexFix(rule, text, code("object")) : "";
  const method = rule.member.endsWith("()");
  const name = method ? rule.member.slice(1, -2) : rule.member.slice(1);
  if (kind === "string") {
    if (rule.use === "store") return ` Assign a new text to '${receiver}' instead.`;
    if (method && name === "length")
      return code("string")
        ? ` Write '${receiver}.length' without parentheses.`
        : " Read the length property without parentheses.";
    if (!method && isTextMethod(name))
      return callFix(
        receiver,
        name,
        TEXT_METHODS[name].parameters.some((parameter) => !("optional" in parameter)),
        code("string"),
      );
    const suggestion = textMemberSuggestion(name);
    // (a method's arguments are the script's to choose: the method in words)
    if (suggestion?.endsWith("(...)")) return ` Use the ${suggestion.slice(0, -5)} method.`;
    if (suggestion !== undefined)
      return code("string")
        ? ` Use '${receiver}.${suggestion}'.`
        : ` Use the ${suggestion.replace("()", "")} ${suggestion.endsWith(")") ? "method" : "property"}.`;
  }
  if (kind === "dict") return dictMemberFix(rule, name, method, code("dict"));
  // (a property stored on a type without it: a read's repair is no place to store into)
  if (!method && rule.use === "store") return "";
  const angle = method || kind !== "angle" ? undefined : angleUnit(name);
  if (angle !== undefined) {
    const conversion = angle === "deg" ? "toDeg" : "toRad";
    return (
      ` Use ${code("angle") ? `'${conversion}(${receiver})'` : `the ${conversion} function`} for its size in ` +
      `${angle === "deg" ? "degrees" : "radians"}.`
    );
  }
  if (!method && kind === "list" && name === "join") {
    // (the join method joins only elements `${...}` shows, V30 §8: its call where the elements' type is known to be
    // one, its step in words where it is not)
    const elements = rule.elements ?? [];
    const shown =
      elements.length > 0 &&
      elements.every(
        (found) => found !== "unknown" && found !== "empty" && VALUE_KINDS[found].shown !== null,
      );
    if (shown) return callFix(receiver, name, false, code("list"));
    return elements.some(
      (found) => found !== "unknown" && found !== "empty" && VALUE_KINDS[found].shown === null,
    )
      ? " The join method joins only elements that can be shown as text, so select an element or a property first."
      : " Call the join method with parentheses, on elements that can be shown as text.";
  }
  if (!method && kind === "absoluteDateTime" && hasTemporalField("datetime", name))
    return named
      ? ` Convert '${receiver}' first, as in '${receiver}.toDateTime().${name}'.`
      : ` Convert '${receiver}' with 'toDateTime()' first.`;
  if (kind !== "string" && VALUE_KINDS[kind].type === "scalar" && isTextMember(name))
    return named
      ? ` Convert '${receiver}' to text first, as in 'toString(${receiver})${method ? `.${name}(...)` : `.${name}`}'.`
      : ` Convert '${receiver}' to text first with 'toString(...)'.`;
  if (!method && kind === "duration") {
    const unit = elapsedDurationUnit(name);
    if (unit !== undefined) {
      const single = name.length > 2 && name.endsWith("s") ? name.slice(0, -1) : name;
      return named
        ? ` Divide '${receiver}' by a unit, as in '${receiver} / 1 ${single}'.`
        : ` Divide '${receiver}' by a unit, such as '1 ${single}'.`;
    }
  }
  if (!method && kind === "calendarDuration")
    return ` Use ${either(Object.keys(CALENDAR_DURATION_PARTS).map((part) => `'${part}'`))}.`;
  if (method && kind === "set" && listMethod(name)?.notOnSet !== undefined)
    return name === "get"
      ? " Use 'contains(...)' instead."
      : ` Copy '${receiver}' into a list with '${named ? `${receiver}.` : ""}toList()' first.`;
  if (!method && kind === "list" && rule.use === "read")
    return " Use 'length', 'first', 'last', or 'random'.";
  return "";
}

/**
 * A dict's member it lacks, with the current checker's fix (`dict-operations.ts`): a value stored or read by its key,
 * the key's code replacing the property's access where it is valid on the receiver (`code`, TABLE r4.146), else in
 * words, or the dict's own members in words; an `add`'s key is the script's to choose.
 */
function dictMemberFix(
  rule: Extract<DiagnosticRule, { rule: "member" }>,
  name: string,
  method: boolean,
  code: boolean,
): string {
  if (method)
    return name === "add"
      ? " Assign the value to a key of the dict instead."
      : ` Use one of its methods instead: ${either(Object.keys(DICT_METHODS))}.`;
  const key = `${rule.receiver}[${JSON.stringify(name)}]`;
  // (a stored value lands where the dict's values may be of another type: the code where the dict can hold it)
  if (rule.use === "store")
    return code
      ? ` If '${rule.receiver}' can hold the value, write '${key}' to store it by its key.`
      : " To store a value by its key, write the key in brackets.";
  return (
    ` Use one of its properties instead: ${either(Object.keys(DICT_PROPERTIES))}.` +
    (code
      ? ` To read a value by its key, write '${key}'.`
      : " To read a value by its key, write the key in brackets.")
  );
}

/**
 * A method read without its parentheses: the call replacing the access where it is valid there (`code`) and the method
 * needs no argument (`needs`), else the call in words.
 */
function callFix(receiver: string, name: string, needs: boolean, code: boolean): string {
  if (needs) return ` Call the ${name} method with its arguments in parentheses.`;
  return code
    ? ` Write '${receiver}.${name}()' with parentheses.`
    : ` Call the ${name} method with parentheses.`;
}

/**
 * An object indexed, which V30 §15 forbids, with the current checker's fix: a dict looks up by a name, and a fixed name
 * written as text is read as the object's property where the object has it (and, for a store, where it can hold the
 * value), which the sentence cannot know (Codex r1); its code where it is valid on the receiver (`code`), else in words;
 * `text`, the access.
 */
function objectIndexFix(
  rule: Extract<DiagnosticRule, { rule: "member" }>,
  text: string,
  code: boolean,
): string {
  const access = parsedExpression(text)?.expression;
  const key = access?.kind === "indexExpression" ? textOf(access.index) : null;
  if (key === null || !/^[A-Za-z_]\w*$/.test(key)) return " Use a dict to look up by name.";
  // (a store's value lands in the property: it holds it where its type takes the value)
  const has = `a property '${key}'${rule.use === "store" ? " that can hold the value" : ""}`;
  return code
    ? ` Use a dict to look up by name. If '${rule.receiver}' has ${has}, write '${rule.receiver}.${key}' instead.`
    : ` Use a dict to look up by name. If the object has ${has}, use a dot instead of brackets.`;
}

/**
 * The fix of a value that is not true or false where a condition needs one (#1195's decided text): its advice always,
 * its example only of a stable path (the lead after Astra r3).
 */
function conditionFix(text: string, kinds: readonly ItemTag[]): string {
  const kind = known(kinds)[0];
  const example = (code: string): string => (stablePath(text) ? `, as in '${code}'.` : ".");
  if (kind === "integer" || kind === "number")
    return ` Compare it instead${example(`${text} > 0`)}`;
  if (kind === "string") return ` Compare it instead${example(`${text} != ""`)}`;
  if (kind === "list" || kind === "set" || kind === "dict")
    return ` Check its length instead${example(`${text}.length > 0`)}`;
  return "";
}

/** The fix of a key that is not text: a number written as text, as the current checker gives it (`dict-operations.ts`). */
function keyFix(text: string, kinds: readonly ItemTag[]): string {
  if (!kinds.some((kind) => kind === "integer" || kind === "number")) return "";
  return stablePath(text)
    ? ` Write a number key as text, as in '"\${${text}}"'.`
    : " Write a number key as text.";
}

/** How `${...}` shows a value of each kind it cannot show, where one has a fix (#1195's decided texts). */
function shownFix(
  rule: Extract<DiagnosticRule, { rule: "shown" }>,
  text: string,
  kinds: readonly ItemTag[],
): string {
  const kind = known(kinds).length === 1 ? known(kinds)[0] : undefined;
  const label = stablePath(text) ? text : null;
  if (kind === "object")
    return rule.property === null || label === null
      ? "Show one of its properties instead."
      : `Show one of its properties instead, as in '\${${label}.${rule.property}}'.`;
  if (kind === "set")
    return label === null
      ? "Show its elements with 'toList().join()' instead."
      : `Show all its elements with '\${${label}.toList().join()}'.`;
  return SHOWN_RULE;
}

/** The text a text literal without `${...}` holds, its code on one line, else `null`. */
function textLiteral(code: string): string | null {
  const expression = ownText(code) ? parsedExpression(code)?.expression : undefined;
  return expression === undefined ? null : textOf(expression);
}

/** The text a text literal expression without `${...}` holds, else `null`. */
function textOf(expression: Expression): string | null {
  if (expression.kind !== "stringLiteral") return null;
  let text = "";
  for (const part of expression.parts) {
    if (part.kind !== "stringText") return null;
    text += part.value;
  }
  return text;
}

/** An expression the source parsed from code, read as the initializer of a `let`, with the offset its code starts at. */
function parsedExpression(
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

/**
 * A literal whose elements mix types (ADR 0021 rule 1.3), in the current checker's sentences (#1195, the owner's
 * review): its elements' own types; a nested collection's as its written type (`a list (integer[])`); objects by the
 * property that differs. The fix: a written union where the elements are scalars, declared on the variable whose start
 * value the literal is, else the type alone; one type for the property; values of one type in a nested collection,
 * whose union V30 §13 forbids (rule 3.4).
 */
function mixedSentence(
  rule: Extract<DiagnosticRule, { rule: "mixed" }>,
  kinds: readonly ItemTag[],
): string {
  const { collection, path } = rule;
  const holds = `A ${collection} holds one type.`;
  // the steps to the property that differs, and the collections below it
  const property = path.findLastIndex((step) => step !== "element" && step !== "entry");
  const below = path.slice(property + 1);
  const nested = (types: readonly ItemTag[]): string => {
    let written = typeText(types);
    for (const step of below.toReversed())
      written =
        written === null ? null : collectionText(step === "entry" ? "dict" : "list", written);
    const outer = below[0] === "entry" ? "dict" : "list";
    return below.length === 0 || written === null
      ? described(types)
      : `${VALUE_KINDS[outer].description} (${written})`;
  };
  if (property >= 0) {
    const name = path
      .slice(0, property + 1)
      .filter((step) => step !== "element" && step !== "entry")
      .map(propertyName)
      .join(".");
    return (
      `This ${collection} mixes objects whose property '${name}' holds ${nested(rule.type)} in one and ` +
      `${nested(kinds)} in another. ${holds} Give '${name}' one type in every ` +
      `${collection === "dict" ? "value" : "element"}.`
    );
  }
  const first = `This ${collection} mixes ${nested(rule.type)} and ${nested(kinds)}. ${holds}`;
  const both = path.length === 0 ? typeText([...rule.type, ...kinds]) : null;
  if (both === null) return `${first} Use values of one type in it.`;
  const written = collectionText(collection, both);
  const root = rule.root;
  return root !== null && (root.kind === "let" || root.kind === "global")
    ? `${first} To allow both, declare it as '${root.kind} ${root.name}: ${written} = ...'.`
    : `${first} To allow both, declare it as '${written}'.`;
}

/** The current checker's fixes of an operator on date and time values (`type-checker.ts`, `operation-checks.ts`). */
function temporalFix(
  rule: Extract<DiagnosticRule, { rule: "operator" }>,
  kinds: readonly ItemTag[],
  source: MessageSource,
): string {
  const [left, right] = rule.operands.map((site) => source.text(site));
  if (left === undefined || right === undefined) return "";
  const [a, b] = rule.operand ? [undefined, kinds[0]] : rule.pair;
  const { operator } = rule;
  const moves = operator === "+" || operator === "-";
  // (an example only where the value it converts is a variable or a path, and the other operand one or a literal)
  const named =
    stablePath(left) &&
    (stablePath(right) || LITERAL_OPERAND.has(expressionKind(right) ?? "identifier"));
  if (moves && a === "absoluteDateTime" && b === "calendarDuration")
    return named
      ? " An absolute date and time has no calendar. Convert it first, as in " +
          `'(${left}.toDateTime() ${operator} ${right}).toAbsoluteDateTime()'.`
      : " An absolute date and time has no calendar. Convert it with 'toDateTime()' first.";
  if (moves && a === "date" && b === "duration") {
    const amount = /^(\d+) ?(d|day|days|w|week|weeks)$/.exec(right);
    if (amount === null) return " A date moves only by calendar units, such as '1 calendar day'.";
    const unit = amount[2]!.startsWith("d") ? "day" : "week";
    return ` A date moves only by calendar units. Write '${amount[1]!} calendar ${unit}${amount[1] === "1" ? "" : "s"}'.`;
  }
  if (moves && a === "datetime" && b === "duration")
    return (
      " A date and time has no time zone, so it cannot move by elapsed time. " +
      (named
        ? `Convert it first, as in '(${left}.toAbsoluteDateTime() ${operator} ${right}).toDateTime()', `
        : "Convert it with 'toAbsoluteDateTime()' first, ") +
      "or use calendar units to keep the clock time."
    );
  if (operator === "-" && b === "datetime" && rule.domain.includes("calendarDuration"))
    return (
      " A date and time has no time zone, so one cannot be subtracted from another. Subtract their dates with " +
      (stablePath(left) && stablePath(right)
        ? `'toDate(${left}) - toDate(${right})'`
        : "'toDate(...)'") +
      ", or convert both with 'toAbsoluteDateTime()' for the elapsed time."
    );
  if (moves && b === "time")
    return " Arithmetic on a time is not available. Combine it with a date first, with 'toDateTime(...)'.";
  const compares = ["<", "<=", ">", ">="].includes(operator);
  if (compares && a === "date" && b === "datetime")
    return stablePath(right)
      ? ` A date compares only with another date. Compare its date, as in 'toDate(${right})'.`
      : " A date compares only with another date. Compare its date, with 'toDate(...)'.";
  if ((compares || operator === "/") && a !== undefined && b !== undefined) {
    const pair = new Set([a, b]);
    if (pair.has("calendarDuration") && pair.has("duration"))
      return ` A calendar day or month has no fixed length. ${compares ? "Compare" : "Divide"} two calendar durations, or two durations.`;
  }
  return "";
}

/**
 * The current checker's fix of '+' between a list or a set and a value that is not one (V30 §4): a set's union or copy
 * into a list, a range's numbers as a list, else the value in a list for a new one, or added to the list itself on a
 * line of its own (an `add` gives no list). A list holds one type, and the operation's types do not say the list's
 * elements', so an example that puts the value in the list holds where the list can hold it (Codex r1). Code replaces
 * the diagnosed site whole, the operation or the one operand it names (TABLE r4.146), and is given only where the list
 * is a stable path and the value code on one line; else the fix is in words. Each side's type: the operand's own at
 * `site` and the other's place (`domain`), or the operation's `pair`.
 */
function listJoinFix(
  rule: Extract<DiagnosticRule, { rule: "operator" }>,
  kinds: readonly ItemTag[],
  site: SourceSite,
  source: MessageSource,
): string {
  const [leftSite, rightSite] = rule.operands;
  if (rule.operator !== "+" || leftSite === undefined || rightSite === undefined) return "";
  const own = known(kinds);
  const atRight = rule.operand && rightSite.file === site.file && rightSite.start === site.start;
  const sides = !rule.operand
    ? rule.pair.map((kind) => [kind])
    : atRight
      ? [rule.domain, own]
      : [own, rule.domain];
  const [a, b] = sides.every((types) => types.length === 1) ? sides.map(([kind]) => kind) : [];
  if (a === undefined || b === undefined || sides.length !== 2) return "";
  if ((a === "set" || b === "set") && (a === "list" || b === "list" || a === b))
    return " Join sets with the union method, or copy a set into a list with the toList method first.";
  const listLeft = a === "list" && b !== "list";
  if (!listLeft && !(b === "list" && a !== "list" && a !== "string")) return "";
  // (an operand's diagnostic sits on the value beside the list, which the code replaces)
  if (rule.operand && atRight !== listLeft) return "";
  const [list, value] = listLeft
    ? [source.text(leftSite), source.text(rightSite)]
    : [source.text(rightSite), source.text(leftSite)];
  const range = (listLeft ? b : a) === "range";
  if (!stablePath(list) || !ownText(value))
    return range
      ? " To add the numbers of a range, convert the range with the toList method first."
      : listLeft
        ? " To add one element, put the element in brackets for a new list, or call the add method on a line of its own."
        : " Put the element in brackets for a new list.";
  // (the value's new code, and the code at the site: the operation with it, or that operand alone)
  const code = range
    ? POSTFIX.has(expressionKind(value) ?? "binaryExpression")
      ? `${value}.toList()`
      : `(${value}).toList()`
    : `[${value}]`;
  const written = rule.operand ? code : listLeft ? `${list} + ${code}` : `${code} + ${list}`;
  if (range)
    return ` If '${list}' can hold whole numbers, write '${written}' to add the numbers of the range.`;
  return (
    ` If '${list}' can hold '${value}', write '${written}' for a new list` +
    (listLeft
      ? `, or add it to '${list}' itself with '${list}.add(${value})' on a line of its own.`
      : ".")
  );
}

function errorSentence(
  rule: DiagnosticRule,
  text: string,
  kinds: readonly ItemTag[],
  source: MessageSource,
  site: SourceSite,
): string {
  switch (rule.rule) {
    case "store":
      // ADR 0021 rule 1.1: a property that reached the place only through copies, at its first direct read or store
      if (rule.brought !== null)
        return (
          `${storeSubject(rule, source)}, but '${source.text(rule.brought)}' on line ` +
          `${source.line(rule.brought)} brings ${described(kinds)} into that property. Use a separate property for a ` +
          "value of another type."
        );
      return `${storeSubject(rule, source)}, so it cannot ${elementOf(rule) === null ? "take" : "contain"} ${described(kinds)}.${storeFix(rule, kinds, text)}`;
    case "fallback": {
      // ADR 0021 rule 7.3: a written union of the place the value lands in directly holds both
      const both = typeText([...rule.type, ...kinds]);
      const declared =
        both === null || (rule.type.includes("integer") && kinds.includes("number"))
          ? null
          : declaration(rule.root, both, `'${rule.root?.name ?? ""}'`);
      return (
        `The ${rule.fallback ? "fallback" : "default"} '${text}' is ${described(kinds)}, but the value it stands ` +
        `in for is ${described(rule.type)}. Use null or a value of that type instead` +
        (declared === null ? "." : `, or to allow both, ${declared}.`)
      );
    }
    case "member": {
      const noun = memberNoun(rule.member);
      if (kinds.length > 0 && kinds.every((kind) => kind === "null"))
        return `'${rule.receiver}' is null here, so it has no ${noun}. Give '${rule.receiver}' a value first.`;
      if (kinds.includes("unknown"))
        return `'${rule.receiver}' has no ${noun}. Add it to the object first.`;
      return `${capitalized(described(kinds))} has no ${noun}, so '${text}' cannot be used.${memberFix(rule, kinds, text, true)}`;
    }
    case "absent": {
      // (the properties it has, as the current checker names them: a misspelt name's fix, ADR 0021 rule 1.4)
      const others = rule.properties.filter((name) => name !== rule.property);
      const listed =
        others.length === 0
          ? ""
          : ` ${others.length === 1 ? "Its only property is" : "Its properties are"} ${nameList(others)}.`;
      // (the nearest name, as the current checker suggests it)
      const hint = misspelledPropertyHint(rule.property, others);
      if (rule.store === null)
        return `'${rule.receiver}' has no property '${rule.property}'.${listed || ` Add '${rule.property}' to its object first.`}${hint}`;
      return (
        `This object has no property '${rule.property}', so '${source.text(rule.store)}' on line ` +
        `${source.line(rule.store)} cannot set '${rule.property}'.${listed}${hint} Add '${rule.property}' to this ` +
        "object."
      );
    }
    case "selection":
      return `'${rule.collection}' is empty here, so it has no element for '${rule.member}'.`;
    case "mixed":
      return mixedSentence(rule, kinds);
    case "operator": {
      const join = joined(rule, text, kinds, [], source);
      if (join !== null)
        return `'+' joins text only with other text, not with ${described(join.other)}. ${joinFix(join.operand)}`;
      const fix = temporalFix(rule, kinds, source) + listJoinFix(rule, kinds, site, source);
      return rule.operand
        ? `${operandRule(rule)}, but '${text}' is ${described(kinds)}.${fix}`
        : `'${rule.operator}' cannot combine ${kinds.map((kind) => described([kind])).join(" and ")}.${fix}`;
    }
    case "shown": {
      const kind = known(kinds).length === 1 ? known(kinds)[0] : undefined;
      if (kind === "dict" && !rule.element)
        return stablePath(text)
          ? interpolatedDictMessage(text)
          : "'${...}' cannot show a dict. Select one value with a key, or show every value with 'values.join()'.";
      return `'\${...}' cannot show ${described(kinds)}. ${shownFix(rule, text, kinds)}`;
    }
    case "count":
      return (
        `${operandRule(rule)}, but '${text}' is ${described(kinds)}.` +
        (kinds.includes("number") ? ROUND_COUNT_FIX : " Use a whole number here.")
      );
    case "boolean":
      return `${operandRule(rule)}, but '${text}' is ${described(kinds)}.${conditionFix(text, kinds)}`;
    case "key":
      return `${operandRule(rule)}, but '${text}' is ${described(kinds)}.${keyFix(text, kinds)}`;
    default:
      return `${operandRule(rule)}, but '${text}' is ${described(kinds)}.`;
  }
}

/**
 * A `+` of text and a value of another kind that `${...}` shows, where none of the operand's kinds fits (`fits`): the kinds
 * the text is joined with, else `null`. An operand that is text where its place takes another kind (`domain`) is joined
 * with that kind; an operand of another kind where its place takes text, with its own; the operation, with the kind of
 * its operand (`pair`) that is not text.
 */
function joined(
  rule: Extract<DiagnosticRule, { rule: "operator" }>,
  text: string,
  kinds: readonly ItemTag[],
  fits: readonly ItemTag[],
  source: MessageSource,
): { readonly other: Known[]; readonly operand: string | null } | null {
  if (rule.operator !== "+" || fits.length > 0 || rule.operands.length !== 2) return null;
  const texts = rule.operands.map((site) => source.text(site));
  // the combination the operation offends in, one kind per operand: the operand that is not text
  if (rule.pair.length === 2 && rule.pair.includes("string")) {
    const index = rule.pair.findIndex((kind) => kind !== "string");
    const kind = rule.pair[index];
    return index < 0 || kind === undefined || !SHOWN_KINDS.has(kind) || kind === "null"
      ? null
      : { other: known([kind]), operand: texts[index] ?? null };
  }
  const own = known(kinds);
  if (!rule.operand) return null;
  // (an operand whose combination is unknown: text where its place takes another kind, or the other way round)
  const other = own.includes("string")
    ? named(rule.domain).filter((kind) => kind !== "string")
    : rule.domain.includes("string")
      ? own
      : [];
  if (other.length === 0 || other.some((kind) => !SHOWN_KINDS.has(kind) || kind === "null"))
    return null;
  return {
    other,
    operand: own.includes("string") ? (texts.find((found) => found !== text) ?? null) : text,
  };
}

/**
 * The text-join fix (#1195): the operand that is not text, in `${...}` as the source writes it (the owner's review), on
 * one line and without a comment; else the sentence alone. The chain around it is never rebuilt: a rebuilt chain
 * changed what some chains say (S8d's reviews r3 and r4).
 */
function joinFix(operand: string | null): string {
  return operand === null || !ownText(operand)
    ? "Put the value in the text instead."
    : `Put the value in the text as '\${${operand}}' instead.`;
}

/** Whether a subject's own text may stand in a fix's code: on one line, and without a comment. */
function ownText(code: string): boolean {
  return !/[\n\r]|\/\/|\/\*/.test(code);
}

/** The kinds `${...}` shows as text. */
const SHOWN_KINDS: ReadonlySet<ItemTag> = new Set([
  "integer",
  "number",
  "boolean",
  "null",
  "duration",
  "calendarDuration",
  "angle",
  "date",
  "time",
  "datetime",
  "absoluteDateTime",
]);

/** The consequence of a warning's check failing, after the warning's first sentence. */
const STOPS = "the Tease stops with an error at this line.";

function warningSentence(
  rule: DiagnosticRule,
  text: string,
  kinds: readonly ItemTag[],
  source: MessageSource,
  context: ContextWord,
  detail: ContextDetail,
): string {
  const may = `may be ${described(kinds)} here. If it is, ${STOPS}`;
  switch (rule.rule) {
    case "store":
      return `${storeSubject(rule, source, context === "later")}, but '${text}' ${may}`;
    case "fallback":
      return (
        `The ${rule.fallback ? "fallback" : "default"} '${text}' stands in for ${described(rule.type)}, but ` +
        `'${text}' ${may}`
      );
    case "member": {
      const noun = memberNoun(rule.member);
      if (kinds.includes("null")) return `'${rule.receiver}' may be null here. If it is, ${STOPS}`;
      if (kinds.length > 0 && kinds.every((kind) => kind !== "unknown" && !REFERENCE.has(kind)))
        return `'${rule.receiver}' may be ${described(kinds)} here, which has no ${noun}. If it is, ${STOPS}`;
      if (context === "missing")
        return `'${rule.receiver}' may hold an object without ${noun} here. If it does, ${STOPS}`;
      // (only a property is set by a store: a method is called, an element stored at its index)
      const settable = setsProperty(rule);
      // a property store into a speaker gives it the property when the script runs; one into an object without it stops
      const holder = detail.receiver?.kinds ?? kinds;
      if (settable && (kinds.includes("speaker") || holder.includes("speaker")))
        return holder.every((kind) => kind === "speaker")
          ? `'${rule.receiver}' may not have ${noun} here. A speaker takes the property when the script runs.`
          : `'${rule.receiver}' may not have ${noun} here. If it is an object without '${rule.member.slice(1)}', ` +
              `${STOPS} A speaker takes the property.`;
      return `'${rule.receiver}' may not have ${noun}${settable ? " that can be set" : ""} here. If it does not, ${STOPS}`;
    }
    case "selection":
      return `'${rule.collection}' may be empty here. If it is, ${STOPS}`;
    case "operator":
      return rule.operand
        ? `${operandRule(rule)}, but '${text}' ${may}`
        : `'${rule.operator}' may not take the values in '${text}' here. If it does not, ${STOPS}`;
    case "absent":
    case "mixed":
      throw new Error(`The rule '${rule.rule}' gives errors only.`);
    default:
      return `${operandRule(rule)}, but '${text}' ${may}`;
  }
}

/**
 * The fallback a null check names beside it (ADR 0021 rule 1.9, owner decision on #850), of the kinds the value has
 * besides null: `0` for numbers, `""` for text, `false` for true or false, `...` for any other value; none for a handle,
 * which has no value to write.
 */
function fallbackValue(kinds: readonly ItemTag[]): string | null {
  const found = known(kinds).filter((kind) => kind !== "null");
  if (found.some((kind) => hasIdentity(kind))) return null;
  const every = (...names: ItemTag[]): boolean =>
    found.length > 0 && found.every((kind) => names.includes(kind));
  return every("integer", "number")
    ? "0"
    : every("string")
      ? '""'
      : every("boolean")
        ? "false"
        : "...";
}

/**
 * The check that makes a use safe (ADR 0021 rules 1.9 and 3.5): of a variable directly, of any other value kept in a
 * variable first, since only a variable narrows (rule 5); for null with a fallback where it has one.
 */
function checkFix(text: string, test: string, fallback: string | null, operand = false): string {
  const name = variable(text);
  // (a value kept in a variable shows its `let`, where its own text may stand in code)
  const check =
    name !== null
      ? `Check '${name}' first, as in 'if ${name} ${test} { ... }'`
      : ownText(text)
        ? `Keep '${text}' in a new variable, as in 'let value = ${text}', and check it, as in 'if value ${test} { ... }'`
        : `Keep '${text}' in a new variable and check the variable first, as in 'if value ${test} { ... }'`;
  if (fallback === null || !ownText(text)) return `${check}.`;
  // (an operand of an operator takes a fallback in parentheses, as the parser asks of `otherwise`)
  const code = `${operandText(text)} otherwise ${fallback}`;
  return `${check}, or give a fallback, as in '${operand ? `(${code})` : code}'.`;
}

/** The literals an example may write beside a named value as the source writes them. */
const LITERAL_OPERAND: ReadonlySet<Expression["kind"]> = new Set([
  "numberLiteral",
  "durationLiteral",
  "unitExpression",
  "angleExpression",
  "booleanLiteral",
]);

/** The kinds a rule takes, where a value's own kinds that fit are not known (an unknown value). */
function ruleKinds(rule: DiagnosticRule): readonly ItemTag[] {
  switch (rule.rule) {
    case "count":
      return ["integer"];
    case "boolean":
      return ["boolean"];
    case "key":
      return ["string"];
    case "store":
    case "fallback":
      return rule.type.filter((kind) => kind !== "null");
    case "operator":
      return rule.domain;
    default:
      return [];
  }
}

/**
 * A warning's fix: a null check for null, the count's rounding for a number (S8c's), the selection's length check; a
 * type test where the value has other kinds that fit or is unknown; else the fix of the error the kind would be.
 */
function warningFix(
  rule: DiagnosticRule,
  text: string,
  kinds: readonly ItemTag[],
  fits: readonly ItemTag[],
  detail: ContextDetail,
  context: ContextWord,
  source: MessageSource,
): string {
  const subject = rule.rule === "member" ? rule.receiver : text;
  if (kinds.includes("null")) {
    // (no fallback for a value a store or a method changes in place: the change would be lost)
    const changed =
      rule.rule === "member" &&
      (rule.use === "store" ||
        (rule.use === "call" &&
          (listMethod(rule.member.slice(1, -2))?.changes !== undefined ||
            dictMethod(rule.member.slice(1, -2))?.changes !== undefined)));
    const fallback = changed ? null : fallbackValue(fits.length > 0 ? fits : ruleKinds(rule));
    return checkFix(
      subject,
      "!= null",
      fallback,
      rule.rule === "operator" || (rule.rule === "boolean" && rule.operator !== null),
    );
  }
  switch (rule.rule) {
    case "selection": {
      // (a check of the collection itself only where reading it again gives the same one; any other is kept first, as
      // `groups.random` or a call, so the check and the read see one selection, Astra r2)
      const { collection } = rule;
      if (stablePath(collection))
        return `Check '${collection}.length' first, as in 'if ${collection}.length > 0 { ... }'.`;
      return ownText(collection)
        ? `Keep '${collection}' in a new variable, as in 'let value = ${collection}', and check its length, as in ` +
            "'if value.length > 0 { ... }'."
        : `Keep '${collection}' in a new variable and check its length first.`;
    }
    case "count":
      if (kinds.includes("number")) return ROUND_COUNT_FIX.trimStart();
      break;
    case "store":
      if (rule.type.includes("integer") && kinds.includes("number"))
        return storeFix(rule, kinds, text).trimStart();
      break;
    case "operator": {
      // (the repairs of the error the values would be: a text join, a date and time conversion)
      const join = joined(rule, text, kinds, fits, source);
      if (join !== null) return joinFix(join.operand);
      const temporal = temporalFix(rule, kinds, source).trimStart();
      if (temporal !== "" || !rule.operand) return temporal;
      break;
    }
    case "member":
      return memberWarningFix(rule, text, kinds, fits, detail);
    default:
      break;
  }
  // (a value of a type the script cannot know: tested where a test can name the type; a literal is known, and a
  // property an object may lack fails at its read, before any test)
  if (kinds.includes("unknown") && fits.length === 0) {
    const test = typeText(ruleKinds(rule));
    return test === null || isLiteral(text) || context === "missing"
      ? ""
      : checkFix(subject, `is ${test}`, null);
  }
  // (no test where the read itself stops, a property an object may lack, nor of a literal, whose type is its own)
  if (isLiteral(text) || context === "missing") return "";
  const test = typeText(fits);
  if (test !== null) return checkFix(subject, `is ${test}`, null);
  return errorFix(rule, text, kinds).trimStart();
}

/** The fix of the error a value of `kinds` would be, for a warning whose value has no kind that fits. */
function errorFix(rule: DiagnosticRule, text: string, kinds: readonly ItemTag[]): string {
  switch (rule.rule) {
    case "store":
      return storeFix(rule, kinds, text);
    case "boolean":
      return conditionFix(text, kinds);
    case "key":
      return keyFix(text, kinds);
    default:
      return "";
  }
}

/**
 * A member warning's fix: a type test for a receiver of another kind beside kinds that have the member, the member's
 * own fix where none has it; for a speaker's property the current checker's: assign it, or copy the player profile.
 */
function memberWarningFix(
  rule: Extract<DiagnosticRule, { rule: "member" }>,
  text: string,
  kinds: readonly ItemTag[],
  fits: readonly ItemTag[],
  detail: ContextDetail,
): string {
  // (the warning's own reference kind: one warning per reference kind of a union)
  const speaker =
    (kinds.find((kind) => REFERENCE.has(kind)) ??
      detail.receiver?.kinds.find((kind) => REFERENCE.has(kind))) === "speaker";
  if (speaker && rule.member.startsWith(".")) {
    const name = rule.member.slice(1);
    if (rule.member.endsWith("()"))
      return `A speaker has no methods. Use one of its properties instead, such as '${stablePath(rule.receiver) ? `${rule.receiver}.` : ""}title'.`;
    if (rule.use !== "read") return "";
    return rule.receiver === PLAYER && PERSON_FIELDS.has(name)
      ? "Copy the player profile before this line, as in 'player.copyFrom(playerProfile)' at the start of the " +
          `script, or assign 'player.${name}' first.`
      : stablePath(rule.receiver)
        ? `Assign the property before this line, as in '${rule.receiver}.${name} = ...'.`
        : "Assign the property before this line.";
  }
  // (a reference's own members are the runtime's: no test narrows them)
  const lacking = known(kinds);
  if (lacking.length === 0 || lacking.some((kind) => REFERENCE.has(kind))) return "";
  const test = typeText(fits.filter((kind) => !kinds.includes(kind)));
  return test !== null
    ? checkFix(rule.receiver, `is ${test}`, null)
    : memberFix(rule, kinds, text, false).trimStart();
}

/** A place the stop names, with its lines: `'tally' (lines 3–9)`, `the top level of 'main.tease' (lines 1–40)`. */
function placeText(place: WorkPlace, source: MessageSource): string {
  const first = source.line(place.lines);
  const last = source.line({
    ...place.lines,
    start: Math.max(place.lines.start, place.lines.end - 1),
  });
  const lines = first === last ? `line ${first}` : `lines ${first}–${last}`;
  return `${place.name === null ? `the top level of '${place.path}'` : `'${place.name}'`} (${lines})`;
}

/**
 * The stop's warning and its "not checked (budget)" mark (the owner's D4, TABLE r4.54: the warning as the owner's
 * example words it; the nesting limit's in the same form).
 */
function budgetMessage(diagnostic: BudgetStop | NotChecked, source: MessageSource): string {
  const place = placeText(diagnostic.place, source);
  if (diagnostic.class === "not-checked-budget")
    return `${capitalized(place)} is not checked completely before the script plays, so its checks run while it plays.`;
  const count = diagnostic.deferred;
  const moved =
    count === 0
      ? ""
      : ` ${count} ${count === 1 ? "check runs" : "checks run"} while it plays instead.`;
  return diagnostic.limit === "nesting"
    ? `This script nests statements too deeply to check completely before it plays.${moved} The deepest nesting is ` +
        `in ${place}.`
    : `This script is too large to check completely before it plays.${moved} Most of the work went to ${place}.`;
}

/** V30 §13: a union that holds a whole collection beside another type, with V30's suggestion where it has one. */
function writtenTypeMessage(error: WrittenTypeError, source: MessageSource): string {
  return (
    `A union cannot hold a whole list, set, or dict beside another type, but '${source.text(error.union)}' does. ` +
    (error.suggestion === null
      ? "Write the union inside the collection instead."
      : `Write '${error.suggestion}' instead.`)
  );
}

// ------------------------------------------------------------------------------------------- causes

const HANDLER_RUNS: Readonly<Record<NonNullable<ContextDetail["handler"]>, string>> = {
  button: "the button is pressed",
  timer: "its timer expires",
  media: "its media ends or reaches its cue",
};

/**
 * The cause of a warning whose word came with its value from another line (a copy, a projection, a call, an
 * operation): where that value comes from, by the word, never naming this line's read as the word's own subject.
 */
function originSentence(word: ContextWord, name: string): string {
  const from = `'${name}' gets its value from`;
  switch (word) {
    case "label":
      return `${from} a line that is also reached by a 'goto'.`;
    case "later":
    case "unknown":
      return `'${name}' comes from outside the script, so its type is known only when the script runs.`;
    case "missing":
      return `${from} a property that an object may lack.`;
    case "branch":
      return `${from} an 'if' or another branch, so which value it gets depends on which branch runs.`;
    case "call":
      return `${from} a place that a function or a file the script calls may change.`;
    case "dead-code":
      return `${from} a line that never runs.`;
    case "deferred-parameter":
      return `${from} a parameter of a function called from more than one place.`;
    case "handler":
      return `${from} a place that a button, timer, or media block may change.`;
    case "loop":
      return `${from} a variable that may change in an earlier round of a loop.`;
    case "member":
      return `${from} a list element or a part of another value.`;
    // (the word also covers an object's own `first` and opaque operations: no reference is established)
    case "unmodelled":
      return `The type of '${name}' is known only when the script runs.`;
    case "budget":
      return `Checking '${name}' here before the script plays would take too long, so it is checked when the script runs.`;
  }
}

/** A warning's cause: why the value may be of another type at this line (§3.4), its word the read's own. */
function contextSentence(
  word: ContextWord,
  name: string,
  detail: ContextDetail,
  kinds: readonly ItemTag[],
): string {
  switch (word) {
    case "label":
      return detail.label === null
        ? `This line is also reached by a 'goto', and '${name}' may change before that jump.`
        : `This line is also reached by 'goto ${detail.label}', and '${name}' may change before that jump.`;
    case "later":
      return "";
    case "missing":
      return detail.receiver === null
        ? `'${name}' may come from an object that has no such property.`
        : `'${detail.receiver.text}' may hold an object that has no '${detail.receiver.member}' property.`;
    case "branch":
      return (
        `'${name}' is set inside an 'if' or another branch, so which value reaches this line depends on which ` +
        "branch runs."
      );
    case "call":
      return detail.callable === null
        ? `'${name}' may be changed by a function or a file the script calls before this line.`
        : `'${name}' is set outside '${detail.callable}', before '${detail.callable}' is called.`;
    case "dead-code":
      return "This line never runs.";
    case "deferred-parameter":
      return detail.callable === null
        ? `'${name}' is a parameter of a function called from more than one place.`
        : `'${detail.callable}' is called from more than one place, so '${name}' may hold another type in each ` +
            "call.";
    case "handler":
      return detail.handler === null
        ? `A button, timer, or media block may run before this line and change '${name}'.`
        : `This block runs when ${HANDLER_RUNS[detail.handler]}, and '${name}' may change inside it before this ` +
            "line.";
    case "loop":
      return `'${name}' may change in an earlier round of this loop.`;
    case "member": {
      const container = detail.receiver?.kinds.find(
        (kind) => kind === "list" || kind === "set" || kind === "dict",
      );
      if (container === undefined) return "";
      // (a selection's collection: an element that may be empty)
      const may = kinds.includes("empty") ? "empty" : described(kinds);
      return container === "dict"
        ? `'${name}' is a dict value, and any value of the dict may be ${may}.`
        : `'${name}' is a ${container} element, and any element of the ${container} may be ${may}.`;
    }
    case "unknown":
      return `'${name}' comes from outside the script, so its type is known only when the script runs.`;
    case "budget":
      return `Checking '${name}' here before the script plays would take too long, so it is checked when the script runs.`;
    case "unmodelled": {
      // (the warning's own kind where it is a reference: one warning per reference kind of a union)
      const reference =
        kinds.find((kind) => REFERENCE.has(kind)) ??
        detail.receiver?.kinds.find((kind) => REFERENCE.has(kind));
      return reference === undefined || detail.receiver === null
        ? `The type of '${name}' is known only when the script runs.`
        : // (one reference type of several the receiver may hold: it may be that one)
          `'${detail.receiver.text}' ${detail.receiver.kinds.every((kind) => kind === reference) ? "is" : "may be"} ` +
            `${described([reference])}, whose properties are known only when the script runs.`;
    }
  }
}
