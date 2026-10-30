import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { analyseCore, type Answers } from "../src/type-inference/core/answers.js";
import { withTestAllowance, withTestDemandAllowance } from "../src/type-inference/core/budget.js";
import { withConsumerOrder } from "../src/type-inference/core/consumers.js";
import { CoreProgram } from "../src/type-inference/core/program.js";
import { coreRequest, type SourceFile } from "./helpers/type-core-analysis.js";
import {
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
  stoppedRecord,
  stopSet,
} from "./helpers/type-core-oracles.js";

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
    assert.deepEqual(
      publicationHashes(files, MODES[0]!, GLOBALS),
      [parts.answers, parts.record, ...parts.occurrences, parts.route].map((text) =>
        createHash("sha256").update(text).digest("hex"),
      ),
    );
  }
  assert.equal(publicationParts(main("let = 1\n"), MODES[0]!, GLOBALS), null);
  assert.equal(publicationHashes(main("let = 1\n"), MODES[0]!, GLOBALS), null);
  assert.equal(publication(main("let = 1\n"), MODES[0]!, GLOBALS), null);
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
