import assert from "node:assert/strict";
import test from "node:test";

import { captureExternalData } from "../src/external-data-capture.js";
import { captureInstructionPlan } from "../src/plan/capture.js";
import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  CHECKPOINT_FORMAT,
  CHECKPOINT_VERSION,
  CheckpointError,
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { executeInstruction, run, stepToEvent } from "../src/runtime/engine.js";
import type { InterpreterEvent } from "../src/runtime/events.js";
import type {
  SerializableRuntimeObject,
  SerializableRuntimeSet,
  SerializableRuntimeValue,
} from "../src/runtime/serializable-values.js";
import {
  createFreshRuntimeSnapshot,
  captureRuntimeSnapshotWithValidatedPlan,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { sayTexts } from "./helpers/runtime-events.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";

test("runtime snapshots survive JSON stringify and parse validation", () => {
  const compiled = plan("let values = set[3, 1, 2]\nexit");
  const execution = executeInstruction(compiled, createFreshRuntimeSnapshot(compiled));
  const parsed: unknown = JSON.parse(JSON.stringify(execution.snapshot));

  assert.deepEqual(parsed, execution.snapshot);
  assert.equal(validateRuntimeSnapshot(parsed, compiled).valid, true);
});

test("restores a self-contained checkpoint from serialized JSON", () => {
  const compiled = plan('let score = 1\nsay "${score}"\nexit');
  const first = executeInstruction(compiled, createImmediatePacingRuntimeSnapshot(compiled));
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, first.snapshot)),
  );
  assert.deepEqual(restored.plan, compiled);
  assert.deepEqual(restored.snapshot, first.snapshot);
  const completed = run(restored.plan, restored.snapshot);

  assert.equal(completed.snapshot.status, "halted");
  // The resumed say reads the score declared before the checkpoint.
  assert.deepEqual(sayTexts(completed), ["1"]);
  assert.deepEqual(
    completed.events.map((event) => event.sequence),
    [1, 2],
  );
});

test("checkpoint accepts a large valid plan and snapshot without a shared work rejection", () => {
  const compiled = plan(
    Array.from({ length: 3_000 }, (_value, index) => `say "${index}"`).join("\n"),
  );
  const snapshot = createFreshRuntimeSnapshot(compiled);
  snapshot.frames[0]!.bindings.push(
    ...Array.from({ length: 20_000 }, (_value, index) => ({ name: `value${index}`, value: index })),
  );

  assert.equal(captureExternalData(compiled).ok, true);
  assert.equal(captureExternalData(snapshot).ok, true);
  assert.equal(
    captureExternalData({
      format: CHECKPOINT_FORMAT,
      version: CHECKPOINT_VERSION,
      plan: compiled,
      snapshot,
    }).ok,
    true,
  );

  const created = createCheckpoint(compiled, snapshot);
  const serialized = serializeCheckpoint(created);
  const restored = restoreCheckpoint(created);
  const deserialized = deserializeCheckpoint(serialized);

  assert.deepEqual(restored, created);
  assert.deepEqual(deserialized, created);
});

test("checkpoint envelope rejects malformed metadata without invoking accessors", () => {
  const compiled = plan("exit");
  // EVIDENCE: serialization created the canonical envelope; this typed view permits metadata corruption below.
  const checkpoint = JSON.parse(
    serializeCheckpoint(createCheckpoint(compiled, createFreshRuntimeSnapshot(compiled))),
  ) as Record<string, unknown>;

  assertCheckpointError({ ...checkpoint, extra: true }, { code: "TSK002", path: "$." });
  const missing = { ...checkpoint };
  delete missing.plan;
  assertCheckpointError(missing, { code: "TSK002", path: "$." });

  let accessorReads = 0;
  const accessor = { ...checkpoint };
  Object.defineProperty(accessor, "plan", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return checkpoint.plan;
    },
  });
  assertCheckpointCode(accessor, "TSK002");
  assert.equal(accessorReads, 0);

  assertCheckpointCode(Object.setPrototypeOf({ ...checkpoint }, {}), "TSK002");
  assertCheckpointCode(
    new Proxy(checkpoint, {
      ownKeys() {
        throw new Error("hostile ownKeys");
      },
    }),
    "TSK002",
  );
});

