import { setKey, sourceKey } from "../../sources.mjs";
import { validatePlan } from "./plan.mjs";

/**
 * A plan's sources as a corpus module (`tests/families/README.md`, "A generator"): data only, no imports, with the
 * record of the run it reproduces, taken from the plan, which is what each configuration passed: one file
 * `main.tease` with the case's globals (`adapters/compiler.mjs`). The runner compares what they publish and stop; the
 * family's behavioural checks are this tool's, beside it.
 */
export function corpusModule(plan, where) {
  validatePlan(plan);
  const globals = plan.cases[0].globals;
  if (plan.cases.some((c) => JSON.stringify(c.globals) !== JSON.stringify(globals)))
    throw new Error("The plan's cases pass different globals");
  const keys = new Set(
    plan.cases.map((c) =>
      sourceKey({ files: [{ path: "main.tease", source: c.source }], globals: c.globals }),
    ),
  );
  const recorded = {
    commands: [
      [
        `node tests/families/property/bin/pilot.mjs plan --family ${plan.family} --profile ${plan.profile} --seed ${plan.seed} --out <plan>; bin/pilot.mjs run --plan <plan> --build <tree> per tree`,
        where,
      ],
    ],
    sources: keys.size,
    sha256: setKey(keys),
  };
  return [
    `// The ${plan.family} property family's sources (#1442), made from its dimensions`,
    `// (tests/families/property/) at profile ${plan.profile}, seed ${plan.seed}; its run reads no other input. Plan:`,
    `// ${plan.planHash}`,
    `export const cases = ${JSON.stringify(plan.cases.map((c) => [c.id, c.source]))};`,
    `export const globals = ${JSON.stringify(globals)};`,
    'export const checks = ["publication", "stops"];',
    "",
    "/** The evidence run this generator reproduces, checked by `tests/families/check.mjs`. */",
    `export const recorded = ${JSON.stringify(recorded)};`,
    "",
  ].join("\n");
}
