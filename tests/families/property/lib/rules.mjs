import { render } from "../families/s8-stores.mjs";
import { hash } from "./json.mjs";
import { expectedPlanType, typeSignature } from "./model.mjs";
import { modes } from "./selection.mjs";

/**
 * The scope rules a plan may name (`pilot.mjs plan --rules`; none by default, so a plan judges any pinned tree as
 * before them), each with a control: one fixed certified configuration whose outcome tells whether the tree holds the
 * rule. 1440: a store at or below a stop that the source certifies (`certificate.mjs`) is judged on its whole domain,
 * as trees from #1440 (`39b864aa2`) on check it; its control, a property a copy decides stored at demand allowance 1,
 * stops at its own key on trees before and after, and its store's planned check is the whole type only after.
 */
export const RULES = {
  1440: {
    title:
      "#1440 (39b864aa2): a certified store at or below a stop is checked against its whole type",
    control: { leaf: "integer", depth: 2, nullable: "none", carrier: "field" },
    mode: modes[0],
    policy: { kind: "demand", units: 1 },
  },
};

/** A plan's rules: known, each once, in one order; `[]` for none. */
export function checkRules(rules) {
  if (
    !Array.isArray(rules) ||
    rules.some((rule) => typeof rule !== "string" || !Object.hasOwn(RULES, rule)) ||
    new Set(rules).size !== rules.length
  )
    throw new Error(`Unknown or repeated rule: ${JSON.stringify(rules)}`);
  return [...rules].sort();
}

/** The control's configuration, judged under its rule; its source is fixed, whatever the plan's seed. */
export function ruleControl(rule) {
  const { control, mode, policy } = RULES[rule];
  const c = render(control, 1442);
  return {
    id: hash({ caseId: c.id, mode, policy, rule }).slice(0, 24),
    case: c,
    mode,
    policy,
    rules: [rule],
  };
}

/** Whether the control's row shows the rule: its store at its stop, settled, and checked against its whole type. */
export function ruleHolds(rule, row) {
  const expected = typeSignature(expectedPlanType(ruleControl(rule).case.type));
  return (
    row.scope?.relation === "at-or-below" &&
    row.scope.phase === "settled" &&
    row.plannedType === expected
  );
}
