import type { Expression } from "../../../ast.js";
import type { SourceSite } from "../../graph.js";
import { angleUnit } from "../../../angle.js";
import { choiceValueFix } from "../../../choice-values.js";
import { unwritableJsonMessage, WRITABLE_JSON_FIX } from "../../../conversions.js";
import { DICT_METHODS, DICT_PROPERTIES } from "../../../dict-operations.js";
import { elapsedDurationUnit } from "../../../duration.js";
import { listMethod } from "../../../list-methods.js";
import { ROUND_COUNT_FIX } from "../../../loop-rules.js";
import { misspelledPropertyHint, nameList } from "../../../object-properties.js";
import { JOIN_FIX } from "../../../shown-text-rules.js";
import {
  CALENDAR_DURATION_PARTS,
  hasTemporalField,
  TEMPORAL_FIELDS,
} from "../../../temporal-builtins.js";
import {
  isTextMember,
  isTextMethod,
  TEXT_METHODS,
  textMemberSuggestion,
} from "../../../text-operations.js";
import { VALUE_KINDS } from "../../../value-kinds.js";
import { propertyName } from "../program.js";
import type { ItemTag } from "../items.js";
import type { DiagnosticRule, SiteExpectation, WrittenTypeError } from "../result.js";
import type { MessageSource } from "./site.js";
import {
  argumentFixOf,
  capitalized,
  choiceSubject,
  collectionText,
  described,
  either,
  expressionKind,
  known,
  type Known,
  listCopyFix,
  memberNoun,
  mixedTypes,
  named,
  operandRule,
  operandText,
  ownText,
  parsedExpression,
  plural,
  POSTFIX,
  receiverText,
  SHOWN_RULE,
  SORT_ONE_TYPE,
  stablePath,
  typeText,
} from "./words.js";
import {
  codeAt,
  type Diagnosed,
  SHOWN_KINDS_ALL,
  SHOWN_SITE,
  type Takes,
  textResult,
  unlike,
  UNPROVED,
} from "./code-forms.js";
import { declaration, elementOf, storeFix, storeSubject, textOf, typeAt } from "./stores.js";

// An error's first sentence and its rules' fixes, and a written type's error.

/**
 * A member's fix where its receiver's kind has no such member (the current checker's, `operation-checks.ts`). Each code
 * form stands in place of the member access the diagnostic sits on (`at`) and is offered where `codeAt` proves it
 * there: the receiver's kinds (`holder`: an error's own, a warning's whole receiver's, none where its facts are lost)
 * ones the member takes, a call's elements of a type it takes, and its value one the access's place takes (`site`);
 * else the member or the step in words (TABLE r4.151). It names the receiver where it is a stable path; a conversion
 * shows another receiver converted in its place, where the whole access is proved (#1268). `text`, the access's code.
 */
