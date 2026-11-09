/*
 * The regex tests' shared host (`runtime/regex`, `semantic/regex-checks`): a run's says, and a run with host globals.
 * Orchestrator 2's; a change to the exports `semantic/regex-checks` uses names the O4 lead as required reviewer.
 */

import assert from "node:assert/strict";
import { run } from "../../../src/runtime/engine.js";
import { compileValidPlan } from "../compile-valid-plan.js";
import { createImmediatePacingRuntimeSnapshot } from "../immediate-pacing-runtime.js";
import { sayTexts } from "../runtime-events.js";
import { runValidSource } from "../run-valid-source.js";

export function said(...lines: string[]): string[] {
  const result = runValidSource([...lines, "exit"].join("\n"));
  assert.equal(result.snapshot.failure, null, lines.join("\n"));
  return sayTexts(result);
}

/** Runs `source` with host globals, whose values the compiler cannot know, and returns the failure or the says. */
export function runWithGlobals(source: string, globals: Record<string, string | number | null>) {
  const plan = compileValidPlan(source, { globals: Object.keys(globals) });
  return run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals }));
}
