import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  analyseCore,
  type Answers,
  type DecisionWork,
} from "../../src/type-inference/core/answers.js";
import {
  withTestAllowance,
  withTestDemandAllowance,
} from "../../src/type-inference/core/budget.js";
import { withConsumerOrder } from "../../src/type-inference/core/consumers.js";
import { CoreProgram } from "../../src/type-inference/core/program.js";
import { coreRequest, type SourceFile } from "../helpers/type-core-analysis.js";
import {
  decisionKey,
  decisionOf,
  decisionsByKey,
  everyAnswer,
  ingressAnswers,
  inMode,
  jsonText,
  MODES,
  occurrences,
  publication,
  publicationHashes,
  publicationParts,
  publishedAnswers,
  publishedRoute,
  publishedUpToOrder,
  QUESTION_BYTES_PER_CELL,
  QUESTION_UNITS_PER_CELL,
  questionRoomOf,
  questionWork,
  stoppedRecord,
  stopSet,
  withQuestionBound,
  withQuestionMemory,
} from "../helpers/type-core-oracles.js";
import type { InstructionPlan, TypeCheckPlan } from "../../src/plan/model.js";
import { HELD_MODES } from "../helpers/type-core-held-host.js";
import { hostValues, stopRuns } from "../helpers/type-core-stop-oracle.js";

/** The plain gate's decline (#2080 part 2): a stop before admission settled left a store's check undecided. */
const UNDECIDED = "a store whose check was left undecided at the budget";
import { DOUBLING } from "../helpers/type-core/type-core-work.js";

/*
 * Controls of the oracle library (`tests/helpers/type-core-oracles.ts`), which later reviews and the generator corpus
 * trust: the stop-set comparison reports what a stop changes (PR #1427's Astra review), and a publication is published
 * whatever its size or depth, or its questions' cost (#1503).
 */

const GLOBALS = ["hostValue", "hostOther", "hostInit"];

test("the stop-set comparison reports a change confined to a stopped diagnostic's code", () => {
  const source = 'let counts: integer[] = ["red", "blue"]\nexit\n';
  const request = coreRequest([{ path: "main.tease", source }], GLOBALS);
  assert.ok(request !== null);
  const stopped = withTestDemandAllowance(16, () => analyseCore(request));
  assert.ok((stopped.budget.counts.get("stopPasses") ?? 0) > 0, "the analysis stops at 16");
  const deferred = stopped.diagnostics.find((d) => d.code === "TSV041");
  assert.ok(deferred !== undefined, "the stop defers the store's check");
  // EVIDENCE: invariant: only the code changes; the diagnostic keeps the shape the analysis gave it.
  const recoded = { ...deferred, code: "TSV044" } as typeof deferred;
  // (the same answers but that one diagnostic's code: what a defect confined to the stop would publish)
  const changed: Answers = {
    ...stopped,
    diagnostics: stopped.diagnostics.map((d) => (d === deferred ? recoded : d)),
  };
  assert.notEqual(stoppedRecord(changed, ["main.tease"]), stoppedRecord(stopped, ["main.tease"]));
});

test("an analysis run inside a consumer-order callback leaves the stop trace of the analysis around it alone", () => {
  const files = [
    {
      path: "main.tease",
      source:
        "let seed = [1]\nlet a = seed\nlet b = a\nlet c = b\na = c\nb = [hostValue]\nsay c[0]\nexit",
    },
  ];
  const inner = coreRequest(
    [{ path: "main.tease", source: "let count = 4\nsay count + 2\nexit" }],
    GLOBALS,
  );
  assert.ok(inner !== null);
  const plain = stopSet(files, MODES[0]!, GLOBALS, 1);
  assert.ok(plain !== null && plain.stops.length > 0, "the analysis stops at 1");
  let nested = false;
  const around = withConsumerOrder(
    (list) => {
      if (!nested) {
        nested = true;
        assert.ok(
          analyseCore(inner).budget.counts.get("stopPasses"),
          "the inner analysis stops too",
        );
      }
      return [...list];
    },
    () => stopSet(files, MODES[0]!, GLOBALS, 1),
  );
  assert.ok(nested);
  assert.deepEqual(around, plain);
});

const main = (source: string): SourceFile[] => [{ path: "main.tease", source }];
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const SMALL = [
  'let box = {n: 1, m: "a"}\nbox.n = 2\nsay box.m\nexit\n',
  "let xs = [1, 2]\nxs.add(3)\nfor x in xs { say x }\nexit\n",
  "let v = hostValue\nlet w = {p: v}\nsay w.p\nexit\n",
];

test("each projection's questions past a finished analysis's allowance stop there, never escaping (#1503)", () => {
  const files = main(SMALL[0]!);
  const request = coreRequest(files, GLOBALS);
  assert.ok(request !== null);
  const bindings = new CoreProgram(request).places
    .filter(({ kind }) => kind.kind === "binding")
    .map((place) => place.id);
  const projections: Record<string, (answers: Answers) => string | null> = {
    publishedUpToOrder: (answers) => publishedUpToOrder(answers, bindings),
    everyAnswer,
    ingressAnswers,
    publication: () => publication(files, MODES[0]!, GLOBALS),
  };
  const total = analyseCore(request).budget.total;
  for (const [name, project] of Object.entries(projections)) {
    const whole = project(analyseCore(request));
    let stopped = 0;
    // (just above the analysis's own total it finishes, and each projection's questions after it cross the allowance)
    for (const above of [40, 100, 160])
      withTestAllowance(total + above, () => {
        const answers = analyseCore(request);
        assert.equal(answers.budget.exhausted, null, `the analysis finishes at ${total + above}`);
        if (project(answers) !== whole) stopped += 1;
      });
    assert.ok(stopped > 0, `${name}: some allowance stops its questions`);
  }
});