export function memberFix(
  rule: Extract<DiagnosticRule, { rule: "member" }>,
  kinds: readonly ItemTag[],
  text: string,
  at: SourceSite,
  site: SiteExpectation,
  holder: readonly ItemTag[],
  diagnosed: Diagnosed,
): string {
  const kind = known(kinds).find((found) => found !== "null");
  if (kind === undefined) return "";
  const receiver = rule.receiver;
  const named = stablePath(receiver);
  // (code in place of the access: the form `codeAt` tests)
  const access = (
    code: string,
    takes: readonly ItemTag[],
    gives: readonly ItemTag[],
    also: readonly Takes[] = [],
  ) =>
    codeAt(
      {
        code,
        takes: [{ subject: holder, takes, held: false }, ...also],
        diagnosed,
        reads: "own",
        holds: [at],
        rulesOut: unlike(gives),
        gives,
        elements: [],
        writes: false,
      },
      site,
    );
  // (code on the receiver, where it is written as a stable path)
  const on = (
    code: string,
    takes: readonly ItemTag[],
    gives: readonly ItemTag[],
    also: readonly Takes[] = [],
  ) => (named ? access(code, takes, gives, also) : null);
  if (!rule.member.startsWith(".")) return kind === "object" ? objectIndexFix(rule, text) : "";
  const method = rule.member.endsWith("()");
  const name = method ? rule.member.slice(1, -2) : rule.member.slice(1);
  if (kind === "string") {
    if (rule.use === "store") return ` Assign a new text to '${receiver}' instead.`;
    if (method && name === "length") {
      const code = on(`${receiver}.length`, ["string"], ["integer"]);
      return code === null
        ? " Read the length property without parentheses."
        : ` Write '${code}' without parentheses.`;
    }
    if (!method && isTextMethod(name)) {
      const signature = TEXT_METHODS[name];
      if (signature.parameters.some((parameter) => !("optional" in parameter)))
        return ` Call the ${name} method with its arguments in parentheses.`;
      const code = on(`${receiver}.${name}()`, ["string"], textResult(signature.result));
      return code === null
        ? ` Call the ${name} method with parentheses.`
        : ` Write '${code}' with parentheses.`;
    }
    const suggestion = textMemberSuggestion(name);
    // (a method's arguments are the script's to choose: the method in words)
    if (suggestion?.endsWith("(...)")) return ` Use the ${suggestion.slice(0, -5)} method.`;
    if (suggestion !== undefined) {
      const member = suggestion.replace("()", "");
      const gives = suggestion.endsWith(")")
        ? isTextMethod(member)
          ? textResult(TEXT_METHODS[member].result)
          : []
        : ["integer" as const];
      const code = on(`${receiver}.${suggestion}`, ["string"], gives);
      return code === null
        ? ` Use the ${member} ${suggestion.endsWith(")") ? "method" : "property"}.`
        : ` Use '${code}'.`;
    }
  }
  // (each member has its own type, which the read's use may not take: named in words, Codex r4 on #1268)
  if (kind === "dict") {
    if (method)
      return name === "add"
        ? " Assign the value to a key of the dict instead."
        : ` Use one of the dict's methods instead: ${either(Object.keys(DICT_METHODS))}.`;
    // (a key's value is there only where the dict has the key when the script runs, which no fact here proves, Codex
    // r6: the key in words, for a read and a store)
    return rule.use === "store"
      ? " To store a value by its key, write the key in brackets."
      : ` Use one of the dict's properties instead: ${either(Object.keys(DICT_PROPERTIES))}.` +
          ` To read a value by its key, write the key in brackets, where '${receiver}' has that key.`;
  }
  // (a property stored on a type without it: a read's repair is no place to store into)
  if (!method && rule.use === "store") return "";
  const angle = method || kind !== "angle" ? undefined : angleUnit(name);
  if (angle !== undefined) {
    const conversion = angle === "deg" ? "toDeg" : "toRad";
    const code = on(`${conversion}(${receiver})`, ["angle"], ["number"]);
    return (
      ` Use ${code === null ? `the ${conversion} function` : `'${code}'`} for its size in ` +
      `${angle === "deg" ? "degrees" : "radians"}.`
    );
  }
  if (!method && kind === "list" && name === "join") {
    // (the join method joins only elements `${...}` shows, V30 §8: its elements' type's kinds)
    const elements = rule.elements ?? [];
    const code = on(
      `${receiver}.join()`,
      ["list"],
      ["string"],
      [{ subject: elements, takes: SHOWN_KINDS_ALL, held: false }],
    );
    if (code !== null) return ` Write '${code}' with parentheses.`;
    const proved =
      elements.length > 0 && elements.every((found) => found !== "unknown" && found !== "empty");
    return !proved
      ? " Call the join method with parentheses, on elements that can be shown as text."
      : elements.every((found) => SHOWN_KINDS_ALL.includes(found))
        ? " Call the join method with parentheses."
        : " The join method joins only elements that can be shown as text, so select an element or a property first.";
  }
  if (!method && kind === "absoluteDateTime" && hasTemporalField("datetime", name)) {
    const code = on(
      `${receiver}.toDateTime().${name}`,
      ["absoluteDateTime"],
      [TEMPORAL_FIELDS[name].result],
    );
    return code === null
      ? ` Convert '${receiver}' with the toDateTime method first.`
      : ` Convert '${receiver}' first, as in '${code}'.`;
  }
  // (a property read whole; another receiver converted in its place, which keeps a call's own arguments; a method's
  // result is its own, which no fact here gives: words, #1268)
  if (kind !== "string" && VALUE_KINDS[kind].type === "scalar" && isTextMember(name)) {
    const code =
      method || name !== "length"
        ? null
        : access(`toString(${receiver}).length`, SHOWN_KINDS_ALL, ["integer"]);
    return code === null
      ? " Convert the value to text first with the toString function."
      : named
        ? ` Convert '${receiver}' to text first, as in '${code}'.`
        : ` Convert '${receiver}' to text first with 'toString(${receiver})'.`;
  }
  if (!method && kind === "duration") {
    const unit = elapsedDurationUnit(name);
    if (unit !== undefined) {
      const single = name.length > 2 && name.endsWith("s") ? name.slice(0, -1) : name;
      // (the division in place of the access, grouped as the access's place takes it, #1268)
      const code = access(`${operandText(receiver)} / 1 ${single}`, ["duration"], ["number"]);
      return code === null
        ? " Divide the duration by a unit of time instead."
        : named
          ? ` Divide '${receiver}' by a unit, as in '${code}'.`
          : ` Divide '${receiver}' by a unit, such as '1 ${single}'.`;
    }
  }
  if (!method && kind === "calendarDuration")
    return ` Use one of its properties instead: ${either(Object.keys(CALENDAR_DURATION_PARTS))}.`;
  if (method && kind === "set" && listMethod(name)?.notOnSet !== undefined)
    return name === "get"
      ? " Use the contains method instead."
      : ` Copy '${receiver}' into a list with the toList method first.`;
  if (!method && kind === "list" && rule.use === "read")
    return " Use one of its properties instead: length, first, last, or random.";
  return "";
}

