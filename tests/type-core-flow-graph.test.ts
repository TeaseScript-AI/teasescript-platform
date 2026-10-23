import assert from "node:assert/strict";
import test from "node:test";

import type { Statement } from "../src/ast.js";
import { parse } from "../src/parser.js";
import { someNode } from "../src/project-globals.js";
import { compileAndRunVariants, type FlowKnob } from "./helpers/flow-differential.js";
import { filesOf, flowDifferences, markerLiveness } from "./helpers/type-core-flow-oracle.js";
import { FLOW_PROGRAMS, HOST_GLOBALS } from "./helpers/type-core-flow-programs.js";

/*
 * The coarse core's flow graph against the lowering, over a corpus of every statement kind and every expression with
 * its own control flow (see `helpers/type-core-flow-oracle.ts` for what is compared, and how).
 */

test("the flow graph agrees with the lowering on every program of the corpus", () => {
  // A report of the first few differences of the first few programs: a broken graph differs in thousands.
  const report: string[] = [];
  let failing = 0;
  for (const program of FLOW_PROGRAMS) {
    const found = flowDifferences(program);
    const listed = program.refinements?.differences ?? [];
    const unexpected = found.filter((difference) => !listed.includes(difference));
    const missing = listed.filter((difference) => !found.includes(difference));
    if (unexpected.length === 0 && missing.length === 0) continue;
    failing += 1;
    if (failing <= 5)
      report.push(
        `${program.name}:`,
        ...unexpected.slice(0, 8).map((difference) => `  unexpected ${difference}`),
        ...missing.slice(0, 8).map((difference) => `  missing ${difference}`),
      );
  }
  assert.equal(failing, 0, `${failing} programs differ\n${report.join("\n")}`);
});

test("no marker that the flow graph finds dead runs", () => {
  // The graph's dead code is a claim about every run (X1), the refinements of literal facts included: each program
  // with a marker the graph finds dead and without host values runs every way its stored knobs allow, its permanent
  // buttons pressed.
  let checked = 0;
  for (const program of FLOW_PROGRAMS) {
    const files = filesOf(program);
    const live = markerLiveness(program);
    if (program.endless === true || ![...live.values()].includes(false)) continue;
    if (files.some((file) => HOST_GLOBALS.some((name) => file.source.includes(name)))) continue;
    const knobs: FlowKnob[] = [
      ...new Set(
        files.flatMap((file) =>
          [...file.source.matchAll(/load "(k\d+)"/g)].map((match) => match[1]!),
        ),
      ),
    ].map((key) => ({ key }));
    const { runs } = compileAndRunVariants(files, knobs, {}, null, null, true);
    assert.notEqual(runs.length, 0, `${program.name} runs`);
    for (const run of runs)
      for (const said of run.says)
        assert.notEqual(
          live.get(said),
          false,
          `${program.name}: ${said} runs, but the graph finds it dead`,
        );
    checked += 1;
  }
  assert.ok(checked >= 40, `${checked} programs run`);
});

/** Every statement kind, so the corpus has each (TypeScript keeps the list complete). */
const STATEMENT_KINDS: Record<Statement["kind"], true> = {
  speakerDeclaration: true,
  speakerSetterStatement: true,
  sayStatement: true,
  showButtonStatement: true,
  waitStatement: true,
  timerStatement: true,
  showImageStatement: true,
  hideImageStatement: true,
  showCameraStatement: true,
  hideCameraStatement: true,
  showPopupStatement: true,
  openUrlStatement: true,
  exportTextStatement: true,
  showPermanentButtonStatement: true,
  playMediaStatement: true,
  stopAudioStatement: true,
  saveStatement: true,
  deleteStatement: true,
  exitStatement: true,
  endStatement: true,
  labelStatement: true,
  gotoStatement: true,
  callFileStatement: true,
  letStatement: true,
  globalStatement: true,
  assignmentStatement: true,
  ifStatement: true,
  switchStatement: true,
  repeatStatement: true,
  forStatement: true,
  whileStatement: true,
  breakStatement: true,
  continueStatement: true,
  functionDeclaration: true,
  returnStatement: true,
  expressionStatement: true,
};

test("the corpus holds every statement kind", () => {
  const seen = new Set<string>();
  for (const program of FLOW_PROGRAMS)
    for (const file of filesOf(program))
      someNode(parse(file.source).program, (node) => {
        if (typeof node.kind === "string") seen.add(node.kind);
        return false;
      });
  assert.deepEqual(
    Object.keys(STATEMENT_KINDS).filter((kind) => !seen.has(kind)),
    [],
  );
});
