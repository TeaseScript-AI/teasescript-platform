import assert from "node:assert/strict";
import test from "node:test";

import { parse } from "../src/parser.js";

test("deep malformed nesting retains structured parser diagnostics", () => {
  const source = `${"(".repeat(96)}1`;
  const first = parse(source);
  const second = parse(source);
  assert.deepEqual(first.diagnostics, second.diagnostics);
  assert.ok(first.diagnostics.length > 0);
});
