import { compileSource } from "../../src/compiler.js";
import { run } from "../../src/runtime/engine.js";
import type { RuntimeOperationResult } from "../../src/runtime/operations/model.js";
import { createFreshRuntimeSnapshot } from "../../src/runtime/snapshot/snapshot-construction.js";
import { childCases, markerOf, snapshotForRetention } from "./retention-child.js";

/*
 * The retention child of the say memo's test (`say-markup-memo.test.ts`; see `retention-witness.ts`). Each case runs a
 * session of a plan of its own, kept until the snapshot, whose say interpolates the saved value the session starts
 * with: the case's marker. (A plan of its own: a later session of the same plan would replace what a memo kept.) `ended`: the session's result is let go of, so nothing of its text may stay while the plan lives.
 * `kept`: its result is kept, the control the witness must find.
 */

const SOURCE = [
  'let probe = load "probe", default: ""',
  'say "Said: ${probe}", instant',
  "exit",
].join("\n");
// What stays until the snapshot: each case's plan, and the kept result.
const plans: unknown[] = [];
const kept: unknown[] = [];

/** Runs a session of a new plan, kept, whose saved value is `marker`, and returns its result. */
function session(marker: string): RuntimeOperationResult {
  const plan = compileSource(SOURCE).plan!;
  plans.push(plan);
  return run(
    plan,
    createFreshRuntimeSnapshot(plan, { scriptStorage: [{ key: "probe", value: marker }] }),
  );
}

function runCases(): void {
  for (const { name, seed } of childCases()) {
    const result = session(markerOf(seed));
    if (name === "kept") kept.push(result);
  }
}

runCases();
const snapshot = await snapshotForRetention();
process.stdout.write(
  JSON.stringify({ report: { plans: plans.length, kept: kept.length }, snapshot }),
);
