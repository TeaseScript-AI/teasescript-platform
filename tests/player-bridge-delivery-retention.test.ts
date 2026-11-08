import assert from "node:assert/strict";
import test from "node:test";

import { runRetentionChild } from "./helpers/retention-witness.js";

/*
 * The delivery invariant, decided by the runtime's own heap (#2006; `retention-witness.ts`): after a delivery aborts,
 * or its connection ends, the heap holds no marked payload of its allocations, and none of the objects they added
 * survives. Each allocation class `own` registers runs its real op in one child (`delivery-retention-child.ts`):
 * - plans, and compiled sources (`prepare`), and transfer tickets (`readTransfer`), whose payload carries the case's
 *   marker of its own: the marker scan decides them;
 * - host sessions (`start`), plan-text slots (`preparePlanText`) and the source-view caches (`drawCode`), whose payload
 *   derives from a plan the case committed first: the weak references to what the op added decide them, and the marker
 *   scan decides the case's committed plan at `closed`.
 * A committed allocation on the same open connection is the control the witness must find. The witness's own limits
 * apply (`retention-witness.ts`: a marker-free copy is not an original); the diagnostic state the connection keeps by
 * design (the recorder, the value trace, the random control) is outside this invariant, and these cases record none.
 */

const CLASSES = ["plan", "sources", "session", "transfer", "slot", "cache"] as const;
/** The classes whose op's payload carries its case's own marker. */
const MARKED = new Set(["plan", "sources", "transfer"]);
const MOMENTS = ["committed", "aborted", "closed"] as const;

test("after a delivery aborts, or its connection ends, the heap holds nothing of its allocations; a committed one is found", () => {
  const names = MOMENTS.flatMap((moment) => CLASSES.map((allocation) => `${moment}/${allocation}`));
  const { report, hits } = runRetentionChild(
    new URL("./helpers/delivery-retention-child.js", import.meta.url),
    names,
  );
  // EVIDENCE: fixture: the child reports one entry per case it ran.
  const reports = report as readonly {
    readonly name: string;
    readonly refs: number;
    readonly held: number;
  }[];
  assert.deepEqual(reports.map(({ name }) => name).sort(), [...names].sort(), "every case ran");
  const problems: string[] = [];
  for (const { name, refs, held } of reports) {
    const [moment, allocation] = name.split("/");
    const found = hits.get(name)!;
    const paths = found.map((hit) => hit.path.join(" ")).join(" || ");
    if (refs === 0) problems.push(`${name}: the op added nothing to observe`);
    if (moment === "committed") {
      if (held === 0) problems.push(`${name}: the committed allocation was not found alive`);
      if (MARKED.has(allocation!) && found.length === 0)
        problems.push(`${name}: the committed payload's marker was not found`);
      continue;
    }
    if (held > 0) problems.push(`${name}: ${held} of ${refs} objects it added survive`);
    if ((moment === "closed" || MARKED.has(allocation!)) && found.length > 0)
      problems.push(`${name}: its marker is held: ${paths}`);
  }
  assert.deepEqual(problems, []);
});