test("uninterrupted and checkpoint-resumed execution are identical", () => {
  const { finalSnapshot } = assertRuntimeResumeEquivalent(
    [
      'speaker vera { title: "Mistress" }',
      "speaker vera",
      'let values = set["first", "second", "third"]',
      "let chosen = values.random",
      'say "Choice: ${chosen}"',
      'values.add("fourth")',
      'say "Again: ${values.random}"',
      "exit",
    ].join("\n"),
    { scenarioName: "general runtime checkpoint equivalence", seed: 12345 },
  );

  assert.equal(finalSnapshot.status, "halted");
});

test("preserves nested deep-copy independence and ordered sets after restore", () => {
  const compiled = plan(
    [
      "let original = { nested: [[1]], values: set[3, 1, 2] }",
      "let copied = original",
      "copied.nested[0][0] = 9",
      "copied.values.add(4)",
      "exit",
    ].join("\n"),
  );
  let snapshot = createFreshRuntimeSnapshot(compiled);
  snapshot = executeInstruction(compiled, snapshot).snapshot;
  snapshot = executeInstruction(compiled, snapshot).snapshot;
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, snapshot)));
  const completed = run(restored.plan, restored.snapshot);
  // EVIDENCE: the compiled declarations initialize both bindings with object literals before checkpointing.
  const original = rootValue(completed.snapshot, "original") as SerializableRuntimeObject;
  // EVIDENCE: copied is assigned from the object-valued original binding in the compiled source.
  const copied = rootValue(completed.snapshot, "copied") as SerializableRuntimeObject;

  assert.deepEqual(objectProperty(original, "nested"), {
    kind: "list",
    items: [{ kind: "list", items: [1] }],
  });
  assert.deepEqual(objectProperty(copied, "nested"), {
    kind: "list",
    items: [{ kind: "list", items: [9] }],
  });
  // EVIDENCE: both `values` properties originate from the `set[3, 1, 2]` literal in the compiled source.
  assert.deepEqual((objectProperty(original, "values") as SerializableRuntimeSet).items, [3, 1, 2]);
  // EVIDENCE: the copied `values` property retains the set kind after the source adds one item.
  assert.deepEqual(
    (objectProperty(copied, "values") as SerializableRuntimeSet).items,
    [3, 1, 2, 4],
  );
});

test("keeps same-named speakers in sibling lexical scopes as distinct state", () => {
  const compiled = plan(
    [
      "if true {",
      '  speaker voice { displayName: "First voice" }',
      '  say as voice "First"',
      "}",
      "if true {",
      '  speaker voice { displayName: "Second voice" }',
      '  say as voice "Second"',
      "}",
      "exit",
    ].join("\n"),
  );
  const first = stepToEvent(compiled, createImmediatePacingRuntimeSnapshot(compiled));
  assert.deepEqual(sayOutput(first), [["voice", "First voice", "First"]]);
  const firstSpeaker = visibleSpeakerId(first.snapshot, "voice");
  const second = stepToEvent(compiled, first.snapshot);
  assert.deepEqual(sayOutput(second), [["voice", "Second voice", "Second"]]);
  const secondSpeaker = visibleSpeakerId(second.snapshot, "voice");
  assert.ok(Number.isSafeInteger(firstSpeaker) && Number.isSafeInteger(secondSpeaker));
  assert.notEqual(firstSpeaker, secondSpeaker);

  const completed = run(compiled, second.snapshot);
  assert.equal(completed.snapshot.status, "halted");
  assert.deepEqual(
    completed.snapshot.speakers.map((speaker) => speaker.id),
    [firstSpeaker, secondSpeaker],
  );
});

