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
import { withValidationTestStatistics } from "../src/validation-testing.js";

const RANGE_ERROR = "Function instruction range is overlapping or impossible.";
const ROOT_ERROR = "Root execution boundary is invalid.";
const BOUNDARY_ERROR =
  "Function instruction boundaries must be non-negative integers.";

test("rejects function boundaries outside the instruction array without dependent traversal", () => {
  const original = functionPlan();
  const mutations = [
    ["endInstruction", original.instructions.length + 1],
    ["endInstruction", Number.MAX_SAFE_INTEGER],
    ["entryInstruction", Number.MAX_SAFE_INTEGER],
    ["bodyEntryInstruction", Number.MAX_SAFE_INTEGER],
    ["implicitReturnInstruction", Number.MAX_SAFE_INTEGER],
  ] as const;

  for (const [field, value] of mutations) {
    const malformed = mutablePlan(original);
    malformed.functions[0]![field] = value;
    const result = validateInstructionPlan(malformed as unknown as InstructionPlan);
    assert.equal(result.valid, false, field);
    assert.ok(
      result.errors.some(
        (error) =>
          error.code === "TSC002" &&
          error.path === "$.functions[0]" &&
          error.message === RANGE_ERROR,
      ),
      field,
    );
    assert.equal(
      result.errors.some((error) => error.message.includes("prologue")),
      false,
      `${field} must not reach prologue validation`,
    );
  }
});

test("rejects an extreme root boundary without building a metadata-sized region", () => {
  const malformed = mutablePlan(functionPlan());
  malformed.rootEndInstruction = Number.MAX_SAFE_INTEGER;

  const result = validateInstructionPlan(malformed as unknown as InstructionPlan);

  assert.equal(result.valid, false);
  assert.deepEqual(result.errors[0], {
    code: "TSC002",
    message: ROOT_ERROR,
    path: "$.rootEndInstruction",
  });
});

test("rejects unsafe persisted temporary and loop identities", () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 1;
  const sourcePlan = mutablePlan(functionPlan());
  (sourcePlan.sourceSpan.start as { offset: number }).offset = unsafe;

  const sourceValidation = validateInstructionPlan(sourcePlan as unknown as InstructionPlan);
  assert.equal(sourceValidation.valid, false);
  assert.ok(sourceValidation.errors.some((error) =>
    error.path === "$.sourceSpan" && error.message === "Source span is malformed."
  ));

  const temporaryPlan = mutablePlan(functionPlan());
  temporaryPlan.temporaryCount = unsafe;

  const temporaryValidation = validateInstructionPlan(temporaryPlan as unknown as InstructionPlan);
  assert.equal(temporaryValidation.valid, false);
  assert.ok(temporaryValidation.errors.some((error) =>
    error.path === "$.temporaryCount" && error.message === "temporaryCount must be a non-negative safe integer."
  ));

  const loopPlan = mutablePlan(compiledPlan("repeat 1 { say 1 }"));
  const loopStart = loopPlan.instructions.find((instruction) => instruction.kind === "loopStart")! as { loopId: number };
  const loopControl = loopPlan.instructions.find((instruction) => instruction.kind === "loopControl")! as { loopId: number };
  loopStart.loopId = unsafe;
  loopControl.loopId = unsafe;

  const loopValidation = validateInstructionPlan(loopPlan as unknown as InstructionPlan);
  assert.equal(loopValidation.valid, false);
  assert.ok(loopValidation.errors.some((error) =>
    error.path.endsWith(".loopId") && error.message === "Expected a positive safe integer."
  ));
  assert.throws(
    () => createFreshRuntimeSnapshot(loopPlan as unknown as InstructionPlan),
    (error: unknown) => error instanceof TypeError && error.message === "Expected a positive safe integer.",
  );

  const validLoopPlan = compiledPlan("repeat 1 { say 1 }");
  const checkpoint = JSON.parse(JSON.stringify(createCheckpoint(
    validLoopPlan,
    createFreshRuntimeSnapshot(validLoopPlan),
  ))) as MutableCheckpoint;
  const checkpointLoopStart = checkpoint.plan.instructions.find((instruction) => instruction.kind === "loopStart")! as { loopId: number };
  const checkpointLoopControl = checkpoint.plan.instructions.find((instruction) => instruction.kind === "loopControl")! as { loopId: number };
  checkpointLoopStart.loopId = unsafe;
  checkpointLoopControl.loopId = unsafe;
  assert.throws(
    () => restoreCheckpoint(checkpoint),
    (error: unknown) => error instanceof CheckpointError && error.info.code === "TSK002",
  );
});

test("validates many small function regions without changing root or owner semantics", () => {
  const source = [
    ...Array.from({ length: 96 }, (_unused, index) =>
      `function f${index} { return ${index} }`,
    ),
    "say f0()",
  ].join("\n");
  const compiled = compileSource(source);
  assert.equal(compiled.diagnostics.length, 0);
  assert.ok(compiled.plan !== null);
  const { result, statistics } = withValidationTestStatistics((finish) => {
    const validation = validateInstructionPlan(compiled.plan);
    return { result: validation, statistics: finish() };
  });
  assert.equal(result.valid, true);
  assert.equal(statistics.counts.planOwnerIndexBuilds, 1);

  const nextStatistics = withValidationTestStatistics((finish) => {
    assert.equal(validateInstructionPlan(compiled.plan).valid, true);
    return finish();
  });
  assert.equal(nextStatistics.counts.planOwnerIndexBuilds, 1);
});