/**
 * An object indexed, which V30 §15 forbids, with the current checker's fix: a dict looks up by a name, and a fixed name
 * written as text is the object's property where the object has it, which no fact here proves (Codex r1): in words,
 * naming the receiver where it is a stable path (TABLE r4.151); `text`, the access.
 */
function objectIndexFix(rule: Extract<DiagnosticRule, { rule: "member" }>, text: string): string {
  const access = parsedExpression(text)?.expression;
  const key = access?.kind === "indexExpression" ? textOf(access.index) : null;
  if (key === null || !/^[A-Za-z_]\w*$/.test(key)) return " Use a dict to look up by name.";
  const owner = stablePath(rule.receiver) ? `'${rule.receiver}'` : "the object";
  return ` Use a dict to look up by name. If ${owner} has a property '${key}', use a dot instead of brackets.`;
}

/**
 * The fix of a value that is not true or false where a condition needs one (#1195's decided text): its advice always,
 * its example only of a stable path (the lead after Astra r3), in place of the value at `at`, where `codeAt` proves it
 * there: every known type of the value one the comparison takes (Codex r4), and true or false where the condition, or
 * the logic operator it is an operand of, takes it.
 */
export function conditionFix(
  rule: Extract<DiagnosticRule, { rule: "boolean" }>,
  text: string,
  kinds: readonly ItemTag[],
  at: SourceSite,
  diagnosed: Diagnosed,
): string {
  const kind = known(kinds)[0];
  const example = (code: string, takes: readonly ItemTag[]): string => {
    const proved = stablePath(text)
      ? codeAt(
          {
            code,
            takes: [{ subject: kinds, takes, held: false }],
            diagnosed,
            reads: "own",
            holds: [at],
            rulesOut: null,
            gives: ["boolean"],
            elements: [],
            writes: false,
          },
          {
            takes: ["boolean"],
            binds: rule.operator === null ? "whole" : "operand",
            elements: null,
            divides: false,
          },
        )
      : null;
    return proved === null ? "." : `, as in '${proved}'.`;
  };
  if (kind === "integer" || kind === "number")
    return ` Compare it instead${example(`${text} > 0`, ["integer", "number"])}`;
  if (kind === "string") return ` Compare it instead${example(`${text} != ""`, ["string"])}`;
  if (kind === "list" || kind === "set" || kind === "dict")
    return ` Check its length instead${example(`${text}.length > 0`, ["list", "set", "dict"])}`;
  return "";
}

/**
 * The fix of a key that is not text: a number written as text, as the current checker gives it (`dict-operations.ts`),
 * in place of the key at `at` where `codeAt` proves it there: every known type of it one `${...}` shows (TABLE r4.162).
 */
export function keyFix(
  text: string,
  kinds: readonly ItemTag[],
  at: SourceSite,
  diagnosed: Diagnosed,
): string {
  if (!kinds.some((kind) => kind === "integer" || kind === "number")) return "";
  const code = stablePath(text)
    ? codeAt(
        {
          code: `"\${${text}}"`,
          takes: [
            {
              subject: kinds,
              takes: SHOWN_KINDS_ALL.filter((kind) => kind !== "null"),
              held: false,
            },
          ],
          diagnosed,
          reads: "own",
          holds: [at],
          rulesOut: null,
          gives: ["string"],
          elements: [],
          writes: false,
        },
        { takes: ["string"], binds: "whole", elements: null, divides: false },
      )
    : null;
  return code === null
    ? " Write a number key as text."
    : ` Write a number key as text, as in '${code}'.`;
}

