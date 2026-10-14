/**
 * The built-in text operations (V30 §8) and list `join` (V30 §16), shared by the compiler and the runtime. Lengths
 * and positions count Unicode code points.
 */

/**
 * What an argument must be: `text`, `nonEmptyText`, a `regex`, `textOrRegex`, a `position` from 0 through the text
 * length, or a `count` (a repetition count or target length) of 0 or more.
 */
export type TextParameterKind =
  "text" | "nonEmptyText" | "regex" | "textOrRegex" | "position" | "count";

export interface TextParameter {
  readonly name: string;
  readonly kind: TextParameterKind;
  readonly optional?: true;
}

export interface TextMember {
  readonly name: string;
  /** `null` for the `length` property; otherwise the method's parameters. */
  readonly parameters: readonly TextParameter[] | null;
  /**
   * `integer?` for a position that is `null` when the part does not occur, `string?` for a match that is `null` when
   * there is none, and `string?[]?` for the groups of a match.
   */
  readonly result:
    "string" | "integer" | "integer?" | "boolean" | "string[]" | "string?" | "string?[]?";
}

const part: TextParameter = { name: "part", kind: "text" };
const partOrRegex: TextParameter = { name: "part", kind: "textOrRegex" };
const pattern: TextParameter = { name: "pattern", kind: "regex" };
const count = (name: string): TextParameter => ({ name, kind: "count" });
const fill: TextParameter = { name: "fill", kind: "nonEmptyText" };

function member(
  name: string,
  parameters: TextMember["parameters"],
  result: TextMember["result"],
): [string, TextMember] {
  return [name, { name, parameters, result }];
}

export const TEXT_MEMBERS: ReadonlyMap<string, TextMember> = new Map([
  member("length", null, "integer"),
  member("contains", [partOrRegex], "boolean"),
  member("startsWith", [part], "boolean"),
  member("endsWith", [part], "boolean"),
  member("indexOf", [partOrRegex], "integer?"),
  member("lastIndexOf", [part], "integer?"),
  member(
    "substring",
    [
      { name: "start", kind: "position" },
      { name: "end", kind: "position", optional: true },
    ],
    "string",
  ),
  member("split", [{ name: "separator", kind: "text" }], "string[]"),
  member(
    "replace",
    [
      { name: "search", kind: "nonEmptyText" },
      { name: "replacement", kind: "text" },
    ],
    "string",
  ),
  member("matches", [pattern], "boolean"),
  member("find", [pattern], "string?"),
  member("capture", [pattern], "string?[]?"),
  member("trim", [], "string"),
  member("trimStart", [], "string"),
  member("trimEnd", [], "string"),
  member("uppercase", [], "string"),
  member("lowercase", [], "string"),
  member("uppercaseFirst", [], "string"),
  member("reverse", [], "string"),
  member("repeat", [count("count")], "string"),
  member("padStart", [count("length"), fill], "string"),
  member("padEnd", [count("length"), fill], "string"),
]);

export const LIST_JOIN: TextMember = {
  name: "join",
  parameters: [{ name: "separator", kind: "text", optional: true }],
  result: "string",
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

export function argumentCountMessage(member: MethodParameters, received: number): string {
  const parameters = member.parameters ?? [];
  const names = parameters.map((parameter) => parameter.name);
  const required = parameters.filter((parameter) => parameter.optional !== true).length;
  const expected =
    names.length === 0
      ? "no arguments"
      : `${required === names.length ? `${required} argument${required === 1 ? "" : "s"}` : `${required} to ${names.length} arguments`} (${names.join(", ")})`;
  return `${member.name}() takes ${expected}, received ${received}.`;
}

/** The text methods whose search will also take a regex in a later step. */
const LATER_REGEX_SEARCHES: ReadonlySet<string> = new Set(["lastIndexOf", "split", "replace"]);

/** An argument of the wrong kind; `argumentFix` names the conversion that fixes it. */
export function argumentTypeMessage(
  member: TextMember,
  parameter: TextParameter,
  description: string,
): string {
  if (
    description === "a regex" &&
    LATER_REGEX_SEARCHES.has(member.name) &&
    parameter === member.parameters?.[0]
  )
    return `${member.name}() does not take a regex yet: that comes later. Give text for '${parameter.name}' instead.`;
  const needed =
    parameter.kind === "regex"
      ? "a regex"
      : parameter.kind === "textOrRegex"
        ? "text (string) or a regex"
        : isTextParameter(parameter)
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
  if (isTextParameter(parameter) || parameter.kind === "textOrRegex")
    return kind !== null && kind !== "string" ? " Convert it with toString(...)." : "";
  if (kind === "number") return " Convert it with toInteger(...), which drops the fraction.";
  return kind === "string" ? " Convert it with toInteger(...)." : "";
}

function isTextParameter(parameter: TextParameter): boolean {
  return parameter.kind === "text" || parameter.kind === "nonEmptyText";
}

export function emptyTextMessage(member: TextMember, parameter: TextParameter): string {
  return `${member.name}() needs non-empty text for '${parameter.name}'.`;
}

export function negativeMessage(
  member: TextMember,
  parameter: TextParameter,
  value: number,
): string {
  return `${member.name}() needs '${parameter.name}' to be 0 or more, not ${value}.`;
}

export function beyondLengthMessage(
  member: TextMember,
  parameter: TextParameter,
  value: number,
  length: number,
): string {
  return `${member.name}() needs '${parameter.name}' from 0 through ${length} (the length of the text), not ${value}.`;
}

export function endBeforeStartMessage(member: TextMember, start: number, end: number): string {
  return `${member.name}() needs 'end' not before 'start', but ${end} is before ${start}.`;
}

/** The failure message for an unknown text member, suggesting the TeaseScript name for a common one. */
export function unknownTextMemberMessage(name: string, use: "method" | "property"): string {
  if (name === "findAll" && use === "method")
    return "Text has no method 'findAll' yet: it comes later. Use find(...) for the first match.";
  const suggestion = TEXT_MEMBER_SUGGESTIONS.get(name);
  return `Text has no ${use} '${name}'.${suggestion === undefined ? "" : ` Use ${suggestion}.`}`;
}

/** The failure message for a member of a regex, which has none: the text methods take the regex instead. */
export function regexMemberMessage(name: string, use: "method" | "property"): string {
  return `A regex has no ${use} '${name}'. Call a method of the text with the regex instead, such as text.contains(regex) or text.matches(regex).`;
}
