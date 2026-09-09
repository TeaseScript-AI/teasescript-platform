import assert from "node:assert/strict";
import test from "node:test";

import {
  compileSource,
  completeAction,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  isMessageMarkup,
  parseMessageMarkup,
  run,
  serializeCheckpoint,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/index.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";

test("runs escapeMarkup through the protected Platform Standard Library prelude", () => {
  const compiled = compileSource(
    [
      'let dynamic = "**Mistress**"',
      'say "**Warning:** ${escapeMarkup(dynamic)}, no touching.", instant',
    ].join("\n"),
  );
  assert.deepEqual(compiled.diagnostics, []);
  assert.notEqual(compiled.plan, null);
  const result = run(compiled.plan!, createFreshRuntimeSnapshot(compiled.plan!));
  const output = result.events.find((event) => event.kind === "say");
  assert.equal(output?.kind, "say");
  if (output?.kind !== "say") throw new Error("Expected authored say output.");
  assert.equal(output.text, "Warning: **Mistress**, no touching.");
  assert.equal(output.content.visibleText, output.text);
  assert.deepEqual(
    output.content.blocks[0]?.kind === "paragraph" ? output.content.blocks[0].lines[0]?.spans : [],
    [{ kind: "bold", start: 0, end: 8, depth: 0 }],
  );

  const protectedName = compileSource('let escapeMarkup = "shadow"');
  assert.ok(protectedName.semanticDiagnostics.some((diagnostic) => diagnostic.code === "TSV001"));
  const wrongType = compileValidPlan("say escapeMarkup(1), instant");
  const failed = run(wrongType, createFreshRuntimeSnapshot(wrongType));
  assert.equal(failed.snapshot.status, "failed");
  assert.ok(failed.events.some((event) => event.kind === "runtimeFailure"));
});

test("paces, prepares, checkpoints, and emits one parsed authored message", () => {
  const compiled = compileValidPlan('say "first"\nsay "[spoiler]**second**[/spoiler]"');
  const promoted = run(compiled, createFreshRuntimeSnapshot(compiled));
  const gate = promoted.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  if (gate?.kind !== "chatPacingGate" || gate.preparedOutput === null)
    throw new Error("Expected promoted prepared say output.");
  assert.equal(gate.preparedOutput.text, "second");
  assert.equal(gate.preparedOutput.content.visibleText, "second");
  assert.deepEqual(
    gate.preparedOutput.content.blocks[0]?.kind === "paragraph"
      ? gate.preparedOutput.content.blocks[0].lines[0]?.spans.map((span) => span.kind)
      : [],
    ["spoiler", "bold"],
  );

  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, promoted.snapshot)),
  );
  assert.deepEqual(restored.snapshot.foregroundAction, gate);
  const released = completeAction(restored.plan, restored.snapshot, {
    actionId: gate.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const resumed = run(restored.plan, released.snapshot);
  const output = resumed.events.find((event) => event.kind === "say");
  assert.equal(output?.kind, "say");
  if (output?.kind !== "say") throw new Error("Expected resumed say output.");
  assert.deepEqual(output.content, gate.preparedOutput.content);
  assert.equal(output.text, gate.preparedOutput.text);

  const pacingPlan = compileValidPlan('say "[color=#ff3344]x[/color]"');
  const paced = run(pacingPlan, createFreshRuntimeSnapshot(pacingPlan));
  assert.equal(paced.snapshot.backgroundActions[0]?.kind, "chatPacingGate");
  assert.equal(paced.snapshot.backgroundActions[0]?.deadlineMs, 1_800);
});