test("a publication is its parts joined, byte for byte as the whole was written (#1503)", () => {
  for (const source of SMALL) {
    const files = main(source);
    const request = coreRequest(files, GLOBALS);
    assert.ok(request !== null);
    const bindings = new CoreProgram(request).places
      .filter(({ kind }) => kind.kind === "binding")
      .map((place) => place.id);
    for (const mode of MODES) {
      // (the whole as `publication` wrote it before its parts, from the same pieces)
      const whole = inMode(mode, () => {
        const answers = analyseCore(request);
        const published = publishedAnswers(answers, bindings, request);
        const route = publishedRoute(files, GLOBALS);
        return JSON.stringify([
          published.text,
          published.record,
          occurrences(answers, (items) => items),
          route.text,
        ]);
      });
      assert.equal(publication(files, mode, GLOBALS), whole);
    }
    // (the runner's form: each part's hash, the same texts)
    const parts = publicationParts(files, MODES[0]!, GLOBALS);
    assert.ok(parts !== null);
    assert.deepEqual(publicationHashes(files, MODES[0]!, GLOBALS), {
      parts: [parts.answers, parts.record, ...parts.occurrences, parts.route].map(sha256),
      unanswered: 0,
    });
  }
  assert.equal(publicationParts(main("let = 1\n"), MODES[0]!, GLOBALS), null);
  assert.equal(publicationHashes(main("let = 1\n"), MODES[0]!, GLOBALS), null);
  assert.equal(publication(main("let = 1\n"), MODES[0]!, GLOBALS), null);
});

/** `files`' bindings (`publishedAnswers`' places). */
const bindingsOf = (request: NonNullable<ReturnType<typeof coreRequest>>) =>
  new CoreProgram(request).places
    .filter(({ kind }) => kind.kind === "binding")
    .map((place) => place.id);

/** An occurrence answer's cells, as the oracle's questions count them: its own, its element's, each property's. */
const cellsOf = (answer: unknown): number => {
  assert.ok(Array.isArray(answer));
  const [, , , , , element, properties] = answer;
  return 1 + (element === null ? 0 : 1) + (Array.isArray(properties) ? properties.length : 0);
};

test("the oracle's own questions stop past their bound, leaving the occurrences from there on unanswered, apart from the parts (#1499, #1837)", () => {
  const files = main(SMALL[0]!);
  const request = coreRequest(files, GLOBALS);
  assert.ok(request !== null);
  const full = publicationParts(files, MODES[0]!, GLOBALS);
  assert.ok(full !== null && full.unanswered === 0);
  // (what its questions spent apart, and the cells they returned: two a binding and each occurrence's)
  const { units, cells } = questionWork();
  const answered = analyseCore(request);
  assert.equal(answered.budget.exhausted, null);
  const asked = inMode(MODES[0]!, () => occurrences(analyseCore(request), (items) => items));
  assert.equal(
    cells,
    2 * bindingsOf(request).length + asked.map(cellsOf).reduce((a, b) => a + b, 0),
  );
  assert.ok(units > 0);
  // (with no units per cell, the least allowance that answers it all is exactly what they spent)
  const at = (allowance: number) =>
    withQuestionBound(allowance, 0, () => publicationParts(files, MODES[0]!, GLOBALS)!);
  assert.deepEqual(at(units), full);
  const stopped = at(units - 1);
  assert.deepEqual(
    [stopped.answers, stopped.record, stopped.route],
    [full.answers, full.record, full.route],
  );
  assert.ok(stopped.unanswered > 0, "the occurrences' questions stop");
  assert.deepEqual(stopped.occurrences, full.occurrences.slice(0, stopped.occurrences.length));
  assert.ok(stopped.occurrences.length < full.occurrences.length, "an occurrence stays unanswered");
  // (why: the analysis finished, so its questions passed their bound, from the first node left)
  const nodes = analyseCore(request).graph.nodes;
  const first = nodes[nodes.length - stopped.unanswered]!.id;
  assert.deepEqual(stopped.unansweredBy, { reason: "questions", node: first });
  assert.equal(full.unansweredBy, undefined);
  // (the count and why stay apart from the hashes, and the joined text never equals one answered in full)
  withQuestionBound(units - 1, 0, () => {
    assert.deepEqual(publicationHashes(files, MODES[0]!, GLOBALS), {
      parts: [stopped.answers, stopped.record, ...stopped.occurrences, stopped.route].map(sha256),
      unanswered: stopped.unanswered,
      unansweredBy: { reason: "questions", node: first },
    });
    assert.equal(
      publication(files, MODES[0]!, GLOBALS),
      `[${stopped.answers},${stopped.record},[${stopped.occurrences.join(",")}],${stopped.route},{"unanswered":${stopped.unanswered}}]`,
    );
  });
  // (at the natural bound, the program's allowance and 64 a cell, it is answered whole)
  assert.ok(units <= answered.budget.allowance + QUESTION_UNITS_PER_CELL * cells);
});

test("the published answers' own questions stop under the same bound, never answered again on a stopped analysis: every node is left after the bindings left (#1837)", () => {
  const files = main(SMALL[0]!);
  const request = coreRequest(files, GLOBALS);
  assert.ok(request !== null);
  const bindings = bindingsOf(request);
  const full = publicationParts(files, MODES[0]!, GLOBALS);
  assert.ok(full !== null);
  // (the admitted types' questions alone, on their own meter)
  inMode(MODES[0]!, () => publishedAnswers(analyseCore(request), bindings, request));
  const { units, cells } = questionWork();
  assert.ok(units > 0);
  assert.equal(cells, 2 * bindings.length);
  withQuestionBound(units - 1, 0, () => {
    assert.throws(
      () => inMode(MODES[0]!, () => publishedAnswers(analyseCore(request), bindings, request)),
      { name: "AnswersStopped" },
    );
    const stopped = publicationParts(files, MODES[0]!, GLOBALS)!;
    const nodes = analyseCore(request).graph.nodes.length;
    assert.deepEqual(
      [stopped.answers, stopped.record, stopped.occurrences, stopped.route],
      ["null", "null", [], full.route],
    );
    assert.ok(stopped.unanswered > nodes, "a binding and every node are left");
    const by = stopped.unansweredBy;
    assert.ok(by !== undefined && "binding" in by && by.reason === "questions");
    assert.equal(bindings[bindings.length - (stopped.unanswered - nodes)], by.binding);
  });
});

