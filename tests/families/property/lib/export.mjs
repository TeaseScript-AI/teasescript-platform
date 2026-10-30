import { validatePlan } from "./plan.mjs";
/** Data-only corpus adapter: no implementation imports or scheduler. Publication comparison is not the S8 behavior oracle. */
export function corpusModule(plan) {
  validatePlan(plan);
  const cases = plan.cases.map((c) => [c.id, c.source]);
  const globals = [...new Set(plan.cases.flatMap((c) => c.globals))];
  return `// Generated from frozen pilot plan ${plan.planHash}.\n// Publication/stops comparison only; retain independent S8 behavior checks separately.\nexport const cases = ${JSON.stringify(cases, null, 2)};\nexport const globals = ${JSON.stringify(globals)};\nexport const checks = ["publication", "stops"];\n`;
}
