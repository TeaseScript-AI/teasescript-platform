import assert from "node:assert/strict";
import test from "node:test";

import {
  CheckpointError,
  RuntimeDataError,
  compileSource,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  deserializeCheckpoint,
  executeInstruction,
  restoreCheckpoint,
  run,
  stepToEvent,
  validateInstructionPlan,
  type InstructionPlan,
  type RuntimeCheckpoint,
  type RuntimeSnapshot,
} from "../src/index.js";
import { compileValidPlan as compiledPlan } from "./helpers/compile-valid-plan.js";

test("rejects out-of-range, unsafe, negative, and fractional function boundaries at the function entry", () => {
  const original = functionPlan();
  const mutations = [
    ["endInstruction", original.instructions.length + 1],
    ["endInstruction", Number.MAX_SAFE_INTEGER],
    ["endInstruction", Number.MAX_SAFE_INTEGER + 1],
    ["endInstruction", -1],
    ["endInstruction", 1.5],
    ["entryInstruction", Number.MAX_SAFE_INTEGER],
    ["bodyEntryInstruction", Number.MAX_SAFE_INTEGER],
    ["implicitReturnInstruction", Number.MAX_SAFE_INTEGER],
  ] as const;

  for (const [field, value] of mutations) {
    const malformed = mutablePlan(original);
    malformed.functions[0]![field] = value;
    const result = validateInstructionPlan(malformed);
    assert.equal(result.valid, false, `${field} ${value}`);
    assert.ok(hasPlanError(result.errors, "$.functions[0]"), `${field} ${value}`);
  }
});

test("rejects an extreme root boundary at the file's path", () => {
  const malformed = mutablePlan(functionPlan());
  malformed.files[0]!.rootEndInstruction = Number.MAX_SAFE_INTEGER;

  const result = validateInstructionPlan(malformed);

  assert.equal(result.valid, false);
  assert.ok(hasPlanError(result.errors, "$.files[0]"));
});

test("rejects unsafe persisted temporary and loop identities", () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 1;
  const sourcePlan = mutablePlan(functionPlan());
  // EVIDENCE: fixture: mutate the cloned readonly source offset to an unsafe integer.
  (sourcePlan.files[0]!.sourceSpan as { so: number }).so = unsafe;

  const sourceValidation = validateInstructionPlan(sourcePlan);
  assert.equal(sourceValidation.valid, false);
  assert.ok(hasPlanError(sourceValidation.errors, "$.files[0].sourceSpan"));

  const temporaryPlan = mutablePlan(functionPlan());
  temporaryPlan.temporaryCount = unsafe;

  const temporaryValidation = validateInstructionPlan(temporaryPlan);
  assert.equal(temporaryValidation.valid, false);
  assert.ok(hasPlanError(temporaryValidation.errors, "$.temporaryCount"));

  const loopPlan = mutablePlan(compiledPlan("repeat 1 { say 1 }"));
  // EVIDENCE: fixture: the compiled repeat emits a loopStart whose ID is deliberately corrupted.
  const loopStart = loopPlan.instructions.find(
    (instruction) => instruction.kind === "loopStart",
  )! as { loopId: number };
  // EVIDENCE: fixture: the compiled repeat emits a loopControl whose ID is deliberately corrupted.
  const loopControl = loopPlan.instructions.find(
    (instruction) => instruction.kind === "loopControl",
  )! as { loopId: number };
  loopStart.loopId = unsafe;
  loopControl.loopId = unsafe;

  const loopValidation = validateInstructionPlan(loopPlan);
  assert.equal(loopValidation.valid, false);
  assert.ok(
    loopValidation.errors.some(
      (error) => error.code === "TSC002" && error.path.endsWith(".loopId"),
    ),
  );
  assert.throws(() => {
    // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: the compiled loop plan retains its complete structure while this fixture sets both loop IDs outside the accepted safe-integer range.
    return createFreshRuntimeSnapshot(loopPlan as unknown as InstructionPlan);
  }, TypeError);

  const validLoopPlan = compiledPlan("repeat 1 { say 1 }");
  // EVIDENCE: fixture: parse the serialized checkpoint into a mutable copy for identity/range corruption.
  const checkpoint = JSON.parse(
    JSON.stringify(createCheckpoint(validLoopPlan, createFreshRuntimeSnapshot(validLoopPlan))),
  ) as MutableCheckpoint;
  // EVIDENCE: fixture: the compiled repeat emits a loopStart whose checkpoint ID is deliberately corrupted.
  const checkpointLoopStart = checkpoint.plan.instructions.find(
    (instruction) => instruction.kind === "loopStart",
  )! as { loopId: number };
  // EVIDENCE: fixture: the compiled repeat emits a loopControl whose checkpoint ID is deliberately corrupted.
  const checkpointLoopControl = checkpoint.plan.instructions.find(
    (instruction) => instruction.kind === "loopControl",
  )! as { loopId: number };
  checkpointLoopStart.loopId = unsafe;
  checkpointLoopControl.loopId = unsafe;
  assert.throws(
    () => restoreCheckpoint(checkpoint),
    (error: unknown) => error instanceof CheckpointError && error.info.code === "TSK002",
  );
});