test("rejects unsafe, negative, and fractional function boundaries before dependent validation", () => {
  for (const value of [Number.MAX_SAFE_INTEGER + 1, -1, 1.5]) {
    const malformed = mutablePlan(functionPlan());
    malformed.functions[0]!.endInstruction = value;
    const result = validateInstructionPlan(malformed as unknown as InstructionPlan);
    assert.ok(result.errors.some((error) =>
      error.path === "$.functions[0]" && error.message === BOUNDARY_ERROR
    ));
    assert.equal(result.errors.some((error) => error.message.includes("prologue")), false);
  }
});

test("rejects impossible ordering, gaps, overlaps, and pre-root entries", () => {
  const cases: Array<(plan: MutablePlan) => void> = [
    (plan) => {
      plan.functions[0]!.entryInstruction = plan.functions[0]!.bodyEntryInstruction;
    },
    (plan) => {
      plan.functions[0]!.bodyEntryInstruction =
        plan.functions[0]!.implicitReturnInstruction + 1;
    },
    (plan) => {
      plan.functions[0]!.endInstruction =
        plan.functions[0]!.implicitReturnInstruction + 2;
    },
    (plan) => {
      plan.functions[0]!.entryInstruction = plan.rootEndInstruction - 1;
    },
    (plan) => {
      plan.functions[1]!.entryInstruction += 1;
    },
    (plan) => {
      plan.functions[1]!.entryInstruction = plan.functions[0]!.entryInstruction;
    },
  ];

  for (const mutate of cases) {
    const malformed = mutablePlan(twoFunctionPlan());
    mutate(malformed);
    const result = validateInstructionPlan(malformed as unknown as InstructionPlan);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.message === RANGE_ERROR));
  }
});

test("continues independent metadata validation after an unsafe function range", () => {
  const malformed = mutablePlan(twoFunctionPlan());
  malformed.functions[0]!.endInstruction = Number.MAX_SAFE_INTEGER;
  malformed.functions[1]!.id = malformed.functions[0]!.id;

  const result = validateInstructionPlan(malformed as unknown as InstructionPlan);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) =>
    error.path === "$.functions[0]" && error.message === RANGE_ERROR
  ));
  assert.ok(result.errors.some((error) =>
    error.path === "$.functions[1].id" &&
    error.message === "Function IDs must be unique."
  ));
});

test("public runtime and checkpoint routes reject an extreme range before side effects", () => {
  const original = functionPlan('say random()\nexit');
  const malformed = mutablePlan(original);
  malformed.functions[0]!.endInstruction = Number.MAX_SAFE_INTEGER;
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

  assert.throws(
    () => createFreshRuntimeSnapshot(invalid),
    (error: unknown) => error instanceof TypeError && error.message === RANGE_ERROR,
  );
  assert.throws(
    () => executeInstruction(invalid, snapshot, capabilities),
    isMalformedPlanRuntimeError,
  );
  assert.throws(
    () => stepToEvent(invalid, snapshot, capabilities),
    isMalformedPlanRuntimeError,
  );
  assert.throws(
    () => run(invalid, snapshot, capabilities),
    isMalformedPlanRuntimeError,
  );
  assert.deepEqual(snapshot, before);
  assert.equal(randomCalls, 0);

  assert.throws(
    () => createCheckpoint(invalid, snapshot),
    isMalformedPlanCheckpointError,
  );

  const checkpoint = JSON.parse(
    JSON.stringify(createCheckpoint(original, snapshot)),
  ) as MutableCheckpoint;
  checkpoint.plan = malformed;
  assert.throws(
    () => restoreCheckpoint(checkpoint),
    isMalformedPlanCheckpointError,
  );
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
    assert.equal(validateInstructionPlan(result.plan).valid, true, source);
  }
});

type MutableFunction = {
  id: number;
  entryInstruction: number;
  bodyEntryInstruction: number;
  implicitReturnInstruction: number;
  endInstruction: number;
};

type MutablePlan = Omit<InstructionPlan, "functions"> & {
  rootEndInstruction: number;
  temporaryCount: number;
  functions: MutableFunction[];
};

type MutableCheckpoint = Omit<RuntimeCheckpoint, "plan" | "snapshot"> & {
  plan: MutablePlan;
  snapshot: RuntimeSnapshot;
};

function isMalformedPlanRuntimeError(error: unknown): boolean {
  return error instanceof RuntimeDataError &&
    error.code === "TSR100" &&
    error.message === RANGE_ERROR;
}

function isMalformedPlanCheckpointError(error: unknown): boolean {
  return error instanceof CheckpointError &&
    error.info.code === "TSK002" &&
    error.info.message === RANGE_ERROR;
}

function functionPlan(root = "exit"): InstructionPlan {
  return compiledPlan(`function sample(value = 1) { return value }\n${root}`);
}

function twoFunctionPlan(): InstructionPlan {
  return compiledPlan([
    "function first(value = 1) { return value }",
    "function second { return 2 }",
    "first()",
    "exit",
  ].join("\n"));
}

function compiledPlan(source: string): InstructionPlan {
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}

function mutablePlan(plan: InstructionPlan): MutablePlan {
  return JSON.parse(JSON.stringify(plan)) as MutablePlan;
}
