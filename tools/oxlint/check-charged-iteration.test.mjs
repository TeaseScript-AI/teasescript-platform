import assert from "node:assert/strict";
import test from "node:test";
import { Project, ts } from "ts-morph";

import { chargedIterationDiagnostics } from "./check-charged-iteration.mjs";

const ITERATION = `
import type { WorkLedger } from "./budget.js";
export function* each<T>(work: WorkLedger, counter: string, items: Iterable<T>): Generator<T> {
  for (const item of items) {
    work.charge(counter);
    yield item;
  }
}
export function* steps(work: WorkLedger, counter: string, more: () => boolean): Generator<void> {
  while (more()) {
    work.charge(counter);
    yield;
  }
}
export function some<T>(work: WorkLedger, counter: string, items: Iterable<T>, test: (item: T) => boolean): boolean {
  for (const item of each(work, counter, items)) if (test(item)) return true;
  return false;
}
`;

const BUDGET = `
export class WorkLedger {
  charge(_counter: string, _units = 1): void {}
}
export function listed(units: number): number {
  return units;
}
export function helper(items: readonly number[]): number {
  return items.length;
}
`;

const OUTSIDE = new Set([
  "lib:Map",
  "lib:Map.get",
  "lib:Map.set",
  "lib:Math.max",
  "lib:Set",
  "src/budget.ts:WorkLedger.charge",
  "src/budget.ts:listed",
]);

/** The lines the check rejects in `sourceText`, as a narrowing module beside a fixture iterator and ledger. */
function rejected(sourceText) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: true,
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2023.d.ts"],
    },
  });
  project.createSourceFile("/repo/src/iteration.ts", ITERATION);
  project.createSourceFile("/repo/src/budget.ts", BUDGET);
  project.createSourceFile("/repo/src/narrowing.ts", sourceText);
  return chargedIterationDiagnostics(project.getProgram().compilerObject, "/repo", {
    files: ["src/narrowing.ts"],
    iteration: "src/iteration.ts",
    charge: "src/budget.ts:WorkLedger.charge",
    outside: OUTSIDE,
  }).map(({ line }) => line);
}

test("allows the charging iterators, listed callables, fixed-size copies and recursion charged on entry", () => {
  const sourceText = `
import { each, some, steps } from "./iteration.js";
import { listed, type WorkLedger } from "./budget.js";
declare const work: WorkLedger;
declare const items: readonly number[];
declare function use(item: unknown): void;
for (const item of each(work, "indexSteps", items)) use(item);
let low = 0;
for (const _ of steps(work, "eventSteps", () => low < 3)) low += 1;
some(work, "eventSteps", items, (item) => item > 0);
const item = { tag: "integer", cert: "def" };
const copy = { ...item, tag: "number" };
const [first, second] = [1, 2];
const table = new Map<string, number>([["a", 1]]);
table.set("b", listed(table.get("a") ?? 0));
const set = new Set<string>();
function climb(depth: number): number {
  work.charge("eventSteps");
  return depth === 0 ? 0 : climb(depth - 1);
}
function down(depth: number): number {
  work.charge("eventSteps");
  return depth === 0 ? 0 : up(depth - 1);
}
function up(depth: number): number {
  work.charge("eventSteps");
  return down(depth);
}
use([copy, first, second, set, climb(1), up(1), Math.max(1, 2)]);
`;
  assert.deepEqual(rejected(sourceText), []);
});

test("rejects raw loops and loops over anything but the charging iterators", () => {
  const sourceText = `
import { each as _each } from "./iteration.js";
import type { WorkLedger } from "./budget.js";
declare const work: WorkLedger;
declare const items: number[];
declare const record: Record<string, number>;
declare function use(item: unknown): void;
for (let index = 0; index < items.length; index += 1) use(items[index]);
for (const key in record) use(key);
while (items.length > 0) items.length = 0;
do use(1); while (items.length > 0);
for (const item of items) use(item);
function shadow(): void {
  work.charge("eventSteps");
  const each = (_work: WorkLedger, _counter: string, list: number[]) => {
    work.charge("eventSteps");
    return list;
  };
  for (const item of each(work, "indexSteps", items)) use(item);
}
shadow();
use(_each);
`;
  assert.deepEqual(rejected(sourceText), [8, 9, 10, 11, 12, 19]);
});

