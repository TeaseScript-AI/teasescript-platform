import assert from "node:assert/strict";
import test from "node:test";

import { runRetentionChild } from "./helpers/retention-witness.js";

/*
 * The delivery invariant, decided by the runtime's own heap (#2006; `retention-witness.ts`): after a delivery aborts,
 * or its connection ends, the heap holds no marked payload of its allocations. Each allocation class `own` registers
 * runs its real op in one child (`delivery-retention-child.ts`), committed (the control the witness must find), aborted
 * on the same open connection, and closed.
 *
 * Each class is decided by a marker of its own, which the marker scan sees through private fields, closures and
 * promises: a plan and compiled sources (`prepare`) and a transfer ticket (`readTransfer`) carry it in their input, and
 * a host session (`start`) in its saved data, which its state and publication hold.
 *
 * The residual, where no input can carry a marker of its own: a plan-text slot (`preparePlanText`) and the source-view
 * caches (`drawCode`: the sidecar text, the sidecar, the latest file) are made from their plan, so their only marker is
 * the plan's, which the committed plan holds too. They are decided by weak references to the objects the op added (a
 * slot and its waiting task; a cache's promise, sidecar and file code, with what they reach through visible fields),
 * and their plan's marker decides them at `closed`. What those objects keep only behind a private field, a closure or a
 * promise's result is not observed for them.
 *
 * Also the witness's own limits (`retention-witness.ts`: a marker-free copy is not an original), and the diagnostic
 * state the connection keeps by design (the recorder, the value trace, the random control), which these cases record
 * none of.
 */

const CLASSES = ["plan", "sources", "session", "transfer", "slot", "cache"] as const;
/** The classes whose own input carries their case's marker. */
const MARKED = new Set(["plan", "sources", "session", "transfer"]);
/** The classes whose op runs on a plan a case committed first, with a marker of its own (`…/plan`). */
const ON_A_PLAN = new Set(["session", "slot", "cache"]);
const MOMENTS = ["committed", "aborted", "closed"] as const;

test("after a delivery aborts, or its connection ends, the heap holds nothing of its allocations; a committed one is found", () => {
  const cases = MOMENTS.flatMap((moment) => CLASSES.map((allocation) => `${moment}/${allocation}`));
  const plans = cases
    .filter((name) => ON_A_PLAN.has(name.split("/")[1]!))
    .map((name) => `${name}/plan`);
  const { report, hits } = runRetentionChild(
    new URL("./helpers/delivery-retention-child.js", import.meta.url),
    [...cases, ...plans],
  );
  // EVIDENCE: fixture: the child reports one entry per case it ran.
  const reports = report as readonly {
    readonly name: string;
    readonly refs: number;
    readonly held: number;
  }[];
  assert.deepEqual(reports.map(({ name }) => name).sort(), [...cases].sort(), "every case ran");
  const problems: string[] = [];
  const paths = (name: string) =>
    hits
      .get(name)!
      .map((hit) => hit.path.join(" "))
      .join(" || ");
  for (const { name, refs, held } of reports) {
    const [moment, allocation] = name.split("/");
    const marked = MARKED.has(allocation!);
    const found = hits.get(name)!.length > 0;
    if (refs === 0) problems.push(`${name}: the op added nothing to observe`);
    if (moment === "committed") {
      if (held === 0) problems.push(`${name}: the committed allocation was not found alive`);
      if (marked && !found) problems.push(`${name}: the committed payload's marker was not found`);
      continue;
    }
    if (held > 0) problems.push(`${name}: ${held} of ${refs} objects it added survive`);
    if (marked && found) problems.push(`${name}: its marker is held: ${paths(name)}`);
    if (moment === "closed" && ON_A_PLAN.has(allocation!) && hits.get(`${name}/plan`)!.length > 0)
      problems.push(`${name}: its plan's marker is held: ${paths(`${name}/plan`)}`);
  }
  assert.deepEqual(problems, []);
});
