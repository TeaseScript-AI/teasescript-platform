/**
 * The methods of text (V30 §8), and list `join` (V30 §16), which checks its separator as they check text: one contract
 * per method, shared by the compiler, the runtime, and the editor. Lengths and positions count Unicode code points.
 */

import {
  argumentCountMessage,
  argumentsTaken,
  LIST_ONLY_METHODS,
  POSITIONAL_METHODS,
} from "./argument-rules.js";
import { compileRegex, replacementParts } from "./regex.js";
import type { SerializableRegex } from "./runtime/serializable-values.js";

/**
 * What an argument must be: `text`, a `regex`, `textOrRegex`, or a whole number (integer), as a `position` in the text
 * or a `count` (a repetition count or a target length). Their domains say which values of that type are valid.
 */
export type TextParameterKind = "text" | "regex" | "textOrRegex" | "position" | "count";

export interface TextParameter {
  readonly name: string;
  readonly kind: TextParameterKind;
  readonly optional?: true;
}

/**
 * A method's result: `integer?` for a position that is `null` when the part does not occur, `string?` for a match that
 * is `null` when there is none, and `string?[]?` for the groups of a match.
 */
export type TextResult =
  "string" | "integer" | "integer?" | "boolean" | "string[]" | "string?" | "string?[]?";

/** A value a domain reads: text, a whole number, a regex, or the length of the text the method is called on. */
export type DomainValue = string | number | SerializableRegex;

/**
 * A domain of a method's arguments: what it reads, the arguments by position and `length`, the length of the text the
 * method is called on, and why their values are invalid. The runtime checks each argument's type and then the domains
 * that read only that argument, in order, and then the other domains in order; a domain of a position fails with
 * `TSR025`, any other with `TSR057`. The compiler checks each domain whose values it knows, where the arguments it reads
 * have no other problem, with the same text.
 */
export interface TextDomain {
  readonly reads: readonly (number | "length")[];
  /** Why the values it reads, in the order of `reads`, are invalid, or `undefined` when they are valid. */
  readonly problem: (values: readonly DomainValue[], method: TextSignature) => string | undefined;
  /**
   * Not checked with the others at runtime: the regex operation checks it inside its regex work, after charging the work
   * for the values it reads, so a value too large for that work fails with `TSR087` first (see `TextMethod`).
   */
  readonly inRegexWork?: true;
}

/** What a method takes: its name and parameters, and the domains of its arguments. */
export interface TextSignature {
  readonly name: string;
  readonly parameters: readonly TextParameter[];
  readonly domains: readonly TextDomain[];
}

/**
 * A method of text (V30 §8): how it is called, what its arguments may be, what it gives, and its help. Text is
 * immutable, so every method only reads the text and copies of its arguments and gives a new value. Arguments are
 * positional. A method whose first parameter takes a regex uses at most the regex work limit when it gets one
 * (`docs/RESOURCE-LIMITS.md`): past it, the call fails with `TSR087`.
 */
export interface TextMethod extends TextSignature {
  readonly result: TextResult;
  /** What the call does, for the editor's help. */
  readonly summary: string;
}

const part = { name: "part", kind: "text" } as const;
const partOrRegex = { name: "part", kind: "textOrRegex" } as const;
const pattern = { name: "pattern", kind: "regex" } as const;
const count = <Name extends string>(name: Name) => ({ name, kind: "count" }) as const;
const position = <Name extends string>(name: Name) => ({ name, kind: "position" }) as const;

/** The argument at `index` is not empty text; a regex may match empty text. */
function nonEmpty(index: number): TextDomain {
  return {
    reads: [index],
    problem: ([value], method) =>
      value === ""
        ? `${method.name}() needs non-empty text for '${method.parameters[index]!.name}'.`
        : undefined,
  };
}

/** The whole number at `index` is 0 or more. */
function atLeastZero(index: number): TextDomain {
  return {
    reads: [index],
    problem: ([value], method) =>
      typeof value === "number" && value < 0
        ? `${method.name}() needs '${method.parameters[index]!.name}' to be 0 or more, not ${value}.`
        : undefined,
  };
}

/** The position at `index` is at most the length of the text. */
function withinText(index: number): TextDomain {
  return {
    reads: [index, "length"],
    problem: ([value, length], method) =>
      typeof value === "number" && typeof length === "number" && value > length
        ? `${method.name}() needs '${method.parameters[index]!.name}' from 0 through ${length} (the length of the text), not ${value}.`
        : undefined,
  };
}

