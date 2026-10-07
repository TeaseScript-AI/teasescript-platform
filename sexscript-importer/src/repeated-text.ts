import type { IrExpression, IrStatement, MigrationDiagnostic } from "./ir.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

/**
 * The legacy player had one text display, and every show() and question replaced the text before it, so authors
 * repeated a message to extend it. The Player keeps earlier messages, so a `say` that repeats the text output just
 * before it on the same straight path, with only waits, images, and sounds in between, says only what it adds, and
 * one that only repeats it goes. Texts compare with their whitespace and line breaks collapsed and without the final
 * punctuation of the earlier text; only literal text and interpolations of identical expressions compare. A nested
 * block, any other statement, and a call in an image or sound start over. A text that adds only punctuation to the
 * one before it, with only waits between them, is an animation, such as growing dots, and stays (owner decision
 * 2026-10-06).
 */
export function withoutRepeatedText(
  statements: IrStatement[],
  diagnostics: MigrationDiagnostic[],
): IrStatement[] {
  const report = (code: string, message: string, statement: IrStatement): void => {
    diagnostics.push({ code, severity: "info", message, span: statement.span });
  };
  const block = (items: IrStatement[]): IrStatement[] => {
    let previous: Shown | null = null;
    // Whether only waits came after the previous text.
    let onlyWaits = true;
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
        if (repeat === "all" && onlyWaits && growsByMarks(previous!.tokens, tokens)) {
          report(
            "SX_REPEATED_TEXT_ANIMATION",
            "Kept a text that adds only punctuation to the text before it, an animation such as growing dots.",
            statement,
          );
          result.push(statement);
          previous = { tokens, say: statement };
          continue;
        }
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
        onlyWaits = true;
        continue;
      }
      // A message kept in a handle (withMessageHandles) shows its text, and a change of its text shows the new one.
      const handle = handleText(statement, previous?.handle === undefined ? null : previous);
      if (handle !== undefined) {
        previous = handle;
        onlyWaits = true;
        result.push(statement);
        continue;
      }
      if (!keepsText(statement)) previous = null;
      if (statement.kind !== "wait" && statement.kind !== "comment" && statement.kind !== "blank")
        onlyWaits = false;
      result.push(statement);
    }
    return result;
  };
  return block(statements);
}

/** The text on display: the last text said, or the current text of a message kept in a handle (`handle`). */
type Shown = { tokens: Token[]; say: Extract<IrStatement, { kind: "say" }>; handle?: string };

/**
 * The text on display after a statement that creates a message handle or changes its text, null where that text is
 * not known; undefined for any other statement. `shown` is what a handle showed before.
 */
function handleText(statement: IrStatement, shown: Shown | null): Shown | null | undefined {
  if (statement.kind === "let" && statement.value.kind === "message") {
    const { value, speaker } = statement.value;
    const tokens = textTokens(value);
    if (tokens === null) return null;
    const say: Extract<IrStatement, { kind: "say" }> = {
      kind: "say",
      value,
      ...(speaker === undefined ? {} : { speaker }),
      span: statement.span,
    };
    return { tokens, say, handle: statement.name };
  }
  if (
    statement.kind !== "assign" ||
    statement.target.kind !== "property" ||
    statement.target.name !== "text" ||
    statement.target.target.kind !== "variable"
  )
    return undefined;
  const name = statement.target.target.name;
  const tokens = textTokens(statement.value);
  if (shown?.handle !== name || tokens === null) return null;
  return { ...shown, tokens: statement.operator === "+=" ? [...shown.tokens, ...tokens] : tokens };
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
  // A value computed anew each time, such as a random draw, matches no other.
  return value.parts.flatMap((part): Token[] =>
    "text" in part
      ? [...part.text].map((char) => ({ char }))
      : [
          {
            value: part.value,
            key: computes(part.value)
              ? `computed ${(computedValues += 1)}`
              : JSON.stringify(part.value),
          },
        ],
  );
}
let computedValues = 0;

/** Whether a value calls, asks, or reads storage, which may give another result each time, as a random draw does. */
export function computes(value: IrExpression): boolean {
  if (
    value.kind === "call" ||
    value.kind === "methodCall" ||
    value.kind === "input" ||
    value.kind === "choice" ||
    value.kind === "listChoice" ||
    value.kind === "button" ||
    value.kind === "message" ||
    value.kind === "load" ||
    (value.kind === "property" && value.name === "random")
  )
    return true;
  let found = false;
  mapChildren(value, (child) => {
    found ||= computes(child);
    return child;
  });
  return found;
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
    return {
      kind: "literal",
      value: parts.map((part) => ("text" in part ? part.text : "")).join(""),
    };
  return { kind: "template", parts };
}

/** Whether the text `next` adds only punctuation to the text `earlier`, a step of an animation such as growing dots. */
export function addsOnlyMarks(earlier: IrExpression, next: IrExpression): boolean {
  const before = textTokens(earlier);
  const after = textTokens(next);
  return before !== null && after !== null && growsByMarks(before, after);
}

