import assert from "node:assert/strict";
import test from "node:test";

import {
  compileSource,
  createCheckpoint,
  deserializeCheckpoint,
  observeTime,
  run,
  serializeCheckpoint,
  type SerializableRuntimeValue,
} from "../src/index.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

test("reports parser and semantic source diagnostics through the package root", () => {
  const parserFailure = compileSource("let = 1");
  assert.equal(parserFailure.plan, null);
  assert.equal(parserFailure.parserDiagnostics[0]?.code, "TSP013");
  assert.deepEqual(
    [
      parserFailure.parserDiagnostics[0]?.span.start.offset,
      parserFailure.parserDiagnostics[0]?.span.end.offset,
    ],
    [4, 4],
  );

  const semanticFailure = compileSource("say unknownName");
  assert.equal(semanticFailure.plan, null);
  assert.equal(semanticFailure.semanticDiagnostics[0]?.code, "TSV002");
  assert.deepEqual(
    [
      semanticFailure.semanticDiagnostics[0]?.span.start.offset,
      semanticFailure.semanticDiagnostics[0]?.span.end.offset,
    ],
    [4, 15],
  );
});

test("propagates unexpected parser exceptions through the public compiler boundary", () => {
  const error = new Error("unexpected parser failure");
  const original = RegExp.prototype.test;
  RegExp.prototype.test = () => {
    throw error;
  };
  try {
    assert.throws(
      () => compileSource("let value = 1"),
      (received: unknown) => received === error,
    );
  } finally {
    RegExp.prototype.test = original;
  }
});

test("executes source output, speaker provenance, collection copies, and control flow", () => {
  const plan = compiled([
    "speaker vera {}",
    "speaker vera",
    "let source = [1, 2]",
    "let copy = source",
    "copy[0] = 9",
    "let values = set[\"first\", \"second\", \"first\"]",
    "let total = 0",
    "for value in 1..=3 { if value == 2 { continue }\ntotal = total + value }",
    "say `Total ${total}: ${values.first}`",
    "say source[0]",
    "say as vera \"Override\"",
  ].join("\n"));

  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { seed: 7 }));
  assert.equal(result.snapshot.status, "halted");
  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => [
      event.text,
      event.speaker?.identifier,
      event.speaker?.displayName,
    ]),
    [
      ["Total 4: first", "vera", "vera"],
      ["1", "vera", "vera"],
      ["Override", "vera", "vera"],
    ],
  );
  assert.deepEqual(
    result.events.filter((event) => event.kind === "developerWarning").map((event) => event.code),
    ["TSW001"],
  );
  assert.equal(rootBinding(result.snapshot.frames[0]?.bindings ?? [], "total"), 4);
});

test("preserves function evaluation, deterministic random output, and checkpoint resume equivalence", () => {
  const result = assertRuntimeResumeEquivalent([
    "let order = []",
    "function mark(value) { order.add(value)\nreturn value }",
    "function add(left, right = left) { return left + right }",
    "say add(mark(2))",
    "say `${order[0]}:${randomInteger(1..=6)}`",
  ].join("\n"), {
    scenarioName: "public source conformance function and RNG scenario",
    seed: 0x2468_ace1,
  });

  assert.deepEqual(
    result.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["4", "2:1"],
  );
  assert.notEqual(result.finalSnapshot.rng.state, 0);
});

test("resumes a blocking wait through public checkpoint and time APIs", () => {
  const plan = compiled('wait 1 ms\nsay "done"\nexit');
  const pending = run(plan, createImmediatePacingRuntimeSnapshot(plan));
  assert.equal(pending.snapshot.status, "waiting");
  assert.deepEqual(pending.events.map((event) => event.kind), ["actionRequested"]);

  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(plan, pending.snapshot)));
  const uninterruptedSettled = observeTime(plan, pending.snapshot, 1);
  const restoredSettled = observeTime(restored.plan, restored.snapshot, 1);
  const uninterrupted = run(plan, uninterruptedSettled.snapshot);
  const resumed = run(restored.plan, restoredSettled.snapshot);

  assert.deepEqual(
    [...pending.events, ...uninterruptedSettled.events, ...uninterrupted.events],
    [...pending.events, ...restoredSettled.events, ...resumed.events],
  );
  assert.deepEqual(resumed.snapshot, uninterrupted.snapshot);
  assert.deepEqual(resumed.events.map((event) => event.kind), ["say", "exit"]);
});

function compiled(source: string) {
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}

function rootBinding(
  bindings: readonly { readonly name: string; readonly value: SerializableRuntimeValue }[],
  name: string,
): SerializableRuntimeValue | undefined {
  return bindings.find((binding) => binding.name === name)?.value;
}