/** `substring`'s end is not before its start. */
const endNotBeforeStart: TextDomain = {
  reads: [0, 1],
  problem: ([start, end], method) =>
    typeof start === "number" && typeof end === "number" && end < start
      ? `${method.name}() needs 'end' not before 'start', but ${end} is before ${start}.`
      : undefined,
};

/**
 * The replacement of a regex search refers only to groups the regex has (V30 §8). A text search replaces literally, and
 * a regex that does not compile fails on its own.
 */
const replacementGroups: TextDomain = {
  reads: [0, 1],
  inRegexWork: true,
  problem: ([search, replacement]) => {
    if (typeof search !== "object" || typeof replacement !== "string") return undefined;
    const compiled = compileRegex(search.source, search.flags);
    if (!compiled.ok) return undefined;
    const parts = replacementParts(replacement, search.source, compiled.program.groups);
    return parts.ok ? undefined : parts.problem;
  },
};

/** A table of contracts, each under its own name. */
function byName<
  const Table extends { readonly [Name in keyof Table]: TextMethod & { readonly name: Name } },
>(table: Table): Table {
  return table;
}

/** Each method of text by its name. */
export const TEXT_METHODS = byName({
  contains: {
    name: "contains",
    parameters: [partOrRegex],
    result: "boolean",
    domains: [],
    summary:
      "Gives true when part occurs in the text. Text is compared literally and case-sensitively, and a regex may match anywhere in the text.",
  },
  startsWith: {
    name: "startsWith",
    parameters: [part],
    result: "boolean",
    domains: [],
    summary: "Gives true when the text starts with part, compared literally and case-sensitively.",
  },
  endsWith: {
    name: "endsWith",
    parameters: [part],
    result: "boolean",
    domains: [],
    summary: "Gives true when the text ends with part, compared literally and case-sensitively.",
  },
  indexOf: {
    name: "indexOf",
    parameters: [partOrRegex],
    result: "integer?",
    domains: [],
    summary:
      "Gives the position of the first occurrence of part, text or a regex, counted in characters from 0, or null when it does not occur.",
  },
  lastIndexOf: {
    name: "lastIndexOf",
    parameters: [partOrRegex],
    result: "integer?",
    domains: [],
    summary:
      "Gives the position of the last occurrence of part, text or a regex, counted in characters from 0, or null when it does not occur. The matches of a regex do not overlap.",
  },
  count: {
    name: "count",
    parameters: [partOrRegex],
    result: "integer",
    domains: [nonEmpty(0)],
    summary:
      'Gives how many times part, non-empty text or a regex, occurs, counted from the start without overlap: "banana".count("ana") is 1.',
  },
  substring: {
    name: "substring",
    parameters: [position("start"), { ...position("end"), optional: true }],
    result: "string",
    domains: [atLeastZero(0), atLeastZero(1), withinText(0), withinText(1), endNotBeforeStart],
    summary:
      "Gives the characters from position start up to, but not including, end, or without end up to the end of the text. A position is from 0 through the length of the text.",
  },
  split: {
    name: "split",
    parameters: [{ name: "separator", kind: "textOrRegex" }],
    result: "string[]",
    domains: [],
    summary:
      'Gives a string[] of the parts between the occurrences of separator, text or a regex, keeping empty parts. split("") gives the single characters.',
  },
  replace: {
    name: "replace",
    parameters: [
      { name: "search", kind: "textOrRegex" },
      { name: "replacement", kind: "text" },
    ],
    result: "string",
    domains: [nonEmpty(0), replacementGroups],
    summary:
      "Gives the text with every occurrence of search, non-empty text or a regex, replaced. Text is replaced literally. In the replacement of a regex, $0 inserts the whole match, $1 a group, $<name> a named group, and $$ one $.",
  },
  matches: {
    name: "matches",
    parameters: [pattern],
    result: "boolean",
    domains: [],
    summary: "Gives true when the regex matches the whole text.",
  },
  find: {
    name: "find",
    parameters: [pattern],
    result: "string?",
    domains: [],
    summary: "Gives the text of the first match of the regex, or null.",
  },
  capture: {
    name: "capture",
    parameters: [pattern],
    result: "string?[]?",
    domains: [],
    summary:
      "Gives the first match of the regex at index 0, followed by each of its groups, or null without a match. A group that did not take part is null.",
  },
  findAll: {
    name: "findAll",
    parameters: [pattern],
    result: "string[]",
    domains: [],
    summary:
      "Gives a string[] of every match of the regex, or [] without one. The matches do not overlap.",
  },
  trim: {
    name: "trim",
    parameters: [],
    result: "string",
    domains: [],
    summary: "Gives the text without whitespace at both ends.",
  },
  trimStart: {
    name: "trimStart",
    parameters: [],
    result: "string",
    domains: [],
    summary: "Gives the text without whitespace at the start.",
  },
  trimEnd: {
    name: "trimEnd",
    parameters: [],
    result: "string",
    domains: [],
    summary: "Gives the text without whitespace at the end.",
  },
  uppercase: {
    name: "uppercase",
    parameters: [],
    result: "string",
    domains: [],
    summary:
      'Gives the text in upper case, with the locale-independent Unicode mapping: "Straße".uppercase() is "STRASSE".',
  },
  lowercase: {
    name: "lowercase",
    parameters: [],
    result: "string",
    domains: [],
    summary: "Gives the text in lower case, with the locale-independent Unicode mapping.",
  },
  uppercaseFirst: {
    name: "uppercaseFirst",
    parameters: [],
    result: "string",
    domains: [],
    summary: "Gives the text with its first character in upper case and the rest unchanged.",
  },
  reverse: {
    name: "reverse",
    parameters: [],
    result: "string",
    domains: [],
    summary: "Gives the text with its characters in reverse order.",
  },
  repeat: {
    name: "repeat",
    parameters: [count("count")],
    result: "string",
    domains: [atLeastZero(0)],
    summary: "Gives the text repeated count times, a whole number of 0 or more.",
  },
  padStart: {
    name: "padStart",
    parameters: [count("length"), { name: "fill", kind: "text" }],
    result: "string",
    domains: [atLeastZero(0), nonEmpty(1)],
    summary:
      'Gives the text with fill, non-empty text, repeated before it up to length characters: "7".padStart(3, "0") is "007". A text that is already long enough is unchanged.',
  },
  padEnd: {
    name: "padEnd",
    parameters: [count("length"), { name: "fill", kind: "text" }],
    result: "string",
    domains: [atLeastZero(0), nonEmpty(1)],
    summary:
      "Gives the text with fill, non-empty text, repeated after it up to length characters. A text that is already long enough is unchanged.",
  },
});

