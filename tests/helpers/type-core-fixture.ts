import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { SourceFile } from "./type-core-analysis.js";
import { readCompactRecord, type CompactRecord } from "./type-core-records.js";

/**
 * The expectation set of the coarse core (checkpoint 9) as its compact fixture (`tests/fixtures/type-core/`, made by
 * the port plan's step S0; its `MANIFEST.md` says how): per record its name, the TABLE cells it tests, the class it
 * belongs to (`owner`: `adapter` for the records the kept adapters own), its files, and its expected record.
 */
export interface FixtureRecord {
  readonly name: string;
  readonly cells: readonly string[];
  readonly owner: string | null;
  readonly files: readonly SourceFile[];
  readonly expected: CompactRecord;
}

const FIXTURE = new URL("../../../tests/fixtures/type-core/cells.jsonl", import.meta.url);

function fields(value: unknown, where: string): Readonly<Record<string, unknown>> {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${where}: an object`,
  );
  // EVIDENCE: validation: the assertion above admits only plain non-array objects, read here by key.
  return value as Readonly<Record<string, unknown>>;
}

function texts(value: unknown, where: string): string[] {
  assert.ok(Array.isArray(value), `${where}: a list`);
  return value.map((entry, index) => {
    assert.equal(typeof entry, "string", `${where}[${index}]: a text`);
    return String(entry);
  });
}

/** The fixture's records, each line checked, so a malformed line fails where it is. */
export function readFixture(): FixtureRecord[] {
  return readFileSync(FIXTURE, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line, index) => {
      const record = fields(JSON.parse(line), `line ${index + 1}`);
      const name = record["name"];
      assert.equal(typeof name, "string", `line ${index + 1}: a name`);
      const where = String(name);
      const owner = record["owner"];
      assert.ok(owner === null || typeof owner === "string", `${where}.owner: a text or null`);
      const files = record["files"];
      assert.ok(Array.isArray(files) && files.length > 0, `${where}.files: a list of files`);
      return {
        name: where,
        cells: texts(record["cells"], `${where}.cells`),
        owner: owner === null ? null : String(owner),
        files: files.map((file, position) => {
          const entry = fields(file, `${where}.files[${position}]`);
          assert.equal(typeof entry["path"], "string", `${where}.files[${position}].path`);
          assert.equal(typeof entry["source"], "string", `${where}.files[${position}].source`);
          return { path: String(entry["path"]), source: String(entry["source"]) };
        }),
        expected: readCompactRecord(record, where),
      };
    });
}
