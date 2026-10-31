import { configurations, validatePlan } from "./plan.mjs";
import { hash } from "./json.mjs";
import { summarize } from "./status.mjs";
/** Merge only exhaustive, non-overlapping shards from the same plan and compiler execution environment. */
export function mergeShards(parts) {
  if (!parts.length) throw new Error("No shards supplied");
  const plan = validatePlan(parts[0].plan),
    baseline = parts[0].metadata;
  const rows = new Map(),
    shards = new Set();
  for (const part of parts) {
    validatePlan(part.plan);
    if (part.plan.planHash !== plan.planHash || part.metadata.planHash !== plan.planHash)
      throw new Error("Shards have different plans");
    if (hash(part.metadata.provenance) !== hash(baseline.provenance))
      throw new Error("Shards have different compiler provenance");
    if (part.metadata.shard.total !== baseline.shard.total) throw new Error("Shard totals differ");
    const shard = part.metadata.shard;
    if (shards.has(shard.index)) throw new Error("Duplicate shard");
    shards.add(shard.index);
    const configs = configurations(plan, shard),
      ids = new Set(configs.map((c) => c.id));
    if (part.rows.length !== configs.length) throw new Error("Shard has missing rows");
    for (const row of part.rows) {
      if (!ids.delete(row.id) || rows.has(row.id)) throw new Error("Unexpected or duplicate row");
      rows.set(row.id, row);
    }
  }
  if (shards.size !== baseline.shard.total) throw new Error("Not all shards supplied");
  const ordered = configurations(plan).map((c) => {
    const row = rows.get(c.id);
    if (!row) throw new Error("Incomplete campaign");
    return row;
  });
  return {
    plan,
    rows: ordered,
    summary: {
      schemaVersion: 1,
      ...summarize(ordered, configurations(plan).length),
      planHash: plan.planHash,
      rules: plan.rules ?? [],
      provenance: baseline.provenance,
      resultsHash: hash(ordered),
      shards: parts.length,
      elapsedMs: parts.reduce((s, p) => s + p.summary.elapsedMs, 0),
      elapsedInterpretation: "Sum of shard campaign times; NOT parallel wall time or queue time",
      scopeNote:
        "Excluded and unscoped configurations remain incomplete; merging never turns them into PASS.",
    },
  };
}
