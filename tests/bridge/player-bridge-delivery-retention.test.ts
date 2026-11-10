import assert from "node:assert/strict";
import test from "node:test";

import { runRetentionChild } from "../helpers/retention-witness.js";

/*
 * The delivery invariant, decided by the runtime's own heap (#2006; `retention-witness.ts`): after a delivery aborts,
 * or its connection ends, the heap holds no marked payload of its allocations, within the residual named below. Each
 * allocation class `own` registers runs its real op in one child (`delivery-retention-child.ts`), committed (the control
 * the witness must find), aborted on the same open connection, and closed.
 *
 * A class is decided by a marker of its own, which the marker scan sees through private fields, closures and promises,
 * wherever the class keeps its payload:
 * - a plan and compiled sources (`prepare`), and a transfer ticket (`readTransfer`): in their input;
 * - a host session (`start`): in the saved value its script loads and says, so in its engine state, its transcript and
 *   its events; weak references to every object of its publication's original public graph the op added also cover
 *   its marker-free state view, and any branch the marker might miss;
 * - the source-view caches (`drawCode`: the sidecar text, the sidecar, the latest file): in their plan's comments,
 *   which the plan does not keep; the plan's sources, their only other holder, are let go of once the caches were made;
 * - a step's candidate (`rewindBack`, prepared and not committed): in a say of the events its Back gives, which the
 *   candidate restored from them keeps and its parked session, the history's point, does not;
 * - a publishing op's point (`submitComposer`): in its answer, by the paths through its history's snapshot store
 *   (`THROUGH_THE_STORE`), with a weak reference to the point.
 *
 * The residual: a plan-text slot (`preparePlanText`) shares its payload with its prerequisite plan (its JSON is the
 * plan's, written in a later task), so it is decided by weak references to the slot and its waiting task, and its plan's
 * marker decides it at `closed`; what it would keep only behind a private field, a closure or a promise's result is not
 * observed. A rewind history (`historyRenew`) takes only a serial, which carries no marker: it is decided by weak
 * references to its whole payload the op made, its registry entry and all it reaches but what a warm-up history holds,
 * with a negative control (`control/history`) that keeps its core after the open's reply failed. What its core keeps
 * behind its private fields is not observed; at its open it keeps no point, snapshot or log, which later publications
 * and steps make. Also
 * the witness's own limits (`retention-witness.ts`: a marker-free copy is not an original), and the
 * diagnostic state the connection keeps by design (the recorder, the value trace, the random control), which these
 * cases record none of.
 */

const CLASSES = [
  "plan",
  "sources",
  "session",
  "transfer",
  "slot",
  "cache",
  "history",
  "candidate",
  "point",
] as const;
/** The classes decided by a marker of their own. */
const MARKED = new Set(["plan", "sources", "session", "transfer", "cache", "candidate"]);
/** The classes whose op runs on a plan a case committed first, with a marker of its own (`…/plan`). */
const ON_A_PLAN = new Set(["session", "slot", "cache", "candidate", "point"]);
/**
 * A publishing op's point (`submitComposer` on a followed session): its marker is in the answer, which the session also
 * keeps, as a failed reply does not undo the session. So its snapshot is decided by the marker's paths: none may run
 * through the history's snapshot store once its delivery aborted; the committed one's must.
 */
const THROUGH_THE_STORE = "#memory";
const MOMENTS = ["committed", "aborted", "closed"] as const;

test("after a delivery aborts, or its connection ends, the heap holds no marked payload of its allocations, within the named residual; a committed one is found", () => {
  const cases = [
    ...MOMENTS.flatMap((moment) => CLASSES.map((allocation) => `${moment}/${allocation}`)),
    "control/history",
  ];
  const plans = cases
    .filter((name) => ON_A_PLAN.has(name.split("/")[1]!))
    .map((name) => `${name}/plan`);
  const { report, hits } = runRetentionChild(
    new URL("../helpers/delivery-retention-child.js", import.meta.url),
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
    // The control keeps what its undone delivery made: the family must find it held.
    if (moment === "control") {
      if (held === 0) problems.push(`${name}: the core it keeps was not found held`);
      continue;
    }
    const marked = MARKED.has(allocation!);
    const found = hits.get(name)!.length > 0;
    if (allocation === "point") {
      // A path is its steps, each `holder -edge->`: one through the store names its edge.
      const stored = hits
        .get(name)!
        .some((hit) => hit.path.some((step) => step.includes(`-${THROUGH_THE_STORE}->`)));
      if (refs === 0) problems.push(`${name}: the op added nothing to observe`);
      if (moment === "committed") {
        if (held === 0) problems.push(`${name}: the committed point was not found alive`);
        if (!stored)
          problems.push(`${name}: the committed snapshot's marker was not found in the store`);
      } else {
        if (held > 0) problems.push(`${name}: ${held} of ${refs} objects it added survive`);
        if (stored) problems.push(`${name}: its snapshot is held in the store: ${paths(name)}`);
      }
      if (moment === "closed" && hits.get(`${name}/plan`)!.length > 0)
        problems.push(`${name}: its plan's marker is held: ${paths(`${name}/plan`)}`);
      continue;
    }
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