test("rejects walks through recursion, aliases, computed members, unlisted callables and copies", () => {
  const sourceText = `
import type { WorkLedger } from "./budget.js";
import { helper } from "./budget.js";
declare const items: number[];
declare const source: string;
declare const record: Record<string, number>;
declare function use(item: unknown): void;
declare const _work: WorkLedger;
function walk(xs: number[], i = 0): void {
  if (i < xs.length) { use(xs[i]); walk(xs, i + 1); }
}
class Box { get all(): number { return this.sum(0); } sum(i: number): number { return i < items.length ? this.all : 0; } }
const visit = Array.prototype.forEach;
visit.call(items, use);
items["forEach"](use);
source.split(".");
source.replaceAll("x", "y");
Math.max.apply(null, items);
Math.max(...items);
const copy = { ...record };
function* all(): Generator<number> { yield* items; }
helper(items);
items.map((item) => item);
const set = new Set(items);
const keys = Object.keys(record);
const array = Array.from(items);
use([walk, new Box(), copy, all, set, keys, array]);
`;
  assert.deepEqual(
    rejected(sourceText),
    [9, 12, 12, 13, 13, 14, 15, 16, 17, 18, 19, 20, 21, 21, 22, 23, 23, 24, 25, 25, 26, 26],
  );
});

test("rejects a function body that does not charge a positive unit on entry, but an arrow the iterator calls", () => {
  const sourceText = `
import { some } from "./iteration.js";
import type { WorkLedger } from "./budget.js";
declare const work: WorkLedger;
declare const items: number[];
declare const other: { charge(counter: string): void };
function even(n: number): boolean {
  work.charge("eventSteps");
  return n === 0 || odd(n - 1);
}
function odd(n: number): boolean {
  return n !== 0 && even(n - 1);
}
const search = (n: number): number => (n === 0 ? 0 : search(n - 1));
function remembered(n: number): number {
  if (n > 0) return n;
  work.charge("eventSteps");
  return 0;
}
function nothing(): void {
  work.charge("eventSteps", 0);
}
function counted(n: number): void {
  work.charge("eventSteps", n + 1);
}
function twice(): void {
  work.charge("eventSteps", 2);
}
function spelled(): void {
  other.charge("eventSteps");
}
class Walk {
  constructor() {}
  get size(): number {
    return items.length;
  }
  set size(_: number) {}
  step(): number {
    return 1;
  }
}
const descend = (function down(i: number): number {
  return i < items.length ? down(i + 1) : i;
})(0);
const table = {
  run(): number {
    return 1;
  },
};
some(work, "eventSteps", items, (item) => item > 0);
some(work, "eventSteps", items, function (item) {
  return item > 0;
});
function shadow(): boolean {
  work.charge("eventSteps");
  const some = (_work: WorkLedger, _counter: string, list: number[], test: (item: number) => boolean) => {
    work.charge("eventSteps");
    return list.length > 0 && test(0);
  };
  return some(work, "eventSteps", items, (item) => item > 0);
}
const charged = (n: number): number => {
  work.charge("eventSteps");
  return n === 0 ? 0 : charged(n - 1);
};
export const all = [charged(1), search(1), remembered(1), nothing(), counted(1), twice(), spelled(), new Walk(), descend, table, shadow()];
`;
  assert.deepEqual(rejected(sourceText), [11, 14, 15, 20, 23, 29, 33, 34, 37, 38, 42, 46, 51, 60]);
});

test("rejects functions used as values unless charged on entry, and objects converted to text", () => {
  const sourceText = `
import { some } from "./iteration.js";
import type { WorkLedger } from "./budget.js";
declare const work: WorkLedger;
declare const items: number[];
function positive(item: number): boolean {
  return item > 0;
}
function counted(item: number): boolean {
  work.charge("eventSteps");
  return item > 0;
}
some(work, "eventSteps", items, positive);
some(work, "eventSteps", items, counted);
const table = { run: (n: number): number => (n === 0 ? 0 : table.run(n - 1)) };
const text = \`\${items}\`;
const sum = "" + items;
const size = \`\${items.length}\` + items.length;
const number = Number(items);
export const all = [table, text, sum, size, number];
`;
  assert.deepEqual(rejected(sourceText), [6, 15, 16, 17, 19]);
});