test("the bound credits each cell returned: one unit a cell answers what no credit stops, and at K a cell the least allowance answering all lies K or more below what the questions spent (#1837, Codex r1)", () => {
  const properties = Array.from({ length: 64 }, (_, index) => `p${index}: ${index}`).join(", ");
  for (const source of [SMALL[0]!, `let o = {${properties}}\nsay "\${o.p0}"\nexit\n`]) {
    const files = main(source);
    const full = publicationParts(files, MODES[0]!, GLOBALS);
    assert.ok(full !== null && full.unanswered === 0);
    const { units, cells } = questionWork();
    const at = (allowance: number, perCell: number) =>
      withQuestionBound(allowance, perCell, () => publicationParts(files, MODES[0]!, GLOBALS)!);
    // (from the first binding's two cells on, one unit a cell lifts the bound past what they spent)
    assert.ok(at(units - 1, 0).unanswered > 0);
    assert.deepEqual(at(units - 1, 1), full);
    // (at K a cell, the least allowance that answers it all, by bisection, and one unit less stops)
    const answered = (allowance: number) => at(allowance, QUESTION_UNITS_PER_CELL).unanswered === 0;
    let [low, high] = [-QUESTION_UNITS_PER_CELL * cells - 1, units];
    assert.ok(!answered(low) && answered(high));
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (answered(middle)) high = middle;
      else low = middle;
    }
    assert.deepEqual(at(high, QUESTION_UNITS_PER_CELL), full);
    const stopped = at(high - 1, QUESTION_UNITS_PER_CELL);
    assert.equal(stopped.unansweredBy?.reason, "questions");
    // (the credit counts: K a cell answers below what the questions spent by at least K)
    assert.ok(high <= units - QUESTION_UNITS_PER_CELL, `${high} against ${units}`);
  }
});

test("a stop the oracle's own questions would make is never published: at the least allowance the compiler's route finishes in, the record is the compiler's (#1837, Codex r1)", () => {
  // (main asked the admitted types on the analysis's ledger before its checks: there they passed that allowance, and the
  // publication was asked again on the stopped analysis, with a stop warning the compiler does not give)
  const files = main("let count = 1\nexit\n");
  const request = coreRequest(files, GLOBALS);
  assert.ok(request !== null);
  const full = publicationParts(files, MODES[0]!, GLOBALS);
  assert.ok(full !== null);
  // (the route stops where its plan or diagnostics differ from the natural allowance's)
  const natural = publishedRoute(files, GLOBALS).text;
  const stops = (allowance: number) =>
    withTestAllowance(allowance, () => publishedRoute(files, GLOBALS).text) !== natural;
  let [low, high] = [1, analyseCore(request).budget.total];
  assert.ok(stops(low));
  while (stops(high)) {
    [low, high] = [high, 2 * high];
    assert.ok(high < 2 ** 40, "some allowance finishes the route");
  }
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (stops(middle)) low = middle;
    else high = middle;
  }
  const parts = withTestAllowance(high, () => publicationParts(files, MODES[0]!, GLOBALS));
  assert.ok(parts !== null);
  assert.deepEqual(
    [parts.answers, parts.record, parts.route, parts.unanswered],
    [full.answers, full.record, full.route, 0],
  );
});

test("the oracle's questions stop as memory where their bytes a cell pass their room in the heap, before V8 runs out of it (#1837)", () => {
  const files = main(SMALL[0]!);
  const full = publicationParts(files, MODES[0]!, GLOBALS);
  assert.ok(full !== null && full.unanswered === 0);
  const { cells } = questionWork();
  const at = (room: number) =>
    withQuestionMemory(room, () => publicationParts(files, MODES[0]!, GLOBALS)!);
  // (room for every cell answers it whole; a byte less stops at the question that returned the last cell)
  assert.deepEqual(at(QUESTION_BYTES_PER_CELL * cells), full);
  const stopped = at(QUESTION_BYTES_PER_CELL * cells - 1);
  assert.ok(stopped.unanswered > 0);
  assert.equal(stopped.unansweredBy?.reason, "memory");
  assert.deepEqual(stopped.occurrences, full.occurrences.slice(0, stopped.occurrences.length));
  // (no room even for the first binding's cells: the answers' own questions stop, at that binding)
  const none = at(0);
  assert.deepEqual([none.answers, none.unansweredBy?.reason], ["null", "memory"]);
});

/**
 * A heap as the questions' room reads it (`questionRoomOf`), in MiB: its limit, the heap in use when the meter is made,
 * and the live heap after each collection (the last repeated), with the collections counted.
 */
function heapOf(limit: number, used: number, afterEach: readonly number[] | null) {
  const MiB = 2 ** 20;
  let collections = 0;
  const heap = {
    statistics: () => ({
      heap_size_limit: limit * MiB,
      used_heap_size:
        (collections === 0 ? used : afterEach![Math.min(collections, afterEach!.length) - 1]!) *
        MiB,
    }),
    collect: afterEach === null ? null : () => (collections += 1),
  };
  return { room: () => questionRoomOf(heap) / MiB, collections: () => collections };
}

test("the questions' room leaves out what a run just before left for V8 to keep through two collections, and keeps out what is still live (#2002)", () => {
  // (the witness: W45-conditional at k = 1,024 and 6,144 MB, a young process; V8's limit 6,240 MiB, the room's
  // default 4,704)
  // the head's meter, right after the base's run: 3,055 MiB in use, the base's analysis held through two collections
  // (2,796 MiB live after one), gone after the third: the default room, as on a fresh tree
  const young = heapOf(6240, 3055, [2796, 2796, 50]);
  assert.equal(young.room(), 4704);
  assert.equal(young.collections(), 3);
  // a reused process's meter: the heap in use under the reserve, no collection made, the default room
  const reused = heapOf(6240, 1414, [50]);
  assert.equal(reused.room(), 4704);
  assert.equal(reused.collections(), 0);
  // live state carried beside the publication: still live after the collections, so the room is what is left beside
  // it less the headroom
  const carried = heapOf(6240, 3055, [2800]);
  assert.equal(carried.room(), 6240 - 2800 - 512);
  // a process that cannot collect (no `--expose-gc`): the default room
  assert.equal(heapOf(6240, 3055, null).room(), 4704);
});

test("an analysis its own budget stopped is answered whole within its questions' bound, so no node is left unanswered and none is stopped (#1837)", () => {
  const files = main(SMALL[0]!);
  const request = coreRequest(files, GLOBALS);
  assert.ok(request !== null);
  const total = analyseCore(request).budget.total;
  // (an allowance the analysis itself passes: its own budget stops it; the oracle then answers its stopped answers
  // without asking again, within its questions' bound)
  const allowance = Math.floor(total / 2);
  assert.notEqual(
    withTestAllowance(allowance, () => analyseCore(request).budget.exhausted),
    null,
  );
  const parts = withTestAllowance(allowance, () => publicationParts(files, MODES[0]!, GLOBALS));
  assert.ok(parts !== null);
  assert.deepEqual([parts.unanswered, parts.unansweredBy], [0, undefined]);
});