/**
 * How `${...}` shows a value of each kind it cannot show, where one has a fix (#1195's decided texts): code in place of
 * the value at `at` inside its braces, where `codeAt` proves it there (#1268): an object's property that `${...}` shows
 * (the consumer's `property`, whose every type it shows), a set's elements joined where `${...}` shows each (Codex r2);
 * none for an element `${...}` selects from a list, whose text names the list.
 */
function shownFix(
  rule: Extract<DiagnosticRule, { rule: "shown" }>,
  text: string,
  kinds: readonly ItemTag[],
  at: SourceSite,
  diagnosed: Diagnosed,
): string {
  const kind = known(kinds).length === 1 ? known(kinds)[0] : undefined;
  const shown = (code: string, takes: readonly Takes[], gives: readonly ItemTag[]) => {
    const proved = rule.element
      ? null
      : codeAt(
          {
            code,
            takes,
            diagnosed,
            reads: "own",
            holds: [at],
            rulesOut: null,
            gives,
            elements: [],
            writes: false,
          },
          SHOWN_SITE,
        );
    return proved === null ? null : `\${${proved}}`;
  };
  const receiver = receiverText(text);
  if (kind === "object") {
    const code =
      rule.property === null
        ? null
        : shown(
            `${receiver}.${rule.property}`,
            [{ subject: kinds, takes: ["object"], held: false }],
            SHOWN_KINDS_ALL,
          );
    return code === null
      ? "Show one of its properties instead."
      : `Show one of its properties instead, as in '${code}'.`;
  }
  if (kind === "dict" && !rule.element) {
    const code = shown(
      `${receiver}.values.join()`,
      [
        { subject: kinds, takes: ["dict"], held: false },
        { subject: rule.elements, takes: SHOWN_KINDS_ALL, held: false },
      ],
      ["string"],
    );
    return (
      "Select one value with a key, or show every value " +
      (code === null ? "with the values and join methods." : `with '${code}'.`)
    );
  }
  if (kind === "set") {
    const code = shown(
      `${receiver}.toList().join()`,
      [
        { subject: kinds, takes: ["set"], held: false },
        { subject: rule.elements, takes: SHOWN_KINDS_ALL, held: false },
      ],
      ["string"],
    );
    return code === null
      ? "Show its elements with the toList and join methods instead."
      : `Show all its elements with '${code}'.`;
  }
  return SHOWN_RULE;
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
  source: MessageSource,
  diagnosed: Diagnosed,
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
  // (a list's `+` as the current checker words it, #1272)
  const mixes =
    rule.operator === undefined ? `This ${collection} mixes` : `'${rule.operator}' would mix`;
  if (property >= 0) {
    const name = path
      .slice(0, property + 1)
      .filter((step) => step !== "element" && step !== "entry")
      .map(propertyName)
      .join(".");
    return (
      `${mixes} objects whose property '${name}' holds ${nested(rule.type)} in one and ` +
      `${nested(kinds)} in another. ${holds} Give '${name}' one type in every ` +
      `${collection === "dict" ? "value" : "element"}.`
    );
  }
  const first = `${mixes} ${nested(rule.type)} and ${nested(kinds)}. ${holds}`;
  if (rule.operator !== undefined) return `${first}${mixedJoinFix(rule, source, diagnosed)}`;
  const both = path.length === 0 ? typeText([...rule.type, ...kinds]) : null;
  if (both === null) return `${first} Use values of one type in it.`;
  const written = collectionText(collection, both);
  const { root } = rule;
  const declared =
    root?.kind === "let" || root?.kind === "global"
      ? declaration(root, written, source, diagnosed)
      : null;
  const type = typeAt(written, diagnosed);
  if (declared === null && type === null) return `${first} Use values of one type in it.`;
  return `${first} To allow both, ${declared ?? `declare it as '${type}'`}.`;
}

