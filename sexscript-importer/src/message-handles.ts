import { SYSTEM_SPEAKER } from "./helpers.ts";
import type { IrExpression, IrStatement, MigrationDiagnostic } from "./ir.ts";
import { addedText, addsOnlyMarks, withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

type Say = Extract<IrStatement, { kind: "say" }>;
type Token = { char: string } | { key: string };

/**
 * The legacy display showed one text, so authors redrew it to animate it or to count; TeaseScript can change a shown
 * message in place through its handle (V30 "Updatable messages"), which the owner wanted for these (decision
 * 2026-10-07):
 * - an animation, texts that each add only punctuation to the one before, with only waits between them (growing
 *   dots), becomes one `let line = say first, instant` and a `line.text += added` (or `= text`) per step;
 * - a counter, a loop whose body says one text with a value computed at runtime, where the last text said before the
 *   loop is the same line with a count or a placeholder in place of the value (`20 jerks` and `${i} jerks`), becomes a
 *   `let counter = say before, instant` and a `counter.text = text` in the loop.
 * The waits between the steps stay as they are: they are the animation's or the count's timing, and withReadingTimes,
 * which runs after this, only touches waits right after a `say`. The system speaker's texts stay, and so does a module's
 * code outside its functions, whose variables are global (`module`).
 */
export function withMessageHandles(
  statements: IrStatement[],
  diagnostics: MigrationDiagnostic[],
  module: boolean,
): IrStatement[] {
  // A handle's name is new in its function, or in the whole file outside functions.
  const all = usedNames(statements);
  const outside = usedNames(statements.filter((item) => item.kind !== "function"));
  for (const item of statements) if (item.kind === "function") outside.add(item.name);
  let taken = all;
  const fresh = (base: string): string => {
    let name = base;
    for (let suffix = 2; taken.has(name); suffix += 1) name = `${base}${suffix}`;
    taken.add(name);
    all.add(name);
    return name;
  };
  const report = (code: string, message: string, statement: IrStatement): void => {
    diagnostics.push({ code, severity: "info", message, span: statement.span });
  };
  const block = (items: IrStatement[], root: boolean): IrStatement[] => {
    const nested = items.map((item) => {
      if (!root || item.kind !== "function")
        return withNestedBlocks(item, (body) => block(body, false));
      const file = taken;
      taken = new Set([...outside, ...usedNames([item])]);
      const result = withNestedBlocks(item, (body) => block(body, false));
      taken = file;
      return result;
    });
    if (root && module) return nested;
    return counters(animations(nested));
  };

  const animations = (items: IrStatement[]): IrStatement[] => {
    const result = [...items];
    for (let index = 0; index < result.length; index += 1) {
      const first = result[index]!;
      if (!shown(first)) continue;
      // The steps: each next text, with only waits, blank lines, and comments before it, adds only punctuation.
      const steps = [index];
      const says: Say[] = [first];
      for (let at = index + 1; at < result.length; at += 1) {
        const item = result[at]!;
        if (
          item.kind === "blank" ||
          item.kind === "comment" ||
          (item.kind === "wait" && !item.visible)
        )
          continue;
        const last = says.at(-1)!;
        if (shown(item) && sameVoice(last, item) && addsOnlyMarks(last.value, item.value)) {
          steps.push(at);
          says.push(item);
          continue;
        }
        break;
      }
      if (steps.length < 2) continue;
      const name = fresh("line");
      report(
        "SX_MESSAGE_ANIMATION",
        "The legacy display redrew this text as an animation that adds punctuation; it is one message, whose text each step changes in place, with the legacy waits between the steps.",
        first,
      );
      result[index] = handle(first, name);
      for (let step = 1; step < says.length; step += 1) {
        const say = says[step]!;
        const added = addedText(says[step - 1]!.value, say.value);
        result[steps[step]!] = {
          kind: "assign",
          target: textOf(name),
          operator: added === null ? "=" : "+=",
          value: added ?? say.value,
          span: say.span,
        };
      }
      index = steps.at(-1)!;
    }
    return result;
  };

  const counters = (items: IrStatement[]): IrStatement[] => {
    const result = [...items];
    result.forEach((loop, index) => {
      if (loop.kind !== "while" && loop.kind !== "for" && loop.kind !== "repeat") return;
      const says = loop.body.filter((item): item is Say => item.kind === "say");
      if (says.length !== 1) return;
      const inLoop = says[0]!;
      if (!shown(inLoop) || !computed(inLoop.value)) return;
      // The last text said before the loop, with nothing that says, asks, or shows a button in between.
      let at = index - 1;
      while (at >= 0 && quiet(result[at]!)) at -= 1;
      const before = result[at];
      if (before === undefined || !shown(before) || !sameVoice(before, inLoop)) return;
      if (!sameLine(before.value, inLoop.value)) return;
      const name = fresh("counter");
      report(
        "SX_MESSAGE_COUNTER",
        "The legacy display showed this text again with a new count each time round the loop after it; it is one message, whose text the loop changes in place.",
        before,
      );
      result[at] = handle(before, name);
      result[index] = {
        ...loop,
        body: loop.body.map((item) =>
          item === inLoop
            ? {
                kind: "assign",
                target: textOf(name),
                operator: "=",
                value: inLoop.value,
                span: item.span,
              }
            : item,
        ),
      };
    });
    return result;
  };
  return block(statements, true);
}

/** A text the legacy script showed: a `say` of the script's own speaker or another, not the importer's. */
function shown(statement: IrStatement | undefined): statement is Say {
  return (
    statement?.kind === "say" && statement.speaker !== SYSTEM_SPEAKER && statement.prose !== true
  );
}

function sameVoice(left: Say, right: Say): boolean {
  return left.speaker === right.speaker;
}

function handle(say: Say, name: string): IrStatement {
  return {
    kind: "let",
    name,
    value: {
      kind: "message",
      value: say.value,
      instant: true,
      ...(say.speaker === undefined ? {} : { speaker: say.speaker }),
    },
    span: say.span,
  };
}

function textOf(name: string): IrExpression {
  return { kind: "property", target: { kind: "variable", name }, name: "text" };
}

/** Whether a statement before a counter's loop leaves the text before it shown: it says, asks, and offers nothing. */
function quiet(statement: IrStatement): boolean {
  if (statement.kind === "say" || statement.kind === "showButton" || statement.kind === "showPopup")
    return false;
  let calm = true;
  const visit = (item: IrStatement): void => {
    if (item.kind === "say" || item.kind === "showButton" || item.kind === "showPopup")
      calm = false;
    mapOwnExpressions(item, (value) => {
      if (asks(value)) calm = false;
      return value;
    });
    withNestedBlocks(item, (body) => {
      body.forEach(visit);
      return body;
    });
  };
  visit(statement);
  return calm;
}

function asks(value: IrExpression): boolean {
  if (
    value.kind === "input" ||
    value.kind === "choice" ||
    value.kind === "listChoice" ||
    value.kind === "button" ||
    value.kind === "message" ||
    (value.kind === "call" && value.name === "askImage")
  )
    return true;
  let found = false;
  mapChildren(value, (child) => {
    found ||= asks(child);
    return child;
  });
  return found;
}

/** Whether a text holds a value computed at runtime, which changes as the loop goes round. */
function computed(value: IrExpression): boolean {
  return tokens(value).some((token) => "key" in token);
}

// A count or a placeholder for one: digits, punctuation, and spaces.
const COUNT = /^[\s\d.,:;!?()\-–—]*$/u;

/**
 * Whether the text said before a counter's loop and the text in the loop are one line: the same text with a value, or
 * the same around the part that changes, where the text before has a count or a placeholder (or nothing) and the
 * loop's text a computed value, and the same part holds a word or a value of its own.
 */
function sameLine(before: IrExpression, inLoop: IrExpression): boolean {
  const first = tokens(before);
  const next = tokens(inLoop);
  const same = (left: Token, right: Token): boolean =>
    "char" in left
      ? "char" in right && left.char === right.char
      : "key" in right && left.key === right.key;
  let start = 0;
  while (start < first.length && start < next.length && same(first[start]!, next[start]!))
    start += 1;
  let end = 0;
  while (
    end < first.length - start &&
    end < next.length - start &&
    same(first[first.length - 1 - end]!, next[next.length - 1 - end]!)
  )
    end += 1;
  const shared = [...first.slice(0, start), ...first.slice(first.length - end)];
  const was = first.slice(start, first.length - end);
  const now = next.slice(start, next.length - end);
  // The same text with the same values shows them anew, as a count kept in a variable.
  if (was.length === 0 && now.length === 0) return next.some((token) => "key" in token);
  return (
    shared.some((token) => "key" in token || /\p{L}/u.test(token.char)) &&
    was.every((token) => "char" in token && COUNT.test(token.char)) &&
    now.some((token) => "key" in token)
  );
}

/** A text as its characters and values; any other value is one value. */
function tokens(value: IrExpression): Token[] {
  if (value.kind === "literal" && typeof value.value === "string")
    return [...value.value].map((char) => ({ char }));
  if (value.kind === "template")
    return value.parts.flatMap((part): Token[] =>
      "text" in part
        ? [...part.text].map((char) => ({ char }))
        : [{ key: JSON.stringify(part.value) }],
    );
  return [{ key: JSON.stringify(value) }];
}

/** Every name the statements use or declare, so that a handle's name is new. */
function usedNames(statements: readonly IrStatement[]): Set<string> {
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, field] of Object.entries(value)) {
      if (
        typeof field === "string" &&
        (key === "name" || key === "variable" || key === "valueVariable" || key === "handle")
      )
        names.add(field);
      else visit(field);
    }
  };
  visit(statements);
  return names;
}
