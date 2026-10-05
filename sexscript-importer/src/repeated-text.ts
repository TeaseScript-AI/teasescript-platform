import type { IrExpression, IrStatement, MigrationDiagnostic } from "./ir.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

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

type SayStatement = Extract<IrStatement, { kind: "say" }>;
type ChainItem = {
  statement: IrStatement;
  say: SayStatement | null;
  text: Token[] | null;
  label: string | null;
};

/**
 * The legacy display also kept a script's last text when it chained to the next script, so a script that starts with
 * the text it was chained from repeated it: across `goto "file"`, the texts and the confirm button just before the
 * transfer that the target's start shows again go from the caller. The target keeps them, since other scripts may
 * enter it. Texts compare as in withoutRepeatedText, without interpolations; a button goes only where the target's
 * matching button has the same label, ignoring case.
 */
export function withoutRepeatedChainText<
  T extends { statements: IrStatement[]; diagnostics: MigrationDiagnostic[] },
>(programs: readonly T[], paths: ReadonlyArray<string | null>): T[] {
  const functions = new Map<string, IrStatement[]>();
  for (const program of programs)
    for (const statement of program.statements)
      if (statement.kind === "function") functions.set(statement.name, statement.body);
  const silentFunctions = new Map<string, boolean>();
  const silent = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.every(silent);
    if (typeof value !== "object" || value === null || !("kind" in value)) return true;
    const kind = value.kind;
    if (
      kind === "say" ||
      kind === "showButton" ||
      kind === "showPopup" ||
      kind === "permanentButton" ||
      kind === "goto" ||
      kind === "exit" ||
      kind === "choice" ||
      kind === "listChoice" ||
      kind === "input" ||
      kind === "button" ||
      kind === "function"
    )
      return false;
    if (kind === "call" && "name" in value && typeof value.name === "string") {
      const body = functions.get(value.name);
      if (body !== undefined) {
        if (!silentFunctions.has(value.name)) {
          silentFunctions.set(value.name, false);
          silentFunctions.set(value.name, silent(body));
        }
        if (!silentFunctions.get(value.name)) return false;
      }
    }
    return Object.values(value).every(silent);
  };
  const item = (statement: IrStatement): ChainItem | null => {
    if (statement.kind === "say") {
      const text = textTokens(statement.value);
      return text !== null && text.every((token) => "char" in token)
        ? { statement, say: statement, text, label: null }
        : null;
    }
    if (
      statement.kind === "showButton" &&
      statement.timeout === null &&
      statement.label.kind === "literal" &&
      typeof statement.label.value === "string"
    )
      return {
        statement,
        say: null,
        text: null,
        label: statement.label.value.trim().toLowerCase(),
      };
    return null;
  };
  const passive = (statement: IrStatement): boolean =>
    statement.kind === "comment" ||
    statement.kind === "blank" ||
    statement.kind === "hideImage" ||
    ((statement.kind === "wait" || statement.kind === "showImage" || statement.kind === "playAudio") &&
      silent(statement));
  // The outputs a script shows first, before anything else that shows or asks.
  const leading = new Map<string, ChainItem[]>();
  programs.forEach((program, index) => {
    const path = paths[index];
    if (path == null) return;
    const items: ChainItem[] = [];
    for (const statement of program.statements) {
      // A function definition runs nothing where it stands.
      if (statement.kind === "function") continue;
      const found = item(statement);
      if (found !== null) items.push(found);
      else if (!passive(statement) && !silent(statement)) break;
    }
    leading.set(path, items);
  });
  const same = (left: ChainItem, right: ChainItem): boolean => {
    if (left.say !== null && right.say !== null && left.text !== null && right.text !== null) {
      return (
        sameVoice(left.say, right.say) &&
        repeatedPart(left.text, right.text, sameToken) === "all" &&
        repeatedPart(right.text, left.text, sameToken) === "all"
      );
    }
    return left.label !== null && left.label === right.label;
  };
  return programs.map((program) => {
    let dropped = 0;
    const block = (items: IrStatement[]): IrStatement[] => {
      const result = items.map((statement) => withNestedBlocks(statement, block));
      const removed = new Set<IrStatement>();
      result.forEach((statement, index) => {
        if (statement.kind !== "goto" || statement.target.kind !== "file") return;
        const target = leading.get(statement.target.path);
        if (target === undefined || target.length === 0) return;
        const trailing: ChainItem[] = [];
        for (let position = index - 1; position >= 0; position -= 1) {
          const previous = result[position]!;
          const found = item(previous);
          if (found !== null) trailing.unshift(found);
          else if (!passive(previous)) break;
        }
        for (let count = Math.min(trailing.length, target.length); count > 0; count -= 1) {
          const tail = trailing.slice(trailing.length - count);
          if (!tail.every((entry, position) => same(entry, target[position]!))) continue;
          for (const entry of tail) removed.add(entry.statement);
          dropped += tail.length;
          break;
        }
      });
      return result.filter((statement) => !removed.has(statement));
    };
    const statements = block(program.statements);
    if (dropped === 0) return program;
    return {
      ...program,
      statements,
      diagnostics: [
        ...program.diagnostics,
        ...Array.from({ length: dropped }, (): MigrationDiagnostic => ({
          code: "SX_REPEATED_TEXT_ACROSS_CHAIN",
          severity: "info",
          message:
            "Dropped a text or button before a transfer that the target script shows again first; the legacy display kept it across the transfer.",
          span: null,
        })),
      ],
    };
  });
}