/**
 * A list `+` that mixes types (#1272): a written union the joined list's elements need, from what they hold at each list
 * level (`levels`): every kind, `null` and numbers among them, so the type holds every value the joined lists bring
 * (Codex r2–r4 on #1310); one union inside the lists, an optional list where a level holds `null` beside lists (V30
 * §13). Where the joined list is a variable's start value, that declaration with the type and its own start value, where
 * `codeAt` proves it there (`declaration`, #1268, TABLE r4.146); else the type in words (a form at its position, r4.171);
 * values of one type in words where no written type holds them.
 */
function mixedJoinFix(
  rule: Extract<DiagnosticRule, { rule: "mixed" }>,
  source: MessageSource,
  diagnosed: Diagnosed,
): string {
  const levels = rule.levels ?? null;
  const words = " Use values of one type in both lists.";
  if (levels === null || levels.length === 0) return words;
  // (a type as an element: in parentheses where it is a union or optional, as V30 §13 writes `(integer | string)[]`)
  const element = (type: string): string =>
    type.endsWith("?") || (type.includes(" | ") && !type.endsWith("]")) ? `(${type})` : type;
  let written = typeText(levels.at(-1)!);
  if (written === null) return words;
  for (const kinds of levels.slice(0, -1).toReversed()) {
    if (!kinds.every((kind) => kind === "list" || kind === "null")) return words;
    written = `${element(written)}[]${kinds.includes("null") ? "?" : ""}`;
  }
  written = `${element(written)}[]`;
  const declared = declaration(rule.root, written, source, diagnosed, "the list");
  const type = typeAt(written, diagnosed);
  if (declared === null && type === null) return words;
  return ` To allow both, ${declared ?? `declare the list with the type '${type}'`}.`;
}

/**
 * The current checker's fixes of an operator on date and time values (`type-checker.ts`, `operation-checks.ts`). Each
 * code form stands in place of the operation the diagnostic sits on (`at`), its value converted where it is a variable
 * or a path and the other operand one or a literal, and is offered where `codeAt` proves it there: the operands of the
 * kinds its conversions take, and its result, which the failed operation never gave, one the operation's place takes
 * (`expects`, Codex r6); an operand's diagnostic proves nothing of the operation's place. Else the conversion in words.
 */
