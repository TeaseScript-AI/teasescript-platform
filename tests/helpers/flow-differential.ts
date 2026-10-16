import {
  compileProject,
  type ProjectDiagnostic,
  type ProjectSourceFile,
} from "../../src/compiler.js";
import type { RuntimeAccountInput } from "../../src/runtime/account.js";
import { run } from "../../src/runtime/engine.js";
import type { RuntimeStatus } from "../../src/runtime/state.js";
import { createImmediatePacingRuntimeSnapshot } from "./immediate-pacing-runtime.js";

/*
 * Runs a script every way its knobs allow, so that an analysis which predicts what the runtime does can be checked
 * against the runtime itself (docs/review-and-audit/IMPLEMENTATION-AND-REVIEW.md, "One home for each language rule").
 * A knob is a stored value the script loads, as in `load "k1", default: false`: it is present in half of the runs and
 * absent in the others, so a script that branches on it takes every way.
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

/** Compiles the project, and when it compiles, runs it once per subset of the knobs until it ends, waits, or fails. */
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
      const snapshot = createImmediatePacingRuntimeSnapshot(compiled.plan, {
        account,
        scriptStorage: stored.map((knob) => ({ key: knob.key, value: knob.value ?? true })),
      });
      const result = run(compiled.plan, snapshot);
      const { failure } = result.snapshot;
      runs.push({
        present: stored.map((knob) => knob.key),
        status: result.snapshot.status,
        failure:
          failure === null
            ? null
            : { code: failure.code, path: failure.path, line: failure.span.start.line + 1 },
        says: result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
      });
    }
  return { diagnostics: compiled.diagnostics, runs };
}