const ASKING_STATEMENTS = new Set(["let", "assign", "expression", "if", "switch", "return", "save"]);

/**
 * An ask's text is its question, which the Player says in the chat as the asking speaker before the field opens
 * (#634): a `say` right before a statement that asks once, with only comments between them and the same speaker,
 * becomes that ask's question. A loop condition asks again on every round, and an ask that a condition may skip is
 * no sure next step, so neither takes the question.
 */
export function withAskQuestions(
  statements: IrStatement[],
  diagnostics: MigrationDiagnostic[],
): IrStatement[] {
  const block = (items: IrStatement[]): IrStatement[] => {
    const result: IrStatement[] = [];
    for (const item of items) {
      const statement = withNestedBlocks(item, block);
      let position = result.length - 1;
      while (position >= 0 && result[position]!.kind === "comment") position -= 1;
      const previous = result[position];
      const merged =
        previous?.kind === "say" && previous.prose !== true
          ? withQuestion(statement, previous)
          : null;
      if (merged === null) {
        result.push(statement);
        continue;
      }
      result.splice(position, 1);
      result.push(merged);
      diagnostics.push({
        code: "SX_ASK_QUESTION",
        severity: "info",
        message: "The text said right before this ask is its question, which the Player says before the field opens.",
        span: statement.span,
      });
    }
    return result;
  };
  return block(statements);
}

/** The statement with its one sure ask taking the text as its question; null where it has no such single ask. */
function withQuestion(statement: IrStatement, say: SayStatement): IrStatement | null {
  if (!ASKING_STATEMENTS.has(statement.kind)) return null;
  let asks = 0;
  let sure = true;
  const count = (value: IrExpression, guarded: boolean): void => {
    if (value.kind === "input") {
      asks += 1;
      if (guarded || value.question !== undefined || value.speaker !== say.speaker) sure = false;
    }
    if (value.kind === "binary" && (value.operator === "and" || value.operator === "or")) {
      count(value.left, guarded);
      count(value.right, true);
      return;
    }
    mapChildren(value, (child) => {
      count(child, guarded);
      return child;
    });
  };
  mapOwnExpressions(statement, (value) => {
    count(value, false);
    return value;
  });
  if (asks !== 1 || !sure) return null;
  const ask = (value: IrExpression): IrExpression =>
    value.kind === "input" ? { ...value, question: say.value } : mapChildren(value, ask);
  return mapOwnExpressions(statement, ask);
}