test("an analysis that finished past the nesting limit leaves its later questions' nodes unanswered as questions, never stopped (#1837, Codex r1 on #1839)", () => {
  // (a finished analysis with `exhausted: "nesting"` and no stop phase: the oracle's own questions after it stop)
  const source = `let item = {a: 1, b: "x"}\nlet alias = item\nsay "\${alias.a}"\n${"if hostValue == 1 {\n".repeat(257)}say "\${hostValue}"\n${"}\n".repeat(257)}exit\n`;
  const files = [{ path: "main.tease", source }];
  const request = coreRequest(files, GLOBALS);
  assert.ok(request !== null);
  const analysis = analyseCore(request);
  assert.deepEqual([analysis.budget.exhausted, analysis.budget.stoppedIn], ["nesting", null]);
  const full = publicationParts(files, MODES[0]!, GLOBALS);
  assert.ok(full !== null && full.unanswered === 0);
  const { units } = questionWork();
  const parts = withQuestionBound(units - 1, 0, () => publicationParts(files, MODES[0]!, GLOBALS));
  assert.ok(parts !== null && parts.unanswered > 0);
  assert.equal(parts.unansweredBy?.reason, "questions");
});

/** A family's sources at `sizes` (`shape` of the generator at `module`), with the generator's globals. */
async function family(module: string, shape: string, sizes: readonly number[]) {
  // EVIDENCE: each generator exports `shapes` (a size to a source or its files) and `globals` (tests/families/README.md).
  const generator = (await import(pathToFileURL(resolve(module)).href)) as {
    readonly shapes: Record<string, (size: number) => string | SourceFile[]>;
    readonly globals?: readonly string[];
  };
  return sizes.map((size) => {
    const made = generator.shapes[shape]!(size);
    return {
      files: typeof made === "string" ? main(made) : made,
      globals: generator.globals ?? [],
    };
  });
}

/**
 * The occurrences' questions' units per cell they return (`Questions`' measure), at the family's natural allowance in
 * the first mode, each source answered whole.
 */
function perCell(
  sources: readonly { files: SourceFile[]; globals: readonly string[] }[],
): number[] {
  return sources.map(({ files, globals }) => {
    const request = coreRequest(files, globals);
    assert.ok(request !== null);
    return inMode(MODES[0]!, () => {
      const answers = analyseCore(request);
      assert.equal(answers.budget.exhausted, null);
      answers.apart(() => undefined);
      const before = answers.budget.finishing;
      const asked = answers.apart(() => occurrences(answers, (items) => items));
      const cells = asked.map(cellsOf).reduce((a, b) => a + b, 0);
      return (answers.budget.finishing - before) / cells;
    });
  });
}

/** Each step's relative rise of a series. */
const rises = (series: readonly number[]) =>
  series.slice(1).map((value, index) => value / series[index]! - 1);

test("the oracle's questions cost per cell they return is flat on W19-record, and on W24-varied, r3-root-copies and W32-own-test rises by a falling step, a log factor, below K (#1837, #1941)", async () => {
  const gates = "tests/families/copies/copy-work/guard-call-handler-and-store-flow-products.mjs";
  // (flat: under 1 % a step either way, 24.224 / 24.204 / 24.140 / 24.087)
  const flat = perCell(await family(gates, "W19-record", [16, 32, 64, 128]));
  for (const rise of rises(flat)) assert.ok(Math.abs(rise) < 0.01, JSON.stringify(flat));
  for (const cost of flat) assert.ok(cost < QUESTION_UNITS_PER_CELL, JSON.stringify(flat));
  for (const [module, shape] of [
    [gates, "W24-varied"],
    [
      "tests/families/copies/copy-projections/layered-field-store-and-reader-matrix.mjs",
      "r3-root-copies",
    ],
    [gates, "W32-own-test"],
  ] as const) {
    const series = perCell(await family(module, shape, [16, 32, 64, 128]));
    const steps = rises(series);
    // (each step's rise below the one before: no polynomial re-walk, #1941's binary searches over a key's definitions)
    for (const [index, step] of steps.entries())
      if (index > 0) assert.ok(step < steps[index - 1]!, `${shape}: ${JSON.stringify(series)}`);
    // (within K at every size)
    for (const cost of series)
      assert.ok(cost < QUESTION_UNITS_PER_CELL, `${shape}: ${JSON.stringify(series)}`);
  }
});

/** No globals: the list-field copies read none. */
const NO_GLOBALS: readonly string[] = [];

/**
 * #1948: a binding's admitted type, asked of each binding, reads its copied value at its own field, never every copied
 * object there: on r3-root-copies (`r_i = a.f_i` over k whole copies of one-field objects into `a`, the oracle's
 * `["element"]` question) and with the fields lists (the backend's own `[]` question, which reads their elements), the
 * bindings' questions grow with the program in every mode (3.7 a doubling at 16 → 32 before #1948: the contract's fold
 * of every copied object at the field, admission's copies of `a` tried for every field).
 */
test("a binding's admitted type reads its copied value at its own field: the bindings' questions grow linearly (#1948)", async () => {
  const rows = (k: number, row: (i: number) => string) =>
    Array.from({ length: k }, (_, i) => row(i)).join("\n");
  const lists = (k: number) => [
    {
      files: main(
        [
          "let t:integer=1",
          rows(k, (i) => `let root${i}={f${i}:[t]}`),
          "let a=root0",
          rows(k - 1, (i) => `a=root${i + 1}`),
          rows(k, (i) => `let r${i}=a.f${i}`),
          "exit",
        ].join("\n"),
      ),
      globals: NO_GLOBALS,
    },
  ];
  const series = [
    {
      name: "r3-root-copies [element]",
      path: ["element"],
      sources: await family(
        "tests/families/copies/copy-projections/layered-field-store-and-reader-matrix.mjs",
        "r3-root-copies",
        [16, 32],
      ),
    },
    { name: "list fields []", path: [], sources: [...lists(16), ...lists(32)] },
  ];
  const steep: string[] = [];
  for (const { name, path, sources } of series)
    for (const [index, mode] of MODES.entries()) {
      const [small, large] = sources.map(({ files, globals }) => {
        const request = coreRequest(files, globals);
        assert.ok(request !== null);
        return inMode(mode, () => {
          const answers = analyseCore(request);
          assert.equal(answers.budget.exhausted, null);
          const bindings = new CoreProgram(request).places
            .filter(({ kind }) => kind.kind === "binding" && /^r\d+$/.test(kind.name))
            .map(({ id }) => id);
          answers.apart(() => undefined);
          const before = answers.budget.finishing;
          answers.apart(() => bindings.map((binding) => answers.place(binding, path)));
          return answers.budget.finishing - before;
        });
      });
      if (large! > DOUBLING * small!) steep.push(`${name}, mode ${index}: ${small} → ${large}`);
    }
  assert.deepEqual(steep, []);
});

