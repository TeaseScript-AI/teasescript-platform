import assert from "node:assert/strict";
import test from "node:test";

import type { ListExpressionPlan } from "../src/plan/model.js";
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
import { executeInstruction, run } from "../src/runtime/engine.js";
import type {
  SerializableRuntimeObject,
  SerializableRuntimeSet,
  SerializableRuntimeValue,
} from "../src/runtime/serializable-values.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";

test("checkpoint accepts a large valid plan and snapshot without a shared work rejection", () => {
  const compiled = plan(
    Array.from({ length: 3_000 }, (_value, index) => `say "${index}"`).join("\n"),
  );
  const snapshot = createFreshRuntimeSnapshot(compiled);
  snapshot.frames[0]!.bindings.push(
    ...Array.from({ length: 20_000 }, (_value, index) => ({ name: `value${index}`, value: index })),
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
  // The accessor would return valid plan data, so only non-invocation can explain the rejection.
  assertCheckpointError(accessor, { code: "TSK002", path: "$.plan" });
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
  const { events, finalSnapshot } = assertRuntimeResumeEquivalent(
    [
      // Without a display-name property, both says use the identifier fallback, so every boundary also
      // checkpoints the warning deduplication state.
      'speaker vera { color: "#b784ff" }',
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
  assert.equal(events.filter((event) => event.kind === "developerWarning").length, 1);
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
  const { events } = assertRuntimeResumeEquivalent(
    [
      "if true {",
      '  speaker voice { displayName: "Scope one" }',
      '  say as voice "First"',
      "}",
      "if true {",
      '  speaker voice { displayName: "Scope two" }',
      '  say as voice "Second"',
      "}",
      "exit",
    ].join("\n"),
  );

  // Each say is emitted with the speaker declared in its own scope, told apart by authored display name.
  assert.deepEqual(
    events.flatMap((event) =>
      event.kind === "say" ? [[event.speaker?.displayName, event.text]] : [],
    ),
    [
      ["Scope one", "First"],
      ["Scope two", "Second"],
    ],
  );
});

test("an unknown root snapshot field is rejected at validation, checkpoint and restore", () => {
  const compiled = plan('say "kept"');
  const snapshot = createFreshRuntimeSnapshot(compiled);
  const withUnknownField = { ...structuredClone(snapshot), unknownField: "none" };
  assert.equal(validateRuntimeSnapshot(withUnknownField, compiled).valid, false);
  assert.throws(
    () => createCheckpoint(compiled, withUnknownField),
    (error: unknown) => error instanceof CheckpointError && error.info.code === "TSK002",
  );
  assertCheckpointCode(
    { ...createCheckpoint(compiled, snapshot), snapshot: withUnknownField },
    "TSK002",
  );
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

  // No migration exists, so a non-current revision must never be read as current; these rows change deliberately
  // if a migration is approved (docs/RUNTIME.md, format revisions).

  for (const replacement of [
    compiled.version - 1,
    compiled.version + 1,
    String(compiled.version),
  ]) {
    // EVIDENCE: fixture mutation widens only the plan revision for obsolete, future and wrong-type values.
    const invalidPlan = structuredClone(compiled) as { version: unknown };
    invalidPlan.version = replacement;
    const validation = validateInstructionPlan(invalidPlan);
    assert.equal(validation.valid, false, String(replacement));
    assert.ok(
      validation.errors.some((error) => error.code === "TSC001" && error.path === "$.version"),
      String(replacement),
    );

    const nestedPlan = structuredClone(checkpoint);
    nestedPlan.plan.version = replacement;
    assertCheckpointError(nestedPlan, { code: "TSK001", path: "$.plan.version" });
  }

  for (const replacement of [
    snapshot.version - 1,
    snapshot.version + 1,
    String(snapshot.version),
  ]) {
    // EVIDENCE: fixture mutation widens only the snapshot revision for obsolete, future and wrong-type values.
    const invalidSnapshot = structuredClone(snapshot) as { version: unknown };
    invalidSnapshot.version = replacement;
    assert.equal(validateRuntimeSnapshot(invalidSnapshot, compiled).valid, false);

    const nestedSnapshot = structuredClone(checkpoint);
    nestedSnapshot.snapshot.version = replacement;
    assertCheckpointError(nestedSnapshot, { code: "TSK001", path: "$.snapshot" });
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
});

test("checkpoint classification uses structured producer failures", () => {
  const compiled = plan("let value = [1]\nexit");
  const snapshot = createFreshRuntimeSnapshot(compiled);
  // One row per external-data failure kind, each replacing the element of the compiled `[1]` literal.
  const elementPath = "$.instructions[0].value.elements[0]";
  for (const { name, replace, path } of [
    { name: "cycle", replace: (list: ListExpressionPlan) => list, path: elementPath },
    {
      name: "non-finite number",
      replace: () => ({
        kind: "literal",
        value: Number.POSITIVE_INFINITY,
        span: compiled.files[0]!.sourceSpan,
      }),
      path: `${elementPath}.value`,
    },
    {
      name: "non-JSON-safe value",
      replace: () => ({ kind: "literal", value: undefined, span: compiled.files[0]!.sourceSpan }),
      path: `${elementPath}.value`,
    },
    {
      name: "non-plain object",
      replace: () => ({ kind: "literal", value: new Date(0), span: compiled.files[0]!.sourceSpan }),
      path: `${elementPath}.value`,
    },
  ]) {
    const malformedPlan = structuredClone(compiled);
    const binding = malformedPlan.instructions[0];
    assert.ok(binding?.kind === "declareBinding" && binding.value.kind === "list", name);
    // EVIDENCE: the copied `[1]` literal's element is replaced with external data for rejection.
    (binding.value.elements as unknown[])[0] = replace(binding.value);

    const errors = validateInstructionPlan(malformedPlan).errors;
    assert.deepEqual(
      errors.map((error) => [error.code, error.path]),
      [["TSC002", path]],
      name,
    );
    assertCheckpointError(
      { format: CHECKPOINT_FORMAT, version: CHECKPOINT_VERSION, plan: malformedPlan, snapshot },
      { code: "TSK002", path: `$.plan${path.slice(1)}` },
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
    const checkpoint = {
      format: CHECKPOINT_FORMAT,
      version: CHECKPOINT_VERSION,
      plan: compiled,
      snapshot: unsupported,
    };
    const expected = { code: "TSK001", path: "$.snapshot" } as const;
    assertCheckpointError(checkpoint, expected);
    assertDeserializedCheckpointError(checkpoint, expected);
  }

  // EVIDENCE: the widened fixture combines an unsupported version with a missing required field.
  const combined = { ...structuredClone(snapshot), version: snapshot.version + 1 };
  Reflect.deleteProperty(combined, "frames");
  assert.equal(validateRuntimeSnapshot(combined, compiled).valid, false);
  const combinedCheckpoint = {
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    plan: compiled,
    snapshot: combined,
  };
  // Either classification is acceptable for doubly invalid data; rejection at the snapshot is required.
  const isSnapshotRejection = (error: unknown): boolean =>
    error instanceof CheckpointError &&
    (error.info.code === "TSK001" || error.info.code === "TSK002") &&
    error.info.path === "$.snapshot";
  assert.throws(() => restoreCheckpoint(combinedCheckpoint), isSnapshotRejection);
  assert.throws(
    () => deserializeCheckpoint(JSON.stringify(combinedCheckpoint)),
    isSnapshotRejection,
  );
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

type CheckpointFailure = Pick<CheckpointError["info"], "code" | "path">;

function assertCheckpointError(value: unknown, expected: CheckpointFailure): void {
  assert.throws(
    () => restoreCheckpoint(value),
    (error: unknown) => {
      assert.ok(error instanceof CheckpointError);
      assert.deepEqual({ code: error.info.code, path: error.info.path }, expected);
      return true;
    },
  );
}

function assertDeserializedCheckpointError(value: unknown, expected: CheckpointFailure): void {
  assert.throws(
    () => deserializeCheckpoint(JSON.stringify(value)),
    (error: unknown) => {
      assert.ok(error instanceof CheckpointError);
      assert.deepEqual({ code: error.info.code, path: error.info.path }, expected);
      return true;
    },
  );
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
