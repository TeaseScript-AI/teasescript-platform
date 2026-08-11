import assert from "node:assert/strict";
import test from "node:test";

import { compileWorkspaceSource, decodeWorkspaceSourceBytes, executeWorkspaceSource } from "../playground/workspace/controller.js";
import { withValidationTestStatistics } from "../src/validation-testing.js";

test("workspace helper exposes production say pacing and returns JSON-safe data", () => {
  const compiled = compileWorkspaceSource('say "Hello"');
  assert.ok(compiled.plan);
  const result = executeWorkspaceSource('say "Hello"');
  assert.equal(result.status, "halted");
  assert.deepEqual(result.events.map((event) => event.kind), ["say", "actionRequested", "complete"]);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test("workspace helper reports parser and semantic diagnostics", () => {
  assert.equal(compileWorkspaceSource("let =").plan, null);
  assert.equal(compileWorkspaceSource("missing = 1").plan, null);
});

test("workspace compilation reuses the compiler-validated plan", () => {
  const statistics = withValidationTestStatistics((finish) => {
    assert.ok(compileWorkspaceSource(Array.from({ length: 100 }, () => 'say "Hello"').join("\n")).plan);
    return finish();
  }).counts;

  assert.equal(statistics.externalCaptureVisits, 1, "only the empty fresh-runtime options object is captured");
});

test("workspace helper stops blocking waits in waiting with action events", () => {
  const result = executeWorkspaceSource("wait 1");
  assert.equal(result.status, "waiting");
  assert.deepEqual(result.events.map((event) => event.kind), ["actionRequested"]);
});

test("workspace helper accepts source beyond the former local byte limit", () => {
  const source = `${"// padding\n".repeat(10_000)}say "large source"`;

  const result = compileWorkspaceSource(source);

  assert.ok(result.plan);
  assert.equal(result.status, "ready");
});

test("workspace helper is deterministic and returns runtime instruction-budget failures", () => {
  const source = 'say random(1, 10)';
  assert.deepEqual(executeWorkspaceSource(source), executeWorkspaceSource(source));
  const result = executeWorkspaceSource("while true {} ");
  assert.equal(result.status, "failed");
  assert.ok(result.events.some((event) => event.kind === "runtimeFailure" && event.code === "TSR037"));
});

test("workspace import decoding accepts large UTF-8 source and rejects malformed UTF-8", () => {
  const source = `say "${"🙂".repeat(20_000)}"`;
  assert.equal(decodeWorkspaceSourceBytes(new TextEncoder().encode(source).buffer), source);
  assert.throws(
    () => decodeWorkspaceSourceBytes(new Uint8Array([0xc3, 0x28]).buffer),
    TypeError,
  );
});