test("jsonText writes plan data as JSON.stringify does, and also past the depth JSON.stringify reaches (#1503)", () => {
  // (an array with a hole at 1)
  const sparse: unknown[] = [1];
  sparse[2] = 3;
  const values: unknown[] = [
    ...SMALL.map((source) => publishedRoute(main(source), GLOBALS).plan),
    null,
    true,
    -0,
    1e21,
    Number.NaN,
    -Infinity,
    'a"b\\c\n\u2028\ud800',
    [],
    {},
    sparse,
    [undefined, () => 1, Symbol("s"), null],
    { a: undefined, b: () => 1, c: Symbol("s"), d: 1, 2: "two", 1: "one" },
    { at: new Date(0) },
    { toJSON: (key: string) => ({ key }) },
    { inner: { toJSON: (key: string) => key }, list: [{ toJSON: (key: string) => key }] },
    [[[]], [{}], { x: [{ y: [] }] }],
    new Wrapped(1),
    Object.assign(Object.create(null), { a: [1], b: "b" }),
    undefined,
  ];
  for (const value of values) assert.equal(jsonText(value), JSON.stringify(value));
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  for (const value of [cycle, { n: 1n }]) {
    assert.throws(() => JSON.stringify(value), TypeError);
    assert.throws(() => jsonText(value), TypeError);
  }
  // (outside plan data: a primitive's wrapper and a raw JSON value throw rather than be guessed at)
  const raw = "rawJSON" in JSON && typeof JSON.rawJSON === "function" ? [JSON.rawJSON("1")] : [];
  for (const value of [{ n: Object(1) }, [Object(false)], ...raw])
    assert.throws(() => jsonText(value), TypeError);
  // (a class's instances take JSON.stringify's recursive path, as a plan's nodes do: it ends past some thousand levels)
  let deep: Nest = 0;
  for (let depth = 0; depth < 20_000; depth += 1)
    deep = depth % 2 === 0 ? [deep] : new Wrapped(deep);
  assert.throws(() => JSON.stringify(deep), RangeError);
  assert.equal(jsonText(deep), '{"a":['.repeat(10_000) + "0" + "]}".repeat(10_000));
});

/** A nest of arrays and class instances around a number. */
type Nest = number | Nest[] | Wrapped;

/** An object of a class, which JSON.stringify writes as it writes a plain one, by another path. */
class Wrapped {
  public constructor(public readonly a: Nest) {}
}

test("a decision record is read by its place and its exact path, never by the first of its place or a joined text", () => {
  const record = (place: number, path: string[], units = 1): DecisionWork => ({
    place,
    path,
    units,
    allowance: 100,
    stopped: false,
  });
  const list = [record(1, []), record(1, ["a.b"]), record(1, ["a", "b"], 7), record(2, [])];
  assert.equal(decisionOf(list, { place: 1, path: ["a", "b"] }).units, 7);
  assert.deepEqual(decisionOf(list, { place: 1, path: ["a.b"] }).path, ["a.b"]);
  assert.throws(
    () => decisionOf(list, { place: 3, path: [] }),
    /No decision records at \[3,\[\]\]/,
  );
  assert.throws(
    () => decisionOf([...list, record(2, [])], { place: 2, path: [] }),
    /2 decision records at \[2,\[\]\]/,
  );
  assert.equal(decisionKey(record(1, ["a", "b"])), '[1,["a","b"]]');
  assert.equal(decisionsByKey(list).size, 4);
  // (a key twice in one list: both records, in the list's order, never one overwriting the other, #1757)
  assert.deepEqual(
    decisionsByKey([...list, record(1, ["a", "b"], 9)])
      .get('[1,["a","b"]]')!
      .map((d) => d.units),
    [7, 9],
  );
});

/** `plan` with each store type check `edit` gives back, removed where it gives `undefined` (a planted change, #2080). */
function editedTypeChecks(
  plan: InstructionPlan,
  edit: (check: TypeCheckPlan) => TypeCheckPlan | undefined,
): InstructionPlan {
  const text = JSON.stringify(plan, (key, value: unknown) => {
    if (key !== "typeCheck") return value;
    // EVIDENCE: invariant: a plan's `typeCheck` is a `TypeCheckPlan`, a type and the place it is checked at.
    const check = value as TypeCheckPlan;
    return edit(check);
  });
  // EVIDENCE: invariant: a plan is JSON-safe data, so its text read back is the same plan with the edited checks.
  return JSON.parse(text) as InstructionPlan;
}

/** `plan` without its stores' type checks, or without its first one only (a planted lost check, #2080). */
function withoutTypeChecks(plan: InstructionPlan, firstOnly = false): InstructionPlan {
  let removed = false;
  return editedTypeChecks(plan, (check) => {
    if (firstOnly && removed) return check;
    removed = true;
    return undefined;
  });
}

test("a stop's runs take host data made from the source's own property names: one pool per global it reads, the same each time (#2080)", () => {
  const files = [
    { path: "main.tease", source: 'let a = {box: {f: hostValue}}\nsay "${a.box.f}"\nexit\n' },
  ];
  const values = hostValues(files, GLOBALS);
  assert.deepEqual(hostValues(files, GLOBALS), values);
  // (a global the source never reads stays 1)
  assert.ok(values.every((each) => each.hostOther === 1 && each.hostInit === 1));
  const shown = new Set(values.map((each) => JSON.stringify(each.hostValue)));
  for (const value of [1, "s", null, { kind: "list", items: [] }])
    assert.ok(shown.has(JSON.stringify(value)), JSON.stringify(value));
  assert.ok(
    shown.has(
      JSON.stringify({
        kind: "object",
        properties: [
          { name: "box", value: { kind: "object", properties: [{ name: "f", value: "s" }] } },
        ],
      }),
    ),
    "an object two properties deep, by the source's names",
  );
  // (a path read below a value: an object along it, three properties deep)
  const deep = [{ path: "main.tease", source: 'say "${hostValue.a.b.c}"\nexit\n' }];
  assert.ok(
    hostValues(deep, GLOBALS).some(
      (each) =>
        JSON.stringify(each.hostValue) ===
        JSON.stringify({
          kind: "object",
          properties: [
            {
              name: "a",
              value: {
                kind: "object",
                properties: [
                  { name: "b", value: { kind: "object", properties: [{ name: "c", value: "s" }] } },
                ],
              },
            },
          ],
        }),
    ),
  );
  // (two globals read: a smaller pool each, its scalars and collections whole, the product capped)
  const two = [{ path: "main.tease", source: "let a = hostValue\nlet b = hostOther\nexit\n" }];
  const both = hostValues(two, GLOBALS);
  for (const value of [0, 2.5, { kind: "dict", entries: [] }])
    assert.ok(
      both.some((each) => JSON.stringify(each.hostOther) === JSON.stringify(value)),
      JSON.stringify(value),
    );
  assert.ok(hostValues(two, GLOBALS, 50).length <= 50);
});

