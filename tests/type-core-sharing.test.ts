import assert from "node:assert/strict";
import test from "node:test";

import { compileProjectWithBackend } from "../src/compiler.js";
import { analyseCore, coreResult } from "../src/type-inference/core/answers.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../src/type-inference/core/backend.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { ingressLeaves, type Item, writerKey } from "../src/type-inference/core/items.js";
import { type CoreAnalysisRequest, CoreProgram } from "../src/type-inference/core/program.js";
import { coreRecord } from "../src/type-inference/core/result.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import { withSolverSeam } from "../src/type-inference/core/solver.js";
import type { PlaceId } from "../src/type-inference/graph.js";
import { coreRequest, type SourceFile } from "./helpers/type-core-analysis.js";
import {
  ADMISSION_FAMILIES,
  ADMISSION_INGRESS_PRESETS,
  ADMISSION_KNOWN_PRODUCTS,
  ADMISSION_SAME_SOURCES,
  DIRECT_INGRESS_PROGRAMS,
  HELD_SHARING_FAULTS,
  MIXED_ADD_PRODUCTS,
  ORACLE_PROGRAMS,
  READ_CHAIN_PRODUCTS,
  REPAIRED_SHARING_FAULTS,
  VALUE_CLASS_SITES,
  VALUE_SHARING_PROGRAMS,
  W34_KNOWN_PRODUCTS,
  W34_VARIANTS,
  W44_VARIANTS,
  W45_VARIANTS,
  WORK_FAMILIES,
} from "./helpers/type-core-families.js";
import { readFixture } from "./helpers/type-core-fixture.js";
import { COMPOSITIONS, roleClasses } from "./helpers/type-core-roles.js";
import { shapesOf } from "./helpers/type-core-rule.js";
import { CARRIER_WITNESSES, WRITTEN_COPY_MATRIX } from "./helpers/type-core-witnesses.js";
import {
  DEFAULT_CHAIN_MATRIX,
  INFERRED_COPY_MATRIX,
  OBJECT_PROPERTY_MATRIX,
  UNION_RULE_MATRIX,
  UNRESTRICTED_COLLECTION_MATRIX,
  V30_TYPE_MATRIX,
  WRITTEN_DOMAIN_MATRIX,
} from "./helpers/type-core-written.js";

/*
 * The sharing differential (TABLE r4.72): S6's sharing of answers between equivalent values (alias classes and chains
 * of copies, S6-CARRIERS §4.1; levels by structure, §4.6; a walk's stops of one snapshot, the decider's and the named
 * data's, §3.1; a literal's entries for the reads of one key, TABLE §8) and S6c's (a choice's options, a run of adds, a
 * literal's computed values and a prefix's entries by their class, `Contract.classOf`, TABLE r4.85) is an optimization,
 * so it is output-neutral: for every program below, in both orders, the published diagnostics, the owed checks, every
 * binding's admitted type at its root and its element (the decider's site with it) and the candidate route's lowered
 * plan (or its rejection) are byte-identical with the sharing on and off (`withoutSharing`). Any difference fails the
 * test. On CI (GitHub Actions sets `CI`) the fixtures' records and the written-domain matrices' sources (whose own
 * tests run each source in both orders) run in the source order only, every other program in both; a local `npm run
 * check` runs them all in both orders (the orchestrator's decision on the CI job's time, 2026-10-26, and the lead's for
 * the matrices).
 *
 * Two components of a snapshot have no program here yet where they alone change the output (Astra r6): the guard bit
 * (`Contract.readSnapshot`) and the via signature in the stop identity and the decider's snapshots. No such program is
 * known: one store's reads of one key share their guard regions (a branch, the code after a leaving one, and an
 * `and`/`or` right operand, whose value is a boolean and carries no read), and the 30 via-only stop collisions of this
 * corpus (an `otherwise`'s operand and fallback reading one record, `A8-added-*-presets`) pair reads of one snapshot at
 * one depth, whose items and sites are the same; 226 probes built for the two (an operand beside its fallback, a
 * receiver beside its default, guarded beside unguarded copies and returns) publish the same without either. The D1
 * witness differs in its via and its depth together.
 */

interface Program {
  readonly name: string;
  readonly files: readonly SourceFile[];
  /** A fixture's record or a written-domain matrix's source, in the source order only on CI. */
  readonly sourceOrderOnCi?: true;
}

