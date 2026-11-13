// A typed parse into a written object: the reader's work, counted at one doubling, repairs and reads nested levels
// without copying or checking again.

import assert from "node:assert/strict";
import test from "node:test";
import type { TypePlan } from "../../../src/plan/model.js";
import {
  readExpected,
  repairedRecord,
  replaceKeptTexts,
} from "../../../src/runtime/values/expected-reading.js";
import type { SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import {
  candidatePlan,
  runWith,
  halted,
  at,
  object,
  ran,
  planNodes,
  listOf,
  bound,
} from "../../helpers/type-core/type-core-discharge-runtime-setup.js";

/** JSON as the reader reads it, each list and dict counting the reads of its `kind` (every reading and copy of one). */
function countedJson(raw: unknown, count: { reads: number }): SerializableRuntimeValue {
  if (raw === null || typeof raw !== "object") {
    // EVIDENCE: fixture: the JSON's scalars are text and numbers.
    return raw as SerializableRuntimeValue;
  }
  if (Array.isArray(raw)) {
    const items = raw.map((item) => countedJson(item, count));
    return {
      get kind(): "list" {
        count.reads += 1;
        return "list";
      },
      items,
    };
  }
  const entries = Object.entries(raw).map(([key, field]) => ({
    key,
    value: countedJson(field, count),
  }));
  return {
    get kind(): "dict" {
      count.reads += 1;
      return "dict";
    },
    entries,
  };
}

/** The steps of array iteration `work` takes, by the array iterator's `next`: a spread of a path takes one per step. */
function iterationSteps(work: () => void): number {
  // EVIDENCE: invariant: an array's iterator inherits `next` from %ArrayIteratorPrototype%, which every iteration calls.
  const prototype = Object.getPrototypeOf([][Symbol.iterator]()) as {
    next: (...args: unknown[]) => IteratorResult<unknown>;
  };
  const next = prototype.next;
  let steps = 0;
  prototype.next = function (this: unknown, ...args: unknown[]): IteratorResult<unknown> {
    steps += 1;
    return next.apply(this, args);
  };
  try {
    work();
  } finally {
    prototype.next = next;
  }
  return steps;
}

/**
 * A typed parse into a written `object` of `json` with `fallback` as its default, compiled in both orders and run: the
 * reader's work for that JSON through `readExpected`, `repairedRecord` and the file store's `replaceKeptTexts`, as reads
 * of its lists' and dicts' `kind` and as steps of array iteration; the run says "complete", warns once and binds `value`.
 */
function readerWork(
  fallback: string,
  json: string,
  given: SerializableRuntimeValue,
  value: SerializableRuntimeValue,
): { readonly reads: number; readonly steps: number } {
  const call = `fromJson(hostValue, default: ${fallback}, files: false)`;
  const source = `let parcel: object = ${call}\nsay "complete"\nexit\n`;
  const plan = candidatePlan(source);
  const result = runWith(plan, json);
  assert.deepEqual(ran(result), halted(["complete"], [`TSW020@${at(source, call)}`]));
  assert.deepEqual(bound(result.snapshot, "parcel"), value);
  const parse = planNodes(plan).find((node) => node["kind"] === "call" && "expected" in node);
  // EVIDENCE: invariant: the plan's typed parse carries its expected type, validated with the plan.
  const type = parse!["expected"] as TypePlan;
  const read = (parsed: SerializableRuntimeValue): void => {
    assert.equal(readExpected(parsed, type, true).kind, "fields");
    assert.deepEqual(repairedRecord(parsed, given, type, true), value);
    replaceKeptTexts(parsed, type, () => undefined);
  };
  const count = { reads: 0 };
  read(countedJson(JSON.parse(json), count));
  const parsed = countedJson(JSON.parse(json), { reads: 0 });
  return { reads: count.reads, steps: iterationSteps(() => read(parsed)) };
}

test("a typed parse into a written `object` repairs a deep property without copying, at each level, the levels below or the path above, every key kept, counted through the reader at one doubling, in both orders (#1223, Astra r1 B1, #1253)", () => {
  // a `next` chain `depth` deep in the default and the JSON, its deepest `score` wrong, a `kept` key at each level: a
  // copy of each level's contents, or of its path, at every level grows with the square of the depth
  const work = (depth: number): { readonly reads: number; readonly steps: number } => {
    let json = '{"score":"bad","kept":0}';
    let value = object({ score: 4, kept: 0 });
    let given = object({ score: 4 });
    for (let level = 1; level <= depth; level += 1) {
      json = `{"next":${json},"kept":${level}}`;
      value = object({ next: value, kept: level });
      given = object({ next: given });
    }
    return readerWork(
      `${"{next: ".repeat(depth)}{score: 4}${"}".repeat(depth)}`,
      json,
      given,
      value,
    );
  };
  const small = work(16);
  const large = work(32);
  assert.ok(
    large.reads <= 2.15 * small.reads,
    `reads at depth 16 and 32: ${small.reads}, ${large.reads}`,
  );
  assert.ok(
    large.steps <= 2.15 * small.steps,
    `steps at depth 16 and 32: ${small.steps}, ${large.steps}`,
  );
});

test("a typed parse into a written `object` reads lists nested in lists without checking the levels below again at each level, counted through the reader at one doubling, in both orders (#1253)", () => {
  // `xs` nested `levels` deep in the default and the JSON, its object kept, a sibling `bad` wrong
  const work = (levels: number): number => {
    let xs = object({ n: 1 });
    let given = object({ n: 0 });
    for (let level = 0; level < levels; level += 1) {
      xs = listOf(xs);
      given = listOf(given);
    }
    return readerWork(
      `{xs: ${"[".repeat(levels)}{n: 0}${"]".repeat(levels)}, bad: 0}`,
      `{"xs":${"[".repeat(levels)}{"n":1}${"]".repeat(levels)},"bad":"bad"}`,
      object({ xs: given, bad: 0 }),
      object({ xs, bad: 0 }),
    ).reads;
  };
  const small = work(16);
  const large = work(32);
  assert.ok(large <= 2.15 * small, `reads at 16 and 32 levels: ${small}, ${large}`);
});
