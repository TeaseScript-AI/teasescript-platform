import type { Expression } from "../../ast.js";
import { parse } from "../../parser.js";
import type { SourceSite } from "../graph.js";
import { dictMethod } from "../../dict-operations.js";
import { elapsedDurationUnit } from "../../duration.js";
import { listMethod } from "../../list-methods.js";
import { FOR_SOURCE_RULE, REPEAT_COUNT_RULE, ROUND_COUNT_FIX } from "../../loop-rules.js";
import { LIST_INDEX_RULE, logicalOperandRule } from "../../operand-rules.js";
import { misspelledPropertyHint, nameList } from "../../object-properties.js";
import { interpolatedDictMessage } from "../../shown-text-rules.js";
import { PERSON_FIELDS, PLAYER } from "../../speaker-terms.js";
import { CALENDAR_DURATION_PARTS, hasTemporalField } from "../../temporal-builtins.js";
import { isTextMember } from "../../text-operations.js";
import { hasIdentity, VALUE_KINDS } from "../../value-kinds.js";
import { REFERENCE } from "./contract.js";
import { propertyName } from "./program.js";
import type { ContextWord, ItemTag } from "./items.js";
import type {
  ContextDetail,
  CoreCode,
  CoreDiagnostic,
  DiagnosticRule,
  StoreRoot,
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

/** How a message names the source: the text at a site, and the line it starts on (1-based). */
export interface MessageSource {
  readonly text: (site: SourceSite) => string;
  readonly line: (site: SourceSite) => number;
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
  return {
    text: (site) => (sources[site.file] ?? "").slice(site.start, site.end),
    line: (site) => {
      // the last line start at or before the site, by binary search
      const lines = linesOf(site.file);
      let low = 0;
      let high = lines.length;
      while (high - low > 1) {
        const middle = (low + high) >> 1;
        if (lines[middle]! <= site.start) low = middle;
        else high = middle;
      }
      return low + 1;
    },
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
  const text = source.text(diagnostic.site);
  const { rule, kinds } = diagnostic;
  if (diagnostic.class === "compile-error") return errorSentence(rule, text, kinds, source);
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
  const missing = rule.rule === "member" && context === "missing";
  // (a store into a speaker alone: the first sentence says what happens, which no cause changes)
  const holder = detail.receiver?.kinds ?? kinds;
  const speaker =
    rule.rule === "member" &&
    rule.use === "store" &&
    holder.length > 0 &&
    holder.every((kind) => kind === "speaker");
  if (!(context === "unknown" && !detail.outside) && context !== "later" && !missing && !speaker)
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
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(text) ? text : null;
}

/** Whether a text is a variable or a property path, as the current checker's fixes name a value. */
function path(text: string): boolean {
  return /^[\p{L}_][\p{L}\p{N}_]*(\.[\p{L}_][\p{L}\p{N}_]*)*$/u.test(text);
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

/** Code as the receiver of a member a fix writes after it: in parentheses unless it binds tighter (`t`, `f(x)`). */
function receiverText(code: string): string {
  const kind = expressionKind(code);
  return kind !== null && POSTFIX.has(kind) ? code : `(${code})`;
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
 * number; showing a number or a truth value as text; for null a nullable type, else a written union (ADR 0021 rule
 * 1.1), where the place is a variable, a parameter, or an element or dict value of one; else a separate property or
 * collection for a property's or an element's values, or a separate variable.
 */
function storeFix(rule: StoreRule, kinds: readonly ItemTag[], text: string): string {
  if (rule.type.includes("integer") && kinds.includes("number")) return ROUND_COUNT_FIX;
  const values = known(kinds);
  const place = known(rule.type).filter((kind) => kind !== "null");
  if (
    place.length === 1 &&
    place[0] === "string" &&
    rule.steps.length === 0 &&
    values.length > 0 &&
    values.every((kind) => kind === "integer" || kind === "number" || kind === "boolean")
  )
    return ` To show it as text, write '"\${${text}}"'.`;
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

/** A member's fix where its receiver's kind has no such member (the current checker's, `operation-checks.ts`). */
function memberFix(
  rule: Extract<DiagnosticRule, { rule: "member" }>,
  kinds: readonly ItemTag[],
): string {
  const kind = known(kinds).find((found) => found !== "null");
  if (kind === undefined || !rule.member.startsWith(".")) return "";
  const method = rule.member.endsWith("()");
  const name = method ? rule.member.slice(1, -2) : rule.member.slice(1);
  const receiver = rule.receiver;
  if (kind === "string" && rule.use === "store")
    return ` Assign a new text to '${receiver}' instead.`;
  if (!method && kind === "absoluteDateTime" && hasTemporalField("datetime", name))
    return ` Convert '${receiver}' first, as in '${receiverText(receiver)}.toDateTime().${name}'.`;
  if (kind !== "string" && VALUE_KINDS[kind].type === "scalar" && isTextMember(name))
    return ` Convert '${receiver}' to text first, as in 'toString(${receiver})${method ? `.${name}(...)` : `.${name}`}'.`;
  if (!method && kind === "duration") {
    const unit = elapsedDurationUnit(name);
    if (unit !== undefined) {
      const single = name.length > 2 && name.endsWith("s") ? name.slice(0, -1) : name;
      return ` Divide '${receiver}' by a unit, as in '${operandText(receiver)} / 1 ${single}'.`;
    }
  }
  if (!method && kind === "calendarDuration")
    return ` Use ${either(Object.keys(CALENDAR_DURATION_PARTS).map((part) => `'${part}'`))}.`;
  if (method && kind === "set" && listMethod(name)?.notOnSet !== undefined)
    return name === "get"
      ? " Use 'contains(...)' instead."
      : ` Copy '${receiver}' into a list with '${receiverText(receiver)}.toList()' first.`;
  if (!method && kind === "list" && rule.use === "read")
    return " Use 'length', 'first', 'last', or 'random'.";
  return "";
}

/** The fix of a value that is not true or false where a condition needs one (#1195's decided text). */
function conditionFix(text: string, kinds: readonly ItemTag[]): string {
  if (!path(text)) return "";
  const kind = known(kinds)[0];
  if (kind === "integer" || kind === "number") return ` Compare it instead, as in '${text} > 0'.`;
  if (kind === "string") return ` Compare it instead, as in '${text} != ""'.`;
  if (kind === "list" || kind === "set" || kind === "dict")
    return ` Check its length instead, as in '${text}.length > 0'.`;
  return "";
}

/** The fix of a key that is not text: a number written as text, as the current checker gives it (`dict-operations.ts`). */
function keyFix(text: string, kinds: readonly ItemTag[]): string {
  if (!kinds.some((kind) => kind === "integer" || kind === "number")) return "";
  const written = /^\d+(\.\d+)?$/.test(text) ? text : `\${${text}}`;
  return ` Write a number key as text, as in '"${written}"'.`;
}

/** How `${...}` shows a value of each kind it cannot show, where one has a fix (#1195's decided texts). */
function shownFix(
  rule: Extract<DiagnosticRule, { rule: "shown" }>,
  text: string,
  kinds: readonly ItemTag[],
): string {
  const kind = known(kinds).length === 1 ? known(kinds)[0] : undefined;
  const label = path(text) ? text : null;
  if (kind === "object")
    return rule.property === null || label === null
      ? "Show one of its properties instead."
      : `Show one of its properties instead, as in '\${${label}.${rule.property}}'.`;
  if (kind === "set")
    return `Show all its elements with '\${${label ?? "value"}.toList().join()}'.`;
  return SHOWN_RULE;
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

/** Whether an expression is a variable or a property path below one (`box.n`). */
function variablePath(expression: Expression): boolean {
  return (
    expression.kind === "identifier" ||
    (expression.kind === "propertyAccessExpression" && variablePath(expression.object))
  );
}

/** Whether an expression is a simple piece of a text-join example: a variable or property path, a number, true or false. */
function simplePiece(expression: Expression): boolean {
  return (
    variablePath(expression) ||
    expression.kind === "numberLiteral" ||
    expression.kind === "booleanLiteral"
  );
}

/**
 * The text a chain of `+` writes instead, as in `"You have ${score} points"` (#1195's decided text): only for a chain on
 * one line, without parentheses, whose pieces are all simple (`simplePiece`) or one-line text without `${...}`, each
 * text written as it is and every other piece in `${...}`; `null` for any other, which takes the fix without an example.
 * No operand of the chain is opened: a sum in parentheses is one piece, and not a simple one.
 */
function joinedText(code: string): string | null {
  if (code.includes("\n")) return null;
  const parsed = parsedExpression(code);
  if (parsed === null) return null;
  const pieces: Expression[] = [];
  let at = parsed.expression;
  while (at.kind === "binaryExpression" && at.operator === "+") {
    pieces.push(at.right);
    at = at.left;
  }
  pieces.push(at);
  let text = "";
  for (const piece of pieces.reverse()) {
    if (
      piece.kind === "stringLiteral" &&
      piece.form === "singleLine" &&
      piece.parts.every((part) => part.kind === "stringText")
    )
      text += piece.parts.map((part) => (part.kind === "stringText" ? part.raw : "")).join("");
    else if (simplePiece(piece))
      text += `\${${code.slice(piece.span.start.offset - parsed.at, piece.span.end.offset - parsed.at)}}`;
    else return null;
  }
  return pieces.length < 2 ? null : `"${text}"`;
}

/** The current checker's fixes of an operator on date and time values (`type-checker.ts`, `operation-checks.ts`). */
function temporalFix(
  rule: Extract<DiagnosticRule, { rule: "operator" }>,
  text: string,
  kinds: readonly ItemTag[],
  source: MessageSource,
): string {
  const [left, right] = rule.operands.map((site) => source.text(site));
  if (left === undefined || right === undefined) return "";
  const [a, b] = rule.operand ? [undefined, kinds[0]] : rule.pair;
  const { operator } = rule;
  const moves = operator === "+" || operator === "-";
  if (moves && a === "absoluteDateTime" && b === "calendarDuration")
    return (
      " An absolute date and time has no calendar. Convert it first, as in " +
      `'(${receiverText(left)}.toDateTime() ${operator} ${operandText(right)}).toAbsoluteDateTime()'.`
    );
  if (moves && a === "date" && b === "duration") {
    const amount = /^(\d+) ?(d|day|days|w|week|weeks)$/.exec(right);
    if (amount === null) return " A date moves only by calendar units, such as '1 calendar day'.";
    const unit = amount[2]!.startsWith("d") ? "day" : "week";
    return ` A date moves only by calendar units. Write '${amount[1]!} calendar ${unit}${amount[1] === "1" ? "" : "s"}'.`;
  }
  if (moves && a === "datetime" && b === "duration")
    return (
      " A date and time has no time zone, so it cannot move by elapsed time. Convert it first, as in " +
      `'(${receiverText(left)}.toAbsoluteDateTime() ${operator} ${operandText(right)}).toDateTime()', or use calendar ` +
      "units to keep the clock time."
    );
  if (operator === "-" && b === "datetime" && rule.domain.includes("calendarDuration"))
    return (
      " A date and time has no time zone, so one cannot be subtracted from another. Subtract their dates with " +
      `'toDate(${left}) - toDate(${right})', or convert both with 'toAbsoluteDateTime()' for the elapsed time.`
    );
  if (moves && b === "time")
    return ` Arithmetic on a time is not available. Combine it with a date first, as in 'toDateTime(date, ${rule.operand ? text : right})'.`;
  const compares = ["<", "<=", ">", ">="].includes(operator);
  if (compares && a === "date" && b === "datetime")
    return ` A date compares only with another date. Compare its date, as in 'toDate(${right})'.`;
  if ((compares || operator === "/") && a !== undefined && b !== undefined) {
    const pair = new Set([a, b]);
    if (pair.has("calendarDuration") && pair.has("duration"))
      return ` A calendar day or month has no fixed length. ${compares ? "Compare" : "Divide"} two calendar durations, or two durations.`;
  }
  return "";
}

function errorSentence(
  rule: DiagnosticRule,
  text: string,
  kinds: readonly ItemTag[],
  source: MessageSource,
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
      return `${capitalized(described(kinds))} has no ${noun}, so '${text}' cannot be used.${memberFix(rule, kinds)}`;
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
    case "mixed": {
      // (where in its elements, as the path below them goes)
      const where =
        rule.path.length === 0
          ? ""
          : ` in ${pathPhrase({ words: rule.collection === "dict" ? "its values" : "its elements" }, rule.path)}`;
      const last = rule.path.at(-1);
      const both = typeText([...rule.type, ...kinds]);
      const fix =
        last !== undefined && last !== "element" && last !== "entry"
          ? `Give '${propertyName(last)}' one type in every ${rule.collection === "dict" ? "value" : "element"}.`
          : rule.path.length === 0 && both !== null
            ? `To keep both, declare a union type, as in '${collectionText(rule.collection, both)}'.`
            : `Use values of one type in it.`;
      return (
        `This ${rule.collection} mixes ${described(rule.type)} and ${described(kinds)}${where}. A ` +
        `${rule.collection} holds one type. ${fix}`
      );
    }
    case "operator": {
      const other = joined(rule, kinds, []);
      if (other !== null)
        return `'+' joins text only with other text, not with ${described(other)}. ${joinRepair(rule, source)}`;
      return rule.operand
        ? `${operandRule(rule)}, but '${text}' is ${described(kinds)}.${temporalFix(rule, text, kinds, source)}`
        : `'${rule.operator}' cannot combine ${kinds.map((kind) => described([kind])).join(" and ")}.` +
            temporalFix(rule, text, kinds, source);
    }
    case "shown": {
      const kind = known(kinds).length === 1 ? known(kinds)[0] : undefined;
      if (kind === "dict" && !rule.element)
        return interpolatedDictMessage(path(text) ? text : null);
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
  kinds: readonly ItemTag[],
  fits: readonly ItemTag[],
): Known[] | null {
  if (rule.operator !== "+" || fits.length > 0 || rule.operands.length !== 2) return null;
  const own = known(rule.operand ? kinds : rule.pair);
  const other = !rule.operand
    ? own.includes("string")
      ? own.filter((kind) => kind !== "string")
      : []
    : own.includes("string")
      ? named(rule.domain).filter((kind) => kind !== "string")
      : rule.domain.includes("string")
        ? own
        : [];
  return other.length === 0 || other.some((kind) => !SHOWN_KINDS.has(kind)) ? null : other;
}

/** The text-join fix (#1195's decided text): the chain's operands as one text. */
function joinRepair(
  rule: Extract<DiagnosticRule, { rule: "operator" }>,
  source: MessageSource,
): string {
  // (the chain's example in its first diagnostic only, `Consumers.#settleChains`)
  const example = rule.chain === null ? null : joinedText(source.text(rule.chain));
  return example === null
    ? "Put the value in the text instead."
    : `Put the value in the text instead, as in '${example}'.`;
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
      // a store into a speaker gives it the property when the script runs; one into an object without it stops
      const holder = detail.receiver?.kinds ?? kinds;
      if (rule.use === "store" && (kinds.includes("speaker") || holder.includes("speaker")))
        return holder.every((kind) => kind === "speaker")
          ? `'${rule.receiver}' may have no ${noun} here. A speaker takes the property when the script runs.`
          : `'${rule.receiver}' may have no ${noun} here. If it is an object without '${rule.member.slice(1)}', ` +
              `${STOPS} A speaker takes the property.`;
      return (
        `'${rule.receiver}' may have no ${noun}${rule.use === "store" ? " that can be set" : ""} here. If it has ` +
        `none, ${STOPS}`
      );
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
  const check =
    name === null
      ? `Keep '${text}' in a variable and check the variable first, as in 'if value ${test} { ... }'`
      : `Check '${name}' first, as in 'if ${name} ${test} { ... }'`;
  if (fallback === null) return `${check}.`;
  // (an operand of an operator takes a fallback in parentheses, as the parser asks of `otherwise`)
  const code = `${operandText(text)} otherwise ${fallback}`;
  return `${check}, or give a fallback, as in '${operand ? `(${code})` : code}'.`;
}

/** A literal's text: a number, text or `true`/`false`. */
const LITERAL = /^(-?\d[\d.]*|"[^"]*"|true|false)$/;

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
    case "selection":
      return `Check '${rule.collection}.length' first.`;
    case "count":
      if (kinds.includes("number")) return ROUND_COUNT_FIX.trimStart();
      break;
    case "store":
      if (rule.type.includes("integer") && kinds.includes("number"))
        return storeFix(rule, kinds, text).trimStart();
      break;
    case "operator": {
      // (the repairs of the error the values would be: a text join, a date and time conversion)
      if (joined(rule, kinds, fits) !== null) return joinRepair(rule, source);
      const temporal = temporalFix(rule, text, kinds, source).trimStart();
      if (temporal !== "" || !rule.operand) return temporal;
      break;
    }
    case "member":
      return memberWarningFix(rule, kinds, fits, detail);
    default:
      break;
  }
  // (a value of a type the script cannot know: tested where a test can name the type; a literal is known, and a
  // property an object may lack fails at its read, before any test)
  if (kinds.includes("unknown") && fits.length === 0) {
    const test = typeText(ruleKinds(rule));
    return test === null || LITERAL.test(text) || context === "missing"
      ? ""
      : checkFix(subject, `is ${test}`, null);
  }
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
      return `A speaker has no methods. Use one of its properties instead, such as '${rule.receiver}.title'.`;
    if (rule.use !== "read") return "";
    return rule.receiver === PLAYER && PERSON_FIELDS.has(name)
      ? "Copy the player profile before this line, as in 'player.copyFrom(playerProfile)' at the start of the " +
          `script, or assign 'player.${name}' first.`
      : `Assign the property before this line, as in '${rule.receiver}.${name} = ...'.`;
  }
  // (a reference's own members are the runtime's: no test narrows them)
  const lacking = known(kinds);
  if (lacking.length === 0 || lacking.some((kind) => REFERENCE.has(kind))) return "";
  const test = typeText(fits.filter((kind) => !kinds.includes(kind)));
  return test !== null
    ? checkFix(rule.receiver, `is ${test}`, null)
    : memberFix(rule, kinds).trimStart();
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
      return `${from} an 'if' or another branch, so which value it gets depends on the choice.`;
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
        `'${name}' is set inside an 'if' or another branch, so which value reaches this line depends on the ` +
        "choice."
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