export type TextMethodName = keyof typeof TEXT_METHODS;

/** A method of text that takes a regex, and then uses the regex work limit, such as `matches` or `replace`. */
export type RegexMethodName = {
  [Name in TextMethodName]: (typeof TEXT_METHODS)[Name]["parameters"] extends readonly [
    { readonly kind: "regex" | "textOrRegex" },
    ...unknown[],
  ]
    ? Name
    : never;
}[TextMethodName];

export function isTextMethod(name: string): name is TextMethodName {
  return Object.hasOwn(TEXT_METHODS, name);
}

/** Whether text has a member `name`: one of its methods, or its property `length`. */
export function isTextMember(name: string): boolean {
  return name === "length" || isTextMethod(name);
}

/**
 * Whether only text has a method `name`: no list, set, dict, or handle has one (`POSITIONAL_METHODS`, `LIST_ONLY_METHODS`,
 * and `get` and `join`, which text does not have), and no date and time value has a method of a text method's name
 * (`TEMPORAL_METHODS`), so a call of it is a call of the text method.
 */
export function isTextOnlyMethod(name: string): name is TextMethodName {
  return isTextMethod(name) && !POSITIONAL_METHODS.has(name) && !LIST_ONLY_METHODS.has(name);
}

/** Whether the method takes a regex, and then uses the regex work limit (see `TextMethod`). */
export function isRegexMethod(name: TextMethodName): name is RegexMethodName {
  return takesRegex(TEXT_METHODS[name].parameters[0]);
}

/** The call as the editor's help writes it, such as `text.substring(start [, end])`. */
export function textMethodSyntax(name: TextMethodName): string {
  const method: TextMethod = TEXT_METHODS[name];
  const required = method.parameters.filter((parameter) => parameter.optional !== true);
  const optional = method.parameters.filter((parameter) => parameter.optional === true);
  return `text.${name}(${required.map((parameter) => parameter.name).join(", ")}${optional.map((parameter) => ` [, ${parameter.name}]`).join("")})`;
}

