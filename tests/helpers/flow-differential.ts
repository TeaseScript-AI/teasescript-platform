import {
  compileProject,
  type ProjectDiagnostic,
  type ProjectSourceFile,
} from "../../src/compiler.js";
import type { RuntimeAccountInput } from "../../src/runtime/account.js";
import { createFreshRuntimeSession, type RuntimeSessionView } from "../../src/runtime/session.js";
import type { RuntimeStatus } from "../../src/runtime/state.js";

/*
 * Runs a script every way its knobs allow, so that an analysis which predicts what the runtime does can be checked
 * against the runtime itself (docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md, "One home for each language rule").
 * A knob is a stored value the script loads, as in `load "k1", default: false`: it is present in half of the runs and
 * absent in the others, so a script that branches on it takes every way. A run moves the script's clock to the next
 * moment something is due, as `npm run probe -- --run` does, so a `wait` passes and a timer fires; it stops when the
 * script ends, fails, or waits for the player or the host.
 */

export interface FlowKnob {
  readonly key: string;
  /** The value the runs with the knob store before the session starts; `true` by default. */
  readonly value?: boolean | number | string;
}

export interface FlowRun {
  /** The keys of the knobs this run stored. */
  readonly present: readonly string[];
  readonly status: RuntimeStatus;
  /** How the run failed, with the 1-based line of the failure in its file. */
  readonly failure: { readonly code: string; readonly path: string; readonly line: number } | null;
  /** The texts the run said, in order. */
  readonly says: readonly string[];
}

export interface FlowVariants {
  readonly diagnostics: readonly ProjectDiagnostic[];
  /** One run per subset of the knobs, in binary order; none when the project has an error. */
  readonly runs: readonly FlowRun[];
}

const MAX_CLOCK_MOVES = 100;

/** Compiles the project, and when it compiles, runs it once per subset of the knobs. */
export function compileAndRunVariants(
  files: readonly ProjectSourceFile[],
  knobs: readonly FlowKnob[],
  account: RuntimeAccountInput = {},
): FlowVariants {
  const compiled = compileProject(files);
  const runs: FlowRun[] = [];
  if (compiled.plan !== null && !compiled.diagnostics.some((d) => d.severity === "error"))
    for (let subset = 0; subset < 1 << knobs.length; subset += 1) {
      const stored = knobs.filter((_, index) => (subset & (1 << index)) !== 0);
      const session = createFreshRuntimeSession(compiled.plan, {
        account,
        scriptStorage: stored.map((knob) => ({ key: knob.key, value: knob.value ?? true })),
        baseDelayMs: 0,
        delayPerWordMs: 0,
        delayPerCharacterMs: 0,
      });
      const says: string[] = [];
      let view = session.view();
      for (let moves = 0; ; moves += 1) {
        for (const event of session.run().events) if (event.kind === "say") says.push(event.text);
        view = session.view();
        const next = view.status === "waiting" && moves < MAX_CLOCK_MOVES ? nextDueMs(view) : null;
        if (next === null) break;
        for (const event of session.observeTime(next).events)
          if (event.kind === "say") says.push(event.text);
      }
      const { failure } = view;
      runs.push({
        present: stored.map((knob) => knob.key),
        status: view.status,
        failure:
          failure === null
            ? null
            : { code: failure.code, path: failure.path, line: failure.span.start.line + 1 },
        says,
      });
    }
  return { diagnostics: compiled.diagnostics, runs };
}

/** The next moment the script waits for by time alone, or `null` when it waits for the player or the host. */
function nextDueMs(view: RuntimeSessionView): number | null {
  const foreground = view.foregroundAction;
  if (foreground !== null && foreground.kind !== "delay" && foreground.kind !== "chatPacingGate")
    return null;
  let earliest = foreground === null ? Infinity : foreground.deadlineMs;
  for (const action of view.backgroundActions) {
    const due =
      action.kind === "timer"
        ? action.timer.state === "running"
          ? action.timer.deadlineMs
          : null
        : "deadlineMs" in action
          ? action.deadlineMs
          : null;
    if (typeof due === "number" && due < earliest) earliest = due;
  }
  return Number.isFinite(earliest) ? Math.max(earliest, view.currentSessionTimeMs) : null;
}
