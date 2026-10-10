import type { Expression, Program, TimerExpression, TimerStatement, WaitStatement } from "./ast.js";
import { createDiagnostic, DiagnosticSeverity, type Diagnostic } from "./diagnostics.js";

/** The warning for a `wait` or timer whose length is written in days or weeks (V30 §27). */
const DAY_WAIT_CODE = "TSV061";

/**
 * A warning for every `wait` and timer whose length is written with a day or week unit, such as `wait 2 days`,
 * `timer (1..3) w`, or `wait 1 day + 2 h`. It counts scene time, which stops while the Player is closed, while such a
 * length almost always means real time. A length held in a variable, read from a list or object, or returned by a call
 * is not checked.
 */
export function dayWaitWarnings(program: Program, source: string): readonly Diagnostic[] {
  const found: Diagnostic[] = [];
  // Every node of the program, found with a list rather than by recursion, as source may nest deeply.
  const work: unknown[] = [program];
  while (work.length > 0) {
    const node = work.pop();
    if (typeof node !== "object" || node === null) continue;
    if (Array.isArray(node)) {
      for (const item of node) work.push(item);
      continue;
    }
    // EVIDENCE: invariant: the parser builds every statement and expression as an object with its `kind`.
    const command = node as { readonly kind?: unknown };
    if (
      command.kind === "waitStatement" ||
      command.kind === "timerStatement" ||
      command.kind === "timerExpression"
    ) {
      // EVIDENCE: invariant: these kinds belong to the wait, timer statement, and timer expression nodes alone.
      const waiting = node as WaitStatement | TimerStatement | TimerExpression;
      if (inDaysOrWeeks(waiting)) {
        const keyword = waiting.kind === "waitStatement" ? "wait" : "timer";
        const length = source
          .slice(waiting.lengthSpan.start.offset, waiting.lengthSpan.end.offset)
          .replace(/\s+/gu, " ");
        found.push(
          createDiagnostic(
            DiagnosticSeverity.Warning,
            DAY_WAIT_CODE,
            `'${keyword} ${length}' counts only time while the Player is open, so closing the Player pauses it.`,
            waiting.lengthSpan,
          ),
        );
      }
    }
    // Source spans hold no statements.
    for (const [key, child] of Object.entries(node))
      if (key !== "span" && !key.endsWith("Span")) work.push(child);
  }
  return found.sort((left, right) => left.span.start.offset - right.span.start.offset);
}

/**
 * Whether a length has a day or week unit: after it, or on a duration written in it, also within arithmetic, as in
 * `1 day + 2 h`. A unit after a value makes that value a count, so a day within it, as in `(elapsed / 1 day) s`, is no
 * length.
 */
function inDaysOrWeeks(waiting: WaitStatement | TimerStatement | TimerExpression): boolean {
  if (waiting.unit !== null) return waiting.unit === "d" || waiting.unit === "w";
  const parts: Expression[] = [waiting.duration];
  while (parts.length > 0) {
    const part = parts.pop()!;
    if (part.kind === "durationLiteral" || part.kind === "unitExpression") {
      if (!part.calendar && (part.unit === "d" || part.unit === "w")) return true;
    } else if (part.kind === "parenthesizedExpression") parts.push(part.expression);
    else if (part.kind === "unaryExpression") parts.push(part.operand);
    else if (part.kind === "binaryExpression") parts.push(part.left, part.right);
  }
  return false;
}