test("rejects impossible ordering, gaps, overlaps, and pre-root entries", () => {
  const cases: Array<[path: string, mutate: (plan: MutablePlan) => void]> = [
    [
      "$.functions[0]",
      (plan) => {
        plan.functions[0]!.entryInstruction = plan.functions[0]!.bodyEntryInstruction;
      },
    ],
    [
      "$.functions[0]",
      (plan) => {
        plan.functions[0]!.bodyEntryInstruction = plan.functions[0]!.implicitReturnInstruction + 1;
      },
    ],
    [
      "$.functions[0]",
      (plan) => {
        plan.functions[0]!.endInstruction = plan.functions[0]!.implicitReturnInstruction + 2;
      },
    ],
    [
      "$.functions[0]",
      (plan) => {
        plan.functions[0]!.entryInstruction = plan.files[0]!.rootEndInstruction - 1;
      },
    ],
    [
      "$.functions[1]",
      (plan) => {
        plan.functions[1]!.entryInstruction += 1;
      },
    ],
    [
      "$.functions[1]",
      (plan) => {
        plan.functions[1]!.entryInstruction = plan.functions[0]!.entryInstruction;
      },
    ],
  ];

  for (const [index, [path, mutate]] of cases.entries()) {
    const malformed = mutablePlan(twoFunctionPlan());
    mutate(malformed);
    const result = validateInstructionPlan(malformed);
    assert.equal(result.valid, false, `case ${index}`);
    assert.ok(hasPlanError(result.errors, path), `case ${index}`);
  }
});

test("continues independent metadata validation after an unsafe function range", () => {
  const malformed = mutablePlan(twoFunctionPlan());
  malformed.functions[0]!.endInstruction = Number.MAX_SAFE_INTEGER;
  malformed.functions[1]!.id = malformed.functions[0]!.id;

  const result = validateInstructionPlan(malformed);

  assert.equal(result.valid, false);
  assert.ok(hasPlanError(result.errors, "$.functions[0]"));
  assert.ok(hasPlanError(result.errors, "$.functions[1].id"));
});

