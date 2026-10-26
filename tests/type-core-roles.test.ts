import assert from "node:assert/strict";
import test from "node:test";

import { compileSourceWithBackend } from "../src/compiler.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { CARRIER_ROLES, operandsOf } from "../src/type-inference/core/carriers.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { CoreProgram } from "../src/type-inference/core/program.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { compactAnalysis, coreRequest } from "./helpers/type-core-analysis.js";
import { derive, evaluate, syntaxOf } from "./helpers/type-core-derived.js";
import { recordDifferences, recordOf } from "./helpers/type-core-records.js";
import {
  assignments,
  derivedStores,
  plannedStores,
  runGlobals,
} from "./helpers/type-core-route.js";
import { COMPOSITIONS, roleClasses, ROLES } from "./helpers/type-core-roles.js";
import { records, shapesOf } from "./helpers/type-core-rule.js";

/*
 * The role matrix (S6-CARRIERS revision 5, §6), beside the floor: generated from the carrier table's roles
 * (`CARRIER_ROLES`), each with its four placements of the data: inside a literal operand, the whole operand, the
 * operation's own read, a member's receiver (`type-core-roles.ts` holds the table and the compositions). Each placement
 * is a class of the rule function (`type-core-rule.ts`), its shapes each named and inline, without and with a later
 * store, compared exactly in both orders; a placement a role cannot have names why. A role the table gains without its
 * row fails here. A shape the candidate route takes also plans the checked stores its record derives and runs as derived
 * under every host value (§5.2, r4.59); the others report the route's reason.
 */

test("every carrier role's placements owe the rule function's complete C1, C9 and C10 records, in both orders (§6, §5.1)", (t) => {
  assert.deepEqual(Object.keys(ROLES).sort(), [...CARRIER_ROLES].sort());
  const { classes, none } = roleClasses();
  const all = shapesOf(classes);
  const wrong: string[] = [];
  const outside = new Map<string, number>();
  let routed = 0;
  for (const shape of all) {
    // (the shape takes its role: a carrier of its program has that operand, Codex r23 F3)
    const parsed = coreRequest([{ path: "main.tease", source: shape.source }]);
    assert.ok(parsed !== null, shape.name);
    const program = new CoreProgram(parsed);
    program.index();
    if (
      ![...program.projOf.keys(), ...program.opOf.keys()].some((value) =>
        operandsOf(program, value).some((operand) => operand.role === shape.carrier),
      )
    )
      wrong.push(`${shape.name}: no carrier of its program has the role`);
    const actual = records(shape.source);
    if (JSON.stringify(actual) !== JSON.stringify(shape.expected))
      wrong.push(
        `${shape.name}: ${JSON.stringify(actual)}, the rule owes ${JSON.stringify(shape.expected)}`,
      );
    // the plan and its runs where the candidate route takes the shape (TABLE r4.59), derived from its record
    let plan;
    try {
      plan = compileSourceWithBackend(shape.source, { globals: ["hostValue"] }, CORE_BACKEND).plan;
    } catch (error) {
      if (!(error instanceof CandidateOutsideSlice)) throw error;
      const what = error.what.replace(/^this /, "");
      outside.set(what, (outside.get(what) ?? 0) + 1);
      continue;
    }
    routed += 1;
    const request = coreRequest([{ path: "main.tease", source: shape.source }]);
    assert.ok(request !== null && plan !== null, shape.name);
    const syntax = syntaxOf(shape.source);
    const { stores } = derive(syntax, compactAnalysis(request));
    assert.deepEqual(
      plannedStores(plan),
      derivedStores(stores),
      `${shape.name}: the checked stores`,
    );
    for (const inputs of assignments(["hostValue"]))
      assert.deepEqual(
        runGlobals(plan, inputs),
        evaluate(syntax, stores, inputs).run,
        `${shape.name} with ${JSON.stringify(inputs)}`,
      );
  }
  t.diagnostic(
    `${all.length} shapes in ${classes.length} role placements compared exactly, ` +
      `${routed} planned and run on the candidate route; outside the slice until ` +
      `S7–S9b (the records only): ${[...outside].map(([what, count]) => `${what} ${count}`).join(", ")}; ` +
      `no shape: ${none.join("; ")}`,
  );
  assert.deepEqual(wrong, [], wrong.join("\n"));
});

/**
 * The role matrix's compositions (S6-CARRIERS §6), as exact records in both orders: round 4's eight choice regressions
 * (inline data a published choice selects owes the store's boundary at the host value, an unselected property none),
 * a carrier of a carrier and a carrier inside a literal inside a carrier (inline and named), inline and named data in one
 * selected collection (the named data's C1 at the selecting expression, the inline data's boundary alone: r4.63 (1), (2),
 * TABLE r4.67 (3)) and inline data or a host member beside an own read's named data (the merged item's C1 at the store's
 * value, the member's own place's at its read: r4.70 (1)), a choice over a held list (§3.3's record boundary beside C1),
 * a union holding a reference across two carriers (opaque by dispatch, checked at its consumer), and nullable root and
 * inner receivers of a member (r4.60 beside each receiver's C5 check). The mixed selected-value and absent-value-text
 * lists in both element orders are the cells test's (D1).
 */
test("the role matrix's compositions give their exact records, in both orders (§6)", () => {
  for (const [name, source, text] of COMPOSITIONS) {
    const request = coreRequest([{ path: "main.tease", source: `${source}exit\n` }]);
    assert.ok(request !== null, name);
    const expected = recordOf(text);
    const forward = compactAnalysis(request);
    const reversed = withSolverSeam({ reverseWorklist: true }, () =>
      withConsumerOrder(
        (list) => [...list].reverse(),
        () => compactAnalysis(request),
      ),
    );
    assert.deepEqual(recordDifferences(expected, forward), [], name);
    assert.deepEqual(recordDifferences(expected, reversed), [], `${name} reversed`);
  }
});
