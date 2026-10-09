import type { Program, SayStatement, Statement, WaitStatement } from "./ast.js";
import { calculateSmartPacingDurationMs, DEFAULT_CHAT_PACING_SETTINGS } from "./chat-pacing.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import { DURATION_UNIT_MILLISECONDS, formatDuration, isCalendar } from "./duration.js";
import { parseMessageMarkup } from "./message-markup.js";
import { staticQuantity, staticVisibleText } from "./static-evaluation.js";

/** The warning for a `wait` that the `say` before it outlasts (V30 §27). */
const SHORT_WAIT_CODE = "TSV060";

/**
 * A warning for every `wait` of known duration that directly follows a `say` with default pacing in the same block and
 * is shorter than the message's reading time at the default reading speed. The wait runs alongside the message's pacing
 * (RUNTIME.md "`instant`, `0`, and `wait`"), so it adds no time unless the player skips the message. The reading time is
 * the shortest the message can have: that of its text when the compiler knows all of it, and otherwise the base delay
 * alone, as a value the compiler cannot know may change which markup the text holds and so hide any of the rest.
 * Unreachable waits are left to their own warning.
 */
export function shortWaitWarnings(
  program: Program,
  unreachable: ReadonlySet<Statement>,
): readonly Diagnostic[] {
  const found: Diagnostic[] = [];
  // Every statement list of the program, found with a list rather than by recursion, as source may nest deeply.
  const work: unknown[] = [program];
  while (work.length > 0) {
    const node = work.pop();
    if (typeof node !== "object" || node === null) continue;
    if (Array.isArray(node)) {
      for (const item of node) work.push(item);
      continue;
    }
    // EVIDENCE: invariant: the parser builds the program and every block as `{ kind, statements }` objects.
    const holder = node as { readonly kind?: unknown; readonly statements?: readonly Statement[] };
    if ((holder.kind === "program" || holder.kind === "block") && holder.statements !== undefined)
      for (let index = 1; index < holder.statements.length; index += 1) {
        const say = holder.statements[index - 1]!;
        const wait = holder.statements[index]!;
        if (say.kind !== "sayStatement" || wait.kind !== "waitStatement" || unreachable.has(wait))
          continue;
        const warning = shortWait(say, wait);
        if (warning !== null) found.push(warning);
      }
    // Source spans hold no statements.
    for (const [key, child] of Object.entries(node))
      if (key !== "span" && !key.endsWith("Span")) work.push(child);
  }
  return found.sort((left, right) => left.span.start.offset - right.span.start.offset);
}

function shortWait(say: SayStatement, wait: WaitStatement): Diagnostic | null {
  // A message with `instant`, `0`, or its own pacing sets its timing itself.
  if (say.pacing !== null) return null;
  const waitMs = knownWaitMs(wait);
  // `wait 0` never adds time.
  if (waitMs === undefined || waitMs === 0) return null;
  const text = staticVisibleText(say.value);
  const readingMs =
    text === undefined
      ? DEFAULT_CHAT_PACING_SETTINGS.baseDelayMs
      : calculateSmartPacingDurationMs(
          parseMessageMarkup(text).visibleText,
          DEFAULT_CHAT_PACING_SETTINGS,
        );
  if (waitMs >= readingMs) return null;
  return createDiagnostic(
    DiagnosticSeverity.Warning,
    SHORT_WAIT_CODE,
    `At the default reading speed, the previous message takes at least ${formatDuration(readingMs)} to read, so this wait of ${formatDuration(waitMs)} adds no time unless the player skips the message. Add \`instant\` to that \`say\` to make the wait the only pause, or remove the wait.`,
    wait.span,
  );
}

/** A `wait`'s milliseconds when they are known: a number of its unit, seconds by default, or an exact duration. */
function knownWaitMs(wait: WaitStatement): number | undefined {
  const known = staticQuantity(wait.duration);
  if (typeof known === "number")
    return known < 0 ? undefined : known * DURATION_UNIT_MILLISECONDS[wait.unit ?? "s"];
  if (known === undefined || wait.unit !== null) return undefined;
  return !isCalendar(known) && known.milliseconds >= 0 ? known.milliseconds : undefined;
}
