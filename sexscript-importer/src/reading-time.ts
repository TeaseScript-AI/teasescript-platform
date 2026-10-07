import { SYSTEM_SPEAKER } from "./helpers.ts";
import type { IrExpression, IrStatement, MigrationDiagnostic } from "./ir.ts";
import { withNestedBlocks } from "./repeated-text.ts";
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
 * decision 2026-10-05), so that the wait alone sets its timing, except right after a text whose wait the reading time
 * replaced: `instant` would cut that reading time short, and the wait, longer than the text's own reading time, still
 * sets the timing.
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
    // The index of the next and of the previous statement that is no blank line or comment, -1 for none.
    const next: number[] = Array.from(nested, () => -1);
    const previous: number[] = Array.from(nested, () => -1);
    for (let index = nested.length - 2; index >= 0; index -= 1)
      next[index] = significant(nested[index + 1]!) ? index + 1 : next[index + 1]!;
    for (let index = 1; index < nested.length; index += 1)
      previous[index] = significant(nested[index - 1]!) ? index - 1 : previous[index - 1]!;
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
        if (dropped.has(previous[index]!)) {
          report(
            "SX_WAIT_KEPT_PACED",
            "The legacy wait after this text is longer than 1.5 times the text's reading time, so it stays; the text keeps its reading time, which the wait covers, so that the text before it is read first.",
            statement,
          );
          return;
        }
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
      dropped.add(waitIndex);
    });
    return dropped.size === 0 ? result : result.filter((_, index) => !dropped.has(index));
  };
  return block(statements);
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
