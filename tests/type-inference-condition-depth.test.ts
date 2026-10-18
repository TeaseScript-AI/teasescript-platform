import test from "node:test";

import { compileValidPlan } from "./helpers/compile-valid-plan.js";

/**
 * The depth the base accepts for a condition (O4 stage 2c, work note §6): 16,000 parentheses, conjunctions,
 * disjunctions and negations around a grouped condition each compile to a plan with no diagnostics at `4807b7570`;
 * the recognizer and its consumers must accept the same. The parser and the checker read these iteratively; a
 * recursive reading would exhaust the call stack long before this depth and surface as a diagnostic.
 */
const DEPTH = 16_000;
const PRELUDE = "let b = randomInteger(0..=1) == 1\nlet v: integer? = null\nif b { v = 1 }\n";

const DEEP: readonly { readonly name: string; readonly condition: string }[] = [
  { name: "parentheses", condition: `${"(".repeat(DEPTH)}v != null${")".repeat(DEPTH)}` },
  { name: "conjunctions", condition: `${"b and ".repeat(DEPTH)}b` },
  { name: "disjunctions", condition: `${"(b or ".repeat(DEPTH)}b${")".repeat(DEPTH)}` },
  { name: "negations", condition: `${"not ".repeat(DEPTH)}(v != null)` },
  { name: "nested negations", condition: `${"not (".repeat(DEPTH)}v != null${")".repeat(DEPTH)}` },
];

for (const { name, condition } of DEEP)
  test(`a condition under ${DEPTH} ${name} compiles`, () => {
    compileValidPlan(`${PRELUDE}if ${condition} { say "deep" }\nexit`);
  });