export function temporalFix(
  rule: Extract<DiagnosticRule, { rule: "operator" }>,
  kinds: readonly ItemTag[],
  source: MessageSource,
  at: SourceSite,
  expects: SiteExpectation,
  diagnosed: Diagnosed,
): string {
  const [left, right] = rule.operands.map((site) => source.text(site));
  if (left === undefined || right === undefined) return "";
  const [a, b] = rule.operand ? [undefined, kinds[0]] : rule.pair;
  const { operator } = rule;
  const moves = operator === "+" || operator === "-";
  const compares = ["<", "<=", ">", ">="].includes(operator);
  const named =
    stablePath(left) &&
    (stablePath(right) || LITERAL_OPERAND.has(expressionKind(right) ?? "identifier"));
  // (the operation with its operands of the kinds the code's conversions take, one per operand)
  // (an operand's diagnostic proves neither the other operand's kinds nor the operation's place: words)
  const operation = (code: string, takes: readonly ItemTag[], gives: readonly ItemTag[]) =>
    rule.operand || a === undefined || b === undefined
      ? null
      : codeAt(
          {
            code,
            takes: [a, b].map((kind, index) => ({
              subject: [kind],
              takes: [takes[index]!],
              held: false,
            })),
            diagnosed,
            reads: "own",
            holds: [at],
            rulesOut: unlike(gives),
            gives,
            elements: [],
            writes: false,
          },
          expects,
        );
  if (moves && a === "absoluteDateTime" && b === "calendarDuration") {
    const code = named
      ? operation(
          `(${left}.toDateTime() ${operator} ${right}).toAbsoluteDateTime()`,
          ["absoluteDateTime", "calendarDuration"],
          ["absoluteDateTime"],
        )
      : null;
    return code === null
      ? " An absolute date and time has no calendar. Convert it with the toDateTime method first."
      : ` An absolute date and time has no calendar. Convert it first, as in '${code}'.`;
  }
  if (moves && a === "date" && b === "duration") {
    const amount = /^(\d+) ?(d|day|days|w|week|weeks)$/.exec(right);
    const unit = amount?.[2]!.startsWith("d") ? "day" : "week";
    const written =
      amount === null ? null : `${amount[1]!} calendar ${unit}${amount[1] === "1" ? "" : "s"}`;
    // (the amount in calendar units in the place of its own, a date's move giving a date or none)
    const code =
      written === null
        ? null
        : operation(
            `${operandText(left)} ${operator} ${written}`,
            ["date", "duration"],
            ["date", "null"],
          );
    return code === null
      ? " A date moves only by calendar units, such as calendar days."
      : ` A date moves only by calendar units. Write '${written!}'.`;
  }
  if (moves && a === "datetime" && b === "duration") {
    const code = named
      ? operation(
          `(${left}.toAbsoluteDateTime() ${operator} ${right}).toDateTime()`,
          ["datetime", "duration"],
          ["datetime"],
        )
      : null;
    return (
      " A date and time has no time zone, so it cannot move by elapsed time. " +
      (code === null
        ? "Convert it with the toAbsoluteDateTime method first, "
        : `Convert it first, as in '${code}', `) +
      "or use calendar units to keep the clock time."
    );
  }
  if (operator === "-" && b === "datetime" && rule.domain.includes("calendarDuration")) {
    const code =
      stablePath(left) && stablePath(right)
        ? operation(
            `toDate(${left}) - toDate(${right})`,
            ["datetime", "datetime"],
            ["calendarDuration"],
          )
        : null;
    return (
      " A date and time has no time zone, so one cannot be subtracted from another. Subtract their dates with " +
      (code === null ? "the toDate function" : `'${code}'`) +
      ", or convert both with the toAbsoluteDateTime method for the elapsed time."
    );
  }
  if (moves && b === "time")
    return " Arithmetic on a time is not available. Combine it with a date first, with the toDateTime function.";
  if (compares && a === "date" && b === "datetime") {
    // (the other operand's date in its place)
    const code = stablePath(right)
      ? operation(
          `${operandText(left)} ${operator} toDate(${right})`,
          ["date", "datetime"],
          ["boolean"],
        )
      : null;
    return code === null
      ? " A date compares only with another date. Compare its date with the toDate function."
      : ` A date compares only with another date. Compare its date, as in 'toDate(${right})'.`;
  }
  if ((compares || operator === "/") && a !== undefined && b !== undefined) {
    const pair = new Set([a, b]);
    if (pair.has("calendarDuration") && pair.has("duration"))
      return ` A calendar day or month has no fixed length. ${compares ? "Compare" : "Divide"} two calendar durations, or two durations.`;
  }
  return "";
}

/**
 * The current checker's fix of '+' between a list or a set and a value that is not one (V30 §4): a set's union or copy
 * into a list, in words; a range's numbers as a list; else the value in a list for a new one, or added to the list
 * itself on a line of its own (an `add` gives no list, Astra r1). Each code form stands in place of the diagnosed site,
 * the operation or the one operand it names, writes the list where it is a stable path and the value where its code is
 * on one line, and is offered where `codeAt` proves it there: the list's elements' type takes the value (`elements`),
 * and the new list fits what the site takes (`expects`); else the fix in words (TABLE r4.151). Each side's type: the
 * operand's own at `site` and the other's place (`domain`), or the operation's `pair`.
 */
