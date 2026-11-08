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
 * Stage 3b's records held back (§13: N1–N10, #1073 U6), each by name with its reason and issue: a closed list. Every
 * other record with an `N` cell is asserted, so one that breaks fails the cells test; a held record that matches fails
 * it too (its completeness check), so a hold cannot outlive its cause.
 */
const CORRIDOR_REASON = "the route rule's corridor across locations (#1938)";
const TSV062_REASON = "a static warning of S9b's otherwise (#1737)";
const U4_REASON = "U4's consumer remainder (#2025)";
const OUTLIER_REASON = "a fixture expectation awaiting its ruling (#2025)";
const CROSS_REASON = "the numeric crossover (#1173, #2025)";
const DEFECT_REASON = "a fixture expectation defect (#2025)";
const CTX_REASON = "a context word under an unrelated test (#2024)";
export const HELD_S10_RECORDS: ReadonlyMap<string, string> = new Map([
  ["cp9-cells/3b/review-early/a2-root-nullable-collection", CORRIDOR_REASON],
  ["cp9-cells/3b/review-early/a3-kinds-only-box", CORRIDOR_REASON],
  ["cp9-cells/3b/review-early/a4-shelves-scope", CORRIDOR_REASON],
  ["cp9-cells/3b/review-early/a5-live-while-only-break", CORRIDOR_REASON],
  ["cp9-cells/3b/review-early/astra-r2-fence-2", CORRIDOR_REASON],
  ["cp9-cells/3b/review-early/n7-entered-label", CORRIDOR_REASON],
  ["cp9-cells/3b/review-early/n9-back-edge", CORRIDOR_REASON],
  ["cp9-cells/3b/review-early/n9-switch-multi", CORRIDOR_REASON],
  ["cp9-cells/3b/review-early/s2-rooms-sibling", CORRIDOR_REASON],
  ["cp9-cells/3b/review-early/sol-r2-fence-5", CORRIDOR_REASON],
  ["cp9-cells/3b/review-late/copies/back-edge", CORRIDOR_REASON],
  ["cp9-cells/3b/review-late/copies/entered-label", CORRIDOR_REASON],
  ["cp9-cells/3b/review-late/copies/refuse-argument", CORRIDOR_REASON],
  ["cp9-cells/3b/review-late/copies/refuse-whole-collection", CORRIDOR_REASON],
  ["cp9-cells/3b/switch/deferred-null-1", CORRIDOR_REASON],
  ["cp9-cells/r42/load-written-optional", CORRIDOR_REASON],
  ["cp9-cells/r46/m3/astra-m3/routes/method-null-kind", CORRIDOR_REASON],
  ["cp9-cells/r46/m3/null-snapshot-alias-control", CORRIDOR_REASON],
  ["cp9-cells/r46/m3/null-snapshot-same-key", CORRIDOR_REASON],
  ["cp9-cells/3b/review-late/fallback/literal-nonnull", TSV062_REASON],
  ["cp9-cells/3b/review-late/fallback/nested-dead", TSV062_REASON],
  ["cp9-cells/3b/review-late/fallback/nested-unsupported", TSV062_REASON],
  ["cp9-cells/3b/review-late/fallback/non-null-first-fallback", TSV062_REASON],
  ["cp9-cells/3b/review-late/r7/sol-dead-null-fallback", TSV062_REASON],
  ["cp9-cells/3b/review-late/r7/sol-dead-union-fallback", TSV062_REASON],
  ["cp9-cells/r46/m3/astra-m3/guard-fallback", TSV062_REASON],
  ["cp9-cells/3b/review-early/s2-same-location-compound-loop", U4_REASON],
  ["cp9-cells/r42/guard/holding-path", U4_REASON],
  ["cp9-cells/r46/guard/branch-holding-path/guarded", U4_REASON],
  ["cp9-cells/3b/invalidation/clear/changed", OUTLIER_REASON],
  ["cp9-cells/3b/invalidation/sort/changed", OUTLIER_REASON],
  ["cp9-cells/r46/guard/arithmetic-unary/guarded", OUTLIER_REASON],
  ["cp9-cells/r49/sharing/record-aliases/guarded", CROSS_REASON],
  ["cp9-cells/3b/loop/break/changed", DEFECT_REASON],
  ["cp9-cells/3b/review-early/astra-r2-fence-6", CTX_REASON],
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
  // S9b's F18 shapes (TABLE r4.77 (2)): a copy of a written type as `fromJson`'s and `load`'s receiving context, which
  // the core takes with its A4 receiving design (#1072's A2); `files: true` is outside the slice's syntax, and the text
  // operand's warning there is C13's, not F18's
  if (record.name.startsWith("cp9-cells/s9b/f18-held/copy/scalar-json-host-value/"))
    return "fromJson with files: true outside the slice, and C13's text operand";
  if (record.name.startsWith("cp9-cells/s9b/f18-held/copy/"))
    return "S9b's F18 copy of a written type as the receiving context (r4.77 (2))";
  // Known text the conversion cannot convert is a compile error of its own (V30 §13, #1105), which the core's record
  // holds since the checks that owe the runtime nothing publish there (the lead's decision 3 on #1072): the record lacks
  // it until its maintainer adds it.
  if (record.name === "cp9-cells/r46/m3/astra-m3/conversion/default")
    return "a known-value error the record lacks (decision 3 on #1072)";
  // A button's value from outside the script owes C13's warning and its check at the choice, as an argument's does (the
  // sentence review of #1437, ruling 4): the record lacks them until its maintainer adds them.
  if (
    record.name === "cp9-cells/s4/choice-external/inferred" ||
    record.name === "cp9-cells/s4/choice-external/written" ||
    record.name === "cp9-cells/s4/choice-value/external-written"
  )
    return "C13's warning of a choice value from outside the script the record lacks (#1437)";
  // the adapters' cell (C13 and the storage rules' adapter rows): the kept checks the consumer calls run with S9b; C13's
  // released as S9b's checks give them (#1072)
  if (record.owner === "adapter" && !RELEASED_ADAPTER_RECORDS.has(record.name))
    return "the adapters' records (S9b)";
  // stage 3b (§13: N1–N10): the records still held, each by name (`HELD_S10_RECORDS`); every other is asserted
  return HELD_S10_RECORDS.get(record.name) ?? null;
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
