import assert from "node:assert/strict";
import test from "node:test";

import type { SerializableRuntimeValue } from "../src/runtime/serializable-values.js";
import type { RuntimeSnapshot } from "../src/runtime/state.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";

test("resume equivalence preserves list warnings and collection state", () => {
  const source = [
    "let values = [1]",
    "values.remove(2)",
    "values.remove(2)",
    'say "after"',
    "exit",
  ].join("\n");
  const result = assertRuntimeResumeEquivalent(source, {
    scenarioName: "list.remove warning corpus",
  });
  const warnings = result.events.filter(
    (event) => event.kind === "developerWarning",
  );

  assert.deepEqual(
    warnings.map((event) => [event.sequence, event.code]),
    [
      [1, "TSW002"],
      [2, "TSW002"],
    ],
  );
  assert.deepEqual(result.events.map((event) => event.sequence), [1, 2, 3, 4]);
  assert.equal(result.finalSnapshot.nextEventSequence, 5);
  assert.deepEqual(rootValue(result.finalSnapshot, "values"), {
    kind: "list",
    items: [1],
  });
});

test("resume equivalence preserves structured control flow and lexical scope", () => {
  const result = assertRuntimeResumeEquivalent([
    "let total = 0",
    "for value in 1..=4 {",
    "  if value == 2 { continue }",
    "  if value == 4 { break }",
    "  if true {",
    "    let scoped = value * 10",
    "    total = total + scoped",
    "  }",
    "}",
    "say total",
    "exit",
  ].join("\n"), {
    scenarioName: "structured control-flow corpus",
  });

  assert.ok(result.boundaries.some((snapshot) => snapshot.loopFrames.length > 0));
  assert.ok(result.boundaries.some((snapshot) => snapshot.frames.length > 1));
  assert.deepEqual(
    result.events
      .filter((event) => event.kind === "say")
      .map((event) => event.text),
    ["40"],
  );
});

test("resume equivalence preserves deterministic random advancement", () => {
  const result = assertRuntimeResumeEquivalent([
    'let values = ["a", "b", "c", "d"]',
    "say values.random",
    "say random()",
    "say randomInteger(1..=6)",
    "say chance(50)",
    "exit",
  ].join("\n"), {
    scenarioName: "deterministic random corpus",
    seed: 0x2468_ace1,
  });

  assert.equal(
    result.events.filter((event) => event.kind === "say").length,
    4,
  );
  assert.ok(
    new Set(result.boundaries.map((snapshot) => snapshot.rng.state)).size > 1,
  );
  assert.notEqual(result.finalSnapshot.rng.state, 0);
});

function rootValue(
  snapshot: RuntimeSnapshot,
  name: string,
): SerializableRuntimeValue {
  const binding = snapshot.frames[0]?.bindings.find((item) => item.name === name);
  assert.ok(binding !== undefined);
  return binding.value;
}
