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
 * Stage 3b's records the consumers' read of the narrowing completes (#1073 PR 2: every read takes its nearest G, an exact
 * definition answers before the guard mark, a consumer's descendant demand takes its path's G), each proven complete in
 * the four modes before its release.
 */
const RELEASED_S10_CONSUMER_RECORDS: ReadonlySet<string> = new Set([
  "cp9-cells/3b/ad1/e1a/tested",
  "cp9-cells/3b/ad1/e1b/tested",
  "cp9-cells/3b/collection/nested",
  "cp9-cells/3b/collection/root",
  "cp9-cells/3b/collection/sibling-Gs",
  "cp9-cells/3b/forms/and-operand",
  "cp9-cells/3b/forms/equal-null-else/held",
  "cp9-cells/3b/forms/is-integer",
  "cp9-cells/3b/forms/is-not-integer",
  "cp9-cells/3b/forms/is-not-null/held",
  "cp9-cells/3b/forms/is-null-else/held",
  "cp9-cells/3b/forms/leaving-break",
  "cp9-cells/3b/forms/leaving-continue",
  "cp9-cells/3b/forms/leaving-exit",
  "cp9-cells/3b/forms/leaving-goto",
  "cp9-cells/3b/forms/not-equal-else/held",
  "cp9-cells/3b/forms/not-is-null/held",
  "cp9-cells/3b/forms/not-null/held",
  "cp9-cells/3b/forms/or-operand",
  "cp9-cells/3b/forms/while-body",
  "cp9-cells/3b/invalidation/add/held",
  "cp9-cells/3b/invalidation/addAll/held",
  "cp9-cells/3b/invalidation/clear/held",
  "cp9-cells/3b/invalidation/removeFirst/held",
  "cp9-cells/3b/invalidation/removeLast/held",
  "cp9-cells/3b/invalidation/reverse/held",
  "cp9-cells/3b/invalidation/shuffle/held",
  "cp9-cells/3b/invalidation/sort/held",
  "cp9-cells/3b/loop/after/held",
  "cp9-cells/3b/loop/break/held",
  "cp9-cells/3b/loop/continue/held",
  "cp9-cells/3b/loop/nested/changed",
  "cp9-cells/3b/loop/no-store",
  "cp9-cells/3b/loop/save",
  "cp9-cells/3b/loop/unconditional-null",
  "cp9-cells/3b/numeric/negative-2.0",
  "cp9-cells/3b/numeric/negative-2.5",
  "cp9-cells/3b/numeric/overlap-18",
  "cp9-cells/3b/numeric/overlap-19",
  "cp9-cells/3b/numeric/overlap-20",
  "cp9-cells/3b/numeric/positive-2.0",
  "cp9-cells/3b/paths/fixed-index/held",
  "cp9-cells/3b/paths/fixed-key/held",
  "cp9-cells/3b/paths/property/held",
  "cp9-cells/3b/paths/variable-index/held",
  "cp9-cells/3b/paths/variable-key/held",
  "cp9-cells/3b/r430/and-call/quiet",
  "cp9-cells/3b/review-early/a1-exact-null-after-check",
  "cp9-cells/3b/review-early/a1-reorder-saved-reverse",
  "cp9-cells/3b/review-early/a1-reorder-saved-shuffle",
  "cp9-cells/3b/review-early/a1-reorder-saved-sort",
  "cp9-cells/3b/review-early/a2-division-preserves-number",
  "cp9-cells/3b/review-early/a2-root-collection",
  "cp9-cells/3b/review-early/a2-rows-index-scope",
  "cp9-cells/3b/review-early/a2-same-location-loop",
  "cp9-cells/3b/review-early/a4-fractional-case",
  "cp9-cells/3b/review-early/a4-later-case-excludes-null",
  "cp9-cells/3b/review-early/a4-number-case-3",
  "cp9-cells/3b/review-early/a4-number-case-3dot0",
  "cp9-cells/3b/review-early/a4-number-case-3e0",
  "cp9-cells/3b/review-early/a4-number-case-plus3",
  "cp9-cells/3b/review-early/a4-one-element-preserving",
  "cp9-cells/3b/review-early/a4-root-shelves",
  "cp9-cells/3b/review-early/astra-r1-fence-4",
  "cp9-cells/3b/review-early/astra-r1-fence-6",
  "cp9-cells/3b/review-early/astra-r1-fence-7",
  "cp9-cells/3b/review-early/astra-r3-fence-2",
  "cp9-cells/3b/review-early/loop-breaking-before",
  "cp9-cells/3b/review-early/loop-preserving-after",
  "cp9-cells/3b/review-early/loop-preserving-continue",
  "cp9-cells/3b/review-early/n1-early-exit",
  "cp9-cells/3b/review-early/n1-number-negative",
  "cp9-cells/3b/review-early/n1-unknown-positive",
  "cp9-cells/3b/review-early/n6-saved-computed",
  "cp9-cells/3b/review-early/s1-nonreordering-control",
  "cp9-cells/3b/review-early/s4-grid-scopes",
  "cp9-cells/3b/review-early/s4-grid-use-selector-change",
  "cp9-cells/3b/review-early/sol-r1-fence-5",
  "cp9-cells/3b/review-early/sol-r1-fence-7",
  "cp9-cells/3b/review-late/corridor/test-leaves",
  "cp9-cells/3b/saved/held",
  "cp9-cells/3b/switch/fractional",
  "cp9-cells/3b/switch/later-case",
  "cp9-cells/3b/switch/null-case-error",
  "cp9-cells/3b/switch/null-default",
  "cp9-cells/3b/switch/whole-2",
  "cp9-cells/3b/switch/whole-2.0",
  "cp9-cells/r42/guard/else-branch",
  "cp9-cells/r42/guard/equals-null",
  "cp9-cells/r42/guard/not-null",
  "cp9-cells/r44/guard/null-member-guarded",
  "cp9-cells/r46/guard/branch-null-eq/guarded",
  "cp9-cells/r46/guard/branch-null-ne/guarded",
  "cp9-cells/r46/m3/astra-m3/guard/get-index/guard",
  "cp9-cells/r46/m3/astra-m3/guard/repeat/guard",
  "cp9-cells/r46/m3/astra-m3/guard/same-path",
  "cp9-cells/r46/m3/sol-m3/guard-null-16",
  "cp9-cells/r46/m3/sol-m3/guard-null-18",
  "cp9-cells/r46/m3/sol-m3/guard-null-20",
  "cp9-cells/r8/n5/component-preserving",
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
  // a computed key's `default: null` owes N3's required check at its integer use (Sol's scoping r1 §4)
  if (record.name === "cp9-cells/s9b/f18-held/computed-key/null-default")
    return "N3's required check of a load's possible null (S10)";
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
  // stage 3b (§13: N1–N10): narrowing definitions, N3's required checks for a possible null and for written unions, and
  // with them S0(c)'s class of expectations that rest on the null and written-union deviation and TABLE r4.52 AD-1's
  // re-derived records (each cites one of these cells), enter with S10
  if (
    record.cells.some((cell) => /^N\d/.test(cell)) &&
    !RELEASED_S10_CONSUMER_RECORDS.has(record.name)
  )
    return "stage 3b's cells (S10)";
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
