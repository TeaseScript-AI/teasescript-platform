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

test("rejects function boundaries outside the instruction array", () => {
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
    assertPlanErrorAt(validateInstructionPlan(malformed), "$.functions[0]", field);
  }
});

test("rejects an extreme root boundary without building a metadata-sized region", () => {
  const malformed = mutablePlan(functionPlan());
  malformed.rootEndInstruction = Number.MAX_SAFE_INTEGER;

  // A structured result, rather than a native allocation failure, shows no metadata-sized region was built.
  assertPlanErrorAt(validateInstructionPlan(malformed), "$.rootEndInstruction");
});

test("rejects unsafe persisted temporary and loop identities", () => {
  const unsafe = Number.MAX_SAFE_INTEGER + 1;
  const sourcePlan = mutablePlan(functionPlan());
  // EVIDENCE: fixture: mutate the cloned readonly source offset to an unsafe integer.
  (sourcePlan.sourceSpan as { so: number }).so = unsafe;

  assertPlanErrorAt(validateInstructionPlan(sourcePlan), "$.sourceSpan");

  const temporaryPlan = mutablePlan(functionPlan());
  temporaryPlan.temporaryCount = unsafe;

  assertPlanErrorAt(validateInstructionPlan(temporaryPlan), "$.temporaryCount");

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

test("validates ownership across many adjacent small function regions", () => {
  const source = [
    ...Array.from({ length: 96 }, (_unused, index) => `function f${index} { return ${index} }`),
    "say f0()",
  ].join("\n");
  const compiled = compileSource(source);
  assert.equal(compiled.diagnostics.length, 0);
  assert.ok(compiled.plan !== null);
  assert.equal(compiled.plan.functions.length, 96);
  assert.equal(validateInstructionPlan(compiled.plan).valid, true);
});

test("rejects unsafe, negative, and fractional function boundaries", () => {
  for (const value of [Number.MAX_SAFE_INTEGER + 1, -1, 1.5]) {
    const malformed = mutablePlan(functionPlan());
    malformed.functions[0]!.endInstruction = value;
    assertPlanErrorAt(validateInstructionPlan(malformed), "$.functions[0]", String(value));
  }
});

test("rejects impossible ordering, gaps, overlaps, and pre-root entries", () => {
  const cases: Array<readonly [string, string, (plan: MutablePlan) => void]> = [
    [
      "entry at body",
      "$.functions[0]",
      (plan) => {
        plan.functions[0]!.entryInstruction = plan.functions[0]!.bodyEntryInstruction;
      },
    ],
    [
      "body after implicit return",
      "$.functions[0]",
      (plan) => {
        plan.functions[0]!.bodyEntryInstruction = plan.functions[0]!.implicitReturnInstruction + 1;
      },
    ],
    [
      "end gap",
      "$.functions[0]",
      (plan) => {
        plan.functions[0]!.endInstruction = plan.functions[0]!.implicitReturnInstruction + 2;
      },
    ],
    [
      "entry before root end",
      "$.functions[0]",
      (plan) => {
        plan.functions[0]!.entryInstruction = plan.rootEndInstruction - 1;
      },
    ],
    [
      "gap between functions",
      "$.functions[1]",
      (plan) => {
        plan.functions[1]!.entryInstruction += 1;
      },
    ],
    [
      "overlapping functions",
      "$.functions[1]",
      (plan) => {
        plan.functions[1]!.entryInstruction = plan.functions[0]!.entryInstruction;
      },
    ],
  ];

  for (const [name, path, mutate] of cases) {
    const malformed = mutablePlan(twoFunctionPlan());
    mutate(malformed);
    assertPlanErrorAt(validateInstructionPlan(malformed), path, name);
  }
});

test("continues independent metadata validation after an unsafe function range", () => {
  const malformed = mutablePlan(twoFunctionPlan());
  malformed.functions[0]!.endInstruction = Number.MAX_SAFE_INTEGER;
  malformed.functions[1]!.id = malformed.functions[0]!.id;

  const result = validateInstructionPlan(malformed);

  assertPlanErrorAt(result, "$.functions[0]");
  assertPlanErrorAt(result, "$.functions[1].id");
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
  return error instanceof RuntimeDataError && error.code === "TSR100";
}

function isMalformedPlanCheckpointError(error: unknown): boolean {
  return (
    error instanceof CheckpointError &&
    error.info.code === "TSK002" &&
    error.info.path === "$.plan.functions[0]"
  );
}

/** Requires a structured plan rejection at the mutated metadata, without pinning diagnostic prose. */
function assertPlanErrorAt(
  result: ReturnType<typeof validateInstructionPlan>,
  path: string,
  label?: string,
): void {
  assert.equal(result.valid, false, label);
  assert.ok(
    result.errors.some((error) => error.code === "TSC002" && error.path === path),
    `${label ?? "plan"} reports TSC002 at ${path}`,
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
