import { SYSTEM_SPEAKER } from "./helpers.ts";
import type { IrExpression, IrStatement, MigrationDiagnostic } from "./ir.ts";
import { hasEffect, ownEffect, withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";
import { repositoryBuildUrl } from "./repository-build.ts";

// The Player's default reading time of a `say` (docs/RUNTIME.md "Smart-autoplay session settings").
const BASE_MS = 1500;
const WORD_MS = 300;
const CHARACTER_MS = 30;
// A wait up to this many times the reading time of the text before it timed its reading (owner decision 2026-10-07).
const READING_WAIT_RATIO = 1.5;
// The longest wait that is a loop's tick, after a text the loop builds anew each pass.
const TICK_MS = 1000;

const visibleText = await loadVisibleText();

/**
 * Legacy `show()` displayed its text at once, so authors timed its reading with the `wait()` after it, where the Player
 * gives every `say` a skippable reading time. A literal wait right after a text, at most 1.5 times the text's reading
 * time, goes and the Player's reading time takes over; this includes a wait before a button or an ask, where the player
 * decides when to go on (owner decisions 2026-10-07). A longer wait is time for an action or a task and stays
 * (`afterText`), as does any other wait. A text before a wait that stays appears without reading time (`instant`, owner
 * decision 2026-10-05), so that the wait alone sets its timing; withoutCutReadingTimes takes it away again where it
 * would cut short a reading time that replaced a wait.
 *
 * The reading time is measured on the whole legacy text, before withParagraphs splits it and withoutRepeatedText
 * shortens it, as the visible text of its message markup; a value interpolated at runtime counts as empty, so the
 * measure is the shortest reading time the text can have. A wait stays as it is where another wait follows it, a pause
 * the author made; after the system speaker's text, which the importer adds; and where it keeps a beat (owner decision
 * 2026-10-07): after a text without letters, which has nothing to read (`3`, `...`), and a loop's tick, a second at
 * most after a text the loop's body builds anew each pass, as a clock or a countdown does. A beat's text keeps
 * `instant`. Animations keep their waits as updatable messages (withMessageHandles).
 */
export function withReadingTimes(
  statements: IrStatement[],
  diagnostics: MigrationDiagnostic[],
): IrStatement[] {
  const report = (code: string, message: string, statement: IrStatement): void => {
    diagnostics.push({ code, severity: "info", message, span: statement.span });
  };
  const block = (items: IrStatement[], loopBody = false): IrStatement[] => {
    const nested = items.map((item) =>
      withNestedBlocks(item, (body) =>
        block(body, item.kind === "while" || item.kind === "repeat" || item.kind === "for"),
      ),
    );
    // The index of the next statement that is no blank line or comment, -1 for none.
    const next: number[] = Array.from(nested, () => -1);
    for (let index = nested.length - 2; index >= 0; index -= 1)
      next[index] = significant(nested[index + 1]!) ? index + 1 : next[index + 1]!;
    const result = [...nested];
    const dropped = new Set<number>();
    nested.forEach((statement, index) => {
      if (statement.kind !== "say") return;
      const waitIndex = next[index]!;
      const wait = nested[waitIndex];
      if (wait?.kind !== "wait" || wait.visible) return;
      const milliseconds = literalMilliseconds(wait);
      const after = nested[next[waitIndex]!];
      if (milliseconds === null || statement.speaker === SYSTEM_SPEAKER || after?.kind === "wait") {
        result[index] = { ...statement, instant: true };
        return;
      }
      if (milliseconds > READING_WAIT_RATIO * shortestReadingTime(statement.value)) {
        result[waitIndex] = { ...wait, afterText: true };
        report(
          "SX_WAIT_KEPT",
          "The legacy wait after this text is longer than 1.5 times the text's reading time, time for an action or a task, so it stays and the text appears without reading time.",
          statement,
        );
        result[index] = { ...statement, instant: true };
        return;
      }
      // A text without letters, such as `3` or `...`, has nothing to read: its wait is a beat, as of a countdown.
      if (letterless(statement.value)) {
        report(
          "SX_WAIT_BEAT",
          "This text has no words to read, a count or a pause such as `3` or `...`, so the legacy wait after it is its beat, which stays, and the text appears without reading time.",
          statement,
        );
        result[index] = { ...statement, instant: true, beat: true };
        return;
      }
      // A loop that says a text it builds anew each pass, a second at most apart, ticks: a clock or a countdown.
      if (loopBody && milliseconds <= TICK_MS && builtAtRuntime(statement.value)) {
        report(
          "SX_WAIT_TICK",
          "The legacy wait after this text, which the loop builds anew each pass, is the loop's tick, a clock or a countdown, so it stays and the text appears without reading time.",
          statement,
        );
        result[index] = { ...statement, instant: true, beat: true };
        return;
      }
      report(
        "SX_WAIT_READING",
        "The legacy wait after this text timed its reading, at most 1.5 times the Player's reading time of the text, so the Player's skippable reading time replaces it.",
        statement,
      );
      result[index] = { ...statement, readingTime: wait };
      dropped.add(waitIndex);
    });
    return dropped.size === 0 ? result : result.filter((_, index) => !dropped.has(index));
  };
  return block(statements);
}

/**
 * `instant` also ends the reading time of the text before it while that still runs (docs/RUNTIME.md, "`instant`, `0`,
 * and `wait`"), so a text keeps `instant` only where no reading time that replaced a legacy wait (`readingTime`) can
 * still run when it is said, as its own block shows on the straight path before it: after a text said at once or one
 * without such a reading time, after a button, an ask, or a choice that surely opens, or media, which wait for it, or
 * after literal waits as long as a fixed text's reading time; statements without effects leave this as it is. Anywhere
 * else, at the start of a function, a loop's body, or a script, after a call or a transfer, or where a reading time of
 * a text with values may still run, the text keeps its own reading time instead and waits for the one before it.
 *
 * A beat keeps `instant` (owner decision 2026-10-07), so a text whose replaced reading time may still run when a beat
 * is said keeps its legacy wait and `instant` instead, as before the rule; a reading time of unknown origin, after a
 * call or where a loop's earlier pass may have left one, gives way to the beat. This runs after the passes that split,
 * shorten, and fold texts, on the texts they leave.
 */
export function withoutCutReadingTimes(
  statements: IrStatement[],
  diagnostics: MigrationDiagnostic[],
): IrStatement[] {
  // The replaced legacy waits whose texts keep them for a beat after them.
  const restored = new Set<WaitStatement>();
  let current = statements;
  for (;;) {
    const found = new Set<WaitStatement>();
    walkTexts(current, (wait) => found.add(wait), null);
    const added = [...found].filter((wait) => !restored.has(wait));
    if (added.length === 0) break;
    for (const wait of added) restored.add(wait);
    current = withRestoredWaits(current, restored, diagnostics);
  }
  return walkTexts(current, () => {}, diagnostics);
}

type WaitStatement = Extract<IrStatement, { kind: "wait" }>;

/**
 * The reading time that may still run: `left` milliseconds (0 for none, Infinity for one of unknown length) from the
 * texts whose replaced waits `sources` holds, and possibly others of unknown origin.
 */
interface Running {
  left: number;
  sources: ReadonlySet<WaitStatement>;
}

const NONE: Running = { left: 0, sources: new Set() };
const UNKNOWN_TIME = (sources: ReadonlySet<WaitStatement>): Running => ({
  left: Infinity,
  sources,
});

function joined(first: Running, second: Running): Running {
  if (first.left === 0) return second;
  if (second.left === 0) return first;
  return {
    left: Math.max(first.left, second.left),
    sources: new Set([...first.sources, ...second.sources]),
  };
}

/**
 * One walk over the statements: takes `instant` away where a reading time may still run, and reports to `beat` the
 * replaced waits whose reading time a beat would end. `diagnostics` is null for a walk that only looks.
 */
function walkTexts(
  statements: IrStatement[],
  beat: (wait: WaitStatement) => void,
  diagnostics: MigrationDiagnostic[] | null,
): IrStatement[] {
  const paced = (statement: IrStatement): void => {
    diagnostics?.push({
      code: "SX_WAIT_KEPT_PACED",
      severity: "info",
      message:
        "This text keeps its reading time: said at once, it could cut short the reading time of a text before it that replaced a legacy wait, so it waits for that one first.",
      span: statement.span,
    });
  };
  const after = (values: readonly IrExpression[], running: Running): Running => {
    const left = afterValues(values, running.left);
    return left === 0 ? NONE : left === Infinity ? UNKNOWN_TIME(running.sources) : running;
  };
  const own = (statement: IrStatement, running: Running): Running => {
    if (LEAVING.has(statement.kind)) return UNKNOWN_TIME(running.sources);
    const values: IrExpression[] = [];
    mapOwnExpressions(statement, (value) => {
      values.push(value);
      return value;
    });
    return after(values, running);
  };
  const walk = (items: readonly IrStatement[], running: Running): [IrStatement[], Running] => {
    const result: IrStatement[] = [];
    let state = running;
    for (const item of items) {
      const [statement, next] = step(item, state);
      result.push(statement);
      state = next;
    }
    return [result, state];
  };
  const step = (item: IrStatement, running: Running): [IrStatement, Running] => {
    // A message kept in a handle (withMessageHandles) is said as a `say` is, after its text is computed.
    if ((item.kind === "let" || item.kind === "assign") && item.value.kind === "message") {
      const { instant, ...message } = item.value;
      const before = after([message.value], running);
      if (instant !== true || before.left === 0) return [item, NONE];
      paced(item);
      return [{ ...item, value: message }, NONE];
    }
    switch (item.kind) {
      case "say": {
        // The text is computed first, which may say something itself.
        const before = own(item, running);
        if (item.instant === true) {
          if (before.left === 0) return [item, NONE];
          // A beat stays as the legacy script timed it; the texts whose reading time it would end keep their waits.
          if (item.beat === true) {
            before.sources.forEach(beat);
            return [item, NONE];
          }
          paced(item);
          const { instant: _instant, ...rest } = item;
          return [rest, NONE];
        }
        return [
          item,
          item.readingTime === undefined
            ? NONE
            : { left: readingLength(item.value), sources: new Set([item.readingTime]) },
        ];
      }
      case "wait": {
        const { duration } = item;
        if (duration.kind !== "literal" || typeof duration.value !== "number")
          return [item, own(item, running)];
        const milliseconds = item.unit === "ms" ? duration.value : duration.value * 1000;
        const left = running.left - milliseconds;
        return [item, left > 0 ? { ...running, left } : NONE];
      }
      case "showButton":
        return [item, NONE];
      // Media wait for the reading time first and then compute what they show, which may say something itself.
      case "showImage":
      case "hideImage":
      case "playAudio":
        return [item, own(item, NONE)];
      case "if": {
        const before = own(item, running);
        const [then, afterThen] = walk(item.then, before);
        const [otherwise, afterElse] = walk(item.else, before);
        return [{ ...item, then, else: otherwise }, joined(afterThen, afterElse)];
      }
      case "switch": {
        const before = own(item, running);
        let most = NONE;
        const cases = item.cases.map((switchCase) => {
          const [body, next] = walk(switchCase.body, before);
          most = joined(most, next);
          return { ...switchCase, body };
        });
        const [fallback, afterDefault] = walk(item.default, before);
        return [{ ...item, cases, default: fallback }, joined(most, afterDefault)];
      }
      case "while":
      case "repeat":
      case "for": {
        // A pass of the body may follow another pass or a `continue`, so it starts unknown, with what came before.
        const [body] = walk(item.body, UNKNOWN_TIME(running.sources));
        const next = { ...item, body };
        return [next, transparent(item) ? running : UNKNOWN_TIME(running.sources)];
      }
      case "function":
        return [{ ...item, body: walk(item.body, UNKNOWN_TIME(new Set()))[0] }, running];
      case "permanentButton":
        return [
          item.body === undefined
            ? item
            : { ...item, body: walk(item.body, UNKNOWN_TIME(new Set()))[0] },
          running,
        ];
      default:
        return [item, transparent(item) ? running : own(item, running)];
    }
  };
  return walk(statements, UNKNOWN_TIME(new Set()))[0];
}

/**
 * The statements with the replaced waits in `restored` back after their texts, after the last paragraph of a split
 * text, and a text that was not split said at once again, as before the rule.
 */
function withRestoredWaits(
  statements: IrStatement[],
  restored: ReadonlySet<WaitStatement>,
  diagnostics: MigrationDiagnostic[],
): IrStatement[] {
  const block = (items: IrStatement[]): IrStatement[] => {
    const nested = items.map((item) => withNestedBlocks(item, block));
    const pieces = new Map<WaitStatement, number>();
    for (const item of nested)
      if (item.kind === "say" && item.readingTime !== undefined && restored.has(item.readingTime))
        pieces.set(item.readingTime, (pieces.get(item.readingTime) ?? 0) + 1);
    if (pieces.size === 0) return nested;
    const seen = new Map<WaitStatement, number>();
    return nested.flatMap((item): IrStatement[] => {
      if (item.kind !== "say" || item.readingTime === undefined || !restored.has(item.readingTime))
        return [item];
      const wait = item.readingTime;
      const count = (seen.get(wait) ?? 0) + 1;
      seen.set(wait, count);
      const { readingTime: _readingTime, ...text } = item;
      if (count < pieces.get(wait)!) return [text];
      diagnostics.push({
        code: "SX_WAIT_FOR_BEAT",
        severity: "info",
        message:
          "The legacy wait after this text stays, and the text is said at once again: a beat that follows, which keeps its timing, would cut its reading time short.",
        span: item.span,
      });
      // Said at once again, the text keeps that as a beat does, and the texts before it keep their waits in turn.
      return [pieces.get(wait) === 1 ? { ...text, instant: true, beat: true } : text, wait];
    });
  };
  return block(statements);
}

// Statements after which nothing runs on the straight path, or that run code elsewhere.
const LEAVING: ReadonlySet<string> = new Set(["goto", "exit", "return", "break", "continue"]);

/**
 * The reading time that may run after values are computed: unknown after an effect such as a call, which may say a
 * text; otherwise none after an ask, a button, or a choice that surely opens; and as before without effects.
 */
function afterValues(values: readonly IrExpression[], running: number): number {
  if (values.some(effectBesidesAsks)) return Infinity;
  return values.some(surelyAsks) ? 0 : running;
}

/** Whether evaluating the value has an effect other than opening an ask, a button, or a choice. */
function effectBesidesAsks(value: IrExpression): boolean {
  if (!asking(value) && ownEffect(value)) return true;
  let found = false;
  mapChildren(value, (child) => {
    found ||= effectBesidesAsks(child);
    return child;
  });
  return found;
}

function asking(value: IrExpression): boolean {
  return (
    value.kind === "input" ||
    value.kind === "button" ||
    value.kind === "choice" ||
    value.kind === "listChoice" ||
    (value.kind === "call" && value.name === "askImage")
  );
}

/** Whether evaluating the value surely opens an ask, a button, or a choice, not on one side of `and` or `or` only. */
function surelyAsks(value: IrExpression): boolean {
  if (asking(value)) return true;
  if (value.kind === "binary")
    return value.operator === "and" || value.operator === "or"
      ? surelyAsks(value.left)
      : surelyAsks(value.left) || surelyAsks(value.right);
  return value.kind === "unary" && surelyAsks(value.value);
}

/** Whether a statement and everything in it say nothing, wait for nothing, and have no effect, and leave nowhere. */
function transparent(statement: IrStatement): boolean {
  if (statement.kind === "say" || statement.kind === "function" || LEAVING.has(statement.kind))
    return false;
  if (
    ["showButton", "showImage", "hideImage", "playAudio", "permanentButton"].includes(
      statement.kind,
    )
  )
    return false;
  let clean = true;
  mapOwnExpressions(statement, (value) => {
    clean &&= !hasEffect(value);
    return value;
  });
  withNestedBlocks(statement, (body) => {
    clean &&= body.every(transparent);
    return body;
  });
  return clean;
}

/** A text's reading time where its words are fixed; unknown (Infinity) where values change its length. */
function readingLength(value: IrExpression): number {
  const fixed =
    (value.kind === "literal" && typeof value.value === "string") ||
    (value.kind === "template" && value.parts.every((part) => "text" in part));
  return fixed ? shortestReadingTime(value) : Infinity;
}

function significant(statement: IrStatement): boolean {
  return statement.kind !== "blank" && statement.kind !== "comment";
}

/** Whether a fixed text shows no letter, as a count or a pause does (`3`, `?`, `. . .`). */
function letterless(value: IrExpression): boolean {
  return (
    value.kind === "literal" &&
    typeof value.value === "string" &&
    value.value.trim() !== "" &&
    !/\p{L}/u.test(visibleText(value.value))
  );
}

/** Whether a text holds a value computed at runtime, or is one. */
function builtAtRuntime(value: IrExpression): boolean {
  if (value.kind === "literal") return false;
  return value.kind !== "template" || value.parts.some((part) => "value" in part);
}

/** The duration of a wait of a number literal, in milliseconds; null for a computed one. */
function literalMilliseconds(wait: Extract<IrStatement, { kind: "wait" }>): number | null {
  const { duration } = wait;
  if (duration.kind !== "literal" || typeof duration.value !== "number" || duration.value < 0)
    return null;
  return wait.unit === "ms" ? duration.value : duration.value * 1000;
}

/**
 * The Player's default reading time of a shown text, in milliseconds, with every interpolated value empty: 1500 ms plus
 * 300 ms per word or 30 ms per visible character, whichever is more. A text computed at runtime has the base time.
 */
export function shortestReadingTime(value: IrExpression): number {
  const text = visibleText(literalText(value));
  const words = text.match(/\S+/gu)?.length ?? 0;
  return BASE_MS + Math.max(words * WORD_MS, [...text].length * CHARACTER_MS);
}

/** A shown text's own words, its literal parts without the values interpolated in it; empty for a computed text. */
function literalText(value: IrExpression): string {
  if (value.kind === "literal") return typeof value.value === "string" ? value.value : "";
  if (value.kind === "template")
    return value.parts.map((part) => ("text" in part ? part.text : "")).join("");
  return "";
}

/** The visible text of message markup, from the repository build's shared markup parser. */
async function loadVisibleText(): Promise<(text: string) => string> {
  const url = repositoryBuildUrl("src/index.js");
  let module: unknown;
  try {
    module = await import(url.href);
  } catch (error) {
    throw new Error(
      `TeaseScript build not found at ${url.pathname}; run "npm run build:typescript" in the repository root.`,
      { cause: error },
    );
  }
  const parse =
    typeof module === "object" && module !== null && "parseMessageMarkup" in module
      ? module.parseMessageMarkup
      : undefined;
  if (typeof parse !== "function")
    throw new Error("Repository build does not export parseMessageMarkup().");
  return (text) => {
    const parsed: unknown = parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("visibleText" in parsed) ||
      typeof parsed.visibleText !== "string"
    )
      throw new Error("parseMessageMarkup() returned no visible text.");
    return parsed.visibleText;
  };
}
