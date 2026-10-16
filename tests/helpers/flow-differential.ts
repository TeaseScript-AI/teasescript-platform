import {
  compileProject,
  type ProjectDiagnostic,
  type ProjectSourceFile,
} from "../../src/compiler.js";
import type { RuntimeAccountInput } from "../../src/runtime/account.js";
import type { RuntimeLockActionSnapshot } from "../../src/runtime/actions/model.js";
import { runtimeTimedWork } from "../../src/runtime/operations/observe-time.js";
import { createFreshRuntimeSession, type RuntimeSessionView } from "../../src/runtime/session.js";
import type { PlayerLockAnswer } from "../../player/runtime-adapter.js";
import type { RuntimeStatus } from "../../src/runtime/state.js";

/*
 * Runs a script every way its knobs allow, so that an analysis which predicts what the runtime does can be checked
 * against the runtime itself (docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md, "One home for each language rule").
 * A knob is a stored value the script loads, as in `load "k1", default: false`: it is present in half of the runs and
 * absent in the others, so a script that branches on it takes every way. A run moves the script's clock to the next
 * moment something is due, as `npm run probe -- --run` does, so a `wait` passes and a timer fires; it stops when the
 * script ends, fails, or waits for the player or the host. It may press each permanent button once, before it moves
 * the clock, so that the button's block runs.
 */

/** The answer a simulated Player gives a lock step (docs/RUNTIME.md, "Locks"). */
export type FlowLockAnswer = (action: RuntimeLockActionSnapshot) => PlayerLockAnswer;

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

/**
 * Compiles the project, and when it compiles, runs it once per subset of the knobs. A run types `answer` into each ask
 * it waits for, such as `askInteger`, or stops there when it is `null`, and answers each lock step with `lock`, or stops
 * there. A lock dialog waits for the player, so the clock first moves to each block due while it asks. With
 * `pressButtons`, a run that waits presses each permanent button it has not pressed yet, as soon as the button takes a
 * press.
 */
export function compileAndRunVariants(
  files: readonly ProjectSourceFile[],
  knobs: readonly FlowKnob[],
  account: RuntimeAccountInput = {},
  answer: string | null = null,
  lock: FlowLockAnswer | null = null,
  pressButtons = false,
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
      const pressed = new Set<number>();
      let view = session.view();
      for (let moves = 0; ; moves += 1) {
        for (const event of session.run().events) if (event.kind === "say") says.push(event.text);
        view = session.view();
        const waiting = view.status === "waiting" && moves < MAX_CLOCK_MOVES;
        const button = pressButtons
          ? session
              .permanentButtonProjection()
              .find((shown) => !shown.busy && !pressed.has(shown.buttonId))
          : undefined;
        if (waiting && button !== undefined) {
          pressed.add(button.buttonId);
          for (const event of session.pressPermanentButton(button.buttonId).events)
            if (event.kind === "say") says.push(event.text);
          continue;
        }
        const action = view.foregroundAction;
        if (waiting && action?.kind === "interaction" && answer !== null) {
          const request = {
            actionId: action.actionId,
            actionKind: "interaction",
            interactionKind: action.interactionKind,
            payload: { kind: "submittedText", submittedText: answer },
          };
          for (const event of session.completeAction(request).events)
            if (event.kind === "say") says.push(event.text);
          continue;
        }
        if (waiting && action?.kind === "lock" && lock !== null) {
          const due = action.phase === "ask" ? earliestDueMs(view) : null;
          if (due !== null) {
            for (const event of session.observeTime(due).events)
              if (event.kind === "say") says.push(event.text);
            continue;
          }
          const request = { actionId: action.actionId, actionKind: "lock", payload: lock(action) };
          for (const event of session.completeAction(request).events)
            if (event.kind === "say") says.push(event.text);
          continue;
        }
        const next = waiting ? nextDueMs(view) : null;
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

/**
 * The next moment the script waits for by time alone, or `null` when it waits for the player or the host: at an
 * interaction, or at a foreground wait that nothing timed settles.
 */
function nextDueMs(view: RuntimeSessionView): number | null {
  const due = runtimeTimedWork(view);
  const foreground = view.foregroundAction;
  if (
    foreground !== null &&
    (foreground.kind === "interaction" ||
      !due.some((work) => work.actionId === foreground.actionId))
  )
    return null;
  return earliestDueMs(view, due);
}

/** The first moment any timed work of the script comes due, or `null` without any. */
function earliestDueMs(view: RuntimeSessionView, due = runtimeTimedWork(view)): number | null {
  let earliest = Infinity;
  for (const work of due) if (work.deadlineMs < earliest) earliest = work.deadlineMs;
  return Number.isFinite(earliest) ? Math.max(earliest, view.currentSessionTimeMs) : null;
}
