import type { Expression, Program, SayStatement, Statement, WaitStatement } from "./ast.js";
import { calculateSmartPacingDurationMs, DEFAULT_CHAT_PACING_SETTINGS } from "./chat-pacing.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";
import { DURATION_UNIT_MILLISECONDS, durationParts, isExactDuration } from "./duration.js";
import { parseMessageMarkup } from "./message-markup.js";
import { staticQuantity, staticVisibleText } from "./static-evaluation.js";

/** The warning for a `wait` that the `say` before it outlasts (V30 §27). */
const SHORT_WAIT_CODE = "TSV060";

/**
 * A warning for every `wait` of known duration that directly follows a `say` with default pacing in the same block and
 * is shorter than the message's reading time at the default reading speed. The wait runs alongside the message's pacing
 * (RUNTIME.md "`instant`, `0`, and `wait`"), so it adds no time unless the player skips the message. The reading time
 * counts an interpolated value, or text the compiler cannot know, as empty, so it is the shortest the message can have.
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
  const readingMs = calculateSmartPacingDurationMs(
    parseMessageMarkup(shortestText(say.value)).visibleText,
    DEFAULT_CHAT_PACING_SETTINGS,
  );
  if (waitMs >= readingMs) return null;
  return createDiagnostic(
    DiagnosticSeverity.Warning,
    SHORT_WAIT_CODE,
    `At the default reading speed, the previous message takes at least ${seconds(readingMs)} s to read, so this ${seconds(waitMs)} s wait adds no time unless the player skips the message. Add \`instant\` to that \`say\` to make the wait the only pause, or remove the wait.`,
    wait.span,
  );
}

/** A `wait`'s milliseconds when they are known: a number of its unit, seconds by default, or an exact duration. */
function knownWaitMs(wait: WaitStatement): number | undefined {
  const known = staticQuantity(wait.duration);
  if (typeof known === "number")
    return known < 0 ? undefined : known * DURATION_UNIT_MILLISECONDS[wait.unit ?? "s"];
  if (known === undefined || wait.unit !== null) return undefined;
  const parts = durationParts(known);
  return isExactDuration(parts) && parts.milliseconds >= 0 ? parts.milliseconds : undefined;
}

/** The authored text of a message with each interpolated value empty; text the compiler cannot know is empty. */
function shortestText(value: Expression): string {
  let literal = value;
  while (literal.kind === "parenthesizedExpression") literal = literal.expression;
  if (literal.kind !== "stringLiteral") return staticVisibleText(value) ?? "";
  return literal.parts.map((part) => (part.kind === "stringText" ? part.value : "")).join("");
}

/** Milliseconds as seconds, to the millisecond. */
function seconds(milliseconds: number): string {
  return String(Number((milliseconds / 1000).toFixed(3)));
}
