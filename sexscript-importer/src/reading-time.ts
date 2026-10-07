import { SYSTEM_SPEAKER } from "./helpers.ts";
import type { IrExpression, IrStatement, MigrationDiagnostic } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";
import { mapChildren, mapOwnExpressions } from "./variable-types.ts";
import { repositoryBuildUrl } from "./repository-build.ts";

// The Player's default reading time of a `say` (docs/RUNTIME.md "Smart-autoplay session settings").
const BASE_MS = 1500;
const WORD_MS = 300;
const CHARACTER_MS = 30;
// A wait up to this many times the reading time of the text before it timed its reading (owner decision 2026-10-07).
const READING_WAIT_RATIO = 1.5;

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
 * the author made, and after the system speaker's text, which the importer adds.
 */
export function withReadingTimes(
  statements: IrStatement[],
  diagnostics: MigrationDiagnostic[],
): IrStatement[] {
  const report = (code: string, message: string, statement: IrStatement): void => {
    diagnostics.push({ code, severity: "info", message, span: statement.span });
  };
  const block = (items: IrStatement[]): IrStatement[] => {
    const nested = items.map((item) => withNestedBlocks(item, block));
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
      report(
        "SX_WAIT_READING",
        "The legacy wait after this text timed its reading, at most 1.5 times the Player's reading time of the text, so the Player's skippable reading time replaces it.",
        statement,
      );
      result[index] = { ...statement, readingTime: true };
      dropped.add(waitIndex);
    });
    return dropped.size === 0 ? result : result.filter((_, index) => !dropped.has(index));
  };
  return block(statements);
}

/**
 * `instant` also ends the reading time of the text before it while that still runs (docs/RUNTIME.md, "`instant`, `0`,
 * and `wait`"), so a text keeps no `instant` where the reading time of a text whose legacy wait it replaced
 * (`readingTime`) may still run: on some path from that text, with no button, ask, or media in between and less
 * waiting than its reading time. The text then waits for that reading time and keeps its own, which the wait after it,
 * if any, overlaps. This runs after the passes that split, shorten, and fold texts, on the texts they leave.
 */
export function withoutCutReadingTimes(
  statements: IrStatement[],
  diagnostics: MigrationDiagnostic[],
): IrStatement[] {
  // A walk gives the statements and the reading time, in milliseconds, that may still run after them (0 for none);
  // a trial walk, which finds what a loop's body leaves running, reports nothing.
  const walk = (items: IrStatement[], running: number, trial = false): [IrStatement[], number] => {
    const result: IrStatement[] = [];
    let left = running;
    for (const item of items) {
      const [statement, after] = step(item, left, trial);
      result.push(statement);
      left = after;
    }
    return [result, left];
  };
  const step = (item: IrStatement, running: number, trial: boolean): [IrStatement, number] => {
    if (item.kind === "function") return [{ ...item, body: walk(item.body, 0, trial)[0] }, running];
    if (item.kind === "permanentButton")
      return [
        item.body === undefined ? item : { ...item, body: walk(item.body, 0, trial)[0] },
        running,
      ];
    const left = ENDS_READING.has(item.kind) || asks(item) ? 0 : running;
    switch (item.kind) {
      case "say": {
        if (item.instant === true && left > 0) {
          if (!trial)
            diagnostics.push({
              code: "SX_WAIT_KEPT_PACED",
              severity: "info",
              message:
                "This text keeps its reading time: `instant` would cut short the reading time of a text before it that replaced a legacy wait; the text waits for that one first.",
              span: item.span,
            });
          const { instant: _instant, ...paced } = item;
          return [paced, shortestReadingTime(item.value)];
        }
        if (item.instant === true) return [item, 0];
        return [item, item.readingTime === true ? shortestReadingTime(item.value) : 0];
      }
      case "wait": {
        const { duration } = item;
        if (duration.kind !== "literal" || typeof duration.value !== "number") return [item, left];
        const milliseconds = item.unit === "ms" ? duration.value : duration.value * 1000;
        return [item, Math.max(0, left - milliseconds)];
      }
      case "if": {
        const [then, afterThen] = walk(item.then, left, trial);
        const [otherwise, afterElse] = walk(item.else, left, trial);
        return [{ ...item, then, else: otherwise }, Math.max(afterThen, afterElse)];
      }
      case "switch": {
        let most = item.default.length === 0 ? left : 0;
        const cases = item.cases.map((switchCase) => {
          const [body, after] = walk(switchCase.body, left, trial);
          most = Math.max(most, after);
          return { ...switchCase, body };
        });
        const [fallback, afterDefault] = walk(item.default, left, trial);
        return [{ ...item, cases, default: fallback }, Math.max(most, afterDefault)];
      }
      case "while":
      case "repeat":
      case "for": {
        // A loop's body starts after what came before it or after its own end.
        const entry = Math.max(left, walk(item.body, left, true)[1]);
        const [body, after] = walk(item.body, entry, trial);
        return [{ ...item, body }, Math.max(left, after)];
      }
      default:
        return [item, left];
    }
  };
  return walk(statements, 0)[0];
}

// A button ends the reading time before it, and media wait for it (docs/RUNTIME.md "Media pacing barrier").
const ENDS_READING: ReadonlySet<string> = new Set([
  "showButton",
  "showImage",
  "hideImage",
  "playAudio",
]);

/** Whether the statement's own expressions ask, show a button, or offer a choice, which ends a reading time. */
function asks(statement: IrStatement): boolean {
  let found = false;
  const visit = (value: IrExpression): IrExpression => {
    if (
      value.kind === "input" ||
      value.kind === "button" ||
      value.kind === "choice" ||
      value.kind === "listChoice" ||
      (value.kind === "call" && value.name === "askImage")
    )
      found = true;
    return mapChildren(value, visit);
  };
  mapOwnExpressions(statement, visit);
  return found;
}

function significant(statement: IrStatement): boolean {
  return statement.kind !== "blank" && statement.kind !== "comment";
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