test("continues fallback-warning deduplication and event sequences after restore", () => {
  const compiled = plan(
    ["speaker vera {}", "speaker vera", 'say "First"', 'say "Second"', "exit"].join("\n"),
  );
  const firstBoundary = stepToEvent(compiled, createImmediatePacingRuntimeSnapshot(compiled));
  assert.deepEqual(
    firstBoundary.events.map((event) => event.kind),
    ["developerWarning", "say"],
  );
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, firstBoundary.snapshot)),
  );
  const remaining = run(restored.plan, restored.snapshot);

  assert.equal(
    remaining.events.some((event) => event.kind === "developerWarning"),
    false,
  );
  assert.deepEqual(
    remaining.events.map((event) => event.sequence),
    [3, 4],
  );
});

test("preserves list.remove missing-value warnings across event boundaries and restore", () => {
  const source = [
    "let values = [1]",
    "values.remove(2)",
    "values.remove(2)",
    'say "After"',
    "exit",
  ].join("\n");
  const compiled = plan(source);
  const initial = createImmediatePacingRuntimeSnapshot(compiled);
  const uninterrupted = run(compiled, initial);
  const firstBoundary = stepToEvent(compiled, initial);
  const call = "values.remove(2)";
  const firstCallStart = source.indexOf(call);

  assert.equal(firstBoundary.snapshot.status, "running");
  assert.deepEqual(rootValue(firstBoundary.snapshot, "values"), { kind: "list", items: [1] });
  assert.deepEqual(
    firstBoundary.events.map((event) => [
      event.kind,
      event.sequence,
      event.kind === "developerWarning" ? event.severity : null,
      event.kind === "developerWarning" ? event.code : null,
      event.kind === "developerWarning" ? event.span.start.offset : null,
      event.kind === "developerWarning" ? event.span.end.offset : null,
    ]),
    [["developerWarning", 1, "warning", "TSW002", firstCallStart, firstCallStart + call.length]],
  );

  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, firstBoundary.snapshot)),
  );
  const resumed = run(restored.plan, restored.snapshot);

  assert.equal(resumed.events.filter((event) => event.kind === "developerWarning").length, 1);
  assert.deepEqual(
    resumed.events.map((event) => event.sequence),
    [2, 3, 4],
  );
  assert.deepEqual([...firstBoundary.events, ...resumed.events], uninterrupted.events);
  assert.deepEqual(resumed.snapshot, uninterrupted.snapshot);
  assert.deepEqual(rootValue(resumed.snapshot, "values"), { kind: "list", items: [1] });
});

test("continues deterministic RNG state after restore", () => {
  const compiled = plan(
    ['let values = ["a", "b", "c", "d"]', "say values.random", "say values.random", "exit"].join(
      "\n",
    ),
  );
  const initial = createImmediatePacingRuntimeSnapshot(compiled, { seed: 0x1234_5678 });
  const uninterrupted = run(compiled, initial);
  const first = stepToEvent(compiled, initial);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, first.snapshot)),
  );
  const rest = run(restored.plan, restored.snapshot);

  assert.deepEqual([...first.events, ...rest.events], uninterrupted.events);
  assert.deepEqual(rest.snapshot.rng, uninterrupted.snapshot.rng);
});

