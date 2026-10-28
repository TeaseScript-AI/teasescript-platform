import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { readFixture } from "./helpers/type-core-fixture.js";
import {
  readCompactRecord,
  recordDifferences,
  type CompactDiagnostic,
  type CompactRecord,
} from "./helpers/type-core-records.js";

/*
 * N10's payloads in the compact records (TABLE N10, §10.5): the fixture's `requiredCheck` is read whole and compared as
 * the lead's comparator compares it, so a record whose writer, rule or missing tests differ fails.
 */

const records = readFixture();

test("the fixture's records carry every N10 payload of its lines", () => {
  const text = readFileSync(
    new URL("../../tests/fixtures/type-core/cells.jsonl", import.meta.url),
    "utf8",
  );
  const written = text.match(/"requiredCheck":\s*\{/gu)?.length ?? 0;
  const read = records.flatMap((record) =>
    record.expected.diagnostics.filter((diagnostic) => diagnostic.requiredCheck !== undefined),
  );
  assert.ok(written > 0);
  assert.equal(read.length, written);
});

test("a changed writer, rule or missing test, or a payload on one side alone, differs (N10)", () => {
  const expected = records.find(
    (record) => record.name === "cp9-cells/F17b/present-null",
  )?.expected;
  assert.ok(expected !== undefined);
  const index = expected.diagnostics.findIndex((entry) => entry.requiredCheck !== undefined);
  const payload = expected.diagnostics[index]?.requiredCheck;
  assert.deepEqual(payload, {
    rule: "N3",
    writer: { file: "main.tease", offset: 27, end: 48 },
    missingTests: ["if n != null", "otherwise"],
  });
  /** `expected` with its payload's diagnostic replaced by `change` of it. */
  const changed = (change: (entry: CompactDiagnostic) => CompactDiagnostic): CompactRecord => ({
    ...expected,
    diagnostics: expected.diagnostics.map((entry, at) => (at === index ? change(entry) : entry)),
  });
  const paid = (requiredCheck: NonNullable<CompactDiagnostic["requiredCheck"]>) =>
    changed((entry) => ({ ...entry, requiredCheck }));
  /** The differences of `actual` from `wanted`, each by its first three words. */
  const differs = (wanted: CompactRecord, actual: CompactRecord): string[] =>
    recordDifferences(wanted, actual).map((entry) => entry.split(" ").slice(0, 3).join(" "));
  const both = ["missing required check", "extra required check"];

  assert.deepEqual(recordDifferences(expected, expected), []);
  for (const [offset, end] of [
    [28, 48],
    [27, 47],
  ] as const)
    assert.deepEqual(
      differs(expected, paid({ ...payload, writer: { ...payload.writer, offset, end } })),
      both,
    );
  assert.deepEqual(differs(expected, paid({ ...payload, rule: "N2" })), both);
  for (const missingTests of [["if n != null"], ["otherwise", "if n != null"], ["if n is integer"]])
    assert.deepEqual(differs(expected, paid({ ...payload, missingTests })), both);
  const without = changed(({ requiredCheck: _, ...entry }) => entry);
  assert.deepEqual(differs(expected, without), ["missing required check"]);
  assert.deepEqual(differs(without, expected), ["extra required check"]);
  // a context the set leaves unasserted stays unasserted beside a payload
  assert.equal(expected.diagnostics[index]?.context, null);
  assert.deepEqual(
    recordDifferences(
      expected,
      changed((entry) => ({ ...entry, context: "branch" })),
    ),
    [],
  );
});

test("a malformed N10 payload fails where it is", () => {
  const line = (requiredCheck: unknown) => ({
    outcome: "compile-error",
    diagnostics: [
      {
        kind: "integer-use",
        class: "compile-error",
        site: { file: "main.tease", offset: 56, end: 57 },
        context: null,
        requiredCheck,
      },
    ],
    checks: [],
  });
  const writer = { file: "main.tease", offset: 27, end: 48 };
  assert.equal(readCompactRecord(line(null)).diagnostics[0]?.requiredCheck, undefined);
  for (const [payload, where] of [
    [{ rule: "N3", writer: { ...writer, end: 26 }, missingTests: ["otherwise"] }, /writer\.end/u],
    [{ rule: "N3", writer, missingTests: [] }, /missingTests: at least one/u],
    [{ rule: "N3", writer, missingTests: "otherwise" }, /missingTests: a list/u],
    [{ writer, missingTests: ["otherwise"] }, /requiredCheck\.rule/u],
  ] as const)
    assert.throws(() => readCompactRecord(line(payload)), where);
});