function listJoinFix(
  rule: Extract<DiagnosticRule, { rule: "operator" }>,
  kinds: readonly ItemTag[],
  site: SourceSite,
  expects: SiteExpectation,
  source: MessageSource,
  diagnosed: Diagnosed,
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
  const listSite = listLeft ? leftSite : rightSite;
  const [list, value] = listLeft
    ? [source.text(leftSite), source.text(rightSite)]
    : [source.text(rightSite), source.text(leftSite)];
  const range = (listLeft ? b : a) === "range";
  const holds: Takes = {
    subject: range ? ["integer"] : [listLeft ? b : a],
    takes: rule.elements ?? [],
    held: true,
  };
  // (the value's new code, and the code at the site: the operation with it, or that operand alone)
  const written = (code: string): string | null =>
    stablePath(list) && ownText(value)
      ? codeAt(
          {
            code: rule.operand ? code : listLeft ? `${list} + ${code}` : `${code} + ${list}`,
            takes: [holds],
            diagnosed,
            reads: "own",
            holds: [site],
            rulesOut: rule.operand ? null : unlike(["list"]),
            gives: ["list"],
            elements: rule.elements ?? "unproved",
            writes: false,
          },
          expects,
        )
      : null;
  if (range) {
    const code = written(
      POSTFIX.has(expressionKind(value) ?? "binaryExpression")
        ? `${value}.toList()`
        : `(${value}).toList()`,
    );
    return code === null
      ? " To add the numbers of a range, convert the range with the toList method first."
      : ` Write '${code}' to add the numbers of the range.`;
  }
  const join = written(`[${value}]`);
  // (an add, on a line of its own, where a statement takes any value, and the list itself then where the join stood:
  // the list read again, before the line, TABLE r4.168)
  const itself =
    rule.elements === undefined
      ? null
      : codeAt(
          {
            code: list,
            takes: [],
            diagnosed,
            reads: "added",
            holds: [listSite],
            rulesOut: null,
            gives: ["list"],
            elements: rule.elements,
            writes: false,
          },
          expects,
        );
  const add =
    listLeft && stablePath(list) && ownText(value) && itself !== null
      ? codeAt(
          {
            code: `${list}.add(${value})`,
            takes: [holds],
            diagnosed,
            reads: "added",
            holds: [leftSite, rightSite],
            rulesOut: null,
            gives: [],
            elements: [],
            writes: false,
          },
          "statement",
        )
      : null;
  if (!listLeft)
    return join === null
      ? " Put the element in brackets for a new list."
      : ` Write '${join}' for a new list.`;
  return (
    (join === null
      ? " To add one element, put the element in brackets for a new list"
      : ` Write '${join}' for a new list`) +
    (add === null
      ? ", or call the add method on a line of its own."
      : `, or add the element to '${list}' itself with '${add}' on a line of its own.`)
  );
}

export function errorSentence(
  rule: DiagnosticRule,
  text: string,
  kinds: readonly ItemTag[],
  source: MessageSource,
  site: SourceSite,
  expects: SiteExpectation | undefined,
  diagnosed: Diagnosed,
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
      return `${storeSubject(rule, source)}, so it cannot ${elementOf(rule) === null ? "take" : "contain"} ${described(kinds)}.${storeFix(rule, kinds, text, site, source, diagnosed)}`;
    case "fallback": {
      // ADR 0021 rule 7.3: a written union of the place the value lands in directly holds both
      const both = typeText([...rule.type, ...kinds]);
      const declared =
        both === null || (rule.type.includes("integer") && kinds.includes("number"))
          ? null
          : declaration(rule.root, both, source, diagnosed, `'${rule.root?.name ?? ""}'`);
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
      return `${capitalized(described(kinds))} has no ${noun}, so '${text}' cannot be used.${memberFix(rule, kinds, text, site, expects ?? UNPROVED, kinds, diagnosed)}`;
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
      return mixedSentence(rule, kinds, source, diagnosed);
    case "operator": {
      const join = joined(rule, text, kinds, [], source);
      if (join !== null)
        return `'+' joins text only with other text, not with ${described(join.other)}. ${joinFix(join, site, !rule.operand, expects ?? UNPROVED, diagnosed)}`;
      const fix =
        temporalFix(rule, kinds, source, site, expects ?? UNPROVED, diagnosed) +
        listJoinFix(rule, kinds, site, expects ?? UNPROVED, source, diagnosed);
      return rule.operand
        ? `${operandRule(rule, text)}, but '${text}' is ${described(kinds)}.${fix}`
        : `'${rule.operator}' cannot combine ${kinds.map((kind) => described([kind])).join(" and ")}.${fix}`;
    }
    case "shown": {
      const kind = known(kinds).length === 1 ? known(kinds)[0] : undefined;
      // (the operand in its own '${…}', #1268)
      return (
        `'\${${text}}' cannot show ${kind === "dict" && !rule.element ? "a dict" : described(kinds)}. ` +
        shownFix(rule, text, kinds, site, diagnosed)
      );
    }
    case "count":
      return (
        `${operandRule(rule, text)}, but '${text}' is ${described(kinds)}.` +
        (kinds.includes("number") ? ROUND_COUNT_FIX : " Use a whole number here.")
      );
    case "boolean":
      return `${operandRule(rule, text)}, but '${text}' is ${described(kinds)}.${conditionFix(rule, text, kinds, site, diagnosed)}`;
    case "key":
      return `${operandRule(rule, text)}, but '${text}' is ${described(kinds)}.${keyFix(text, kinds, site, diagnosed)}`;
    case "argument":
      return `${operandRule(rule, text)}, but '${text}' is ${described(kinds)}.${argumentFixOf(rule, kinds, text)}`;
    case "elements":
      return rule.families.length > 1
        ? `${SORT_ONE_TYPE}, but '${rule.receiver}' holds ${mixedTypes(rule.families)}.`
        : `${operandRule(rule, text)}, but '${rule.receiver}' holds ${plural(kinds)}.${rule.callee === "join" ? ` ${JOIN_FIX}` : ""}`;
    case "json": {
      // (the runtime's own sentence: one message for the compile-time and the runtime check, V30 §13)
      const kind = known(kinds)[0];
      if (kind === undefined) return `toJson(...) cannot write '${text}'. ${WRITABLE_JSON_FIX}`;
      const holder =
        rule.holder === null || rule.holder === "empty" || rule.holder === "unknown"
          ? null
          : rule.holder;
      return rule.nested ? unwritableJsonMessage(kind, holder) : unwritableJsonMessage(kind);
    }
    case "choice":
      return `${operandRule(rule, text)}, but ${choiceSubject(rule, text)} is ${described(kinds)}.${choiceFix(rule, kinds, text)}`;
    default:
      return `${operandRule(rule, text)}, but '${text}' is ${described(kinds)}.`;
  }
}

