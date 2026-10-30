import { hash } from "./json.mjs";
import { summarize } from "./status.mjs";
/** Row identities must agree: never compare two partial campaigns as if complete. */
export function compare(base, head) {
  const b = new Map(base.map((r) => [r.id, r])),
    h = new Map(head.map((r) => [r.id, r]));
  if (b.size !== base.length || h.size !== head.length)
    throw new Error("Duplicate row identities");
  if (b.size !== h.size || [...b.keys()].some((id) => !h.has(id)))
    throw new Error("Campaign configurations differ");
  const fixed = [],
    regressed = [],
    unchanged = [],
    incomparable = [];
  for (const [id, x] of b) {
    const y = h.get(id);
    if (
      hash({ source: x.sourceHash, mode: x.mode, policy: x.policy }) !==
      hash({ source: y.sourceHash, mode: y.mode, policy: y.policy })
    )
      throw new Error(
        "Configuration identity collision across sources or settings",
      );
    if (
      x.outcomes &&
      y.outcomes &&
      hash(x.outcomes.map((o) => [o.inputHash, o.allowed])) !==
        hash(y.outcomes.map((o) => [o.inputHash, o.allowed]))
    )
      throw new Error("Compared input values or expectations differ");
    if (
      !["PASS", "FAIL"].includes(x.status) ||
      !["PASS", "FAIL"].includes(y.status)
    ) {
      incomparable.push(id);
      continue;
    }
    if (x.status === "FAIL" && y.status === "PASS") fixed.push(id);
    else if (x.status === "PASS" && y.status === "FAIL") regressed.push(id);
    else unchanged.push(id);
  }
  return {
    schemaVersion: 1,
    base: summarize(base),
    head: summarize(head),
    fixed,
    regressed,
    unchangedCount: unchanged.length,
    incomparableCount: incomparable.length,
    interpretation:
      "Changes are scoped observations, not unique bug counts; incomplete configurations are never counted fixed.",
  };
}
