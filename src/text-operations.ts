/**
 * The built-in text operations (V30 §8) and list `join` (V30 §16), shared by the compiler and the runtime. Lengths
 * and positions count Unicode code points.
 */

/**
 * What an argument must be: `text`, `nonEmptyText`, a `position` from 0 through the text length, or a `count` (a
 * repetition count or target length) of 0 or more.
 */
export type TextParameterKind = "text" | "nonEmptyText" | "position" | "count";

export interface TextParameter {
  readonly name: string;
  readonly kind: TextParameterKind;
  readonly optional?: true;
}

export interface TextMember {
  readonly name: string;
  /** `null` for the `length` property; otherwise the method's parameters. */
  readonly parameters: readonly TextParameter[] | null;
  readonly result: "string" | "integer" | "boolean" | "string[]";
}

const part: TextParameter = { name: "part", kind: "text" };
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
  member("contains", [part], "boolean"),
  member("startsWith", [part], "boolean"),
  member("endsWith", [part], "boolean"),
  member("indexOf", [part], "integer"),
  member("lastIndexOf", [part], "integer"),
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
  member("trim", [], "string"),
  member("trimStart", [], "string"),
  member("trimEnd", [], "string"),
  member("uppercase", [], "string"),
  member("lowercase", [], "string"),
  member("uppercaseFirst", [], "string"),
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

export function argumentCountMessage(member: TextMember, received: number): string {
  const parameters = member.parameters ?? [];
  const names = parameters.map((parameter) => parameter.name);
  const required = parameters.filter((parameter) => parameter.optional !== true).length;
  const expected =
    names.length === 0
      ? "no arguments"
      : `${required === names.length ? `${required} argument${required === 1 ? "" : "s"}` : `${required} to ${names.length} arguments`} (${names.join(", ")})`;
  return `${member.name}() takes ${expected}, received ${received}.`;
}

/** An argument of the wrong kind; `argumentFix` names the conversion that fixes it. */
export function argumentTypeMessage(
  member: TextMember,
  parameter: TextParameter,
  description: string,
): string {
  return `${member.name}() needs ${isTextParameter(parameter) ? "text (string)" : "a whole number (integer)"} for '${parameter.name}', not ${description}.`;
}

/** The conversion that turns an argument of scalar `kind` into what `parameter` needs, or nothing. */
export function argumentFix(parameter: TextParameter, kind: ArgumentKind): string {
  if (isTextParameter(parameter))
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
  const suggestion = TEXT_MEMBER_SUGGESTIONS.get(name);
  return `Text has no ${use} '${name}'.${suggestion === undefined ? "" : ` Use ${suggestion}.`}`;
}