test("a stop's runs find a stopped plan that runs past a runtime failure the natural plan raises, and none in a sound one (#2080)", () => {
  const files = [
    { path: "main.tease", source: 'let n: integer = 1\nn = hostValue\nsay "after"\nexit\n' },
  ];
  for (const mode of MODES) {
    const run = <T>(make: () => T): T => inMode(mode, make);
    // (an allowance that stops nothing: the stopped plan is the natural one, every run alike)
    assert.equal(
      stopRuns(files, ["hostValue"], run, 1_000_000).kind,
      "closed",
      JSON.stringify(mode),
    );
    // (the same plan without its store's type check: the natural plan fails where it runs on)
    const found = stopRuns(files, ["hostValue"], run, 1_000_000, (plan) => withoutTypeChecks(plan));
    assert.equal(found.kind, "open", JSON.stringify(mode));
    assert.equal(found.first?.natural?.failure?.code, "TSR058");
    assert.equal(found.first?.stopped.failure, null);
    assert.deepEqual(found.first?.stopped.said, ["after"]);
  }
});

test("a stop's runs of a program the natural compile rejects run nothing where the stop rejects it too (#2080)", () => {
  const files = [{ path: "main.tease", source: 'let n: integer = 1\nn = "x"\nexit\n' }];
  const found = stopRuns(files, ["hostValue"], (make) => make(), 16);
  assert.equal(found.kind, "no plan");
  assert.equal(found.runs, 0);
});

test("a stop's runs report a later failure at another site, and a difference no host value exercised as unwitnessed, never closed (#2080, Codex r1 on #2142)", () => {
  const run = <T>(make: () => T): T => make();
  // (the first store's check only removed: the stopped plan fails at the second store, saying nothing more)
  const later = stopRuns(
    [
      {
        path: "main.tease",
        source: 'let n: integer = hostValue\nlet m: integer = hostValue\nsay "after"\nexit\n',
      },
    ],
    ["hostValue"],
    run,
    1_000_000,
    (plan) => withoutTypeChecks(plan, true),
  );
  assert.equal(later.kind, "later");
  assert.notEqual(later.first?.natural?.failure?.start, later.first?.stopped.failure?.start);
  // (the store's check runs only for a duration, which the pool never offers: the plans differ, no run tells them apart)
  const unwitnessed = stopRuns(
    [
      {
        path: "main.tease",
        source:
          'let n: integer = 1\nif hostValue is duration {\n  n = hostOther\n}\nsay "after"\nexit\n',
      },
    ],
    ["hostValue", "hostOther"],
    run,
    1_000_000,
    (plan) => withoutTypeChecks(plan),
  );
  assert.equal(unwitnessed.kind, "unwitnessed");
});

test("a stop's runs leave a difference unwitnessed where a failure elsewhere hides it, and read an earlier stricter failure as no escape (#2080, Codex r2 on #2142)", () => {
  const run = <T>(make: () => T): T => make();
  // (`hidden`'s check removed, which only a duration reaches; `visible`'s check fails for many values: still undecided)
  const hidden = stopRuns(
    [
      {
        path: "main.tease",
        source:
          'if hostValue is integer {\n  let visible: string = hostOther\n}\nlet hidden: integer = 1\nif hostValue is duration {\n  hidden = hostOther\n}\nsay "after"\nexit\n',
      },
    ],
    ["hostValue", "hostOther"],
    run,
    1_000_000,
    (plan) =>
      editedTypeChecks(plan, (check) => (check.place.includes("hidden") ? undefined : check)),
  );
  assert.equal(hidden.kind, "unwitnessed");
  // (the first of two stores strengthened from number to integer: at 2.5 it fails first, where the natural plan fails at the second)
  const stricter = stopRuns(
    [
      {
        path: "main.tease",
        source: 'let a: number = hostValue\nlet b: integer = hostValue\nsay "after"\nexit\n',
      },
    ],
    ["hostValue"],
    run,
    1_000_000,
    (plan) =>
      editedTypeChecks(plan, (check) =>
        check.type.kind === "number" ? { ...check, type: { kind: "integer" } } : check,
      ),
  );
  // (no escape: stricter is not a class the oracle claims, so the differing plans stay unresolved)
  assert.equal(stricter.kind, "unwitnessed");
});

