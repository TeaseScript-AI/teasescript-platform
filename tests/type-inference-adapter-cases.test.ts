import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";

import { operationRelations } from "../src/type-inference/adapters/index.js";
import {
  generateTable,
  ROUTINE_NAMES,
  type CaseRow,
  type RoutineName,
} from "./helpers/adapter-case-tables.js";
import { assertCase, type AdapterExpectation } from "./helpers/adapter-parity.js";

/**
 * The case tables of the branched legacy routines (O4 stage 2b, work note §6.6): each table is generated from its
 * templates and the legacy oracle, compared with the table checked in (so that neither the templates nor the oracle
 * drift unseen), and every row is asserted against the relation the routing gives the operation. Set
 * `ADAPTER_CASES_WRITE=1` to write the tables anew after a deliberate change of the templates or the legacy.
 */
const TABLES = new URL("../../tests/fixtures/type-inference/adapter-cases/", import.meta.url);

function tablePath(routine: RoutineName): URL {
  return new URL(`${routine}.jsonl`, TABLES);
}

function readTable(routine: RoutineName): CaseRow[] | null {
  const path = tablePath(routine);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): CaseRow => {
      const parsed: unknown = JSON.parse(line);
      assert.ok(typeof parsed === "object" && parsed !== null && "id" in parsed, "a row");
      // EVIDENCE: the table is written by this test from `CaseRow` values, one JSON object per line.
      return parsed as CaseRow;
    });
}

function writeTable(routine: RoutineName, rows: readonly CaseRow[]): void {
  mkdirSync(TABLES, { recursive: true });
  writeFileSync(tablePath(routine), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function expectation(row: CaseRow): AdapterExpectation {
  assert.ok(row.adapter !== null);
  return row.adapter;
}

for (const routine of ROUTINE_NAMES)
  test(`the ${routine} table is what its templates and the legacy give, and every row holds`, () => {
    const generated = generateTable(routine);
    const rows = generated.map((entry) => entry.row);
    if (process.env["ADAPTER_CASES_WRITE"] === "1") writeTable(routine, rows);
    const table = readTable(routine);
    assert.ok(table !== null, `a table at ${tablePath(routine).pathname}; write it with ADAPTER_CASES_WRITE=1`);
    const byId = new Map(table.map((row) => [row.id, row]));
    for (const row of rows) {
      const kept = byId.get(row.id);
      assert.ok(kept !== undefined, `the table has ${row.id}`);
      assert.deepEqual(row, kept, `the generated row ${row.id} is the table's`);
    }
    assert.equal(table.length, rows.length, "the table has no row the templates do not generate");
    const relations = operationRelations();
    const pending: string[] = [];
    for (const { row, outcome, inputs: built } of generated) {
      if (row.adapter === null || built.inputs === null) continue;
      const { contract, inputs } = built;
      const relation = relations.relation(contract);
      if (relation === undefined) {
        pending.push(row.id);
        continue;
      }
      try {
        assertCase(
          relation,
          inputs,
          outcome,
          { fact: row.fact, errors: outcome.errorsAtOperation, elsewhere: row.elsewhere },
          expectation(row),
        );
      } catch (error) {
        throw new Error(`${row.id}: ${error instanceof Error ? error.message : String(error)}\n${row.source}`, {
          cause: error,
        });
      }
    }
    assert.deepEqual(pending, [], "a relation for every row's contract");
  });