test("accepts current internal format revisions and rejects non-current or malformed revisions", () => {
  const compiled = plan("exit");
  const snapshot = createFreshRuntimeSnapshot(compiled);
  // EVIDENCE: fixture mutation widens only the three validated revision fields of this canonical checkpoint.
  const checkpoint = structuredClone(createCheckpoint(compiled, snapshot)) as {
    version: unknown;
    plan: { version: unknown };
    snapshot: { version: unknown };
  };

  assert.equal(validateInstructionPlan(compiled).valid, true);
  assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true);
  assert.doesNotThrow(() => restoreCheckpoint(checkpoint));

  // Each boundary rejects its previous and next revisions and a wrong-typed current revision.
  for (const replacement of [
    compiled.version - 1,
    compiled.version + 1,
    String(compiled.version),
  ]) {
    // EVIDENCE: fixture mutation widens only the plan revision for numeric and wrong-type replacements.
    const invalidPlan = structuredClone(compiled) as { version: unknown };
    invalidPlan.version = replacement;
    const validation = validateInstructionPlan(invalidPlan);
    assert.equal(validation.valid, false, String(replacement));
    assert.ok(
      validation.errors.some((error) => error.code === "TSC001" && error.path === "$.version"),
      String(replacement),
    );
  }

  for (const replacement of [
    snapshot.version - 1,
    snapshot.version + 1,
    String(snapshot.version),
  ]) {
    // EVIDENCE: fixture mutation widens only the snapshot revision for numeric and wrong-type replacements.
    const invalidSnapshot = structuredClone(snapshot) as { version: unknown };
    invalidSnapshot.version = replacement;
    assert.equal(
      validateRuntimeSnapshot(invalidSnapshot, compiled).valid,
      false,
      String(replacement),
    );
  }

  for (const replacement of [
    CHECKPOINT_VERSION - 1,
    CHECKPOINT_VERSION + 1,
    String(CHECKPOINT_VERSION),
  ]) {
    const invalidCheckpoint = structuredClone(checkpoint);
    invalidCheckpoint.version = replacement;
    assertCheckpointError(invalidCheckpoint, { code: "TSK001", path: "$.version" });
    assertDeserializedCheckpointError(invalidCheckpoint, { code: "TSK001", path: "$.version" });
  }

  for (const replacement of [compiled.version - 1, compiled.version + 1]) {
    const invalidNestedPlan = structuredClone(checkpoint);
    invalidNestedPlan.plan.version = replacement;
    assertCheckpointError(invalidNestedPlan, { code: "TSK001", path: "$.plan.version" });
  }

  for (const replacement of [snapshot.version - 1, snapshot.version + 1]) {
    const invalidNestedSnapshot = structuredClone(checkpoint);
    invalidNestedSnapshot.snapshot.version = replacement;
    assertCheckpointError(invalidNestedSnapshot, { code: "TSK001", path: "$.snapshot" });
  }
});

test("checkpoint classification uses structured producer failures", () => {
  const compiled = plan("exit");
  const snapshot = createFreshRuntimeSnapshot(compiled);
  // EVIDENCE: this live external-plan fixture adds one self-reference to a compiler-produced plan copy.
  const cyclicPlan = structuredClone(compiled) as InstructionPlan & { self: unknown };
  cyclicPlan.self = cyclicPlan;
  const capturedPlan = captureInstructionPlan(cyclicPlan);
  assert.equal(capturedPlan.failureKind, "cycle");
  assertCheckpointError(
    { format: CHECKPOINT_FORMAT, version: CHECKPOINT_VERSION, plan: cyclicPlan, snapshot },
    { code: "TSK002", path: "$.plan.self" },
  );

  for (const externalFailure of [
    { value: Number.POSITIVE_INFINITY, kind: "nonFiniteNumber" },
    { value: undefined, kind: "nonJsonSafeValue" },
    { value: new Date(0), kind: "nonPlainObject" },
  ] as const) {
    const malformedPlan = { ...structuredClone(compiled), padding: externalFailure.value };
    const captured = captureInstructionPlan(malformedPlan);
    assert.equal(captured.failureKind, externalFailure.kind);
    assertCheckpointError(
      { format: CHECKPOINT_FORMAT, version: CHECKPOINT_VERSION, plan: malformedPlan, snapshot },
      { code: "TSK002", path: "$.plan.padding" },
    );
  }

  for (const malformedVersion of [
    { field: "format", value: "unsupported-snapshot" },
    { field: "version", value: snapshot.version + 1 },
  ] as const) {
    // EVIDENCE: the selected format/version field is widened only to exercise unsupported classification.
    const unsupported = {
      ...structuredClone(snapshot),
      [malformedVersion.field]: malformedVersion.value,
    };
    const capturedSnapshot = captureRuntimeSnapshotWithValidatedPlan(unsupported, compiled);
    assert.equal(capturedSnapshot.failureKind, "unsupported");
    const checkpoint = {
      format: CHECKPOINT_FORMAT,
      version: CHECKPOINT_VERSION,
      plan: compiled,
      snapshot: unsupported,
    };
    assertCheckpointError(checkpoint, { code: "TSK001", path: "$.snapshot" });
    assertDeserializedCheckpointError(checkpoint, { code: "TSK001", path: "$.snapshot" });
  }

  // A snapshot that is both obsolete and missing a field is rejected structurally; which of
  // its faults is reported first is not a contract.
  // EVIDENCE: the widened fixture combines an unsupported version with a missing required field.
  const doublyMalformed = { ...structuredClone(snapshot), version: snapshot.version + 1 };
  Reflect.deleteProperty(doublyMalformed, "frames");
  const capturedMalformed = captureRuntimeSnapshotWithValidatedPlan(doublyMalformed, compiled);
  assert.equal(capturedMalformed.validation.valid, false);
  assert.equal(capturedMalformed.snapshot, null);
  const malformedCheckpoint = {
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    plan: compiled,
    snapshot: doublyMalformed,
  };
  for (const restore of [
    () => restoreCheckpoint(malformedCheckpoint),
    () => deserializeCheckpoint(JSON.stringify(malformedCheckpoint)),
  ]) {
    assert.throws(restore, (error: unknown) => {
      assert.ok(error instanceof CheckpointError);
      assert.ok(["TSK001", "TSK002"].includes(error.info.code), error.info.code);
      assert.equal(error.info.path, "$.snapshot");
      return true;
    });
  }
});