test("restores a promoted block-string fragment without repeating evaluation or selection", () => {
  const compiled = compileValidPlan(
    [
      "let evaluations = 0",
      "function fragment {",
      "  evaluations = evaluations + 1",
      '  return ["**Alpha**", "**Beta**"]',
      "}",
      'say "first"',
      'say """',
      "  # Selected",
      "  ${fragment()}",
      '"""',
      'say "evaluations=${evaluations}", instant',
      "exit",
    ].join("\n"),
  );
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled, { seed: 0x2468_ace1 }));
  const gate = waiting.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  if (gate?.kind !== "chatPacingGate" || gate.preparedOutput === null)
    throw new Error("Expected promoted block-string output.");
  assert.match(gate.preparedOutput.text, /^Selected\n(?:Alpha|Beta)$/u);
  assert.deepEqual(
    gate.preparedOutput.content.blocks.map((block) => block.kind),
    ["heading", "paragraph"],
  );
  assert.deepEqual(
    gate.preparedOutput.content.blocks[1]?.kind === "paragraph"
      ? gate.preparedOutput.content.blocks[1].lines[0]?.spans.map((span) => span.kind)
      : [],
    ["bold"],
  );
  const preparedRngState = waiting.snapshot.rng.state;

  const uninterruptedRelease = completeAction(compiled, waiting.snapshot, {
    actionId: gate.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const uninterrupted = run(compiled, uninterruptedRelease.snapshot);

  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, waiting.snapshot)),
  );
  const restoredGate = restored.snapshot.foregroundAction;
  assert.deepEqual(restoredGate, gate);
  if (restoredGate?.kind !== "chatPacingGate") throw new Error("Expected restored pacing gate.");
  const restoredRelease = completeAction(restored.plan, restored.snapshot, {
    actionId: restoredGate.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const resumed = run(restored.plan, restoredRelease.snapshot);

  assert.deepEqual(
    [...restoredRelease.events, ...resumed.events],
    [...uninterruptedRelease.events, ...uninterrupted.events],
  );
  assert.deepEqual(resumed.snapshot, uninterrupted.snapshot);
  const sayEvents = resumed.events.filter((event) => event.kind === "say");
  assert.deepEqual(
    sayEvents.map((event) => event.text),
    [gate.preparedOutput.text, "evaluations=1"],
  );
  assert.deepEqual(sayEvents[0]?.content, gate.preparedOutput.content);
  assert.equal(resumed.snapshot.rng.state, preparedRngState);
});

test("preserves message markup through every instruction checkpoint boundary", () => {
  const result = assertRuntimeResumeEquivalent(
    [
      'let literal = "[spoiler]dynamic[/spoiler]"',
      'say "# Heading\\nReusable **format** and ${escapeMarkup(literal)}"',
      "exit",
    ].join("\n"),
    { scenarioName: "message markup checkpoint equivalence" },
  );
  const output = result.events.find((event) => event.kind === "say");
  assert.equal(output?.kind, "say");
  if (output?.kind === "say") {
    assert.equal(output.text, "Heading\nReusable format and [spoiler]dynamic[/spoiler]");
    assert.equal(isMessageMarkup(output.content), true);
  }
});

test("validates and restores wide parser-produced prepared markup iteratively", () => {
  const compiled = compileValidPlan('say "first"\nsay "second"');
  const promoted = run(compiled, createFreshRuntimeSnapshot(compiled));
  // EVIDENCE: structuredClone preserves the runtime snapshot shape while producing the mutable test fixture.
  const snapshot = structuredClone(promoted.snapshot) as RuntimeSnapshot;
  assert.equal(snapshot.foregroundAction?.kind, "chatPacingGate");
  if (
    snapshot.foregroundAction?.kind !== "chatPacingGate" ||
    snapshot.foregroundAction.preparedOutput === null
  )
    throw new Error("Expected prepared say output.");
  const content = parseMessageMarkup(`${"line\n".repeat(20_000)}end`);
  // EVIDENCE: the fixture starts from runtime-produced pacing state and replaces only the canonical prepared message pair.
  const preparedOutput = snapshot.foregroundAction.preparedOutput as {
    content: typeof content;
    text: string;
  };
  preparedOutput.content = content;
  preparedOutput.text = content.visibleText;
  assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true);
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, snapshot)));
  assert.deepEqual(restored.snapshot.foregroundAction, snapshot.foregroundAction);

  // EVIDENCE: structuredClone preserves the validated snapshot shape before one field is deliberately corrupted.
  const malformed = structuredClone(snapshot) as RuntimeSnapshot;
  if (
    malformed.foregroundAction?.kind !== "chatPacingGate" ||
    malformed.foregroundAction.preparedOutput === null
  )
    throw new Error("Expected cloned prepared say output.");
  // EVIDENCE: the guards above establish a non-null prepared output whose text field is the corruption target.
  (malformed.foregroundAction.preparedOutput as { text: string }).text = "mismatch";
  assert.equal(validateRuntimeSnapshot(malformed, compiled).valid, false);
  assert.throws(() => createCheckpoint(compiled, malformed));
});