/** What the text `next` adds after the whole text `earlier`, exactly as written; null where it does not start with it. */
export function addedText(earlier: IrExpression, next: IrExpression): IrExpression | null {
  const before = textTokens(earlier);
  const after = textTokens(next);
  if (before === null || after === null || after.length <= before.length) return null;
  return before.every((token, index) => sameToken(token, after[index]!))
    ? textValue(after.slice(before.length))
    : null;
}

/** Whether `next` is `earlier` in full, whitespace runs alike, followed by punctuation and whitespace only. */
function growsByMarks(earlier: readonly Token[], next: readonly Token[]): boolean {
  const flat = (tokens: readonly Token[]): string =>
    tokens
      .map((token) => ("char" in token ? token.char : `\u0000${token.key}\u0000`))
      .join("")
      .replaceAll(/\s+/gu, " ")
      .trim();
  const before = flat(earlier);
  const after = flat(next);
  return (
    before !== "" &&
    after.length > before.length &&
    after.startsWith(before) &&
    /^[\s.!?,;:…]+$/u.test(after.slice(before.length))
  );
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
    token !== undefined &&
    "char" in token &&
    (SPACE.test(token.char) || PUNCTUATION.test(token.char));
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

export function withNestedBlocks(
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
      kind === "message" ||
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
    ((statement.kind === "wait" ||
      statement.kind === "showImage" ||
      statement.kind === "playAudio") &&
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

/** An ask that says a question before it opens: a single-field input or a form, or `askImage`. */
export function isAsk(value: IrExpression): boolean {
  return value.kind === "input" || (value.kind === "call" && value.name === "askImage");
}

/** Built-ins and generated helpers whose calls only compute a value. */
const PURE_CALLS: ReadonlySet<string> = new Set([
  "toInteger",
  "toNumber",
  "toString",
  "floor",
  "ceil",
  "round",
  "min",
  "max",
  "randomInteger",
  "abs",
  "getTimestamp",
  "sexscriptLegacyLoadFloat",
  "sexscriptLegacyLoadInteger",
  "sexscriptLegacyValue",
  "sexscriptLegacyCompare",
  "sexscriptLegacyIndexOf",
  "sexscriptLegacyItemAt",
  "sexscriptLegacyItems",
  "sexscriptLegacyPlainText",
  "sexscriptLegacyTruth",
]);

/** Text and list methods that only read their receiver. */
const PURE_METHODS: ReadonlySet<string> = new Set([
  "contains",
  "endsWith",
  "indexOf",
  "join",
  "lastIndexOf",
  "lowercase",
  "replace",
  "split",
  "startsWith",
  "substring",
  "toSeconds",
  "trim",
  "uppercase",
  "uppercaseFirst",
]);

/** Whether evaluating this node itself, apart from its children, may have an effect: a call, a change, or an interaction. */
export function ownEffect(value: IrExpression): boolean {
  switch (value.kind) {
    case "call":
      return !PURE_CALLS.has(value.name);
    case "methodCall":
      return !PURE_METHODS.has(value.name);
    case "input":
    case "choice":
    case "listChoice":
    case "button":
    case "message":
      return true;
    default:
      return false;
  }
}

/** Whether evaluating the value may have an effect anywhere in it. */
export function hasEffect(value: IrExpression): boolean {
  let found = ownEffect(value);
  mapChildren(value, (child) => {
    found ||= hasEffect(child);
    return child;
  });
  return found;
}

/** Whether the statement runs something with an effect before it reaches `target`, in evaluation order. */
export function effectBefore(statement: IrStatement, target: IrExpression): boolean {
  let effect = false;
  let reached = false;
  const visit = (value: IrExpression): void => {
    if (reached) return;
    if (value === target) {
      reached = true;
      return;
    }
    mapChildren(value, (child) => {
      visit(child);
      return child;
    });
    if (!reached && ownEffect(value)) effect = true;
  };
  mapOwnExpressions(statement, (value) => {
    visit(value);
    return value;
  });
  return reached && effect;
}

export const ASKING_STATEMENTS: ReadonlySet<string> = new Set([
  "let",
  "assign",
  "expression",
  "if",
  "switch",
  "return",
  "save",
  "showImage",
]);

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
        message:
          "The text said right before this ask is its question, which the Player says before the field opens.",
        span: statement.span,
      });
    }
    return result;
  };
  return block(statements);
}

/**
 * The statement with its one sure ask taking the text as its question; null where it has no such single ask. An
 * `askImage` whose message already says the same text keeps it, and the `say` goes.
 */