test("rejects corrupted checkpoint data through structured errors", () => {
  const compiled = plan("exit");
  // EVIDENCE: serialization supplies the canonical envelope before this fixture replaces snapshot frames.
  const checkpoint = JSON.parse(
    serializeCheckpoint(createCheckpoint(compiled, createFreshRuntimeSnapshot(compiled))),
  ) as { snapshot: Record<string, unknown> };
  checkpoint.snapshot.frames = [];

  assertCheckpointCode(checkpoint, "TSK002");
  assert.throws(
    () => deserializeCheckpoint("{"),
    (error: unknown) => {
      return error instanceof CheckpointError && error.info.code === "TSK003";
    },
  );
});

test("rejects colliding or malformed scope-frame identity state", () => {
  const compiled = plan('if true {\n  say "inside"\n}\nexit');
  const conditional = executeInstruction(compiled, createFreshRuntimeSnapshot(compiled));
  const entered = executeInstruction(compiled, conditional.snapshot);
  // EVIDENCE: serialization supplies a canonical checkpoint with the runtime snapshot shape used below.
  const checkpoint = JSON.parse(
    serializeCheckpoint(createCheckpoint(compiled, entered.snapshot)),
  ) as { snapshot: RuntimeSnapshot };

  checkpoint.snapshot.nextScopeId = checkpoint.snapshot.frames[1]!.id;
  assertCheckpointCode(checkpoint, "TSK002");
  checkpoint.snapshot.nextScopeId = 2;
  // EVIDENCE: the root frame exists in this runtime-produced snapshot; the fixture corrupts its identity.
  (checkpoint.snapshot.frames[0] as { id: number }).id = 9;
  assertCheckpointCode(checkpoint, "TSK002");
});

test("fails structurally when the configurable instruction budget is exhausted", () => {
  const compiled = plan("let first = 1\nlet second = 2\nexit");
  const result = run(compiled, createFreshRuntimeSnapshot(compiled), {}, { instructionBudget: 1 });

  assert.equal(result.snapshot.status, "failed");
  assert.equal(result.snapshot.failure?.code, "TSR037");
  assert.deepEqual(
    result.events.map((event) => event.kind),
    ["runtimeFailure"],
  );
});