test("a stop's runs catch the design round's controls: a false branch, a nested element, a later failure with no output, and an error site no run reaches (#2080, the design round on #2142)", () => {
  const run = <T>(make: () => T): T => make();
  const unit = (source: string) => [{ path: "main.tease", source }];
  // (the false branch's store check removed: the pool's false reaches it)
  assert.equal(
    stopRuns(
      unit(
        "let flag: boolean = hostValue\nlet n: integer = 1\nif flag {} else { n = hostOther }\nexit\n",
      ),
      ["hostValue", "hostOther"],
      run,
      1_000_000,
      (plan) =>
        editedTypeChecks(plan, (check) => (check.place.includes("'n'") ? undefined : check)),
    ).kind,
    "open",
  );
  // (the inner element of `integer[][]` opened: values made from the checked type reach it)
  assert.equal(
    stopRuns(
      unit("let n: integer[][] = hostValue\nexit\n"),
      ["hostValue"],
      run,
      1_000_000,
      (plan) =>
        editedTypeChecks(plan, (check) => ({
          ...check,
          type: { kind: "list", element: { kind: "list", element: null } },
        })),
    ).kind,
    "open",
  );
  // (the first of two stores' checks removed, nothing said on either side: the stopped plan ran past the first check)
  assert.equal(
    stopRuns(
      unit("let n: integer = hostValue\nlet m: integer = hostValue\nexit\n"),
      ["hostValue"],
      run,
      1_000_000,
      (plan) => withoutTypeChecks(plan, true),
    ).kind,
    "later",
  );
  // (no natural plan; the stop's plan checked at the erring store: the false run fails there, the true run never reaches
  // it, so no run passes it, which the oracle claimed open before the design round)
  // (#2080 part 1 declines a settled stop's no-plan store that a rejection lost; before admission settles the plain gate
  // declines the inferred store, #2080 part 2: the stopped compile publishes nothing to plant in, and the runs read it
  // declined, never open)
  const planted = stopRuns(
    unit('let flag: boolean = hostValue\nlet n = 1\nif flag {} else { n = "bad" }\nexit\n'),
    ["hostValue"],
    run,
    1,
    (plan) => ({
      ...plan,
      instructions: plan.instructions.map((instruction) =>
        JSON.stringify(instruction).includes('"bad"')
          ? { ...instruction, typeCheck: { type: { kind: "integer" }, place: "'n'" } }
          : instruction,
      ),
    }),
    "work",
  );
  assert.equal(planted.natural.plan, false);
  assert.deepEqual([planted.kind, planted.stopped.declined], ["declined", UNDECIDED]);
  // (no natural plan; the erring store under a guard no pool value takes: untested, never open)
  const unreached = stopRuns(
    unit('let n = 1\nif hostValue is duration { n = "bad" }\nexit\n'),
    ["hostValue"],
    run,
    1,
    undefined,
    "work",
  );
  assert.equal(unreached.natural.plan, false);
  assert.deepEqual([unreached.kind, unreached.stopped.declined], ["declined", UNDECIDED]);
});

test("a stop's runs read #2116's final witness closed on main at demand 64, and open with its store checks dropped, in every held mode (#2080 part 1, PR #2116's final, comment 6736629257)", () => {
  // (`all:new-cases-2::graph/396`: the lossy stop path kept six runtime checks here on main and none on #2116's head,
  // where `hostValue = "text"` ran past the store main checks. These tests compile main alone, so they cannot compile
  // that head: the plan with its store checks dropped stands in for it, the same failure in the same place)
  const files = [
    {
      path: "main.tease",
      source:
        'let typed:number=1.5\nlet num:integer=1\nlet text:string="x"\nlet root={f:typed,g:num}\nlet foreign={f:hostValue,g:text}\nlet a=root\nlet b=foreign\nlet c=root\nif hostValue is integer {a=b}\nb=b\nb=a\na=a\nlet out=c\nexit\n',
    },
  ];
  for (const mode of HELD_MODES) {
    const run = <T>(make: () => T): T => mode.run(make);
    assert.equal(stopRuns(files, ["hostValue"], run, 64).kind, "closed", mode.name);
    assert.equal(
      stopRuns(files, ["hostValue"], run, 64, (plan) => withoutTypeChecks(plan)).kind,
      "open",
      mode.name,
    );
  }
});

