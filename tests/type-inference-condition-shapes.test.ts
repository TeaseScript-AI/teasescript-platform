import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import { parse } from "../src/parser.js";
import { generateConditionTable, type ConditionRow } from "./helpers/condition-shapes.js";
import { request } from "./helpers/type-inference-graph.js";

/**
 * The condition-shape table (O4 stage 2c, work note §4): generated from the templates and the legacy oracle on the
 * current build and compared with the table checked in, which was written at the base build before the visitor
 * changed, so that the visitor is asserted against the legacy's observations. Set `CONDITION_SHAPES_WRITE=1` to write
 * the table anew, only from a build without the production change (a base checkout with these two test files).
 */
const TABLE = new URL(
  "../../tests/fixtures/type-inference/condition-shapes.jsonl",
  import.meta.url,
);

function readTable(): ConditionRow[] | null {
  if (!existsSync(TABLE)) return null;
  return readFileSync(TABLE, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): ConditionRow => {
      const parsed: unknown = JSON.parse(line);
      assert.ok(typeof parsed === "object" && parsed !== null && "id" in parsed, "a row");
      // EVIDENCE: the table is written by this test from `ConditionRow` values, one JSON object per line.
      return parsed as ConditionRow;
    });
}

const generated = generateConditionTable();

test("the condition-shape table is what its templates and the legacy give", () => {
  const rows = generated.map((entry) => entry.row);
  if (process.env["CONDITION_SHAPES_WRITE"] === "1")
    writeFileSync(TABLE, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const table = readTable();
  assert.ok(table !== null, `a table at ${TABLE.pathname}; write it with CONDITION_SHAPES_WRITE=1`);
  const byId = new Map(table.map((row) => [row.id, row]));
  assert.equal(byId.size, table.length, "every row has its own id");
  for (const row of rows) {
    const kept = byId.get(row.id);
    assert.ok(kept !== undefined, `the table has ${row.id}`);
    assert.deepEqual(row, kept, `the generated row ${row.id} is the table's\n${row.source}`);
  }
  assert.equal(table.length, rows.length, "the table has no row the templates do not generate");
});

test("every row's declared shape names a site of its condition", () => {
  for (const { row } of generated) {
    if (row.condition === null) {
      assert.equal(row.shape, null, `${row.id}: the switch has no condition`);
      continue;
    }
    assert.ok(row.shape !== null, `${row.id}: a shape`);
    const text = row.source.slice(row.condition.start, row.condition.end);
    const { program } = parse(row.source);
    assert.ok(program !== undefined, `${row.id}: parses`);
    if (row.shape.kind === "null" || row.shape.kind === "type") {
      const tested = row.source.slice(row.shape.tested.start, row.shape.tested.end);
      assert.ok(
        row.shape.tested.start >= row.condition.start && row.shape.tested.end <= row.condition.end,
        `${row.id}: the tested expression lies inside the condition`,
      );
      assert.ok(
        tested.length > 0 && text.includes(tested),
        `${row.id}: tested ${tested} in ${text}`,
      );
    }
  }
});

test("the differential's variants of the rows resolve without any host global", () => {
  let variants = 0;
  for (const { row, runtime } of generated) {
    if (runtime === null) continue;
    assert.notEqual(
      request([{ path: "main.tease", source: runtime }], [], []),
      null,
      `${row.id}:\n${runtime}`,
    );
    variants += 1;
  }
  assert.ok(variants > 0);
});
