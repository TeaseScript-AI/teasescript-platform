import assert from "node:assert/strict";
import test from "node:test";

import { compileProjectWithBackend } from "../src/compiler.js";
import { analyseCore } from "../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { CoreProgram } from "../src/type-inference/core/program.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import { coreRequest, type SourceFile } from "./helpers/type-core-analysis.js";
import {
  ADMISSION_FAMILIES,
  ADMISSION_INGRESS_PRESETS,
  ADMISSION_KNOWN_PRODUCTS,
  ADMISSION_SAME_SOURCES,
  ORACLE_PROGRAMS,
  W34_KNOWN_PRODUCTS,
  W34_VARIANTS,
  W44_VARIANTS,
  W45_VARIANTS,
  WORK_FAMILIES,
} from "./helpers/type-core-families.js";
import { readFixture } from "./helpers/type-core-fixture.js";
import { COMPOSITIONS, roleClasses } from "./helpers/type-core-roles.js";
import { shapesOf } from "./helpers/type-core-rule.js";
import { CARRIER_WITNESSES } from "./helpers/type-core-witnesses.js";

/*
 * The sharing differential (TABLE r4.72): S6's sharing of answers between equivalent values (alias classes and chains
 * of copies, S6-CARRIERS §4.1; levels by structure, §4.6; a walk's stops of one snapshot, the decider's and the named
 * data's, §3.1; a literal's entries for the reads of one key, TABLE §8) is an optimization, so it is output-neutral: for
 * every program below, in both orders, the published diagnostics, the owed checks, every binding's admitted type at its
 * root and its element (the decider's site with it) and the candidate route's lowered plan (or its rejection) are
 * byte-identical with the sharing on and off (`withoutSharing`). Any difference fails the test.
 */

interface Program {
  readonly name: string;
  readonly files: readonly SourceFile[];
}

const one = (name: string, source: string): Program => ({
  name,
  files: [{ path: "main.tease", source }],
});

function programs(): Program[] {
  const out: Program[] = [];
  for (const shape of shapesOf(roleClasses().classes)) out.push(one(shape.name, shape.source));
  for (const [name, source] of COMPOSITIONS)
    out.push(one(`composition ${name}`, `${source}exit\n`));
  for (const [name, source] of CARRIER_WITNESSES)
    out.push(one(`witness ${name}`, `${source}exit\n`));
  for (const families of [
    WORK_FAMILIES,
    W34_VARIANTS,
    W44_VARIANTS,
    W45_VARIANTS,
    W34_KNOWN_PRODUCTS,
    ADMISSION_FAMILIES,
    ADMISSION_KNOWN_PRODUCTS,
    ADMISSION_SAME_SOURCES,
    ADMISSION_INGRESS_PRESETS,
  ])
    for (const family of families)
      for (const k of [2, 3])
        out.push({ name: `${family.name} at ${k}`, files: family.program(k) });
  for (const { name, files } of ORACLE_PROGRAMS) out.push({ name: `oracle ${name}`, files });
  // Astra's round-5 D1 witness: a decider beside an unselected read of its source (her B1 shape is the oracle's)
  out.push(
    one(
      "a decider beside an unselected read of its source",
      'let raw = hostValue\nraw = 1\nlet out = [[raw].get(9, default: null), raw, "tail"]\nrepeat out[0] {}\nexit\n',
    ),
  );
  for (const record of [...readFixture(), ...readFixture("cells-rule-function.jsonl")])
    out.push({ name: record.name, files: record.files });
  return out;
}

/** What a program publishes, in one order: the answers, each binding's admitted types, the plan or the rejection. */
function published(program: Program, reversed: boolean): string {
  const globals = ["hostValue"];
  const ordered = <T>(callback: () => T): T =>
    reversed
      ? withConsumerOrder(
          (list) => [...list].reverse(),
          () => withSolverSeam({ reverseWorklist: true }, callback),
        )
      : callback();
  const request = coreRequest(program.files, globals);
  assert.ok(request !== null, `${program.name}: its files parse and resolve`);
  const answers = ordered(() => analyseCore(request));
  const admitted = new CoreProgram(request).places
    .filter(({ kind }) => kind.kind === "binding")
    .map((place) => [
      place.id,
      answers.place(place.id, []).admitted,
      answers.place(place.id, ["element"]).admitted,
    ]);
  const lowered = (() => {
    try {
      const result = ordered(() =>
        compileProjectWithBackend(program.files, { globals }, CORE_BACKEND),
      );
      return { plan: result.plan, diagnostics: result.diagnostics };
    } catch (error) {
      if (!(error instanceof CandidateOutsideSlice)) throw error;
      return { outside: error.what };
    }
  })();
  return JSON.stringify({
    outcome: answers.outcome,
    diagnostics: answers.diagnostics,
    checks: answers.checks,
    admitted,
    lowered,
  });
}

test("the core's sharing of answers is output-neutral for every family, witness and record, in both orders (TABLE r4.72)", (t) => {
  const all = programs();
  const differing: string[] = [];
  for (const program of all)
    for (const reversed of [false, true])
      if (published(program, reversed) !== withoutSharing(() => published(program, reversed)))
        differing.push(`${program.name}${reversed ? " (reversed)" : ""}`);
  t.diagnostic(`${all.length} programs, each in both orders, with the sharing on and off`);
  assert.deepEqual(differing, []);
  assert.ok(all.length > 2_500, `${all.length} programs`);
});
