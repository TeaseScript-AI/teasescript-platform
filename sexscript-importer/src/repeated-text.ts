import type { IrExpression, IrStatement, MigrationDiagnostic } from "./ir.ts";

/**
 * The legacy player had one text display, and every show() and question replaced the text before it, so authors
 * repeated a message to extend it. The Player keeps earlier messages, so a `say` that repeats the text output just
 * before it on the same straight path, with only waits, images, and sounds in between, says only what it adds, and
 * one that only repeats it goes. Texts compare with their whitespace and line breaks collapsed and without the final
 * punctuation of the earlier text; only literal text and interpolations of identical expressions compare. A nested
 * block, any other statement, and a call in an image or sound start over.
 */
export function withoutRepeatedText(
  statements: IrStatement[],
  diagnostics: MigrationDiagnostic[],
): IrStatement[] {
  const report = (code: string, message: string, statement: IrStatement): void => {
    diagnostics.push({ code, severity: "info", message, span: statement.span });
  };
  const block = (items: IrStatement[]): IrStatement[] => {
    let previous: { tokens: Token[]; say: Extract<IrStatement, { kind: "say" }> } | null = null;
    const result: IrStatement[] = [];
    // A wait that follows a wait across a dropped text joins it: `wait 1` five times between dots becomes `wait 5`.
    let joinsWait = false;
    for (const item of items) {
      const statement = withNestedBlocks(item, block);
      const last = result.at(-1);
      if (joinsWait && statement.kind === "wait" && last?.kind === "wait") {
        const joined = joinedWait(last, statement);
        if (joined !== null) {
          result[result.length - 1] = joined;
          continue;
        }
      }
      joinsWait = false;
      if (statement.kind === "say") {
        const tokens = textTokens(statement.value);
        if (tokens === null) {
          previous = null;
          result.push(statement);
          continue;
        }
        const repeat =
          previous !== null && sameVoice(previous.say, statement)
            ? repeatedPart(previous.tokens, tokens, sameToken)
            : null;
        if (repeat === "all") {
          report(
            "SX_REPEATED_TEXT_DROPPED",
            "Dropped a text that only repeated the text before it, which the legacy display replaced.",
            statement,
          );
          joinsWait = last?.kind === "wait";
          continue;
        }
        if (repeat !== null) {
          report(
            "SX_REPEATED_TEXT_SHORTENED",
            "Kept only the part after the text before it, which this text repeated because the legacy display replaced it.",
            statement,
          );
          result.push({ ...statement, value: textValue(tokens.slice(repeat)) });
        } else {
          if (
            previous !== null &&
            sameVoice(previous.say, statement) &&
            repeatedPart(previous.tokens, tokens, sameShape) !== null
          )
            report(
              "SX_REPEATED_TEXT_KEPT",
              "Kept a text that may repeat the text before it: their interpolated values differ.",
              statement,
            );
          result.push(statement);
        }
        previous = { tokens, say: statement };
        continue;
      }
      if (!keepsText(statement)) previous = null;
      result.push(statement);
    }
    return result;
  };
  return block(statements);
}

type WaitStatement = Extract<IrStatement, { kind: "wait" }>;

function joinedWait(first: WaitStatement, second: WaitStatement): WaitStatement | null {
  const left = first.duration;
  const right = second.duration;
  if (
    first.unit !== second.unit ||
    first.visible ||
    second.visible ||
    left.kind !== "literal" ||
    right.kind !== "literal" ||
    typeof left.value !== "number" ||
    typeof right.value !== "number"
  )
    return null;
  // Rounded to milliseconds, so 0.1 and 0.2 give 0.3.
  const total = Math.round((left.value + right.value) * 1000) / 1000;
  return { ...first, duration: { kind: "literal", value: total } };
}

type Token = { char: string } | { value: IrExpression; key: string };

/** The characters and interpolated values of a literal text or a template; null for any other value. */
function textTokens(value: IrExpression): Token[] | null {
  if (value.kind === "literal") {
    return typeof value.value === "string" ? [...value.value].map((char) => ({ char })) : null;
  }
  if (value.kind !== "template") return null;
  return value.parts.flatMap((part): Token[] =>
    "text" in part
      ? [...part.text].map((char) => ({ char }))
      : [{ value: part.value, key: JSON.stringify(part.value) }],
  );
}

