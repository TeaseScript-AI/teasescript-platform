import assert from "node:assert/strict";
import test from "node:test";

import { compileWorkspaceSource, decodeWorkspaceSourceBytes, executeWorkspaceSource } from "../playground/workspace/controller.js";

test("workspace helper compiles, halts, and returns JSON-safe data", () => {
  const compiled = compileWorkspaceSource('say "Hello"');
  assert.ok(compiled.plan);
  const result = executeWorkspaceSource('say "Hello"');
  assert.equal(result.status, "halted");
  assert.deepEqual(result.events.map((event) => event.kind), ["say", "complete"]);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("workspace helper reports parser and semantic diagnostics", () => {
  assert.equal(compileWorkspaceSource("let =").plan, null);
  assert.equal(compileWorkspaceSource("missing = 1").plan, null);
});

test("workspace helper stops blocking waits in waiting with action events", () => {
  const result = executeWorkspaceSource("wait 1");
  assert.equal(result.status, "waiting");
  assert.deepEqual(result.events.map((event) => event.kind), ["actionRequested"]);
});

test("workspace helper is deterministic and returns runtime failures and budgets", () => {
  const source = 'say random(1, 10)';
  assert.deepEqual(executeWorkspaceSource(source), executeWorkspaceSource(source));
  assert.equal(executeWorkspaceSource("while true {} ").status, "failed");
});

test("workspace import decoding rejects malformed UTF-8", () => {
  assert.throws(
    () => decodeWorkspaceSourceBytes(new Uint8Array([0xc3, 0x28]).buffer),
    TypeError,
  );
});
