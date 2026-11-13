// Carriers and chains of copies (S6-CARRIERS): an identity in linear space, every alias member answering as its class
// does, and chains resolved changing no published record.

import assert from "node:assert/strict";
import test from "node:test";
import { withMemberOracle, withoutChains } from "../../../src/type-inference/core/admission.js";
import { analyseCore, coreResult, type Answers } from "../../../src/type-inference/core/answers.js";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import { coreRecord } from "../../../src/type-inference/core/result.js";
import type { CoreAnalysisRequest } from "../../../src/type-inference/core/program.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { coreRequest, type SourceFile } from "../../helpers/type-core-analysis.js";
import { ADMISSION_FAMILIES } from "../../helpers/type-core/families/admission.js";
import {
  ADMISSION_SAME_SOURCES,
  VALUE_CLASS_SITES,
} from "../../helpers/type-core/families/admission-products.js";
import {
  DIRECT_INGRESS_PROGRAMS,
  ORACLE_PROGRAMS,
} from "../../helpers/type-core/families/sharing-faults.js";
import { HOT_CANDIDATE_FAMILIES } from "../../helpers/type-core/families/candidates.js";
import { VALUE_SHARING_PROGRAMS } from "../../helpers/type-core/families/value-sharing.js";
import { W34_VARIANTS } from "../../helpers/type-core/families/w34-links.js";
import {
  W44_VARIANTS,
  W45_VARIANTS,
  WORK_FAMILIES,
} from "../../helpers/type-core/families/work-gates.js";
import { readFixture } from "../../helpers/type-core/type-core-fixture.js";

/**
 * A value's identity names its inputs by their own identities (round 12 B4): a chain of 32 `otherwise`s, each
 * of the one before twice, is a source of 32 lines, never an identity of 2^32 characters.
 */
test("a chain of carriers over shared inputs is identified in linear space", () => {
  const levels = Array.from(
    { length: 32 },
    (_, index) => `let a${index + 1} = a${index} otherwise a${index}`,
  );
  const source = `let a0 = {n: 1}\n${levels.join("\n")}\nlet xs = [a32, a32]\nlet n: integer = xs[0].n\nexit`;
  const request = coreRequest([{ path: "main.tease", source }]);
  assert.ok(request !== null);
  assert.equal(analyseCore(request).outcome, "valid");
});

/** A program's published record in one order, as the oracle's analysis gives it, which the chain control reuses. */
const resolvedRecords = new Map<string, string>();

const recordKey = (files: readonly SourceFile[], reversed: boolean): string =>
  `${reversed}|${JSON.stringify(files)}`;

function publishedRecord(answers: Answers, files: readonly SourceFile[]): string {
  return JSON.stringify(
    coreRecord(
      coreResult(answers),
      files.map((file) => file.path),
    ),
  );
}

/**
 * S6-CARRIERS's member-answer oracle (the orchestrator's condition (a)), as a generated family: at every decided
 * path, each alias member's own answer equals its class representative's, each with its own guard applied, its items
 * compared whole (tags, certainty, reasons, context words, writers, leaves, marks). It runs over every work family at
 * small sizes, Astra's two M1 witnesses (a conditional store below the copied path before and between the copies) and
 * every alias form beside the events its class answers through, in both orders, and over the fixture's records.
 */
test("every alias member answers as its class does at every decided path, in both orders (condition (a))", (t) => {
  const differences: string[] = [];
  let compared = 0;
  const report = (difference: string | null): void => {
    compared += 1;
    if (difference !== null) differences.push(difference);
  };
  const run = (
    files: readonly SourceFile[],
    request: CoreAnalysisRequest,
    reversed: boolean,
  ): void => {
    const answers = withMemberOracle(report, () =>
      reversed
        ? withConsumerOrder(
            (list) => [...list].reverse(),
            () => withSolverSeam({ reverseWorklist: true }, () => analyseCore(request)),
          )
        : analyseCore(request),
    );
    resolvedRecords.set(recordKey(files, reversed), publishedRecord(answers, files));
  };

  // each program prepared once, then analysed in each order
  const inBoth = (name: string, files: readonly SourceFile[]): void => {
    const request = coreRequest(files);
    assert.ok(request !== null, `${name}: its files parse and resolve`);
    for (const reversed of [false, true]) run(files, request, reversed);
  };
  for (const family of [
    ...WORK_FAMILIES,
    ...W34_VARIANTS,
    ...W44_VARIANTS,
    ...W45_VARIANTS,
    ...ADMISSION_FAMILIES,
    ...HOT_CANDIDATE_FAMILIES,
    ...ADMISSION_SAME_SOURCES,
    ...VALUE_CLASS_SITES,
  ])
    for (const k of [2, 3, 5]) inBoth(`${family.name} at ${k}`, family.program(k));
  for (const { name, files } of [
    ...ORACLE_PROGRAMS,
    ...VALUE_SHARING_PROGRAMS,
    ...DIRECT_INGRESS_PROGRAMS,
  ])
    inBoth(name, files);
  for (const record of readFixture()) {
    const request = coreRequest(record.files);
    if (request !== null) run(record.files, request, false);
  }
  t.diagnostic(`${compared} member answers compared with their classes'`);
  assert.deepEqual(differences, []);
  assert.ok(compared > 1_000, `${compared} member answers compared`);
});

/**
 * S6-CARRIERS's chains: a member read through a chain of copies keeps its own links' writers, which the oracle
 * sets aside, so this guards what they are for: every published record, its diagnostics' F28 writers included, is the
 * same with every chain resolved and with none (`withoutChains`), over every work family at small sizes in both orders
 * and over the fixture's records. The resolved side is the oracle's analysis of the same program where it ran.
 */
test("resolving chains of copies changes no published record or writer, in both orders", () => {
  const differing: string[] = [];
  const compare = (
    name: string,
    files: readonly SourceFile[],
    request: CoreAnalysisRequest,
    reversed: boolean,
  ): void => {
    const run = (): string => {
      const analysed = (): Answers => analyseCore(request);
      const answers = reversed
        ? withConsumerOrder(
            (list) => [...list].reverse(),
            () => withSolverSeam({ reverseWorklist: true }, analysed),
          )
        : analysed();
      return publishedRecord(answers, files);
    };
    const resolved = resolvedRecords.get(recordKey(files, reversed)) ?? run();
    if (resolved !== withoutChains(run)) differing.push(`${name}${reversed ? " reversed" : ""}`);
  };
  // each program prepared once, then compared in each order
  for (const family of [
    ...WORK_FAMILIES,
    ...W34_VARIANTS,
    ...W44_VARIANTS,
    ...W45_VARIANTS,
    ...ADMISSION_FAMILIES,
    ...ADMISSION_SAME_SOURCES,
  ])
    for (const k of [2, 3, 5]) {
      const name = `${family.name} at ${k}`;
      const files = family.program(k);
      const request = coreRequest(files);
      assert.ok(request !== null, `${name}: its files parse and resolve`);
      for (const reversed of [false, true]) compare(name, files, request, reversed);
    }
  for (const record of readFixture()) {
    const request = coreRequest(record.files);
    if (request !== null) compare(record.name, record.files, request, false);
  }
  assert.deepEqual(differing, []);
});