const CI_ORDERS = process.env["CI"] === "true" ? [false] : [false, true];

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
    READ_CHAIN_PRODUCTS,
    MIXED_ADD_PRODUCTS,
    VALUE_CLASS_SITES,
  ])
    for (const family of families)
      for (const k of [2, 3])
        out.push({ name: `${family.name} at ${k}`, files: family.program(k) });
  for (const { name, files } of ORACLE_PROGRAMS) out.push({ name: `oracle ${name}`, files });
  for (const { name, files } of REPAIRED_SHARING_FAULTS)
    out.push({ name: `repaired ${name}`, files });
  // S6c's programs: each discovery it shares beside what a coarser key would merge (`VALUE_SHARING_PROGRAMS`)
  for (const { name, files } of VALUE_SHARING_PROGRAMS) out.push({ name: `S6c ${name}`, files });
  for (const { name, files } of DIRECT_INGRESS_PROGRAMS) out.push({ name: `#1196 ${name}`, files });
  // external round 7 B1's written copies (`WRITTEN_COPY_MATRIX`)
  for (const { name, source } of WRITTEN_COPY_MATRIX) out.push(one(`written copy ${name}`, source));
  // the merged S6's written-domain matrices (`type-core-written.ts`), each exact source once (Astra's D3)
  const sources = new Set<string>();
  for (const { name, source } of [
    ...WRITTEN_DOMAIN_MATRIX,
    ...UNRESTRICTED_COLLECTION_MATRIX,
    ...V30_TYPE_MATRIX,
    ...INFERRED_COPY_MATRIX,
    ...OBJECT_PROPERTY_MATRIX,
    ...DEFAULT_CHAIN_MATRIX,
    ...UNION_RULE_MATRIX,
  ])
    if (!sources.has(source)) {
      sources.add(source);
      out.push({ ...one(`written domain ${name}`, source), sourceOrderOnCi: true });
    }
  // Astra's round-5 D1 witness: a decider beside an unselected read of its source (her B1 shape is the oracle's)
  out.push(
    one(
      "a decider beside an unselected read of its source",
      'let raw = hostValue\nraw = 1\nlet out = [[raw].get(9, default: null), raw, "tail"]\nrepeat out[0] {}\nexit\n',
    ),
  );
  for (const record of readFixture())
    out.push({ name: record.name, files: record.files, sourceOrderOnCi: true });
  return out;
}

// (a written-domain matrix's host-started binding reads `hostInit`, `WrittenCase.globals`)
const GLOBALS = ["hostValue", "hostInit"];

/** A program's request and its bindings, built once for its four analyses. */
interface Prepared {
  readonly program: Program;
  readonly request: CoreAnalysisRequest;
  readonly bindings: readonly PlaceId[];
}

function prepared(program: Program): Prepared {
  const request = coreRequest(program.files, GLOBALS);
  assert.ok(request !== null, `${program.name}: its files parse and resolve`);
  const bindings = new CoreProgram(request).places
    .filter(({ kind }) => kind.kind === "binding")
    .map((place) => place.id);
  return { program, request, bindings };
}

/** Two sites as (file index, start, end), in source order. */
function compareSites(a: readonly number[], b: readonly number[]): number {
  return a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;
}

/**
 * What a program publishes, in one order: the answers, each binding's admitted types, the plan or the rejection; the
 * record alone (its outcome, diagnostics and checks, and the same serialized); and whether each of its lists is in
 * source order of its sites (r4.86 (1)).
 */
function published(
  { program, request, bindings }: Prepared,
  reversed: boolean,
): { readonly text: string; readonly record: string; readonly sited: boolean } {
  const ordered = <T>(callback: () => T): T =>
    reversed
      ? withConsumerOrder(
          (list) => [...list].reverse(),
          () => withSolverSeam({ reverseWorklist: true }, callback),
        )
      : callback();
  const answers = ordered(() => analyseCore(request));
  const admitted = bindings.map((place) => [
    place,
    answers.place(place, []).admitted,
    answers.place(place, ["element"]).admitted,
  ]);
  const lowered = (() => {
    try {
      const result = ordered(() =>
        compileProjectWithBackend(program.files, { globals: GLOBALS }, CORE_BACKEND),
      );
      return { plan: result.plan, diagnostics: result.diagnostics };
    } catch (error) {
      if (!(error instanceof CandidateOutsideSlice)) throw error;
      return { outside: error.what };
    }
  })();
  const record = {
    outcome: answers.outcome,
    diagnostics: answers.diagnostics,
    checks: answers.checks,
  };
  const paths = program.files.map((file) => file.path);
  const serialized = coreRecord(coreResult(answers), paths);
  const sitesOf = (
    list: readonly {
      readonly site: { readonly file: number; readonly start: number; readonly end: number };
    }[],
  ) => list.map(({ site }) => [site.file, site.start, site.end]);
  const recordSites = (
    list: readonly {
      readonly site: { readonly file: string; readonly offset: number; readonly end: number };
    }[],
  ) => list.map(({ site }) => [paths.indexOf(site.file), site.offset, site.end]);
  const sited = [
    sitesOf(answers.diagnostics),
    sitesOf(answers.checks),
    recordSites(serialized.diagnostics),
    recordSites(serialized.runtimeChecks),
  ].every((sites) =>
    sites.every((site, index) => index === 0 || compareSites(sites[index - 1]!, site) <= 0),
  );
  return {
    text: JSON.stringify({ ...record, admitted, lowered }),
    record: JSON.stringify({ record, serialized }),
    sited,
  };
}

