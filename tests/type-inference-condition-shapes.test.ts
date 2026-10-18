import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import { parse } from "../src/parser.js";
import { conditionShape } from "../src/type-inference/narrowing-shapes.js";
import {
  conditionAt,
  generateConditionTable,
  type ConditionRow,
} from "./helpers/condition-shapes.js";
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

test("the recognizer gives every row's condition its declared shape", () => {
  for (const { row } of generated) {
    if (row.condition === null) {
      assert.equal(row.shape, null, `${row.id}: the switch has no condition`);
      continue;
    }
    assert.ok(row.shape !== null, `${row.id}: a shape`);
    const node = conditionAt(parse(row.source).program, row.condition);
    assert.ok(node !== undefined, `${row.id}: the condition at ${row.condition.start}`);
    const shape = conditionShape(node);
    assert.equal(shape.kind, row.shape.kind, `${row.id}: ${row.source}`);
    switch (shape.kind) {
      case "literal":
        assert.ok(row.shape.kind === "literal");
        assert.equal(shape.node.value, row.shape.value, row.id);
        break;
      case "null":
      case "type": {
        assert.ok(row.shape.kind === "null" || row.shape.kind === "type");
        assert.equal(shape.negated, row.shape.negated, row.id);
        assert.deepEqual(
          { start: shape.tested.span.start.offset, end: shape.tested.span.end.offset },
          row.shape.tested,
          `${row.id}: the tested expression`,
        );
        if (shape.kind === "type" && row.shape.kind === "type")
          assert.equal(
            row.source.slice(shape.node.type.span.start.offset, shape.node.type.span.end.offset),
            row.shape.type,
            `${row.id}: the type term`,
          );
        break;
      }
      case "not":
      case "and":
      case "or":
      case "other":
        break;
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
