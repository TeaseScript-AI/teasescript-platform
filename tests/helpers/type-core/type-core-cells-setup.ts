// The cells tests' shared setup (tests/type-core/cells/): the expectation set's records, and a record as one sorted
// list of texts.

import { readFixture } from "./type-core-fixture.js";
import { type CompactRecord } from "../type-core-records.js";

/**
 * The coarse core against its independent expectation set (checkpoint 9):
 * per record the outcome, the diagnostics as (kind, class, site, asserted context) and the checks as (kind, target,
 * required kinds, boundary, site) multisets. Every record is asserted except those `heldBack` names, each by its cell or
 * its name, with its reason.
 */
export const records = readFixture();

/** A record as one sorted list of texts: its outcome, its diagnostics and its checks. */
export function summary(record: CompactRecord): string[] {
  return [
    record.outcome,
    ...record.diagnostics.map((d) => `${d.kind} ${d.class} @${d.site.offset}`),
    ...record.checks.map(
      (check) =>
        `${check.kind} ${check.target} [${check.against.join(", ")}]${check.boundary ? " boundary" : ""} @${check.site.offset}`,
    ),
  ].sort();
}
