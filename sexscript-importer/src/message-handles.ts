import { SYSTEM_SPEAKER } from "./helpers.ts";
import type { IrExpression, IrStatement, MigrationDiagnostic } from "./ir.ts";
import {
  addedText,
  addsOnlyMarks,
  computes,
  hasEffect,
  withNestedBlocks,
} from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";

type Say = Extract<IrStatement, { kind: "say" }>;
type Token = { char: string } | { key: string; value: IrExpression };

/**
 * The legacy display showed one text, so authors redrew it to animate it or to count; TeaseScript can change a shown
 * message in place through its handle (V30 "Updatable messages"), which the owner wanted for these (decision
 * 2026-10-07):
 * - an animation, texts that each add only punctuation to the one before, with only waits between them (growing
 *   dots), becomes one `let line = say first, instant` and a `line.text += added` per step, or `= text` where the step
 *   is no plain extension or its values are computed, such as a random draw, which each step makes anew;
 * - a counter, a loop whose body says one text with a count, a variable the loop steps or a range loop's own, where the
 *   last text said before the loop, with only statements without effects in between, is the same line with a number
 *   or a placeholder in place of the count (`20 jerks` and `${i} jerks`) or the same text, becomes a
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
        const earlier = says[step - 1]!.value;
        const added = computes(earlier) ? null : addedText(earlier, say.value);
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
      if (!shown(inLoop)) return;
      // The last text said before the loop, with only statements without effects in between.
      let at = index - 1;
      while (at >= 0 && quiet(result[at]!)) at -= 1;
      const before = result[at];
      if (before === undefined || !shown(before) || !sameVoice(before, inLoop)) return;
      if (!sameLine(before.value, inLoop.value, loop)) return;
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

// Statements that leave the text on display as it is when their expressions have no effect.
const QUIET: ReadonlySet<string> = new Set([
  "blank",
  "comment",
  "wait",
  "let",
  "assign",
  "save",
  "delete",
  "showImage",
  "hideImage",
  "playAudio",
]);

/** Whether a statement before a counter's loop leaves the text before it on display: it has no effect but media. */
function quiet(statement: IrStatement): boolean {
  if (!QUIET.has(statement.kind)) return false;
  let calm = true;
  mapOwnExpressions(statement, (value) => {
    calm &&= !hasEffect(value);
    return value;
  });
  return calm;
}

/**
 * The names a loop counts with: those its body steps by a number, `x += 1`, `x -= 2`, or `x = x + 1`, and a range
 * loop's own.
 */
function counts(loop: Extract<IrStatement, { kind: "while" | "for" | "repeat" }>): Set<string> {
  const names = new Set<string>();
  if (loop.kind === "for" && loop.collection.kind === "range") names.add(loop.variable);
  const number = (value: IrExpression): boolean =>
    value.kind === "literal" && typeof value.value === "number";
  for (const item of loop.body) {
    if (item.kind !== "assign" || item.target.kind !== "variable") continue;
    const name = item.target.name;
    const { value } = item;
    if (
      (item.operator !== "=" && number(value)) ||
      (item.operator === "=" &&
        value.kind === "binary" &&
        (value.operator === "+" || value.operator === "-") &&
        value.left.kind === "variable" &&
        value.left.name === name &&
        number(value.right))
    )
      names.add(name);
  }
  return names;
}

/** The names the statements write, also through a member, an element, or a method of the value. */
function written(statements: readonly IrStatement[]): Set<string> {
  const names = new Set<string>();
  const base = (value: IrExpression): string | null =>
    value.kind === "variable"
      ? value.name
      : value.kind === "property" || value.kind === "index" || value.kind === "methodCall"
        ? base(value.target)
        : null;
  const visit = (item: IrStatement): void => {
    if (item.kind === "let") names.add(item.name);
    const target =
      item.kind === "assign"
        ? base(item.target)
        : item.kind === "expression"
          ? base(item.expression)
          : null;
    if (target !== null) names.add(target);
    if (item.kind === "for") names.add(item.variable);
    withNestedBlocks(item, (body) => {
      body.forEach(visit);
      return body;
    });
  };
  statements.forEach(visit);
  return names;
}

// A number or a placeholder for one: digits, punctuation, and spaces.
const COUNT = /^[\s\d.,:;!?()\-–—]*$/u;

/**
 * Whether the text said before a counter's loop and the text in the loop are one line that shows a count: the same
 * text, holding a count and otherwise only values the loop does not change, or the same around the part that changes,
 * where the text before has a number or a placeholder (or nothing) and the loop's text one count with only digits,
 * punctuation, and spaces around it, and the same part holds a word or a value of its own.
 */
function sameLine(
  before: IrExpression,
  inLoop: IrExpression,
  loop: Extract<IrStatement, { kind: "while" | "for" | "repeat" }>,
): boolean {
  const first = tokens(before);
  const next = tokens(inLoop);
  if (first === null || next === null) return false;
  const counted = counts(loop);
  const isCount = (token: Token): boolean =>
    "value" in token && token.value.kind === "variable" && counted.has(token.value.name);
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
  if (was.length === 0 && now.length === 0) {
    const changed = written(loop.body);
    const values = next.filter((token) => "value" in token);
    return (
      values.some(isCount) &&
      values.every(
        (token) =>
          isCount(token) ||
          ("value" in token && !computes(token.value) && !readsAny(token.value, changed)),
      )
    );
  }
  const nowValues = now.filter((token) => "value" in token);
  // The values around the count show the same each time round.
  const changed = written(loop.body);
  const stable = shared.every(
    (token) => !("value" in token) || (!computes(token.value) && !readsAny(token.value, changed)),
  );
  return (
    stable &&
    shared.some((token) => "value" in token || /\p{L}/u.test(token.char)) &&
    was.every((token) => "char" in token && COUNT.test(token.char)) &&
    nowValues.length === 1 &&
    isCount(nowValues[0]!) &&
    now.every((token) => "value" in token || COUNT.test(token.char))
  );
}

/** Whether the value reads one of the names. */
function readsAny(value: IrExpression, names: ReadonlySet<string>): boolean {
  if (value.kind === "variable") return names.has(value.name);
  let found = false;
  mapChildren(value, (child) => {
    found ||= readsAny(child, names);
    return child;
  });
  return found;
}

/** A literal text or a template as its characters and values; null for any other value. */
function tokens(value: IrExpression): Token[] | null {
  if (value.kind === "literal")
    return typeof value.value === "string" ? [...value.value].map((char) => ({ char })) : null;
  if (value.kind !== "template") return null;
  return value.parts.flatMap((part): Token[] =>
    "text" in part
      ? [...part.text].map((char) => ({ char }))
      : [{ key: JSON.stringify(part.value), value: part.value }],
  );
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