function textValue(tokens: readonly Token[]): IrExpression {
  const parts: Array<{ text: string } | { value: IrExpression }> = [];
  for (const token of tokens) {
    if ("value" in token) parts.push({ value: token.value });
    else if (parts.length > 0 && "text" in parts.at(-1)!) {
      const last = parts.pop()!;
      parts.push({ text: ("text" in last ? last.text : "") + token.char });
    } else parts.push({ text: token.char });
  }
  if (parts.every((part) => "text" in part))
    return { kind: "literal", value: parts.map((part) => ("text" in part ? part.text : "")).join("") };
  return { kind: "template", parts };
}

const SPACE = /\s/u;
const PUNCTUATION = /[.!?,;:…]/u;
const WORD = /[\p{L}\p{N}]/u;

function sameToken(left: Token, right: Token): boolean {
  if ("char" in left) return "char" in right && left.char === right.char;
  return "key" in right && left.key === right.key;
}

/** Equal as text, where any interpolated value matches any other. */
function sameShape(left: Token, right: Token): boolean {
  return "char" in left ? "char" in right && left.char === right.char : "key" in right;
}

/**
 * Where `next` goes on after repeating `earlier` ("all" when it adds nothing), or null where it does not start with
 * it: whitespace runs compare as one space, the final punctuation of `earlier` is left out, and the repeat ends at a
 * word boundary, before the punctuation and whitespace that follow it.
 */
function repeatedPart(
  earlier: readonly Token[],
  next: readonly Token[],
  same: (left: Token, right: Token) => boolean,
): number | "all" | null {
  const isSpace = (token: Token | undefined): boolean =>
    token !== undefined && "char" in token && SPACE.test(token.char);
  const isMark = (token: Token | undefined): boolean =>
    token !== undefined && "char" in token && (SPACE.test(token.char) || PUNCTUATION.test(token.char));
  let end = earlier.length;
  while (end > 0 && isMark(earlier[end - 1])) end -= 1;
  let start = 0;
  while (start < end && isSpace(earlier[start])) start += 1;
  if (start === end) return null;
  let position = 0;
  while (isSpace(next[position])) position += 1;
  for (let index = start; index < end; index += 1) {
    const token = earlier[index]!;
    if (isSpace(token)) {
      if (!isSpace(next[position])) return null;
      while (isSpace(earlier[index + 1])) index += 1;
      while (isSpace(next[position])) position += 1;
      continue;
    }
    const other = next[position];
    if (other === undefined || !same(token, other)) return null;
    position += 1;
  }
  const following = next[position];
  if (following !== undefined && "char" in following && WORD.test(following.char)) return null;
  while (isMark(next[position])) position += 1;
  return position >= next.length ? "all" : position;
}

function sameVoice(
  left: Extract<IrStatement, { kind: "say" }>,
  right: Extract<IrStatement, { kind: "say" }>,
): boolean {
  return left.speaker === right.speaker && left.prose === right.prose;
}

/** Whether a statement leaves the text before it on the legacy display: a wait, an image, or a sound, without calls. */
function keepsText(statement: IrStatement): boolean {
  switch (statement.kind) {
    case "comment":
    case "blank":
    case "hideImage":
      return true;
    case "wait":
      return !hasCall(statement.duration);
    case "showImage":
      return !hasCall(statement.file);
    case "playAudio":
      return (
        !hasCall(statement.file) &&
        (statement.repeatCount === null || !hasCall(statement.repeatCount))
      );
    default:
      return false;
  }
}

function hasCall(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCall);
  if (typeof value !== "object" || value === null) return false;
  if ("kind" in value && (value.kind === "call" || value.kind === "methodCall")) return true;
  return Object.values(value).some(hasCall);
}

function withNestedBlocks(
  statement: IrStatement,
  map: (body: IrStatement[]) => IrStatement[],
): IrStatement {
  switch (statement.kind) {
    case "function":
    case "while":
    case "repeat":
    case "for":
      return { ...statement, body: map(statement.body) };
    case "if":
      return { ...statement, then: map(statement.then), else: map(statement.else) };
    case "switch":
      return {
        ...statement,
        cases: statement.cases.map((item) => ({ ...item, body: map(item.body) })),
        default: map(statement.default),
      };
    case "permanentButton":
      return statement.body === undefined ? statement : { ...statement, body: map(statement.body) };
    default:
      return statement;
  }
}
