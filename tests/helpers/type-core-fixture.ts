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

const FIXTURES = new URL("../../../tests/fixtures/type-core/", import.meta.url);

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

/** The adapters' records S9b's checks give, released from the adapters' hold (`heldBack`). */
const RELEASED_ADAPTER_RECORDS: ReadonlySet<string> = new Set([
  "cp9-cells/C13/bad-iterable",
  "cp9-cells/C13/bad-pair-iterable",
  "cp9-cells/C13/join-argument",
  "cp9-cells/C13/string-argument",
  "cp9-cells/C13/sort-receiver",
  "cp9-cells/C13/pass",
]);

/**
 * Why a record is held back from the positive list, named by its cell or by its name, or `null` for an asserted record:
 * the tests that assert the set (the cells test's records, the candidate route's plans) hold back the same records.
 */
export function heldBack(record: FixtureRecord): string | null {
  // Its right-hand datetime has no subtraction row: §3.4 sites that operand, not the whole pair. Keep the set
  // unchanged until its maintainer corrects this start as well as its end (r4.62).
  if (record.name === "cp9-cells/F16/invalid-datetime-difference")
    return "operator site awaiting set correction (TABLE §3.4, r4.62)";
  // S9b's F18 shapes (TABLE r4.81 (1), r4.77 (2)): a named default's call-site answer and a copy of a written type as
  // `fromJson`'s and `load`'s receiving context, which the core's rule takes with S9b
  if (record.name.startsWith("cp9-cells/s9b/f18-held/")) return "S9b's F18 shapes (r4.81 (1))";
  // Known text the conversion cannot convert is a compile error of its own (V30 §13, #1105), which the core's record
  // holds since the checks that owe the runtime nothing publish there (the lead's decision 3 on #1072): the record lacks
  // it until its maintainer adds it.
  if (record.name === "cp9-cells/r46/m3/astra-m3/conversion/default")
    return "a known-value error the record lacks (decision 3 on #1072)";
  // the adapters' cell (C13 and the storage rules' adapter rows): the kept checks the consumer calls run with S9b; C13's
  // released as S9b's checks give them (#1072)
  if (record.owner === "adapter" && !RELEASED_ADAPTER_RECORDS.has(record.name))
    return "the adapters' records (S9b)";
  // stage 3b (§13: N1–N10): narrowing definitions, N3's required checks for a possible null and for written unions, and
  // with them S0(c)'s class of expectations that rest on the null and written-union deviation and TABLE r4.52 AD-1's
  // re-derived records (each cites one of these cells), enter with S10
  if (record.cells.some((cell) => /^N\d/.test(cell))) return "stage 3b's cells (S10)";
  return null;
}

/** The fixture's records (`cells.jsonl`), each line checked, so a malformed line fails where it is. */
export function readFixture(): FixtureRecord[] {
  return readFileSync(new URL("cells.jsonl", FIXTURES), "utf8")
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
