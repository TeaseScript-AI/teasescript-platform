import { generate, interactionGroups, render } from "../families/s8-stores.mjs";
import { select, profiles } from "./selection.mjs";
import { hash, requireInteger } from "./json.mjs";
export function makePlan(profile = "quick", seed = 1442) {
  if (!profiles[profile]) throw new Error(`Unknown profile: ${profile}`);
  requireInteger(seed, "seed", 0, 0xffffffff);
  const p = profiles[profile],
    { selected, coverage } = select(
      generate(seed),
      interactionGroups,
      p.sources,
      seed,
    );
  const body = {
    schemaVersion: 1,
    family: "s8-stores",
    profile,
    seed,
    coverage,
    cases: selected,
    modes: p.modes,
    policies: p.policies,
    deadlineMs: p.deadlineMs,
  };
  return { ...body, planHash: hash(body) };
}
export function validatePlan(plan) {
  if (
    plan.schemaVersion !== 1 ||
    plan.family !== "s8-stores" ||
    !profiles[plan.profile]
  )
    throw new Error("Unsupported plan schema/family/profile");
  const { planHash, ...body } = plan;
  if (hash(body) !== planHash) throw new Error("Plan digest mismatch");
  const expected = makePlan(plan.profile, plan.seed);
  if (hash(expected) !== hash(plan))
    throw new Error(
      "Plan does not match the frozen generator/profile; regenerate explicitly",
    );
  for (const c of plan.cases)
    if (hash(render(c.dimensions, plan.seed)) !== hash(c))
      throw new Error(`Invalid case ${c.id}`);
  return plan;
}
export function configurations(plan, shard = { index: 0, total: 1 }) {
  requireInteger(shard.total, "shard total", 1, 1024);
  requireInteger(shard.index, "shard index", 0, shard.total - 1);
  const result = [];
  plan.cases.forEach((c, i) => {
    if (i % shard.total !== shard.index) return;
    for (const mode of plan.modes)
      for (const policy of plan.policies) {
        const id = hash({ caseId: c.id, mode, policy }).slice(0, 24);
        result.push({ id, case: c, mode, policy });
      }
  });
  return result;
}
