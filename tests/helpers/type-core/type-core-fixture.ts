import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { SourceFile } from "../type-core-analysis.js";
import { readCompactRecord, type CompactRecord } from "../type-core-records.js";

/**
 * The expectation set of the coarse core (checkpoint 9) as its compact fixture (`tests/fixtures/type-core/`, made by
 * the port plan's step S0; its `MANIFEST.md` says how): per record its name, the cells it tests, the class it
 * belongs to (`owner`: `adapter` for the records the kept adapters own), its files, and its expected record.
 */
export interface FixtureRecord {
  readonly name: string;
  readonly cells: readonly string[];
  readonly owner: string | null;
  readonly files: readonly SourceFile[];
  readonly expected: CompactRecord;
}

const FIXTURES = new URL("../../../../tests/fixtures/type-core/", import.meta.url);

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
 * Stage 3b's records held back (§13: N1–N10, #1073 U6), each by name with its reason, its issue and the differences
 * from its record its cause gives: a closed list. Every other record with an `N` cell is asserted, so one that breaks
 * fails the cells test; a held record whose differences change in any mode fails its completeness check, so a hold
 * cannot outlive its cause or change it unseen.
 */
const CORRIDOR_REASON = "the route rule's corridor across locations (#1938)";
const N1173_REASON = "a written optional load's definite number error (#1173, listed in #1938)";
const RECEIVER_REASON = "a method no member of a receiver's union supports (#2258)";
const TSV062_REASON = "a static warning of S9b's otherwise (#1737)";
const U4_REASON = "U4's consumer remainder (#2025)";
const OUTLIER_REASON = "a fixture expectation awaiting its ruling (#2025)";
const CROSS_REASON = "the numeric crossover (#1173, #2025)";
/** A held record: why it is held, and the differences from its record the analysis gives in every mode. */
export interface S10Hold {
  readonly reason: string;
  readonly differences: readonly string[];
}
export const HELD_S10_RECORDS: ReadonlyMap<string, S10Hold> = new Map([
  [
    "cp9-cells/3b/review-early/a2-root-nullable-collection",
    {
      reason: CORRIDOR_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:58-68 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:58-68 ×1",
        'missing required check integer-use main.tease:58-68 N3 writer main.tease:11-24 ["if rows[0][0] != null","otherwise"] ×1',
        "extra check null-check rows.element.element [integer] main.tease:58-68 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/review-early/a3-kinds-only-box",
    {
      reason: CORRIDOR_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic operator compile-error main.tease:49-54 ×1",
        "extra diagnostic operator warning-runtime-check main.tease:49-54 ×1",
        'missing required check operator main.tease:49-54 N3 writer main.tease:66-75 ["if box.n != null","otherwise"] ×1',
        "extra check null-check box.n [integer|number] main.tease:49-54 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/review-early/a4-shelves-scope",
    {
      reason: CORRIDOR_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:120-136 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:120-136 ×1",
        'missing required check integer-use main.tease:120-136 N3 writer main.tease:14-31 ["if shelves[1][0][0] != null","otherwise"] ×1',
        "extra check null-check shelves.element.element.element [integer] main.tease:120-136 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/review-early/a5-live-while-only-break",
    {
      reason: CORRIDOR_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:101-102 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:101-102 ×1",
        'missing required check integer-use main.tease:101-102 N3 writer main.tease:66-70 ["if n != null","otherwise"] ×1',
        "extra check null-check n [integer] main.tease:101-102 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/review-early/astra-r2-fence-2",
    {
      reason: CORRIDOR_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:125-135 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:125-135 ×1",
        'missing required check integer-use main.tease:125-135 N3 writer main.tease:25-38 ["if rows[1][0] != null","otherwise"] ×1',
        "extra check null-check rows.element.element [integer] main.tease:125-135 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/review-early/n7-entered-label",
    {
      reason: CORRIDOR_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:102-103 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:102-103 ×1",
        'missing required check integer-use main.tease:102-103 N3 writer main.tease:39-43 ["if n != null","otherwise"] ×1',
        "extra check null-check n [integer] main.tease:102-103 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/review-early/n9-back-edge",
    {
      reason: CORRIDOR_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:45-46 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:45-46 ×1",
        'missing required check integer-use main.tease:45-46 N3 writer main.tease:55-59 ["if n != null","otherwise"] ×1',
        "extra check null-check n [integer] main.tease:45-46 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/review-early/n9-switch-multi",
    {
      reason: CORRIDOR_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:79-80 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:79-80 ×1",
        'missing required check integer-use main.tease:79-80 N3 writer main.tease:39-43 ["if n != null","otherwise"] ×1',
        "extra check null-check n [integer] main.tease:79-80 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/review-early/s2-rooms-sibling",
    {
      reason: CORRIDOR_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:104-121 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:104-121 ×1",
        'missing required check integer-use main.tease:104-121 N3 writer main.tease:12-43 ["if rooms[j].items[0] != null","otherwise"] ×1',
        "extra check null-check rooms.element.items.element [integer] main.tease:104-121 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/review-early/sol-r2-fence-5",
    {
      reason: CORRIDOR_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:62-72 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:62-72 ×1",
        'missing required check integer-use main.tease:62-72 N3 writer main.tease:11-24 ["if rows[1][0] != null","otherwise"] ×1',
        "extra check null-check rows.element.element [integer] main.tease:62-72 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/review-late/copies/back-edge",
    {
      reason: CORRIDOR_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:70-75 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:70-75 ×1",
        'missing required check integer-use main.tease:70-75 N3 writer main.tease:55-61 ["if saved != null","otherwise"] ×1',
        "extra check null-check saved [integer] main.tease:70-75 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/review-late/copies/entered-label",
    {
      reason: CORRIDOR_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:128-133 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:128-133 ×1",
        'missing required check integer-use main.tease:128-133 N3 writer main.tease:114-120 ["if saved != null","otherwise"] ×1',
        "extra check null-check saved [integer] main.tease:128-133 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/review-late/copies/refuse-argument",
    {
      reason: CORRIDOR_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:81-82 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:81-82 ×1",
        'missing required check integer-use main.tease:81-82 N3 writer main.tease:92-98 ["if n != null","otherwise"] ×1',
        "extra check null-check use.n [integer] main.tease:81-82 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/review-late/copies/refuse-whole-collection",
    {
      reason: CORRIDOR_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:48-55 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:48-55 ×1",
        'missing required check integer-use main.tease:48-55 N3 writer main.tease:34-40 ["if copy[0] != null","otherwise"] ×1',
        "extra check null-check copy.element [integer] main.tease:48-55 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/switch/deferred-null-1",
    {
      reason: CORRIDOR_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:117-118 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:117-118 ×1",
        'missing required check integer-use main.tease:117-118 N3 writer main.tease:77-81 ["if n != null","otherwise"] ×1',
        "extra check null-check n [integer] main.tease:117-118 ×1",
      ],
    },
  ],
  [
    "cp9-cells/r42/load-written-optional",
    {
      reason: N1173_REASON,
      differences: [
        "missing diagnostic integer-use warning-runtime-check main.tease:58-64 ×1",
        'missing required check integer-use main.tease:58-64 N3 writer main.tease:22-50 ["if loaded != null","otherwise"] ×1',
        "missing check integer-check loaded [integer] main.tease:58-64 ×1",
      ],
    },
  ],
  [
    "cp9-cells/r46/m3/astra-m3/routes/method-null-kind",
    {
      reason: RECEIVER_REASON,
      differences: [
        "missing diagnostic member-read compile-error main.tease:90-103 ×2",
        "extra diagnostic member-read warning-runtime-check main.tease:90-103 ×2",
        'missing required check member-read main.tease:90-103 N3 writer main.tease:87-88 ["use a receiver supporting value.clear()"] ×1',
        'missing required check member-read main.tease:90-103 N3 writer main.tease:63-67 ["use a receiver supporting value.clear()"] ×1',
        "extra check null-check value [non-null] main.tease:90-103 ×2",
      ],
    },
  ],
  [
    "cp9-cells/r46/m3/null-snapshot-alias-control",
    {
      reason: CORRIDOR_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:215-236 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:215-236 ×1",
        'missing required check integer-use main.tease:215-236 N3 writer main.tease:148-207 ["if shelf.last.item.count != null","otherwise"] ×1',
        "extra check null-check shelf.element.item.count [integer] main.tease:215-236 ×1",
      ],
    },
  ],
  [
    "cp9-cells/r46/m3/null-snapshot-same-key",
    {
      reason: CORRIDOR_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:214-235 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:214-235 ×1",
        'missing required check integer-use main.tease:214-235 N3 writer main.tease:148-206 ["if shelf.last.item.count != null","otherwise"] ×1',
        "extra check null-check shelf.element.item.count [integer] main.tease:214-235 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/review-late/fallback/literal-nonnull",
    { reason: TSV062_REASON, differences: ["extra diagnostic static warning main.tease:14-28 ×1"] },
  ],
  [
    "cp9-cells/3b/review-late/fallback/nested-dead",
    { reason: TSV062_REASON, differences: ["extra diagnostic static warning main.tease:15-29 ×1"] },
  ],
  [
    "cp9-cells/3b/review-late/fallback/nested-unsupported",
    {
      reason: TSV062_REASON,
      differences: ["extra diagnostic static warning main.tease:110-124 ×1"],
    },
  ],
  [
    "cp9-cells/3b/review-late/fallback/non-null-first-fallback",
    {
      reason: TSV062_REASON,
      differences: ["extra diagnostic static warning main.tease:96-110 ×1"],
    },
  ],
  [
    "cp9-cells/3b/review-late/r7/sol-dead-null-fallback",
    { reason: TSV062_REASON, differences: ["extra diagnostic static warning main.tease:62-76 ×1"] },
  ],
  [
    "cp9-cells/3b/review-late/r7/sol-dead-union-fallback",
    { reason: TSV062_REASON, differences: ["extra diagnostic static warning main.tease:80-98 ×1"] },
  ],
  [
    "cp9-cells/r46/m3/astra-m3/guard-fallback",
    {
      reason: TSV062_REASON,
      differences: [
        "outcome valid, got warning",
        "extra diagnostic static warning main.tease:46-57 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/review-early/s2-same-location-compound-loop",
    {
      reason: U4_REASON,
      differences: [
        "outcome valid, got warning-runtime-check",
        "extra diagnostic operator warning-runtime-check main.tease:59-64 ×1",
        "extra check null-check xs.element [integer|number] main.tease:59-64 ×1",
      ],
    },
  ],
  [
    "cp9-cells/r42/guard/holding-path",
    {
      reason: U4_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:43-48 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:43-48 ×1",
        "extra check integer-check box.n [integer] main.tease:43-48 ×1",
      ],
    },
  ],
  [
    "cp9-cells/r46/guard/branch-holding-path/guarded",
    {
      reason: U4_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic written-target compile-error main.tease:108-113 ×1",
        "extra diagnostic written-target warning-runtime-check main.tease:108-113 ×1",
        "extra check copy-type whole [integer] main.tease:108-113 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/invalidation/clear/changed",
    {
      reason: OUTLIER_REASON,
      differences: [
        "outcome warning-runtime-check, got valid",
        "missing diagnostic integer-use warning-runtime-check main.tease:57-62 ×1",
        "missing context integer-use warning-runtime-check main.tease:57-62 member ×1",
        "missing check null-check xs.element [integer] main.tease:57-62 ×1",
      ],
    },
  ],
  [
    "cp9-cells/3b/invalidation/sort/changed",
    {
      reason: OUTLIER_REASON,
      differences: [
        "extra diagnostic member-read warning-runtime-check main.tease:38-47 ×1",
        "extra check operand xs.element [integer|number|string|duration|calendarDuration|angle|date|time|datetime|absoluteDateTime] main.tease:38-47 ×1",
      ],
    },
  ],
  [
    "cp9-cells/r46/guard/arithmetic-unary/guarded",
    {
      reason: OUTLIER_REASON,
      differences: [
        "outcome valid, got compile-error",
        "extra diagnostic static compile-error main.tease:68-73 ×1",
      ],
    },
  ],
  [
    "cp9-cells/r49/sharing/record-aliases/guarded",
    {
      reason: CROSS_REASON,
      differences: [
        "outcome compile-error, got warning-runtime-check",
        "missing diagnostic integer-use compile-error main.tease:165-186 ×1",
        "missing diagnostic integer-use compile-error main.tease:197-218 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:165-186 ×1",
        "extra diagnostic integer-use warning-runtime-check main.tease:197-218 ×1",
        "extra check integer-check archive.element.data.v0 [integer] main.tease:165-186 ×1",
        "extra check integer-check archive.element.data.v1 [integer] main.tease:197-218 ×1",
      ],
    },
  ],
]);

/**
 * Why a record is held back from the positive list, named by its cell or by its name, or `null` for an asserted record:
 * the tests that assert the set (the cells test's records, the candidate route's plans) hold back the same records.
 */
export function heldBack(record: FixtureRecord): string | null {
  // Its right-hand datetime has no subtraction row: §3.4 sites that operand, not the whole pair. Keep the set
  // unchanged until its maintainer corrects this start as well as its end.
  if (record.name === "cp9-cells/F16/invalid-datetime-difference")
    return "operator site awaiting set correction (TABLE §3.4, r4.62)";
  // S9b's F18 shapes: a copy of a written type as `fromJson`'s and `load`'s receiving context, which
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
  return HELD_S10_RECORDS.get(record.name)?.reason ?? null;
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