/**
 * A `+` of text and a value of another kind that `${...}` shows, where none of the operand's kinds fits (`fits`): the kinds
 * the text is joined with, else `null`. An operand that is text where its place takes another kind (`domain`) is joined
 * with that kind; an operand of another kind where its place takes text, with its own; the operation, with the kind of
 * its operand (`pair`) that is not text.
 */
export function joined(
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
 * The text-join fix (#1195): the operand that is not text, in `${...}` as the source writes it (the owner's review),
 * where `codeAt` proves the text it gives in place of the diagnosed site `at` (the operation, `whole`, or the operand
 * an operand's diagnostic sits on): a value of a kind `${...}` shows, and text, which the failed operation never gave,
 * one the place takes (`expects`, Codex r6); else the sentence alone. The chain around it is never rebuilt: a rebuilt chain
 * changed what some chains say (S8d's reviews r3 and r4).
 */
export function joinFix(
  join: { readonly other: readonly ItemTag[]; readonly operand: string | null },
  at: SourceSite,
  whole: boolean,
  expects: SiteExpectation,
  diagnosed: Diagnosed,
): string {
  const code =
    join.operand === null
      ? null
      : codeAt(
          {
            code: `"\${${join.operand}}"`,
            takes: [{ subject: join.other, takes: SHOWN_KINDS_ALL, held: false }],
            diagnosed,
            reads: "own",
            holds: [at],
            rulesOut: whole ? unlike(["string"]) : null,
            gives: ["string"],
            elements: [],
            writes: false,
          },
          expects,
        );
  return code === null
    ? "Put the value in the text instead."
    : `Put the value in the text as '\${${join.operand!}}' instead.`;
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

/** The literals an example may write beside a named value as the source writes them. */
const LITERAL_OPERAND: ReadonlySet<Expression["kind"]> = new Set([
  "numberLiteral",
  "durationLiteral",
  "unitExpression",
  "angleExpression",
  "booleanLiteral",
]);

/**
 * A TSV029 fix of one known kind: a value no button returns is picked from the answer (the buttons return text or
 * numbers, `choiceValueFix`), a range option is copied into a list.
 */
export function choiceFix(
  rule: Extract<DiagnosticRule, { rule: "choice" }>,
  kinds: readonly ItemTag[],
  text: string,
): string {
  const kind = known(kinds).length === 1 ? known(kinds)[0] : undefined;
  if (kind === undefined) return "";
  if (rule.part === "value") return ` ${choiceValueFix(kind)}`;
  return rule.part === "option" && kind === "range" ? ` ${listCopyFix(text)}` : "";
}

/** V30 §13: a union that holds a whole collection beside another type, with V30's suggestion where it has one. */
export function writtenTypeMessage(
  error: WrittenTypeError,
  source: MessageSource,
  diagnosed: Diagnosed,
): string {
  // (the suggestion is a type at the type's position, TABLE r4.171)
  const suggestion = error.suggestion === null ? null : typeAt(error.suggestion, diagnosed);
  return (
    `A union cannot hold a whole list, set, or dict beside another type, but '${source.text(error.union)}' does. ` +
    (suggestion === null
      ? "Write the union inside the collection instead."
      : `Write '${suggestion}' instead.`)
  );
}
