// What the oracle library writes and reads: a publication as its parts joined (#1503), plan data as JSON past
// JSON.stringify's depth, and a decision record by its place and exact path.

import assert from "node:assert/strict";
import test from "node:test";

import { analyseCore, type DecisionWork } from "../../../src/type-inference/core/answers.js";
import { CoreProgram } from "../../../src/type-inference/core/program.js";
import { coreRequest } from "../../helpers/type-core-analysis.js";
import {
  decisionKey,
  decisionOf,
  decisionsByKey,
  inMode,
  jsonText,
  MODES,
  occurrences,
  publication,
  publicationHashes,
  publicationParts,
  publishedAnswers,
  publishedRoute,
} from "../../helpers/type-core-oracles.js";
import { GLOBALS, main, sha256, SMALL } from "../../helpers/type-core/type-core-oracles-setup.js";

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