test("a stop's runs claim only what they demonstrate: Codex r3's wrong-check, part, cap and loop cases stay unwitnessed, and its no-plan cases, a store's absent property and a genuine escape are declined (#2080, Codex r3 on #2142)", () => {
  const unit = (source: string) => [{ path: "main.tease", source }];
  const loosened = (type: TypeCheckPlan["type"]): TypeCheckPlan["type"] =>
    type.kind === "list" && type.element?.kind === "list"
      ? { ...type, element: { kind: "list", element: null } }
      : type.kind === "union"
        ? { ...type, members: type.members.map(loosened) }
        : type;
  const props = Array.from({ length: 10 }, (_, at) => `p${at}: seed`).join(", ");
  const cases: {
    readonly name: string;
    readonly files: readonly { readonly path: string; readonly source: string }[];
    readonly globals: readonly string[];
    readonly demand: number;
    readonly planted?: (plan: InstructionPlan) => InstructionPlan;
    readonly stop?: "work";
  }[] = [
    // (a retained index check fails where the dropped store check is never reached)
    {
      name: "index",
      files: unit("let n: integer = [1, 1, hostOther, 1, 1].get(hostValue, default: 1)\nexit\n"),
      globals: ["hostValue", "hostOther"],
      demand: 1_000_000,
      planted: (plan) => withoutTypeChecks(plan),
    },
    // (a union's nested element opened, which no pool value of the union reaches)
    {
      name: "union",
      files: unit("let n: integer[][]? = hostValue\nexit\n"),
      globals: ["hostValue"],
      demand: 1_000_000,
      planted: (plan) =>
        editedTypeChecks(plan, (check) => ({ ...check, type: loosened(check.type) })),
    },
    // (a part check dropped beside a sibling one)
    {
      name: "part",
      files: unit(
        "let seed: integer = 1\nlet copy = hostValue\nif hostOther is duration {\n copy.a = seed\n copy.xs = [{n: seed}]\n}\ncopy = hostOther\nexit\n",
      ),
      globals: ["hostValue", "hostOther"],
      demand: 1_000_000,
      planted: (plan) => ({
        ...plan,
        instructions: plan.instructions.map((instruction) =>
          "partChecks" in instruction && Array.isArray(instruction.partChecks)
            ? {
                ...instruction,
                partChecks: instruction.partChecks.filter(
                  (part: { readonly path: readonly unknown[] }) =>
                    !JSON.stringify(part.path).includes("xs"),
                ),
              }
            : instruction,
        ),
      }),
    },
    // (the tenth property of an object widened, past the pool's cap)
    {
      name: "cap",
      files: unit(`let seed: integer = 1\nlet n = {${props}}\nn = hostValue\nexit\n`),
      globals: ["hostValue"],
      demand: 1_000_000,
      planted: (plan) =>
        editedTypeChecks(plan, (check) =>
          check.type.kind === "object"
            ? {
                ...check,
                type: {
                  ...check.type,
                  properties: check.type.properties.map((property) =>
                    property.name === "p9" ? { ...property, type: { kind: "number" } } : property,
                  ),
                },
              }
            : check,
        ),
    },
    // (no natural plan; the erring store behind a check no pool value passes, inside a block the runs enter)
    {
      name: "ancestor",
      files: unit(
        'let n = 1\nif hostValue is boolean {\n  let gate: duration = hostOther\n  n = "bad"\n}\nexit\n',
      ),
      globals: ["hostValue", "hostOther"],
      // (#2080 part 1 declines it at a settled stop and the plain gate before admission settles, #2080 part 2)
      demand: 1,
      stop: "work",
    },
    // (no natural plan; the erring store in another file, at offsets of a store of the main file)
    {
      name: "file",
      files: [
        {
          path: "main.tease",
          source: `${" ".repeat("let n = 1\nif hostValue is duration { ".length)}let x = 1\nexit\n`,
        },
        {
          path: "other.tease",
          source: 'let n = 1\nif hostValue is duration { n = "bad" }\nexit\n',
        },
      ],
      globals: ["hostValue"],
      // (#2080 part 1 declines it at a settled stop and the plain gate before admission settles, #2080 part 2)
      demand: 1,
      stop: "work",
    },
    // (a stricter check in a loop: the stopped plan fails in the second round, before the natural failure)
    {
      name: "loop",
      files: unit(
        "let current = hostValue\nrepeat 2 {\n let a: number = current\n let b: integer = current\n current = hostOther\n}\nexit\n",
      ),
      globals: ["hostValue", "hostOther"],
      demand: 1_000_000,
      planted: (plan) =>
        editedTypeChecks(plan, (check) =>
          check.type.kind === "number" ? { ...check, type: { kind: "integer" } } : check,
        ),
    },
  ];
  // (a work stop's no-plan case is declined, never read open)
  for (const mode of HELD_MODES)
    for (const { name, files, globals, demand, planted, stop } of cases)
      assert.equal(
        stopRuns(files, globals, (make) => mode.run(make), demand, planted, stop).kind,
        stop === "work" ? "declined" : "unwitnessed",
        `${name} (${mode.name})`,
      );
  // (the two campaign items Codex r3 took for genuine escapes: C5c reports a store's absent property at the object that
  // lacks it, which every run passes, while every run fails at the store itself, TSR017; read at the store, unwitnessed)
  const controls = [
    {
      mode: HELD_MODES[3]!,
      source:
        "let typed: list = [1]\nlet root = {h: {f: typed}}\nroot.q = root\nlet a = root.q\nlet seen = a.h.f\nexit\n",
      globals: ["hostValue", "hostInit"],
    },
    {
      mode: HELD_MODES[0]!,
      source:
        "let leaf: integer? = null\nlet root = {cell: leaf}\nlet lower = {left: root}\nlet upper = {right: lower}\nlower.spare = hostOther\nlet result = upper.right.left.cell\nsay result\nexit\n",
      globals: ["hostValue", "hostOther", "hostInit"],
    },
  ];
  // (both stop settled at demand 16, where #2080 part 1 declines them, and before admission settles the plain gate
  // declines them, #2080 part 2: no stop publishes them)
  for (const { mode, source, globals } of controls) {
    const found = stopRuns(unit(source), globals, (make) => mode.run(make), 1, undefined, "work");
    assert.equal(found.natural.plan, false, source);
    assert.deepEqual([found.kind, found.stopped.declined], ["declined", UNDECIDED], source);
  }
  // (a campaign item with both: an absent property's store and a store the stop moved to a check against `unknown`,
  // neither passed; `all:new-cases-3::graph/899`. Its decision stops in the restarted pass, which stops the analysis
  // before admission settled: the plain gate declines it, #2080 part 2)
  const both = stopRuns(
    unit(
      'let typed:object={x:1}\nlet num:integer=1\nlet text:string="x"\nlet root={f:typed,g:num}\nlet foreign={f:hostValue,g:text}\nlet a=root\nlet b=foreign\nlet c=root\na.q=b\nc=c\nc=b\nb=b\nlet out=c\nexit\n',
    ),
    ["hostValue", "hostOther", "hostInit"],
    (make) => HELD_MODES[2]!.run(make),
    64,
  );
  assert.deepEqual([both.kind, both.stopped.declined], ["declined", UNDECIDED]);
  // (two stores lacking properties of one object share its site, each its own error, Codex r1 on #2185: #2080 part 1
  // declines it at a settled stop and the plain gate before admission settles, #2080 part 2, so no stop publishes a plan
  // to drop the first store's `requireExisting` from, and nothing is read open)
  for (const mode of HELD_MODES) {
    let dropped = false;
    const found = stopRuns(
      unit("let root={x:1}\nroot.q=2\nroot.z=3\nexit\n"),
      ["hostValue"],
      (make) => mode.run(make),
      1,
      (plan) => ({
        ...plan,
        instructions: plan.instructions.map((instruction) => {
          if (dropped || instruction.kind !== "assign" || instruction.requireExisting !== true)
            return instruction;
          dropped = true;
          const { requireExisting: _, ...kept } = instruction;
          return kept;
        }),
      }),
      "work",
    );
    assert.deepEqual([found.kind, found.stopped.declined], ["declined", UNDECIDED], mode.name);
  }
  // (a genuine escape: the stop's plan stored a text the natural compile rejects, under a guard the pool's boolean takes;
  // #2080 part 1 declines it at a settled stop, and the plain gate before admission settles, #2080 part 2: closed by
  // declining)
  for (const mode of HELD_MODES) {
    const found = stopRuns(
      unit('let n = 1\nif hostValue is boolean { n = "bad" }\nexit\n'),
      ["hostValue"],
      (make) => mode.run(make),
      1,
      undefined,
      "work",
    );
    assert.equal(found.natural.plan, false, mode.name);
    assert.deepEqual([found.kind, found.stopped.declined], ["declined", UNDECIDED], mode.name);
  }
  // (one of the nine `later` campaign items, where the stopped run passed the store the natural plan rejects and failed
  // at the loop's own start: its decision stops in the restarted pass, which stops the analysis before admission
  // settled, and the plain gate declines it, #2080 part 2)
  const later = stopRuns(
    unit(
      "let t:integer?=null\nlet root={n:t,nest:{n:t,keep:1},spare:t}\nlet other={n:2.5,nest:{n:2.5,keep:1},spare:1}\nlet a=root\nif other != null { a=other }\nlet b=a\nrepeat b.n {}\nexit\n",
    ),
    ["hostValue", "hostOther", "hostInit"],
    (make) => HELD_MODES[2]!.run(make),
    64,
  );
  assert.deepEqual([later.kind, later.stopped.declined], ["declined", UNDECIDED]);
});
