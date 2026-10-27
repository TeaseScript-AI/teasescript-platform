import assert from "node:assert/strict";
import test from "node:test";

import { checkChargedIteration } from "./check-charged-iteration.mjs";

function rejected(sourceText) {
  return checkChargedIteration("fixture.ts", sourceText).map(({ line }) => line);
}

test("allows walks through the charging iterators and fixed-size spreads of objects", () => {
  const sourceText = `
for (const item of each(work, "indexSteps", items)) use(item);
for (const _ of steps(work, "eventSteps", () => low < high)) low += 1;
const found = some(work, "eventSteps", items, (item) => item > 0);
const copy = { ...item, tag: "integer" };
const [first, second] = pair;
const set = new Set();
const table = new Set(["return", "exit"]);
`;
  assert.deepEqual(rejected(sourceText), []);
});

test("rejects raw loops and loops over anything but the charging iterators", () => {
  const sourceText = `
for (let index = 0; index < items.length; index += 1) use(items[index]);
for (const key in record) use(key);
while (pending.length > 0) pending.pop();
do { step(); } while (more());
for (const item of items) use(item);
for (const item of copied(work, "indexSteps", items)) use(item);
`;
  assert.deepEqual(rejected(sourceText), [2, 3, 4, 5, 6, 7]);
});

test("rejects array walks, copies, spreads and constructors that walk their argument", () => {
  const sourceText = `
items.map((item) => item);
items.filter((item) => item).some((item) => item);
kinds.includes("null");
labels.join(".");
steps.slice(1);
list.sort((a, b) => a - b);
const all = [...items];
call(...items);
const [head, ...tail] = items;
const set = new Set(items);
const keys = Object.keys(record);
const array = Array.from(items);
`;
  assert.deepEqual(rejected(sourceText), [2, 3, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});
