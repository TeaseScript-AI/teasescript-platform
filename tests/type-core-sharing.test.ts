import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, type Answers } from "../src/type-inference/core/answers.js";
import { withTestAllowance, withTestDemandAllowance } from "../src/type-inference/core/budget.js";
import { Contract } from "../src/type-inference/core/contract.js";
import { ingressLeaves, type Item } from "../src/type-inference/core/items.js";
import {
  type CoreAnalysisRequest,
  CoreProgram,
  propertyStep,
} from "../src/type-inference/core/program.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import type { PlaceId } from "../src/type-inference/graph.js";
import { VALUE_KIND_NAMES } from "../src/value-kinds.js";
import { coreRequest, type SourceFile } from "./helpers/type-core-analysis.js";
import {
  ADMISSION_FAMILIES,
  HOT_CANDIDATE_FAMILIES,
  ADMISSION_INGRESS_PRESETS,
  ADMISSION_KNOWN_PRODUCTS,
  ADMISSION_SAME_SOURCES,
  DIRECT_INGRESS_PROGRAMS,
  REORDERING_SHARING_FAULTS,
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
import { sampled, SWEEP } from "./helpers/sweep.js";
import {
  ingressAnswers,
  inMode,
  inOrder,
  MODES,
  publication,
  stopSet,
  publishedAnswers,
  publishedRoute,
} from "./helpers/type-core-oracles.js";
import {
  BOUNDED_ADMISSION_WITNESSES,
  CARRIER_WITNESSES,
  HOT_CANDIDATE_WITNESSES,
  WRITTEN_COPY_MATRIX,
} from "./helpers/type-core-witnesses.js";
import {
  OBJECT_PROPERTY_MATRIX,
  UNION_RULE_MATRIX,
  UNRESTRICTED_COLLECTION_MATRIX,
} from "./helpers/type-core-written.js";

/*
 * The sharing differential (TABLE r4.72): S6's sharing of answers between equivalent values (alias classes and chains
 * of copies, S6-CARRIERS §4.1; levels by structure, §4.6; a walk's stops of one snapshot, the decider's and the named
 * data's, §3.1; a literal's entries for the reads of one key, TABLE §8) and S6c's (a choice's options, a run of adds, a
 * literal's computed values and a prefix's entries by their class, `Contract.classOf`, TABLE r4.85) is an optimization,
 * so it is output-neutral: for every program below, in both orders, the published diagnostics, the owed checks, every
 * binding's admitted type at its root and its element (the decider's site with it) and the candidate route's lowered
 * plan (or its rejection) are byte-identical with the sharing on and off (`withoutSharing`; `type-core-oracles.ts`).
 * Any difference fails the test. Of the fixture's records and of each written-domain matrix's sources (whose own tests
 * run each source in both orders) the test takes a sample (`sampled`: the first, the last and two between), every
 * other program whole; `TEASESCRIPT_SWEEP=full` takes them all, the sweep's queue evidence (`docs/TESTING.md`, "Sampled
 * sweeps"; the lead's decision on #1638). `type-core-written.test.ts` compares the sources of the matrices it checks in three
 * layers (`WRITTEN_DOMAIN_MATRIX`, `V30_TYPE_MATRIX`, `INFERRED_COPY_MATRIX`, `DEFAULT_CHAIN_MATRIX`) on the analyses
 * and plans its own tests observe.
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
}

const one = (name: string, source: string): Program => ({
  name,
  files: [{ path: "main.tease", source }],
});

/**
 * #1210's programs: projections of host reads (a property, an element, a nested property) in one literal, in records, in
 * lists or bare, two deep and read below, beside another field, another global, a direct read and known data, guarded,
 * changed between, chosen, selected and added; a named source and a named projection the controls.
 * Each `^` marks a host read whose leaf the receiving place's contract at `place` and the receiving read `read` name;
 * `answered`: the read names only the first so many (the others take their test's narrowing, its kind no longer
 * external data, S10 part 2b).
 */
const PROJECTED_INGRESS_PROGRAMS: readonly {
  readonly name: string;
  readonly lines: readonly string[];
  readonly place: readonly [string, readonly string[]];
  readonly read: string;
  readonly answered?: number;
}[] = [
  {
    name: "records of one property read (the issue's witness)",
    lines: [
      "let box = [{n: ^hostValue.n}, {n: ^hostValue.n}]",
      "let out: integer = box[0].n",
      'say "DONE"',
    ],
    place: ["box", ["element", "n"]],
    read: "box[0].n",
  },
  {
    name: "lists of one property read",
    lines: ["let box = [[^hostValue.text], [^hostValue.text]]", "let n: integer = box.first[0]"],
    place: ["box", ["element", "element"]],
    read: "box.first[0]",
  },
  {
    name: "lists of one property read with a direct read between",
    lines: [
      "let box = [[^hostValue.text], [^hostValue], [^hostValue.text]]",
      "let n: integer = box.first[0]",
    ],
    place: ["box", ["element", "element"]],
    read: "box.first[0]",
  },
  {
    name: "records of one element read",
    lines: ["let box = [{n: ^hostValue[0]}, {n: ^hostValue[0]}]", "let out: integer = box[0].n"],
    place: ["box", ["element", "n"]],
    read: "box[0].n",
  },
  {
    name: "records of one nested property read",
    lines: ["let box = [{n: ^hostValue.a.b}, {n: ^hostValue.a.b}]", "let out: integer = box[0].n"],
    place: ["box", ["element", "n"]],
    read: "box[0].n",
  },
  {
    name: "property reads bare",
    lines: ["let box = [^hostValue.n, ^hostValue.n]", "let out: integer = box[0]"],
    place: ["box", ["element"]],
    read: "box[0]",
  },
  {
    name: "records in records of one property read",
    lines: [
      "let box = [{w: {n: ^hostValue.n}}, {w: {n: ^hostValue.n}}]",
      "let out: integer = box[0].w.n",
    ],
    place: ["box", ["element", "w", "n"]],
    read: "box[0].w.n",
  },
  {
    name: "property reads read below an element step",
    lines: ["let box = [^hostValue.r, ^hostValue.r]", "let out: integer = box[0].n"],
    place: ["box", ["element", "n"]],
    read: "box[0].n",
  },
  {
    name: "reads of different properties",
    lines: ["let box = [{n: ^hostValue.n}, {n: ^hostValue.m}]", "let out: integer = box[0].n"],
    place: ["box", ["element", "n"]],
    read: "box[0].n",
  },
  {
    name: "reads of one property of two globals",
    lines: [
      "let box = [{n: ^hostValue.n}, {n: ^hostInit.n}, {n: ^hostValue.n}]",
      "let out: integer = box[0].n",
    ],
    place: ["box", ["element", "n"]],
    read: "box[0].n",
  },
  {
    name: "property reads beside a direct read and known data",
    lines: [
      "let box = [{n: ^hostValue.n}, {n: ^hostValue}, {n: 1}, {n: ^hostValue.n}]",
      "let out: integer = box[0].n",
    ],
    place: ["box", ["element", "n"]],
    read: "box[0].n",
  },
  {
    name: "guarded property reads beside one outside the test",
    lines: [
      "let outside = {n: ^hostValue.n}",
      "if hostValue.n > 0 {",
      "  let box = [outside, {n: ^hostValue.n}, {n: ^hostValue.n}]",
      "  let out: integer = box[0].n",
      "}",
    ],
    place: ["box", ["element", "n"]],
    read: "box[0].n",
  },
  {
    name: "narrowed property reads beside one outside the test",
    lines: [
      "let outside = {n: ^hostValue.n}",
      "if hostValue.n is integer {",
      "  let box = [outside, {n: ^hostValue.n}, {n: ^hostValue.n}]",
      "  let out: integer = box[0].n",
      "}",
    ],
    place: ["box", ["element", "n"]],
    read: "box[0].n",
    answered: 1,
  },
  {
    name: "property reads with a tested property below",
    lines: [
      "if hostValue.r.n is integer {",
      "  let box = [{w: ^hostValue.r}, {w: ^hostValue.r}]",
      "  let out: integer = box[0].w.n",
      "}",
    ],
    place: ["box", ["element", "w", "n"]],
    read: "box[0].w.n",
  },
  {
    name: "property reads with a call storing the property between",
    lines: [
      "function bump {",
      "  hostValue.n = 2",
      "  return 1",
      "}",
      "let box = [{n: ^hostValue.n}, {n: bump()}, {n: ^hostValue.n}]",
      "let out: integer = box[0].n",
    ],
    place: ["box", ["element", "n"]],
    read: "box[0].n",
  },
  {
    name: "the first of records of one property read",
    lines: ["let box = [{g: ^hostValue.n}, {g: ^hostValue.n}].first", "let out: integer = box.g"],
    place: ["box", ["g"]],
    read: "box.g",
  },
  {
    name: "property reads added",
    lines: [
      "let ys = []",
      "ys.add(^hostValue.n)",
      "ys.add(^hostValue.n)",
      "let out: integer = ys[0]",
    ],
    place: ["ys", ["element"]],
    read: "ys[0]",
  },
  {
    name: "control: property reads of a named source",
    lines: [
      "let raw = ^hostValue",
      "let box = [{n: raw.n}, {n: raw.n}]",
      "let out: integer = box[0].n",
    ],
    place: ["box", ["element", "n"]],
    read: "box[0].n",
  },
  {
    name: "control: reads of a named projection",
    lines: ["let p = ^hostValue.n", "let box = [{n: p}, {n: p}]", "let out: integer = box[0].n"],
    place: ["box", ["element", "n"]],
    read: "box[0].n",
  },
];

/** A #1210 program's source without its marks, and the spans (`start-end`) of the host reads they mark. */
function unmarked(lines: readonly string[]): {
  readonly source: string;
  readonly spans: readonly string[];
} {
  const spans: string[] = [];
  let source = "";
  for (const [index, part] of `${lines.join("\n")}\nexit\n`.split("^").entries()) {
    if (index > 0) spans.push(`${source.length}-${source.length + /^\w+/.exec(part)![0].length}`);
    source += part;
  }
  return { source, spans };
}

function programs(): Program[] {
  const out: Program[] = [];
  for (const shape of shapesOf(roleClasses().classes)) out.push(one(shape.name, shape.source));
  for (const [name, source] of COMPOSITIONS)
    out.push(one(`composition ${name}`, `${source}exit\n`));
  for (const [name, source] of CARRIER_WITNESSES)
    out.push(one(`witness ${name}`, `${source}exit\n`));
  for (const [name, source] of HOT_CANDIDATE_WITNESSES)
    out.push(one(`#1188 witness ${name}`, `${source}exit\n`));
  for (const [name, source] of BOUNDED_ADMISSION_WITNESSES)
    out.push(one(`bounded admission witness ${name}`, `${source}exit\n`));
  for (const families of [
    WORK_FAMILIES,
    W34_VARIANTS,
    W44_VARIANTS,
    W45_VARIANTS,
    W34_KNOWN_PRODUCTS,
    ADMISSION_FAMILIES,
    HOT_CANDIDATE_FAMILIES,
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
  for (const { name, lines } of PROJECTED_INGRESS_PROGRAMS)
    out.push(one(`#1210 ${name}`, unmarked(lines).source));
  // external round 7 B1's written copies (`WRITTEN_COPY_MATRIX`)
  for (const { name, source } of WRITTEN_COPY_MATRIX) out.push(one(`written copy ${name}`, source));
  // the merged S6's other written-domain matrices (`type-core-written.ts`), each exact source once (Astra's D3), each
  // matrix's sources sampled (`sampled`; every one in the sweep)
  const sources = new Set<string>();
  for (const matrix of [
    UNRESTRICTED_COLLECTION_MATRIX,
    OBJECT_PROPERTY_MATRIX,
    UNION_RULE_MATRIX,
  ]) {
    const own: Program[] = [];
    for (const { name, source } of matrix)
      if (!sources.has(source)) {
        sources.add(source);
        own.push(one(`written domain ${name}`, source));
      }
    out.push(...sampled(own));
  }
  // Astra's round-5 D1 witness: a decider beside an unselected read of its source (her B1 shape is the oracle's)
  out.push(
    one(
      "a decider beside an unselected read of its source",
      'let raw = hostValue\nraw = 1\nlet out = [[raw].get(9, default: null), raw, "tail"]\nrepeat out[0] {}\nexit\n',
    ),
  );
  // the fixture's records, sampled (every one in the sweep)
  out.push(...sampled(readFixture().map(({ name, files }) => ({ name, files }))));
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

/**
 * What a program publishes, in one order (`publishedAnswers`, `publishedRoute`): the answers, each binding's admitted
 * types, the plan or the rejection; the record alone; and whether each of its lists is in source order of its sites.
 */
function published(
  { program, request, bindings }: Prepared,
  reversed: boolean,
): { readonly text: string; readonly record: string; readonly sited: boolean } {
  const answers = publishedAnswers(
    inOrder(reversed, () => analyseCore(request)),
    bindings,
    request,
  );
  const route = inOrder(reversed, () => publishedRoute(program.files, GLOBALS));
  return { text: `${answers.text}\n${route.text}`, record: answers.record, sited: answers.sited };
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
    for (const reversed of [false, true]) {
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
    `${all.length} programs in ${runs} runs (each in both orders, one run per exact input and order; the fixture's ` +
      `records and the written-domain matrices' sources ${SWEEP ? "all" : "sampled"}), with the sharing on and off`,
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
 * leaves, is the same with the sharing on and off, in both orders, over #1196's controls and #1210's programs.
 */
test("every occurrence over host data names each ingress's leaf with the sharing on and off, in both orders (#1196)", () => {
  const occurrences = (request: CoreAnalysisRequest): string =>
    ingressAnswers(analyseCore(request));
  const differing: string[] = [];
  for (const { name, files } of [
    ...DIRECT_INGRESS_PROGRAMS,
    ...PROJECTED_INGRESS_PROGRAMS.map(({ name, lines }) =>
      one(`#1210 ${name}`, unmarked(lines).source),
    ),
  ]) {
    const request = coreRequest(files, GLOBALS);
    assert.ok(request !== null, `${name}: its files parse and resolve`);
    for (const reversed of [false, true]) {
      const run = (): string => inOrder(reversed, () => occurrences(request));
      if (run() !== withoutSharing(run)) differing.push(`${name}${reversed ? " (reversed)" : ""}`);
    }
  }
  assert.deepEqual(differing, []);
});

/**
 * #1210: a projection of a host read carries its ingress's leaf (S6-CARRIERS §3.1), so a literal's one entry for k such
 * reads unions their leaves and no identity merge drops a read. With the sharing on and off, in both orders, the
 * receiving place's contract and the receiving read name exactly the leaves of the reads the source marks, and the four
 * publish the same checks, each with its target, domain and site (a dropped read published a loose boundary).
 */
test("a projection of a host read names its ingress's leaf and publishes the same checks with the sharing on and off, in both orders (#1210)", () => {
  const leaves = (items: readonly Item[]): string =>
    [
      ...new Set(
        items.flatMap(({ ingress }) =>
          ingress === undefined
            ? []
            : ingressLeaves(ingress).map(({ start, end }) => `${start}-${end}`),
        ),
      ),
    ]
      .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
      .join(",");
  const wrong: string[] = [];
  for (const { name, lines, place, read, answered } of PROJECTED_INGRESS_PROGRAMS) {
    const { source, spans } = unmarked(lines);
    const expected = `${spans.join(",")} / ${spans.slice(0, answered ?? spans.length).join(",")}`;
    const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
    assert.ok(request !== null, `${name}: its source parses and resolves`);
    const id = new CoreProgram(request).places.find(
      ({ kind }) => kind.kind === "binding" && kind.name === place[0],
    )!.id;
    // (the place's contract and the read's answer, by their leaves; the checks whole)
    const answer = (): { readonly leaves: string; readonly checks: string } => {
      const answers = analyseCore(request);
      const node = answers.graph.nodes.find(
        ({ span }) => span !== null && source.slice(span.start.offset, span.end.offset) === read,
      )!;
      return {
        leaves: `${leaves(answers.place(id, place[1]).contract.kinds)} / ${leaves(answers.valueAt(node, []).items)}`,
        checks: JSON.stringify(answers.checks),
      };
    };
    let checks: string | undefined;
    for (const reversed of [false, true])
      for (const shared of [true, false]) {
        const run = shared
          ? inOrder(reversed, answer)
          : withoutSharing(() => inOrder(reversed, answer));
        const mode = `${reversed ? "reversed" : "source"} order, sharing ${shared ? "on" : "off"}`;
        if (run.leaves !== expected)
          wrong.push(`${name} (${mode}): leaves ${run.leaves}, expected ${expected}`);
        if ((checks ??= run.checks) !== run.checks)
          wrong.push(`${name} (${mode}): its checks differ from the first run's`);
      }
  }
  assert.deepEqual(wrong, []);
});

/**
 * S6's sharing faults that reordered their diagnostics on `main` (`REORDERING_SHARING_FAULTS`, TABLE r4.83 (4)): published in
 * source order of their sites (r4.86 (1)), the same with the sharing on and off, and in both orders.
 */
test("S6's sharing faults that reordered their diagnostics are output-neutral in both orders", () => {
  const differing: string[] = [];
  const reordered: string[] = [];
  for (const program of REORDERING_SHARING_FAULTS) {
    const once = prepared(program);
    const records: string[] = [];
    for (const reversed of [false, true]) {
      const shared = published(once, reversed);
      if (shared.text !== withoutSharing(() => published(once, reversed)).text)
        differing.push(`${program.name}${reversed ? " (reversed)" : ""}`);
      records.push(shared.record);
    }
    if (records[0] !== records[1]) reordered.push(program.name);
  }
  assert.deepEqual(differing, []);
  assert.deepEqual(reordered, []);
});

/**
 * #1398, #1299: a value's kinds stand in their fixed order (`mergeItems`), so what a program publishes, every
 * occurrence's answer with the order of its items included, is the same in the four modes. On `main` before, each
 * source here published another order in one mode: a copy ring whose cut a reversed walk meets elsewhere (#1398's
 * reduction of G5's `cut/s49`), its suggested test's kinds with it, and a list whose elements are added under a
 * condition, whose element read's `empty` the sharing placed first or last (#1299); two kind pairs each.
 */
const ORDER_WITNESSES: readonly Program[] = [
  ...[
    ['"x"', "integer", "1"],
    ["true", "string", '"y"'],
  ].map(([value, type, initial]) =>
    one(
      `a copy ring of ${value} and a written ${type}`,
      [
        `let bad = {p0: ${value}, p1: ${value}}`,
        "let host = hostValue",
        `let wint: ${type} = ${initial}`,
        `let wnull: ${type}? = null`,
        "let written = {p0: wint, p1: wnull}",
        "let a5 = bad",
        "let a4 = a5",
        "let a3 = a4",
        "let a2 = a3",
        "let a0 = written",
        "if a2 != null {",
        "  a3 = a2",
        "}",
        "a4 = a3",
        "a5 = a4",
        "a0 = a5",
        "a2 = a4",
        "a4 = a0",
        'say "${a2.p0}"',
        "a3 = host",
        "exit",
      ].join("\n"),
    ),
  ),
  ...[
    ["1", "2"],
    ["true", "1"],
  ].map(([first, second]) =>
    one(
      `elements ${first} and ${second} added under a condition`,
      [
        'let flag = askBoolean "go"',
        "let xs = []",
        "if flag {",
        `  xs.add(${first})`,
        `  xs.add(${second})`,
        "}",
        "say xs[0]",
        "exit",
      ].join("\n"),
    ),
  ),
];

test("what a program publishes, its answers' orders included, is the same in the four modes (#1398, #1299)", () => {
  const differing = ORDER_WITNESSES.flatMap(({ name, files }) => {
    const [first, ...others] = MODES.map((mode) => publication(files, mode, GLOBALS));
    return others.every((other) => other === first) ? [] : [name];
  });
  assert.deepEqual(differing, []);
  // (the suggested test names the kinds in the kinds' table order, whichever the source or the walk meets first)
  const { request } = prepared(ORDER_WITNESSES[0]!);
  for (const mode of MODES)
    assert.deepEqual(
      inMode(mode, () => analyseCore(request)).diagnostics.flatMap((diagnostic) =>
        diagnostic.code === "TSV042" && "fits" in diagnostic ? [diagnostic.fits] : [],
      ),
      [["integer", "string"]],
      JSON.stringify(mode),
    );
});

/**
 * #1398 (Astra r1 on #1558): a stopped answer takes the same fixed order. A null-defaulted load read beside a list
 * holding it, alone and beside a second load: at the test demand allowance 256 the reversed modes stop and answer from
 * the stopped sources (`CoreAnswers.#items`: the typed default's own shape), the source modes from the solver. In every
 * mode, at that allowance and at the natural one, each occurrence's items, its element's and its properties' stand in
 * the kinds' table order, then `unknown` and `empty`, whichever source answers.
 */
const STOPPED_ORDER_WITNESSES: readonly Program[] = [
  one(
    "a null-defaulted load beside a list holding it",
    'let a = load(hostValue, default: null)\nlet pair = [a]\nsay pair[0]\nsay pair[1].p\nsay a otherwise "fallback"\nexit\n',
  ),
  one(
    "two null-defaulted loads beside a list holding both",
    'let a = load(hostValue, default: null)\nlet b = load(hostOther, default: null)\nlet pair = [a,b]\nsay pair[0]\nsay pair[1].p\nsay a otherwise "fallback"\nexit\n',
  ),
];

test("a stopped answer's items stand in the kinds' table order too, in the four modes (#1398)", () => {
  const rank = new Map([...VALUE_KIND_NAMES, "unknown", "empty"].map((tag, index) => [tag, index]));
  const ordered = (items: readonly Item[]): boolean =>
    items.every(
      (item, index) => index === 0 || rank.get(items[index - 1]!.tag)! <= rank.get(item.tag)!,
    );
  const misordered: string[] = [];
  let stopped = 0;
  let lists = 0;
  for (const program of STOPPED_ORDER_WITNESSES) {
    const request = coreRequest(program.files, [...GLOBALS, "hostOther"]);
    assert.ok(request !== null, program.name);
    for (const allowance of [256, null])
      for (const mode of MODES) {
        const run = (): Answers => inMode(mode, () => analyseCore(request));
        const answers = allowance === null ? run() : withTestDemandAllowance(allowance, run);
        if (answers.budget.decisions.some((decision) => decision.stopped)) stopped += 1;
        for (const node of answers.graph.nodes) {
          const at = answers.at(node);
          if (at === null) continue;
          const tags = new Set(at.items.map((item) => item.tag));
          const each: (readonly Item[])[] = [
            at.items,
            ...(tags.has("list") ? [answers.project(node, "element")] : []),
            ...(tags.has("object") ? [...answers.properties(node).values()] : []),
          ];
          for (const items of each) {
            lists += 1;
            if (!ordered(items))
              misordered.push(
                `${program.name} ${JSON.stringify(mode)} ${allowance ?? "natural"} node ${node.id}: ${items.map((item) => item.tag).join(",")}`,
              );
          }
        }
      }
  }
  assert.deepEqual(misordered, []);
  assert.ok(stopped > 0, "a decision stops in some mode at the test allowance");
  assert.ok(lists > 100, `${lists} lists`);
});

/**
 * #1398 (Codex r3, r4 and r5 on #1558, TABLE r4.277): a list of a value's kinds takes its one order where it is
 * completed (`inItsOrder`): a written spelling's where exactly one spelling covers every kind but `null`, `unknown` and
 * `empty`, else the table's then `unknown`. The rows: a receiver beside its contract's reference kinds, the `besides`
 * gathered from a site's other warnings, a warning's `fits` (a fixed table of what fits, the one list the rule leaves
 * to the table's order, D3), a sort's families (in its elements' order), a fallback's family beside its receiving union
 * (its rule, its check and the check's text), what two reads take together, a shown set's elements, one place's
 * decision after a stop (Codex r4), the sort's warning the stop defers at a test allowance, a literal's sorted elements
 * after a stop; a written parse's or load's elements, read and sorted (Codex r5), a written value beside an inferred
 * kind it spells (D2's coverage) or one it does not, two spellings joined and one spelling read twice, and a written
 * value in a literal's cell; after a stop, a literal of a typed parse, a sorted literal of a written value and a typed
 * load's written default. Each row's published lists in the four modes: a written type's spelling keeps its own (the
 * store rows' `[string, integer]`, a written type a decision borrows, one a fallback's receiving type only repeats),
 * and the sort's offending kind is the one its elements' order picks, deferred or not.
 */
const COMPOSED_ORDER_ROWS: readonly {
  readonly name: string;
  readonly source: string;
  readonly analyse?: (request: CoreAnalysisRequest) => Answers;
  readonly lists: (
    answers: Answers,
    request: CoreAnalysisRequest,
  ) => readonly (readonly string[])[];
  readonly expected: readonly string[];
}[] = (() => {
  // (each diagnostic of a rule, a budget stop set aside)
  const ruled = (answers: Answers) =>
    answers.diagnostics.flatMap((diagnostic) => ("rule" in diagnostic ? [diagnostic] : []));
  const warnings = (answers: Answers) =>
    ruled(answers).flatMap((diagnostic) =>
      diagnostic.class === "warning-runtime-check" ? [diagnostic] : [],
    );
  const receivers = (answers: Answers) =>
    warnings(answers).flatMap((warning) =>
      warning.provenance.detail.receiver === null ? [] : [warning.provenance.detail.receiver.kinds],
    );
  const sort = "let values: (string | integer)[] = hostValue\nvalues.sort()\nexit\n";
  const fallback =
    'let direct: string | integer = "s"\nif hostValue == 1 { direct = 1 }\n' +
    "let value: string | integer | duration = direct otherwise hostOther\nsay value\nexit\n";
  const fallbacks = (answers: Answers) =>
    warnings(answers).flatMap((warning) => (warning.rule.rule === "fallback" ? [warning] : []));
  const stopped = (request: CoreAnalysisRequest) => analyseCore(request).stoppedAt("work");
  // (the admitted decision of `box`'s `n` elements, borrowed from a written type or not)
  const decided =
    (inherited: boolean) =>
    (answers: Answers, request: CoreAnalysisRequest): readonly (readonly string[])[] => {
      const box = new CoreProgram(request).places.find(
        ({ kind }) => kind.kind === "binding" && kind.name === "box",
      )!.id;
      const { admitted } = answers.place(box, [propertyStep("n"), "element"]);
      return admitted.by === "decided" && admitted.inherited === inherited ? [admitted.kinds] : [];
    };
  const deferred = (answers: Answers) =>
    answers.budget.deferred.flatMap((warning) =>
      warning.rule.rule === "elements" ? [{ warning, families: warning.rule.families }] : [],
    );
  // (the items of the last `text` after `before` in `source`, or of its `step`)
  const readOf =
    (source: string, before: string, text: string, step?: "element") =>
    (answers: Answers): readonly (readonly string[])[] => {
      const start = source.lastIndexOf(before + text) + before.length;
      const node = answers.graph.nodes.find(
        (found) =>
          found.span?.start.offset === start && found.span.end.offset === start + text.length,
      );
      if (node === undefined) return [];
      const items =
        step === undefined ? (answers.at(node)?.items ?? []) : answers.project(node, step);
      return [items.map((item) => item.tag)];
    };
  // (a written type's admitted kinds at a path of a binding)
  const written =
    (name: string, path: readonly string[]) =>
    (answers: Answers, request: CoreAnalysisRequest): readonly (readonly string[])[] => {
      const place = new CoreProgram(request).places.find(
        ({ kind }) => kind.kind === "binding" && kind.name === name,
      )!.id;
      const { admitted } = answers.place(place, path);
      return admitted.by === "written" ? [admitted.kinds] : [];
    };
  const elements = (answers: Answers) =>
    warnings(answers).flatMap((warning) =>
      warning.rule.rule === "elements" ? [{ warning, families: warning.rule.families }] : [],
    );
  const parse = "let xs: (string | integer)[] = fromJson(hostValue)\nxs.sort()\nexit\n";
  const load = 'let xs: (string | integer)[] = load("k", default: [1])\nxs.sort()\nexit\n';
  const w = "let w: string | integer = fromJson(hostValue)\n";
  const union =
    "let w: (string | integer)[] | (string | integer)[] = fromJson(hostValue)\nsay w[0]\nexit\n";
  const narrowed =
    "let x = hostValue\nif x is string | integer {\n  let y = x\n  let a = [y, 1]\n  a.sort()\n}\nexit\n";
  const typedLiteral = "let ys: (string | integer)[] = [fromJson(hostValue), 1]\nsay ys[0]\nexit\n";
  return [
    {
      name: "a receiver beside its contract's reference kinds",
      source: "let alias: speaker? = null\nsay alias.uppercase()\nexit\n",
      lists: receivers,
      expected: ["speaker", "null"],
    },
    {
      name: "a host receiver beside its contract's reference kinds",
      source: "let alias: speaker? = hostValue\nsay alias.uppercase()\nexit\n",
      lists: receivers,
      expected: ["speaker", "unknown"],
    },
    {
      name: "a condition's other kinds at its site",
      source:
        'let value: integer | string | duration | boolean = 1\nif hostValue == 1 { value = "s" }\n' +
        "if hostOther == 1 { value = 1 s }\nif value {}\nexit\n",
      lists: (answers) =>
        warnings(answers).flatMap((warning) =>
          warning.kinds[0] === "integer" && warning.besides.length > 0 ? [warning.besides] : [],
        ),
      expected: ["string", "duration"],
    },
    {
      name: "a sort's fits where a domain stands in for host data",
      source: sort,
      lists: (answers) =>
        warnings(answers).flatMap((warning) =>
          warning.rule.rule === "elements" ? [warning.fits] : [],
        ),
      expected: ["integer", "string"],
    },
    {
      name: "a sort's families, in its elements' order",
      source: sort,
      lists: (answers) =>
        ruled(answers).flatMap((diagnostic) =>
          diagnostic.rule.rule === "elements" && diagnostic.rule.families.length > 0
            ? [diagnostic.rule.families]
            : [],
        ),
      expected: ["string", "number"],
    },
    {
      name: "a sort's offending kind, by its elements' own order",
      source: sort,
      lists: (answers) =>
        warnings(answers).flatMap((warning) =>
          warning.rule.rule === "elements" ? [warning.kinds] : [],
        ),
      expected: ["integer"],
    },
    {
      name: "toJson's fits where a domain stands in for host data",
      source: "let values: (string | regex | integer)[] = hostValue\nsay toJson(values)\nexit\n",
      lists: (answers) =>
        warnings(answers).flatMap((warning) =>
          warning.rule.rule === "json" ? [warning.fits] : [],
        ),
      expected: ["integer", "string"],
    },
    {
      name: "a fallback's family beside its receiving union",
      source: fallback,
      lists: (answers) =>
        fallbacks(answers).flatMap((warning) =>
          warning.rule.rule === "fallback"
            ? [
                warning.rule.type,
                warning.obligation.against,
                warning.obligation.on.split(" against ")[1]!.split("|"),
              ]
            : [],
        ),
      expected: ["integer", "number", "string", "duration"],
    },
    {
      name: "a fallback's family alone",
      source:
        'let direct: string | integer = "s"\nif hostValue == 1 { direct = 1 }\n' +
        "let value = direct otherwise false\nsay value\nexit\n",
      lists: (answers) =>
        fallbacks(answers).flatMap((warning) =>
          warning.rule.rule === "fallback" ? [warning.rule.type, warning.obligation.against] : [],
        ),
      expected: ["integer", "number", "string"],
    },
    {
      name: "what two reads take together",
      source:
        'let value = [] + "s"\nlet first: number = value\nlet second = value + 1\nsay second\nexit\n',
      lists: (answers) =>
        ruled(answers).flatMap((diagnostic) =>
          diagnostic.class === "compile-error" && diagnostic.expects?.takes
            ? [diagnostic.expects.takes]
            : [],
        ),
      expected: ["integer", "number"],
    },
    {
      name: "a shown set's elements",
      source:
        'let values: (string | integer | object) set = set["s"]\nif hostValue == 1 { values = set[1] }\n' +
        'say "${values}"\nexit\n',
      lists: (answers) =>
        ruled(answers).flatMap((diagnostic) =>
          diagnostic.rule.rule === "shown" && diagnostic.rule.elements.length > 0
            ? [diagnostic.rule.elements]
            : [],
        ),
      expected: ["string", "integer", "object"],
    },
    {
      name: "one place's decision after a stop",
      source: 'let box = {n: [1, "s"]}\nexit\n',
      analyse: stopped,
      lists: decided(false),
      expected: ["integer", "string"],
    },
    {
      name: "a written type a place's decision borrows after a stop",
      source: "let w: string | integer = 1\nlet box = {n: [w]}\nexit\n",
      analyse: stopped,
      lists: decided(true),
      expected: ["string", "integer"],
    },
    {
      name: "a written type a fallback's receiving type repeats",
      source: 'let value: string | integer = load("key", default: false)\nsay value\nexit\n',
      lists: (answers) =>
        ruled(answers).flatMap((diagnostic) =>
          diagnostic.rule.rule === "fallback" ? [diagnostic.rule.type] : [],
        ),
      expected: ["string", "integer"],
    },
    ...[40, 160].flatMap((allowance) => {
      const analyse = (request: CoreAnalysisRequest) =>
        withTestAllowance(allowance, () => analyseCore(request));
      return [
        {
          name: `a deferred sort's offending kind at the allowance ${allowance}`,
          source: sort,
          analyse,
          lists: (answers: Answers) => deferred(answers).map(({ warning }) => warning.kinds),
          expected: ["integer"],
        },
        {
          name: `a deferred sort's fits at the allowance ${allowance}`,
          source: sort,
          analyse,
          lists: (answers: Answers) => deferred(answers).map(({ warning }) => warning.fits),
          expected: ["integer", "string"],
        },
        {
          name: `a deferred sort's families at the allowance ${allowance}`,
          source: sort,
          analyse,
          lists: (answers: Answers) => deferred(answers).map(({ families }) => families),
          expected: ["string", "number"],
        },
      ];
    }),
    {
      name: "a literal's sorted elements after a stop",
      source: 'let ys = ["s", 1].sort()\nexit\n',
      analyse: (request) => withTestAllowance(40, () => analyseCore(request)),
      lists: (answers) =>
        ruled(answers).flatMap((diagnostic) =>
          diagnostic.rule.rule === "elements" ? [diagnostic.kinds] : [],
        ),
      expected: ["integer", "string"],
    },
    ...[
      ["parse", parse],
      ["load", load],
    ].flatMap(([how, source]) => [
      {
        name: `a written ${how}'s elements, read`,
        source: source!,
        lists: readOf(source!, "\n", "xs", "element"),
        expected: ["string", "integer", "empty"],
      },
      {
        name: `a written ${how}'s admitted elements`,
        source: source!,
        lists: written("xs", ["element"]),
        expected: ["string", "integer"],
      },
      {
        name: `a written ${how}'s sorted elements' offending kind`,
        source: source!,
        lists: (answers: Answers) => elements(answers).map(({ warning }) => warning.kinds),
        expected: ["integer"],
      },
      {
        name: `a written ${how}'s sorted elements' families`,
        source: source!,
        lists: (answers: Answers) => elements(answers).map(({ families }) => families),
        expected: ["string", "number"],
      },
      ...[40, 160].map((allowance) => ({
        name: `a written ${how}'s deferred sort's offending kind at the allowance ${allowance}`,
        source: source!,
        analyse: (request: CoreAnalysisRequest) =>
          withTestAllowance(allowance, () => analyseCore(request)),
        lists: (answers: Answers) => deferred(answers).map(({ warning }) => warning.kinds),
        expected: ["integer"],
      })),
    ]),
    {
      name: "a written value beside an inferred kind it spells",
      source: `${w}let xs = [1]\nxs.add(w)\nsay xs[0]\nexit\n`,
      lists: readOf(`${w}let xs = [1]\nxs.add(w)\nsay xs[0]\nexit\n`, "say ", "xs[0]"),
      expected: ["string", "integer"],
    },
    {
      name: "a written value beside a kind it does not spell",
      source: `${w}let x = w otherwise true\nsay x\nexit\n`,
      lists: readOf(`${w}let x = w otherwise true\nsay x\nexit\n`, "say ", "x"),
      expected: ["integer", "string", "boolean"],
    },
    {
      name: "two spellings of one union joined",
      source: `${w}let v: integer | string = fromJson(hostOther)\nlet xs = [w]\nxs.add(v)\nsay xs[0]\nexit\n`,
      lists: readOf(
        `${w}let v: integer | string = fromJson(hostOther)\nlet xs = [w]\nxs.add(v)\nsay xs[0]\nexit\n`,
        "say ",
        "xs[0]",
      ),
      expected: ["integer", "string"],
    },
    {
      name: "one spelling read from two written places",
      source: `${w}let u: string | integer = fromJson(hostOther)\nlet xs = [w]\nxs.add(u)\nsay xs[0]\nexit\n`,
      lists: readOf(
        `${w}let u: string | integer = fromJson(hostOther)\nlet xs = [w]\nxs.add(u)\nsay xs[0]\nexit\n`,
        "say ",
        "xs[0]",
      ),
      expected: ["string", "integer"],
    },
    {
      name: "a written value in a literal's cell",
      source: `${w}let xs = [w]\nsay xs[0]\nexit\n`,
      lists: readOf(`${w}let xs = [w]\nsay xs[0]\nexit\n`, "say ", "xs[0]"),
      expected: ["string", "integer"],
    },
    // (after a stop at the test allowance 16: a typed parse's written destination beside a whole number in a literal,
    // the literal's children's kinds, each once; a sorted literal of a written value and a whole number, its deferred
    // families; a typed load's default a written value, the stores' syntax decision)
    {
      name: "a stopped literal of a typed parse and a whole number",
      source: typedLiteral,
      analyse: (request) => withTestAllowance(16, () => analyseCore(request)),
      lists: readOf(typedLiteral, " = ", "[fromJson(hostValue), 1]", "element"),
      // (each child's kinds once, beside its sibling's, as a stopped literal's shape gives them)
      expected: ["string", "integer", "integer"],
    },
    {
      name: "a stopped sort of a literal of a written value and a whole number",
      source: `${w}[w, 1].sort()\nexit\n`,
      analyse: (request) => withTestAllowance(16, () => analyseCore(request)),
      lists: (answers) => deferred(answers).map(({ families }) => families),
      expected: ["string", "number"],
    },
    {
      name: "a stopped syntax decision of a typed load's written default",
      source: `${w}let x = load(hostOther, default: w)\nlet ys = [x, 1]\nys.sort()\nexit\n`,
      analyse: stopped,
      lists: (answers, request) => {
        const x = new CoreProgram(request).places.find(
          ({ kind }) => kind.kind === "binding" && kind.name === "x",
        )!.id;
        const { admitted } = answers.place(x, []);
        return admitted.by === "decided" ? [admitted.kinds] : [];
      },
      expected: ["string", "integer"],
    },
    // (Codex r8: after a stop at the test allowance 16, a sort of a placeless literal's element, #1581's cells)
    {
      name: "a stopped sort of a placeless literal's element",
      source: '["s", 1][0].sort()\nexit\n',
      analyse: (request) => withTestAllowance(16, () => analyseCore(request)),
      lists: (answers) =>
        ruled(answers).flatMap((diagnostic) =>
          diagnostic.code === "TSV043" ? [diagnostic.kinds] : [],
        ),
      expected: ["integer", "string"],
    },
    // (Codex r6: after a stop, an inferred range conversion's elements; a written union of one spelling twice; a
    // stored read a written type test narrows host data to, natural)
    {
      name: "a stopped range conversion's elements",
      source: "let a = (1..5).toList()\nsay a[0]\nexit\n",
      analyse: stopped,
      lists: readOf(
        "let a = (1..5).toList()\nsay a[0]\nexit\n",
        "= ",
        "(1..5).toList()",
        "element",
      ),
      expected: ["integer", "empty"],
    },
    {
      name: "a stopped parse of a written union of one spelling twice",
      source: union,
      analyse: (request) => withTestAllowance(16, () => analyseCore(request)),
      lists: readOf(union, "= ", "fromJson(hostValue)", "element"),
      expected: ["string", "integer", "empty"],
    },
    {
      name: "a stored read a written type test narrows",
      source: narrowed,
      lists: readOf(narrowed, "[", "y"),
      expected: ["string", "integer"],
    },
    {
      name: "a sort of a stored read a written type test narrows, its families",
      source: narrowed,
      lists: (answers) => elements(answers).map(({ families }) => families),
      expected: ["string", "number"],
    },
    {
      name: "a sort of a stored read a written type test narrows, its offending kind",
      source: narrowed,
      lists: (answers) => elements(answers).map(({ warning }) => warning.kinds),
      expected: ["integer"],
    },
  ];
})();

/**
 * #1398 (Codex r10 on #1558): a narrowed local read's exact class takes its narrowing once, from its read class
 * (`readClass`), which already holds it, so building it costs what it did before the mark: at the test demand allowance
 * 256, reversed with the sharing on, a guarded list of a narrowed written value and a boolean stops its elements' `n`
 * in the second pass and its elements in the third, as on main.
 */
test("a narrowed local read's class charges its narrowing once: a guarded list's stops at 256 (#1398)", () => {
  for (const [kind, value] of [
    ["integer", "3"],
    ["string", '"written"'],
  ]) {
    const source =
      `let written: integer | string = ${value}\nif written is ${kind} {\nlet a = {n: written}\n` +
      "let b = {n: true}\nlet xs = [a, b]\nsay xs[0].n\n}\nexit\n";
    const found = stopSet(
      [{ path: "main.tease", source }],
      { reversed: true, unshared: false },
      ["hostValue", "hostInit", "hostOther"],
      256,
    );
    assert.deepEqual(
      found?.stops,
      [
        [2, "xs", "element.n", 1],
        [3, "xs", "element", 1],
      ],
      kind,
    );
  }
});

test("a list composed of a value's kinds stands in their fixed order where it is completed, in the four modes (#1398)", () => {
  const wrong: string[] = [];
  for (const row of COMPOSED_ORDER_ROWS) {
    const request = coreRequest(
      [{ path: "main.tease", source: row.source }],
      [...GLOBALS, "hostOther"],
    );
    assert.ok(request !== null, row.name);
    for (const mode of MODES) {
      const lists = row.lists(
        inMode(mode, () => (row.analyse ?? analyseCore)(request)),
        request,
      );
      if (lists.length === 0) wrong.push(`${row.name} ${JSON.stringify(mode)}: none published`);
      for (const list of lists)
        if (JSON.stringify(list) !== JSON.stringify(row.expected))
          wrong.push(`${row.name} ${JSON.stringify(mode)}: ${list.join(",")}`);
    }
  }
  assert.deepEqual(wrong, []);
});

/** #1573's programs: `n` bindings of choices of `k` reads of one host global's properties, read in `lists`. */
function choicesInLists(n: number, k: number, lists: readonly (readonly number[])[]): string {
  const options = Array.from({ length: k }, (_, r) => `{text: "${r}", value: hostValue.p${r}}`);
  return [
    ...Array.from({ length: n }, (_, j) => `let p${j} = askChoice ${options.join(", ")}`),
    ...lists.map(
      (list, i) =>
        `let xs${i} = [${list.map((j) => `p${j}`).join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
    ),
    "exit\n",
  ].join("\n");
}

/**
 * #1573: the choices of four bindings are one class mixed by their leaves, so a list's contract reads one member (the
 * first binding) and names the others' leaves (`othersLeaves`) through one node per sequence of other members as the
 * list holds them, each member's leaves its own: lists of all four with the other three in three orders, one of them
 * twice, and of three, whose other members are distinct sets of two (one of them with another read member). In both
 * orders with the sharing on, the two lists of one order name one node, the lists name no more nodes than with the
 * sharing off, and each list's leaves are its members', as with the sharing off.
 */
test("a list's other members of one mixed class name one node per order, each its own leaves, in both orders (#1573)", () => {
  const lists = [
    [0, 1, 2, 3],
    [0, 3, 2, 1],
    [3, 1, 0, 2],
    [0, 1, 2, 3],
    [0, 1, 2],
    [0, 2, 3],
    [0, 3, 1],
    [1, 2, 3],
  ];
  const source = choicesInLists(4, 2, lists);
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null, "the program parses and resolves");
  const places = new CoreProgram(request).places;
  const external = (answers: Answers): Item[] =>
    lists.map((_, i) => {
      const id = places.find(({ kind }) => kind.kind === "binding" && kind.name === `xs${i}`)!.id;
      const items = answers.place(id, ["element"]).contract.kinds;
      assert.deepEqual(
        items.map((item) => item.tag),
        ["unknown"],
        `xs${i}`,
      );
      return items[0]!;
    });
  const leaves = (items: readonly Item[]): string[] =>
    items.map((item) =>
      ingressLeaves(item.ingress!)
        .map(({ start }) => start)
        .join(","),
    );
  // (each member's options read `hostValue` at these offsets, on its own line)
  const lines = source.split("\n");
  const members = [0, 1, 2, 3].map((j) => {
    const at = lines.slice(0, j).reduce((sum, line) => sum + line.length + 1, 0);
    return [...lines[j]!.matchAll(/hostValue/g)].map((match) => at + match.index);
  });
  const expected = lists.map((list) =>
    list
      .flatMap((j) => members[j]!)
      .sort((a, b) => a - b)
      .join(","),
  );
  for (const reversed of [false, true]) {
    const shared: Item[] = inOrder(reversed, () => external(analyseCore(request)));
    const unshared: Item[] = inOrder(reversed, () =>
      withoutSharing(() => external(analyseCore(request))),
    );
    assert.deepEqual(leaves(shared), expected, `reversed: ${reversed}`);
    assert.deepEqual(leaves(unshared), expected, `reversed: ${reversed}, unshared`);
    const nodes = shared.map((item) => item.ingress!);
    assert.ok(nodes[3] === nodes[0], `reversed: ${reversed}: one order's node`);
    assert.ok(
      new Set(nodes).size <= new Set(unshared.map((item) => item.ingress!)).size,
      `reversed: ${reversed}: no more nodes than with the sharing off`,
    );
  }
});

/**
 * #1573: a further list of the same bindings reads their choices' leaves from one walk of each choice's options, never
 * walking them again (`leafRoles`), so the class work a list adds is the same whatever the choices' size: the steps of
 * every class walk (`classMixed`'s calls) and the contract's steps (`invSteps`) that one more list of two of them adds,
 * at 2 and at 8 options.
 */
test("a further list of choices of one class adds class work independent of the choices' size (#1573)", () => {
  let calls = 0;
  const original = Contract.prototype.classMixed;
  Contract.prototype.classMixed = function (this: Contract, value: PlaceId, exact: boolean) {
    calls += 1;
    return original.call(this, value, exact);
  };
  try {
    const added = (k: number): readonly [number, number] => {
      const [two, three] = [2, 3].map((n) => {
        const source = choicesInLists(
          2,
          k,
          Array.from({ length: n }, () => [0, 1]),
        );
        const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
        assert.ok(request !== null, source);
        calls = 0;
        const steps = analyseCore(request).budget.counts.get("invSteps") ?? 0;
        return [calls, steps] as const;
      });
      return [three![0] - two![0], three![1] - two![1]];
    };
    assert.deepEqual(added(8), added(2));
  } finally {
    Contract.prototype.classMixed = original;
  }
});

/**
 * #1573 (Codex r1's B1 on #1628): a reader of a choice walked once (`leafRoles`) or of a read choice checked once
 * (`heldLeaves`) counts to its demand what the walk or the check charged (`WorkLedger.repeat`), as when each list made
 * its own, so no list's decision stops elsewhere than it did: two classes of choices (of `hostValue`'s and of
 * `hostOther`'s properties) read in four lists of all four bindings, and two choices of 17 properties read in three
 * lists. At the test demand allowance 256, in the four modes, the stops and exhaustion are those of each list making
 * its own (where a second decision stopping in a second pass ends the analysis, TABLE r4.183), a regression oracle of
 * these sources.
 */
test("a choice's walk or check shared by its lists moves no decision's stop at 256, in the four modes (#1573)", () => {
  const choice = (host: string, k: number): string =>
    `askChoice ${Array.from({ length: k }, (_, r) => `{text: "${r}", value: ${host}.p${r}}`).join(", ")}`;
  const program = (hosts: readonly string[], k: number, lists: number): string =>
    [
      ...hosts.map((host, j) => `let p${j} = ${choice(host, k)}`),
      ...Array.from(
        { length: lists },
        (_, i) =>
          `let xs${i} = [${hosts.map((_, j) => `p${j}`).join(", ")}]\nlet n${i}: integer = xs${i}[hostValue.i]`,
      ),
      "exit\n",
    ].join("\n");
  const at = (pass: number, label: string, path: string, ordinal: number) =>
    [pass, label, path, ordinal] as const;
  const element = (pass: number, list: number, ordinal: number) =>
    at(pass, `xs${list}`, "element", ordinal);
  const cases = [
    {
      // (the walk: one other member of each class per list)
      source: program(["hostValue", "hostOther", "hostValue", "hostOther"], 2, 4),
      modes: [
        [[element(1, 0, 6), element(1, 1, 9), element(1, 2, 12), element(1, 3, 15)], null],
        [[element(1, 0, 6), element(2, 1, 8)], "work"],
        [[element(1, 3, 9), element(2, 2, 11)], "work"],
        [[], null],
      ],
    },
    {
      // (the check: the read choice's answer, 33 nodes, checked for each list)
      source: program(["hostValue", "hostValue"], 17, 3),
      modes: [
        [
          [
            at(1, "p0", "", 1),
            at(1, "p1", "", 2),
            element(1, 0, 4),
            element(1, 1, 7),
            element(2, 2, 6),
          ],
          "work",
        ],
        [[at(1, "p0", "", 1), element(1, 0, 4), at(2, "p1", "", 1)], "work"],
        [[element(1, 2, 21), element(1, 1, 24), element(1, 0, 27), at(2, "p1", "", 26)], "work"],
        [[element(1, 2, 21), element(2, 1, 23)], "work"],
      ],
    },
  ] as const;
  const modes = [
    { reversed: false, unshared: false },
    { reversed: false, unshared: true },
    { reversed: true, unshared: false },
    { reversed: true, unshared: true },
  ];
  for (const { source, modes: expected } of cases)
    for (const [index, mode] of modes.entries()) {
      const found = stopSet(
        [{ path: "main.tease", source }],
        mode,
        ["hostValue", "hostOther"],
        256,
      );
      const [stops, exhausted] = expected[index]!;
      assert.deepEqual(
        { stops: found?.stops, exhausted: found?.exhausted },
        { stops, exhausted },
        `${JSON.stringify(mode)}: ${source.slice(0, 60)}`,
      );
    }
});