test("public runtime and checkpoint routes reject an extreme range before side effects", () => {
  const original = functionPlan("say random()\nexit");
  const malformed = mutablePlan(original);
  malformed.functions[0]!.endInstruction = Number.MAX_SAFE_INTEGER;
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: fixture changes only the function endInstruction to an extreme safe integer before exercising typed public runtime APIs.
  const invalid = malformed as unknown as InstructionPlan;
  const snapshot = createFreshRuntimeSnapshot(original);
  const before = structuredClone(snapshot);
  let randomCalls = 0;
  const capabilities = {
    random: {
      next(): number {
        randomCalls += 1;
        return 0.5;
      },
    },
  };

  assert.throws(() => createFreshRuntimeSnapshot(invalid), TypeError);
  assert.throws(
    () => executeInstruction(invalid, snapshot, capabilities),
    isMalformedPlanRuntimeError,
  );
  assert.throws(() => stepToEvent(invalid, snapshot, capabilities), isMalformedPlanRuntimeError);
  assert.throws(() => run(invalid, snapshot, capabilities), isMalformedPlanRuntimeError);
  assert.deepEqual(snapshot, before);
  assert.equal(randomCalls, 0);

  assert.throws(() => createCheckpoint(invalid, snapshot), isMalformedPlanCheckpointError);

  // EVIDENCE: fixture: parse the serialized checkpoint into a mutable copy for identity/range corruption.
  const checkpoint = JSON.parse(
    JSON.stringify(createCheckpoint(original, snapshot)),
  ) as MutableCheckpoint;
  checkpoint.plan = malformed;
  assert.throws(() => restoreCheckpoint(checkpoint), isMalformedPlanCheckpointError);
  assert.throws(
    () => deserializeCheckpoint(JSON.stringify(checkpoint)),
    isMalformedPlanCheckpointError,
  );
});

test("preserves compiler-generated plans across representative layouts", () => {
  const sources = [
    "",
    "exit",
    "function empty { }\nexit",
    "function required(value) { return value }\nrequired(1)\nexit",
    "function defaults(value = 1) { return value }\ndefaults()\nexit",
    "function implicit { say 1 }\nimplicit()\nexit",
    [
      "function recursive(value) {",
      "  if value > 0 { return recursive(value - 1) }",
      "  return 0",
      "}",
      "recursive(2)",
      "exit",
    ].join("\n"),
    "function first { return second() }\nfunction second { return 2 }\nfirst()\nexit",
  ];

  for (const source of sources) {
    const result = compileSource(source);
    assert.deepEqual(result.diagnostics, [], source);
    assert.notEqual(result.plan, null, source);
  }
});

type MutableFunction = {
  id: number;
  entryInstruction: number;
  bodyEntryInstruction: number;
  implicitReturnInstruction: number;
  endInstruction: number;
};

type MutablePlan = Omit<InstructionPlan, "functions" | "files"> & {
  files: {
    -readonly [
      Key in keyof InstructionPlan["files"][number]
    ]: InstructionPlan["files"][number][Key];
  }[];
  temporaryCount: number;
  functions: MutableFunction[];
};

type MutableCheckpoint = Omit<RuntimeCheckpoint, "plan" | "snapshot"> & {
  plan: MutablePlan;
  snapshot: RuntimeSnapshot;
};

function hasPlanError(errors: readonly { code: string; path: string }[], path: string): boolean {
  return errors.some((error) => error.code === "TSC002" && error.path === path);
}

function isMalformedPlanRuntimeError(error: unknown): boolean {
  return error instanceof RuntimeDataError && error.code === "TSR100";
}

function isMalformedPlanCheckpointError(error: unknown): boolean {
  return (
    error instanceof CheckpointError &&
    error.info.code === "TSK002" &&
    error.info.path === "$.plan.functions[0]"
  );
}

function functionPlan(root = "exit"): InstructionPlan {
  return compiledPlan(`function sample(value = 1) { return value }\n${root}`);
}

function twoFunctionPlan(): InstructionPlan {
  return compiledPlan(
    [
      "function first(value = 1) { return value }",
      "function second { return 2 }",
      "first()",
      "exit",
    ].join("\n"),
  );
}

function mutablePlan(plan: InstructionPlan): MutablePlan {
  // EVIDENCE: JSON serialization preserves the compiled plan's data shape; individual callers apply their documented invalid field mutations to this mutable copy.
  return JSON.parse(JSON.stringify(plan)) as MutablePlan;
}