test("the core's sharing of answers is output-neutral for every family, witness and record, in both orders, and its record is the same in both (TABLE r4.72, r4.86)", (t) => {
  const all = programs();
  const differing: string[] = [];
  let runs = 0;
  // (programs of one exact input, their files in order, share its outcome in each order: each is reported by its name)
  const changed = new Map<string, boolean>();
  // (the record a program publishes, and its serialized form, is in source order of its sites, the same in both orders:
  // r4.86 (1))
  const reordered: string[] = [];
  const unsited: string[] = [];
  for (const program of all) {
    let ready: Prepared | undefined;
    const records: string[] = [];
    for (const reversed of program.sourceOrderOnCi === true ? CI_ORDERS : [false, true]) {
      const input = `${reversed}|${JSON.stringify(program.files)}`;
      let differs = changed.get(input);
      if (differs === undefined) {
        runs += 1;
        const once = (ready ??= prepared(program));
        const shared = published(once, reversed);
        differs = shared.text !== withoutSharing(() => published(once, reversed)).text;
        changed.set(input, differs);
        records.push(shared.record);
        if (!shared.sited) unsited.push(`${program.name}${reversed ? " (reversed)" : ""}`);
      }
      if (differs) differing.push(`${program.name}${reversed ? " (reversed)" : ""}`);
    }
    if (records.length === 2 && records[0] !== records[1]) reordered.push(program.name);
  }
  t.diagnostic(
    `${all.length} programs in ${runs} runs (each in both orders, the fixtures' and the matrices' in ` +
      `${CI_ORDERS.length}; one run per exact input and order), with the sharing on and off`,
  );
  assert.deepEqual(differing, []);
  assert.deepEqual(reordered, []);
  assert.deepEqual(unsited, []);
  assert.ok(all.length > 2_500, `${all.length} programs`);
});

/**
 * #1196: a read of a host global has a mixed class (`Contract.classOf`), so the values over it share their discovery
 * where their answer holds no external data and read every member where it does, each naming its own leaf (C9). A lost
 * leaf changes nothing the differential above publishes, so here every occurrence's answer, its items whole with their
 * leaves, is the same with the sharing on and off, in both orders, over #1196's controls.
 */
test("every occurrence over host data names each ingress's leaf with the sharing on and off, in both orders (#1196)", () => {
  const itemText = ({ ingress, writer, ...rest }: Item): string =>
    JSON.stringify({
      ...rest,
      writer: writer === null ? null : writerKey(writer),
      leaves: ingress === undefined ? [] : ingressLeaves(ingress).map(writerKey).sort(),
    });
  const occurrences = (request: CoreAnalysisRequest): string => {
    const answers = analyseCore(request);
    return answers.graph.nodes
      .flatMap((node) => {
        const answer = answers.at(node);
        return answer === null ? [] : [`${node.id} ${answer.items.map(itemText).join(" ")}`];
      })
      .join("\n");
  };
  const differing: string[] = [];
  for (const { name, files } of DIRECT_INGRESS_PROGRAMS) {
    const request = coreRequest(files, GLOBALS);
    assert.ok(request !== null, `${name}: its files parse and resolve`);
    for (const reversed of [false, true]) {
      const run = (): string =>
        reversed
          ? withConsumerOrder(
              (list) => [...list].reverse(),
              () => withSolverSeam({ reverseWorklist: true }, () => occurrences(request)),
            )
          : occurrences(request);
      if (run() !== withoutSharing(run)) differing.push(`${name}${reversed ? " (reversed)" : ""}`);
    }
  }
  assert.deepEqual(differing, []);
});

/** S6's sharing faults that reorder their diagnostics (`HELD_SHARING_FAULTS`), held: run and reported, failing nothing. */
test(
  "S6's held sharing faults are output-neutral in both orders",
  { todo: "Depends on #1059 (diagnostics published in source order), TABLE r4.83 (4)" },
  () => {
    const differing: string[] = [];
    for (const program of HELD_SHARING_FAULTS) {
      const once = prepared(program);
      for (const reversed of [false, true])
        if (published(once, reversed).text !== withoutSharing(() => published(once, reversed)).text)
          differing.push(`${program.name}${reversed ? " (reversed)" : ""}`);
    }
    assert.deepEqual(differing, []);
  },
);