function withQuestion(statement: IrStatement, say: SayStatement): IrStatement | null {
  if (!ASKING_STATEMENTS.has(statement.kind)) return null;
  let asks = 0;
  let sure = true;
  let found: IrExpression | null = null;
  const said = textTokens(say.value);
  const count = (value: IrExpression, guarded: boolean): void => {
    if (isAsk(value)) found = value;
    if (value.kind === "input") {
      asks += 1;
      if (guarded || value.question !== undefined || value.speaker !== say.speaker) sure = false;
    }
    if (value.kind === "call" && value.name === "askImage") {
      asks += 1;
      const message = value.positional[0];
      const asked = message === undefined ? null : textTokens(message);
      const repeats =
        said !== null &&
        asked !== null &&
        repeatedPart(said, asked, sameToken) === "all" &&
        repeatedPart(asked, said, sameToken) === "all";
      const empty = message === undefined || (message.kind === "literal" && message.value === null);
      if (guarded || say.speaker !== undefined || !(empty || repeats)) sure = false;
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
  // The text is said where the ask opens, so nothing with an effect may run in the statement before it.
  if (asks !== 1 || !sure || found === null || effectBefore(statement, found)) return null;
  const ask = (value: IrExpression): IrExpression => {
    if (value.kind === "input") return { ...value, question: say.value };
    if (value.kind === "call" && value.name === "askImage") {
      const message = value.positional[0];
      return message === undefined || (message.kind === "literal" && message.value === null)
        ? { ...value, positional: [say.value, ...value.positional.slice(1)] }
        : value;
    }
    return mapChildren(value, ask);
  };
  return mapOwnExpressions(statement, ask);
}

/**
 * An empty legacy text only cleared the display, which a chat has no use for: a `say` of a blank literal, or of a
 * variable that the program declares once with a blank literal and never assigns again, goes, and so does that
 * variable's declaration where nothing reads it any more. Other text stays. `variables` is false for a module, whose
 * variables other files may write.
 */
export function withoutBlankText(
  statements: IrStatement[],
  diagnostics: MigrationDiagnostic[],
  variables = true,
): IrStatement[] {
  const writes = new Map<string, number>();
  const blankStarts = new Set<string>();
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(scan);
    if (typeof value !== "object" || value === null || !("kind" in value)) return;
    if (value.kind === "let" && "name" in value && typeof value.name === "string") {
      writes.set(value.name, (writes.get(value.name) ?? 0) + 1);
      if ("value" in value && isBlank(value.value)) blankStarts.add(value.name);
    }
    if (
      value.kind === "assign" &&
      "target" in value &&
      typeof value.target === "object" &&
      value.target !== null &&
      "kind" in value.target &&
      value.target.kind === "variable" &&
      "name" in value.target &&
      typeof value.target.name === "string"
    )
      writes.set(value.target.name, (writes.get(value.target.name) ?? 0) + 2);
    if (value.kind === "for" && "variable" in value && typeof value.variable === "string")
      writes.set(value.variable, (writes.get(value.variable) ?? 0) + 2);
    if (value.kind === "function" && "parameters" in value && Array.isArray(value.parameters))
      for (const parameter of value.parameters)
        if (typeof parameter === "object" && parameter !== null && "name" in parameter)
          writes.set(String(parameter.name), (writes.get(String(parameter.name)) ?? 0) + 2);
    Object.values(value).forEach(scan);
  };
  scan(statements);
  const blank = (value: IrExpression): boolean =>
    isBlank(value) ||
    (variables &&
      value.kind === "variable" &&
      blankStarts.has(value.name) &&
      writes.get(value.name) === 1);
  let dropped = 0;
  const drop = (items: IrStatement[]): IrStatement[] =>
    items.flatMap((item): IrStatement[] => {
      if (item.kind === "say" && blank(item.value)) {
        dropped += 1;
        diagnostics.push({
          code: "SX_BLANK_TEXT",
          severity: "info",
          message: "Dropped an empty text, which only cleared the legacy display.",
          span: item.span,
        });
        return [];
      }
      return [withNestedBlocks(item, drop)];
    });
  const kept = drop(statements);
  if (dropped === 0) return kept;
  // A blank variable that nothing reads now goes too.
  const read = new Set<string>();
  const reads = (value: unknown): void => {
    if (Array.isArray(value)) value.forEach(reads);
    if (typeof value !== "object" || value === null) return;
    if ("kind" in value && value.kind === "variable" && "name" in value)
      read.add(String(value.name));
    Object.values(value).forEach(reads);
  };
  reads(kept);
  const prune = (items: IrStatement[]): IrStatement[] =>
    items
      .filter(
        (item) =>
          !(
            item.kind === "let" &&
            blankStarts.has(item.name) &&
            writes.get(item.name) === 1 &&
            item.global !== true &&
            !read.has(item.name)
          ),
      )
      .map((item) => withNestedBlocks(item, prune));
  return prune(kept);
}

function isBlank(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "literal" &&
    "value" in value &&
    typeof value.value === "string" &&
    value.value.trim() === ""
  );
}