function rootValue(snapshot: RuntimeSnapshot, name: string): SerializableRuntimeValue {
  const binding = snapshot.frames[0]?.bindings.find((item) => item.name === name);
  assert.ok(binding !== undefined);
  return binding.value;
}

function objectProperty(object: SerializableRuntimeObject, name: string): SerializableRuntimeValue {
  const property = object.properties.find((item) => item.name === name);
  assert.ok(property !== undefined);
  return property.value;
}

function assertCheckpointCode(value: unknown, code: string): void {
  assert.throws(
    () => restoreCheckpoint(value),
    (error: unknown) => {
      return error instanceof CheckpointError && error.info.code === code;
    },
  );
}

interface ExpectedCheckpointError {
  readonly code: string;
  readonly path: string;
}

function assertCheckpointError(value: unknown, expected: ExpectedCheckpointError): void {
  assert.throws(
    () => restoreCheckpoint(value),
    (error: unknown) => {
      assert.ok(error instanceof CheckpointError);
      assert.deepEqual({ code: error.info.code, path: error.info.path }, expected);
      return true;
    },
  );
}

function assertDeserializedCheckpointError(
  value: unknown,
  expected: ExpectedCheckpointError,
): void {
  assert.throws(
    () => deserializeCheckpoint(JSON.stringify(value)),
    (error: unknown) => {
      assert.ok(error instanceof CheckpointError);
      assert.deepEqual({ code: error.info.code, path: error.info.path }, expected);
      return true;
    },
  );
}

/** Each say event's speaker identifier, speaker display name, and text. */
function sayOutput(result: { readonly events: readonly InterpreterEvent[] }): unknown[][] {
  return result.events.flatMap((event) =>
    event.kind === "say"
      ? [[event.speaker?.identifier, event.speaker?.displayName, event.text]]
      : [],
  );
}

function visibleSpeakerId(snapshot: RuntimeSnapshot, name: string): number {
  const value = snapshot.frames.at(-1)?.bindings.find((item) => item.name === name)?.value;
  assert.ok(
    typeof value === "object" && value !== null && value.kind === "speakerReference",
    `${name} is a visible speaker`,
  );
  return value.speakerId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("checkpoint and plan validation never coerce non-string enumerated fields to text", () => {
  const compiled = plan('let n = 1\nwait n s\nshowButton "Go"');
  const fresh = createFreshRuntimeSnapshot(compiled);
  const waiting = run(compiled, fresh).snapshot;
  for (const snapshot of [fresh, waiting]) {
    const json: unknown = JSON.parse(serializeCheckpoint(createCheckpoint(compiled, snapshot)));
    assert.ok(isRecord(json) && isRecord(json.snapshot));
    // A one-element array stringifies to its element, so only an exact type check rejects it.
    json.snapshot.status = [json.snapshot.status];
    assert.equal(validateRuntimeSnapshot(json.snapshot, compiled).valid, false);
    assert.throws(() => deserializeCheckpoint(JSON.stringify(json)), CheckpointError);
  }

  const index = compiled.instructions.findIndex((instruction) => instruction.kind === "wait");
  const forged: unknown = structuredClone(compiled);
  assert.ok(isRecord(forged) && Array.isArray(forged.instructions));
  const wait: unknown = forged.instructions[index];
  assert.ok(isRecord(wait) && wait.unit === "s");
  assert.equal(validateInstructionPlan(forged).valid, true);
  wait.unit = ["s"];
  assert.equal(validateInstructionPlan(forged).valid, false);

  const sum = plan("let n = 1 + 2\nexit");
  const forgedSum: unknown = structuredClone(sum);
  assert.ok(isRecord(forgedSum) && Array.isArray(forgedSum.instructions));
  const binding: unknown = forgedSum.instructions[0];
  assert.ok(isRecord(binding) && isRecord(binding.value) && binding.value.operator === "+");
  assert.equal(validateInstructionPlan(forgedSum).valid, true);
  binding.value.operator = ["+"];
  assert.equal(validateInstructionPlan(forgedSum).valid, false);
});
