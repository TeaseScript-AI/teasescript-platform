import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore } from "../src/type-inference/core/answers.js";
import { ingressLeaves, type Item, writerKey } from "../src/type-inference/core/items.js";
import { type CoreAnalysisRequest, CoreProgram } from "../src/type-inference/core/program.js";
import { withoutSharing } from "../src/type-inference/core/sharing.js";
import type { PlaceId } from "../src/type-inference/graph.js";
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
import { inOrder, publishedAnswers, publishedRoute } from "./helpers/type-core-oracles.js";
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
 * Any difference fails the test. On CI (GitHub Actions sets `CI`) the fixtures' records and the written-domain matrices'
 * sources (whose own tests run each source in both orders) run in the source order only, every other program in both;
 * a local `npm run check` runs them all in both orders (the orchestrator's decision on the CI job's time, 2026-10-26,
 * and the lead's for the matrices). `type-core-written.test.ts` compares the sources of the matrices it checks in three
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
  /** A fixture's record or a written-domain matrix's source, in the source order only on CI. */
  readonly sourceOrderOnCi?: true;
}

const CI_ORDERS = process.env["CI"] === "true" ? [false] : [false, true];

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
    name: "a choice of records of one property read",
    lines: [
      'let box = askChoice {text: "a", value: {g: ^hostValue.n}}, {text: "b", value: {g: ^hostValue.n}}',
      "let out: integer = box.g",
    ],
    place: ["box", ["g"]],
    read: "box.g",
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
  // the merged S6's other written-domain matrices (`type-core-written.ts`), each exact source once (Astra's D3)
  const sources = new Set<string>();
  for (const { name, source } of [
    ...UNRESTRICTED_COLLECTION_MATRIX,
    ...OBJECT_PROPERTY_MATRIX,
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
    program.files.map((file) => file.path),
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
 * leaves, is the same with the sharing on and off, in both orders, over #1196's controls and #1210's programs.
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
