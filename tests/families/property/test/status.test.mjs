import test from "node:test";
import assert from "node:assert/strict";
import { summarize, exitCode, STATUSES } from "../lib/status.mjs";
import { compare } from "../lib/compare.mjs";
for (const status of STATUSES)
  test(`status ${status} is not accidentally green`, () => {
    const result = summarize([{ status, executions: 0, assertions: 0 }]);
    assert.equal(result.verdict === "PASS", status === "PASS");
    assert.equal(exitCode(result) === 0, status === "PASS");
  });
test("zero rows are incomplete", () =>
  assert.equal(summarize([]).verdict, "INCOMPLETE"));
test("identical exceptions are not evidence of agreement", () => {
  const rows = [{ id: "a", status: "ERROR", reason: "same TypeError" }];
  const r = compare(rows, rows);
  assert.equal(r.fixed.length, 0);
  assert.equal(r.unchangedCount, 0);
  assert.equal(r.incomparableCount, 1);
  assert.equal(r.head.verdict, "ERROR");
});
test("comparison identifies fixed and new failures", () => {
  const r = compare(
    [
      { id: "a", status: "FAIL" },
      { id: "b", status: "PASS" },
    ],
    [
      { id: "a", status: "PASS" },
      { id: "b", status: "FAIL" },
    ],
  );
  assert.deepEqual(r.fixed, ["a"]);
  assert.deepEqual(r.regressed, ["b"]);
});
test("missing and duplicate records are errors", () => {
  assert.throws(() => summarize([{ status: "PASS" }], 2));
  assert.throws(() => compare([{ id: "x", status: "PASS" }], []));
  assert.throws(() => compare([{ id: "x" }, { id: "x" }], []));
});

test("same row ID with different source or oracle inputs is never compared", () => {
  assert.throws(
    () =>
      compare(
        [{ id: "a", sourceHash: "x", status: "PASS" }],
        [{ id: "a", sourceHash: "y", status: "PASS" }],
      ),
    /collision/,
  );
  assert.throws(
    () =>
      compare(
        [
          {
            id: "a",
            status: "PASS",
            outcomes: [{ inputHash: "x", allowed: true }],
          },
        ],
        [
          {
            id: "a",
            status: "PASS",
            outcomes: [{ inputHash: "y", allowed: true }],
          },
        ],
      ),
    /expectations/,
  );
});
