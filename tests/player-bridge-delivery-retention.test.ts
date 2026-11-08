import assert from "node:assert/strict";
import test from "node:test";

import { runRetentionChild } from "./helpers/retention-witness.js";

/*
 * The delivery invariant, decided by the runtime's own heap (#2006; `retention-witness.ts`): after a delivery aborts,
 * or its connection ends, the heap holds no marked payload of its allocations, within the residual named below. Each
 * allocation class `own` registers runs its real op in one child (`delivery-retention-child.ts`), committed (the control
 * the witness must find), aborted on the same open connection, and closed.
 *
 * A class is decided by a marker of its own, which the marker scan sees through private fields, closures and promises,
 * wherever the class keeps its payload:
 * - a plan and compiled sources (`prepare`), and a transfer ticket (`readTransfer`): in their input;
 * - a host session (`start`): in the saved value its script loads and says, so in its engine state, its publication's
 *   view and transcript, and its events; a second net, weak references to every object of its publication's public
 *   graph the op added, sees a branch the marker might miss;
 * - the source-view caches (`drawCode`: the sidecar text, the sidecar, the latest file): in their plan's comments,
 *   which the plan does not keep; the plan's sources, their only other holder, are let go of once the caches were made.
 *
 * The residual: a plan-text slot (`preparePlanText`) shares its payload with its prerequisite plan (its JSON is the
 * plan's, written in a later task), so it is decided by weak references to the slot and its waiting task, and its plan's
 * marker decides it at `closed`; what it would keep only behind a private field, a closure or a promise's result is not
 * observed. Also the witness's own limits (`retention-witness.ts`: a marker-free copy is not an original), and the
 * diagnostic state the connection keeps by design (the recorder, the value trace, the random control), which these
 * cases record none of.
 */

const CLASSES = ["plan", "sources", "session", "transfer", "slot", "cache"] as const;
/** The classes decided by a marker of their own. */
const MARKED = new Set(["plan", "sources", "session", "transfer", "cache"]);
/** The classes whose op runs on a plan a case committed first, with a marker of its own (`…/plan`). */
const ON_A_PLAN = new Set(["session", "slot", "cache"]);
const MOMENTS = ["committed", "aborted", "closed"] as const;

test("after a delivery aborts, or its connection ends, the heap holds no marked payload of its allocations, within the named residual; a committed one is found", () => {
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
