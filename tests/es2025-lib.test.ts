import assert from "node:assert/strict";
import test from "node:test";

// The code targets ES2025 (docs/DEVELOPMENT-WORKFLOW.md "Verification"): each ES2025 library member below type-checks
// only under that `lib`, and this checks that the Node CI runs implements it too.
test("the ES2025 members the type check admits exist at runtime", () => {
  assert.deepEqual([...new Set([1, 2]).union(new Set([2, 3]))], [1, 2, 3]);
  assert.equal(new Float16Array([1.5])[0], 1.5);
  assert.deepEqual(
    Iterator.from([1, 2])
      .map((value) => value * 2)
      .toArray(),
    [2, 4],
  );
  assert.equal(RegExp.escape("a.b"), "\\x61\\.b");
  return Promise.try(() => 1).then((value) => assert.equal(value, 1));
});