/** Whether a domain is one of a position, whose failure is `TSR025` (see `TextDomain`). */
export function readsPosition(method: TextSignature, domain: TextDomain): boolean {
  return domain.reads.some(
    (read) => read !== "length" && method.parameters[read]!.kind === "position",
  );
}

/** The number of characters of a text: its Unicode code points. */
export function stringLength(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index += text.codePointAt(index)! > 0xffff ? 2 : 1)
    length += 1;
  return length;
}

export const LIST_JOIN: TextSignature = {
  name: "join",
  parameters: [{ name: "separator", kind: "text", optional: true }],
  domains: [],
};

/** Names other languages use for a text operation, mapped to how TeaseScript writes it. */
const TEXT_MEMBER_SUGGESTIONS: ReadonlyMap<string, string> = new Map([
  ["size", "length"],
  ["toUpperCase", "uppercase()"],
  ["toLowerCase", "lowercase()"],
  ["capitalize", "uppercaseFirst()"],
  ["includes", "contains(...)"],
  ["replaceAll", "replace(...)"],
  ["slice", "substring(...)"],
  ["substr", "substring(...)"],
  ["strip", "trim()"],
  ["trimLeft", "trimStart()"],
  ["trimRight", "trimEnd()"],
]);

/** The scalar kind of an argument, for choosing the conversion a message suggests; `null` for other values. */
export type ArgumentKind = "string" | "integer" | "number" | "boolean" | "duration" | null;

/** A method's name and parameters, as a message about its arguments names them: a text operation or another method. */
export interface MethodParameters {
  readonly name: string;
  readonly parameters: readonly Pick<TextParameter, "name" | "optional">[] | null;
}

/** A call of a method with a number of arguments it does not take, at compile time (TSV020) and at runtime (TSR028). */
export function methodArgumentCountMessage(member: MethodParameters, received: number): string {
  const parameters = member.parameters ?? [];
  return argumentCountMessage(
    member.name,
    argumentsTaken(
      parameters.map((parameter) => parameter.name),
      parameters.filter((parameter) => parameter.optional !== true).length,
    ),
    received,
  );
}

/** An argument of the wrong kind; `argumentFix` names the conversion that fixes it. */
export function argumentTypeMessage(
  member: TextSignature,
  parameter: TextParameter,
  description: string,
): string {
  const needed = takesRegex(parameter)
    ? takesText(parameter)
      ? "text (string) or a regex"
      : "a regex"
    : takesText(parameter)
      ? "text (string)"
      : "a whole number (integer)";
  return `${member.name}() needs ${needed} for '${parameter.name}', not ${description}.`;
}

/** The conversion that turns an argument of scalar `kind` into what `parameter` needs, or nothing. */
export function argumentFix(parameter: TextParameter, kind: ArgumentKind): string {
  if (parameter.kind === "regex")
    return kind === "string"
      ? " Write a regex such as /[0-9]+/, or make one from text with toRegex(text, default: ...)."
      : "";
  if (takesText(parameter))
    return kind !== null && kind !== "string" ? " Convert it with toString(...)." : "";
  if (kind === "number") return " Convert it with toInteger(...), which drops the fraction.";
  return kind === "string" ? " Convert it with toInteger(...)." : "";
}

/** Whether an argument of `parameter` may be text. */
export function takesText(parameter: TextParameter): boolean {
  return parameter.kind === "text" || parameter.kind === "textOrRegex";
}

/** Whether an argument of `parameter` may be a regex. */
export function takesRegex(parameter: TextParameter | undefined): boolean {
  return parameter?.kind === "regex" || parameter?.kind === "textOrRegex";
}

/** The failure message for an unknown text member, suggesting the TeaseScript name for a common one. */
export function unknownTextMemberMessage(name: string, use: "method" | "property"): string {
  const suggestion = TEXT_MEMBER_SUGGESTIONS.get(name);
  return `Text has no ${use} '${name}'.${suggestion === undefined ? "" : ` Use ${suggestion}.`}`;
}

/** The failure message for a member of a regex, which has none: the text methods take the regex instead. */
export function regexMemberMessage(name: string, use: "method" | "property"): string {
  return `A regex has no ${use} '${name}'. Call a method of the text with the regex instead, such as text.contains(regex) or text.matches(regex).`;
}
