import assert from "node:assert/strict";
import test from "node:test";

import { validateInstructionPlan } from "../src/plan/validation.js";
import type { Instruction, InstructionPlan } from "../src/plan/model.js";
import type { PlanValidationResult } from "../src/plan/validation.js";
import { CheckpointError, createCheckpoint, restoreCheckpoint } from "../src/runtime/checkpoint.js";
import { executeInstruction, run, RuntimeDataError } from "../src/runtime/engine.js";
import { createFreshRuntimeSnapshot, validateRuntimeSnapshot } from "../src/runtime/state.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";

test("reports malformed nested binary expression nodes at their plan paths", () => {
  const malformed = structuredClone(plan("let target = 0\ntarget = 1 + 2 + 3"));
  const assignment = malformed.instructions[1];
  assert.equal(assignment?.kind, "assign");
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- EVIDENCE: the compiler-produced second instruction is asserted above to be the assignment fixture being mutated.
  const mutableAssignment = assignment as unknown as { target: unknown; value: unknown };
  // EVIDENCE: the fixture's assignment value is compiled from the binary source expression `1 + 2 + 3`.
  const expression = structuredClone(mutableAssignment.value) as MutableBinaryExpression;
  mutableAssignment.target = expression;

  expression.operator = "invalid-root";
  // EVIDENCE: the compiler-produced left-associative `1 + 2 + 3` expression has a binary left child.
  const left = expression.left as MutableBinaryExpression;
  // EVIDENCE: the compiler-produced inner binary expression has literal `2` as its right child.
  const leftRight = left.right as MutableLiteralExpression;
  leftRight.value = {};
  // EVIDENCE: the compiler-produced right operand is literal `3`; only its kind is replaced.
  (expression.right as { kind: string }).kind = "unknown";

  const validation = validateInstructionPlan(malformed);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.every((error) => error.code === "TSC002"));
  assert.deepEqual(
    new Set(validation.errors.map((error) => error.path)),
    new Set([
      // A binary expression is not an assignable target, independent of its nested defects.
      "$.instructions[1].target",
      "$.instructions[1].target.operator",
      "$.instructions[1].target.left.right.value",
      "$.instructions[1].target.right.kind",
    ]),
  );
});

interface MutableBinaryExpression {
  kind: "binary";
  operator: unknown;
  left: unknown;
  right: unknown;
  span: unknown;
}

interface MutableLiteralExpression {
  kind: "literal";
  value: unknown;
  span: unknown;
}

test("rejects control-flow targets that leave the instruction's execution region", () => {
  const callSource = [
    'function first { say "first" }',
    'function second { say "second" }',
    "first()",
    "exit",
  ].join("\n");
  const defaultSource = [
    "function first(value = 1) { say value }",
    "function second { say 2 }",
    "first()",
    "exit",
  ].join("\n");
  const firstFunction = (compiled: InstructionPlan): number => compiled.functions[0]!.id;
  const rows: Array<{
    name: string;
    source: string;
    instruction: (compiled: InstructionPlan) => number;
    field: "target" | "continueTarget" | "returnInstruction";
    forbidden: (compiled: InstructionPlan) => number;
    // A loop or call-return rule also reports at this path, so only the message isolates the region rule.
    sharedPath?: true;
  }> = [
    {
      name: "root jump into a function prologue",
      source: rootBranchWithTwoFunctions(),
      instruction: (compiled) => rootInstructionIndex(compiled, "jump"),
      field: "target",
      forbidden: (compiled) => compiled.functions[1]!.entryInstruction,
    },
    {
      name: "root conditional jump into a function body",
      source: rootBranchWithTwoFunctions(),
      instruction: (compiled) => rootInstructionIndex(compiled, "jumpIfFalse"),
      field: "target",
      forbidden: (compiled) => compiled.functions[1]!.bodyEntryInstruction,
    },
    {
      name: "function jump into root execution",
      source: functionBranches(),
      instruction: (compiled) =>
        functionInstructionIndex(compiled, firstFunction(compiled), "jump"),
      field: "target",
      forbidden: () => 0,
    },
    {
      name: "function A jump into function B",
      source: functionBranches(),
      instruction: (compiled) =>
        functionInstructionIndex(compiled, firstFunction(compiled), "jump"),
      field: "target",
      forbidden: (compiled) => compiled.functions[1]!.bodyEntryInstruction,
    },
    {
      name: "function loopStart continue target into root execution",
      source: functionLoop(),
      instruction: (compiled) =>
        functionInstructionIndex(compiled, firstFunction(compiled), "loopStart"),
      field: "continueTarget",
      forbidden: () => 0,
      sharedPath: true,
    },
    {
      name: "function loopStart exit target into root execution",
      source: functionLoop(),
      instruction: (compiled) =>
        functionInstructionIndex(compiled, firstFunction(compiled), "loopStart"),
      field: "target",
      forbidden: () => 0,
      sharedPath: true,
    },
    {
      name: "function loopControl target into root execution",
      source: functionLoop(),
      instruction: (compiled) =>
        functionInstructionIndex(compiled, firstFunction(compiled), "loopControl"),
      field: "target",
      forbidden: () => 0,
      sharedPath: true,
    },
    {
      name: "root call return into a function body",
      source: callSource,
      instruction: (compiled) => rootInstructionIndex(compiled, "callFunction"),
      field: "returnInstruction",
      forbidden: (compiled) => compiled.functions[1]!.bodyEntryInstruction,
      sharedPath: true,
    },
    {
      name: "parameter default target into another function",
      source: defaultSource,
      instruction: (compiled) =>
        functionInstructionIndex(compiled, firstFunction(compiled), "prepareParameterDefault"),
      field: "target",
      forbidden: (compiled) => compiled.functions[1]!.entryInstruction,
    },
  ];

  for (const row of rows) {
    const compiled = plan(row.source);
    assert.equal(validateInstructionPlan(compiled).valid, true, row.name);
    const index = row.instruction(compiled);
    const malformed = mutateTarget(compiled, index, row.field, row.forbidden(compiled));

    const validation = validateInstructionPlan(malformed);
    const path = `$.instructions[${index}].${row.field}`;
    assertRegionError(validation, path, row.name);
    if (row.sharedPath) {
      assert.ok(
        validation.errors.some(
          (error) => error.path === path && error.message.includes("execution region"),
        ),
        row.name,
      );
    }
  }
});

test("validates break targets after multi-temporary condition cleanup", () => {
  const compiled = plan(
    ["function truth { return true }", "while truth() and truth() { break }"].join("\n"),
  );
  const loopIndex = rootInstructionIndex(compiled, "loopStart");
  const breakIndex = compiled.instructions.findIndex(
    (instruction) => instruction.kind === "loopControl" && instruction.action === "break",
  );
  assert.ok(breakIndex >= 0);
  assert.equal(validateInstructionPlan(compiled).valid, true);

  const malformed = mutateTarget(
    compiled,
    breakIndex,
    "target",
    targetOf(compiled, loopIndex, "target"),
  );
  const validation = validateInstructionPlan(malformed);
  assert.equal(validation.valid, false);
  assert.ok(
    validation.errors.some(
      (error) => error.code === "TSC002" && error.path === `$.instructions[${breakIndex}].target`,
    ),
  );
});

test("preserves a compiler-generated root-end target", () => {
  const compiled = plan(
    ['function hidden { say "hidden" }', 'if false { say "never" }'].join("\n"),
  );
  const jumpIndex = rootInstructionIndex(compiled, "jumpIfFalse");

  assert.equal(targetOf(compiled, jumpIndex, "target"), compiled.rootEndInstruction);
  assert.equal(validateInstructionPlan(compiled).valid, true);
});

test("preserves a compiler-generated owning-function implicit-return target", () => {
  const compiled = plan(
    ["function boundary {", '  if false { say "never" }', "}", "boundary()", "exit"].join("\n"),
  );
  const definition = compiled.functions[0]!;
  const jumpIndex = functionInstructionIndex(compiled, definition.id, "jumpIfFalse");

  assert.equal(targetOf(compiled, jumpIndex, "target"), definition.implicitReturnInstruction);
  assert.equal(validateInstructionPlan(compiled).valid, true);
});

test("prevents the poisoned-snapshot path before execution", () => {
  const original = plan(
    ['function hidden { say "inside function" }', "if false { exit }"].join("\n"),
  );
  const jumpIndex = rootInstructionIndex(original, "jumpIfFalse");
  const malformed = mutateTarget(
    original,
    jumpIndex,
    "target",
    original.functions[0]!.bodyEntryInstruction,
  );
  assertRegionError(validateInstructionPlan(malformed), `$.instructions[${jumpIndex}].target`);
  assert.throws(() => createFreshRuntimeSnapshot(malformed), TypeError);
  for (const operation of [executeInstruction, run]) {
    const snapshot = createFreshRuntimeSnapshot(original);
    const before = structuredClone(snapshot);
    assert.throws(
      () => operation(malformed, snapshot),
      (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR100",
    );
    assert.deepEqual(snapshot, before);
  }
});

test("rejects malformed cross-region plans during checkpoint restoration", () => {
  const original = plan(
    ['function hidden { say "inside function" }', "if false { exit }"].join("\n"),
  );
  const jumpIndex = rootInstructionIndex(original, "jumpIfFalse");
  const malformed = mutateTarget(
    original,
    jumpIndex,
    "target",
    original.functions[0]!.bodyEntryInstruction,
  );
  // EVIDENCE: JSON round-trips the runtime-created checkpoint before replacing its plan with the malformed clone.
  const checkpoint = JSON.parse(
    JSON.stringify(createCheckpoint(original, createFreshRuntimeSnapshot(original))),
  ) as { plan: InstructionPlan };
  checkpoint.plan = malformed;

  assert.throws(
    () => restoreCheckpoint(checkpoint),
    (error: unknown) => {
      return (
        error instanceof CheckpointError &&
        error.info.code === "TSK002" &&
        error.info.path === `$.plan.instructions[${jumpIndex}].target`
      );
    },
  );
});

test("keeps snapshots valid after accepted root control flow reaches its boundary", () => {
  const compiled = plan(
    ['function hidden { say "hidden" }', 'if false { say "never" }'].join("\n"),
  );
  const initial = createFreshRuntimeSnapshot(compiled);
  const first = executeInstruction(compiled, initial);

  assert.equal(first.snapshot.status, "halted");
  assert.equal(first.snapshot.nextInstruction, compiled.rootEndInstruction);
  assert.equal(validateRuntimeSnapshot(first.snapshot, compiled).valid, true);
});

test("rejects forged prepared say fields and lifetimes before any script event executes", () => {
  const ordinary = plan('say "first", instant\nsay "second", instant');
  const secondSay = ordinary.instructions.findIndex(
    (instruction, index) => index > 0 && instruction.kind === "say",
  );
  assert.ok(secondSay >= 0);
  // EVIDENCE: JSON preserves the compiler-produced plan before the fixture forges a prepared speaker temporary.
  const forgedSpeaker = JSON.parse(JSON.stringify(ordinary)) as InstructionPlan & {
    temporaryCount: number;
  };
  forgedSpeaker.temporaryCount = 1;
  assert.equal(validateInstructionPlan(forgedSpeaker).valid, true);
  const forgedSay = forgedSpeaker.instructions[secondSay];
  assert.ok(forgedSay?.kind === "say");
  // EVIDENCE: fixture adds the newly allocated in-range temporary as a prepared speaker to an otherwise static say.
  (forgedSay as { speakerTemporary?: number }).speakerTemporary = 1;
  assert.ok(
    validateInstructionPlan(forgedSpeaker).errors.some(
      (error) =>
        error.code === "TSC002" && error.path === `$.instructions[${secondSay}].speakerTemporary`,
    ),
  );
  assert.throws(
    () => run(forgedSpeaker, createFreshRuntimeSnapshot(ordinary)),
    (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR100",
  );

  const prepared = plan(
    ["function pace { return 1 }", 'say ["first", "second"], pace()'].join("\n"),
  );
  const sayIndex = prepared.instructions.findIndex((instruction) => instruction.kind === "say");
  const say = prepared.instructions[sayIndex];
  assert.equal(say?.kind, "say");
  if (
    say?.kind !== "say" ||
    typeof say.speakerTemporary !== "number" ||
    typeof say.textTemporary !== "number" ||
    typeof say.contextualSpeakerTemporary !== "number"
  ) {
    throw new Error("Expected prepared say fields.");
  }

  const speakerPreparation = prepared.instructions.findIndex(
    (instruction) => instruction.kind === "prepareSaySpeaker",
  );
  const textPreparation = prepared.instructions.findIndex(
    (instruction) => instruction.kind === "prepareSayText",
  );
  const pacingCall = prepared.instructions.findIndex(
    (instruction) => instruction.kind === "callFunction",
  );
  const pacingStore = prepared.instructions.findIndex(
    (instruction) => instruction.kind === "storeTemporary",
  );
  assert.ok(speakerPreparation >= 0);
  assert.ok(textPreparation >= 0);
  assert.ok(pacingCall >= 0);
  assert.ok(pacingStore >= 0);

  const forgedText = JSON.parse(JSON.stringify(prepared));
  forgedText.temporaryCount += 1;
  assert.equal(validateInstructionPlan(forgedText).valid, true);
  forgedText.instructions[sayIndex].textTemporary = forgedText.temporaryCount;
  assert.ok(
    validateInstructionPlan(forgedText).errors.some(
      (error) =>
        error.code === "TSC002" && error.path === `$.instructions[${sayIndex}].textTemporary`,
    ),
  );

  const sayPath = `$.instructions[${sayIndex}]`;
  // Each row names the path of the rule it breaks; a fragment is added where another rule
  // reports at the same path.
  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: fixture callbacks deliberately rewrite prepared-say producer, consumer, temporary, and control-flow fields into invalid combinations.
  const cases: Array<[string, string, (candidate: any) => void, string?]> = [
    [
      "wrong producer kind",
      `${sayPath}.speakerTemporary`,
      (candidate) => {
        candidate.instructions[sayIndex].speakerTemporary = say.textTemporary;
      },
    ],
    [
      "aliased preparation temporaries",
      `${sayPath}.textTemporary`,
      (candidate) => {
        candidate.instructions[sayIndex].textTemporary = say.speakerTemporary;
      },
      "alias",
    ],
    [
      "aliased contextual speaker temporary",
      `${sayPath}.contextualSpeakerTemporary`,
      (candidate) => {
        candidate.instructions[sayIndex].contextualSpeakerTemporary = say.speakerTemporary;
      },
      "alias",
    ],
    [
      "missing contextual speaker producer",
      `${sayPath}.contextualSpeakerTemporary`,
      (candidate) => {
        delete candidate.instructions[sayIndex].contextualSpeakerTemporary;
      },
    ],
    [
      "orphaned preparation instructions",
      `$.instructions[${textPreparation}]`,
      (candidate) => {
        delete candidate.instructions[sayIndex].speakerTemporary;
        delete candidate.instructions[sayIndex].textTemporary;
      },
    ],
    [
      "duplicate prepared speaker producer",
      `${sayPath}.speakerTemporary`,
      (candidate) => {
        candidate.instructions[textPreparation].destinationTemporary = say.speakerTemporary;
      },
    ],
    [
      "prepared speaker overwritten by store",
      `${sayPath}.speakerTemporary`,
      (candidate) => {
        candidate.instructions[pacingStore].temporaryId = say.speakerTemporary;
        candidate.instructions[sayIndex].pacing.temporaryId = say.speakerTemporary;
      },
    ],
    [
      "prepared text overwritten by store",
      `${sayPath}.textTemporary`,
      (candidate) => {
        candidate.instructions[pacingStore].temporaryId = say.textTemporary;
        candidate.instructions[sayIndex].pacing.temporaryId = say.textTemporary;
      },
    ],
    [
      "prepared speaker overwritten by a function call",
      `${sayPath}.speakerTemporary`,
      (candidate) => {
        candidate.instructions[pacingCall].destinationTemporary = say.speakerTemporary;
        candidate.instructions[pacingStore].value.temporaryId = say.speakerTemporary;
      },
    ],
    [
      "prepared speaker cleared before its say",
      `${sayPath}.speakerTemporary`,
      (candidate) => {
        candidate.instructions[pacingStore] = {
          kind: "clearTemporary",
          temporaryId: say.speakerTemporary,
          span: candidate.instructions[pacingStore].span,
        };
      },
    ],
    [
      "prepared text cleared before its say",
      `${sayPath}.textTemporary`,
      (candidate) => {
        candidate.instructions[pacingStore] = {
          kind: "clearTemporary",
          temporaryId: say.textTemporary,
          span: candidate.instructions[pacingStore].span,
        };
      },
    ],
    [
      "backedge re-enters a prepared say",
      sayPath,
      (candidate) => {
        candidate.instructions[sayIndex + 1] = {
          kind: "jump",
          target: sayIndex,
          span: candidate.instructions[sayIndex + 1].span,
        };
      },
    ],
  ];
  for (const [name, path, mutate, fragment] of cases) {
    const malformed = JSON.parse(JSON.stringify(prepared));
    mutate(malformed);
    const validation = validateInstructionPlan(malformed);
    assert.ok(
      validation.errors.some(
        (error) =>
          error.code === "TSC002" &&
          error.path === path &&
          (fragment === undefined || error.message.includes(fragment)),
      ),
      `${name}: ${JSON.stringify(validation.errors)}`,
    );
  }

  const contextual = plan(
    [
      'speaker vera { title: "Captain" }',
      "function pace { return 1 }",
      'say as vera "${speaker.title}", pace()',
    ].join("\n"),
  );
  const contextualSpeakerPreparation = contextual.instructions.findIndex(
    (instruction) => instruction.kind === "prepareSaySpeaker",
  );
  const contextualCapture = contextual.instructions.findIndex(
    (instruction) => instruction.kind === "prepareSayContextualSpeaker",
  );
  const contextualTextPreparation = contextual.instructions.findIndex(
    (instruction) => instruction.kind === "prepareSayText",
  );
  assert.ok(contextualSpeakerPreparation >= 0);
  assert.ok(contextualCapture >= 0);
  assert.ok(contextualTextPreparation >= 0);
  for (const [name, left, right] of [
    [
      "contextual capture before its output speaker",
      contextualSpeakerPreparation,
      contextualCapture,
    ],
    [
      "contextual capture after a text payload consumer",
      contextualCapture,
      contextualTextPreparation,
    ],
  ] as const) {
    const malformed = structuredClone(contextual);
    // EVIDENCE: fixture reorders two compiler-produced instructions while preserving each instruction value.
    const mutableInstructions = malformed.instructions as Instruction[];
    assert.ok(mutableInstructions[left] !== undefined && mutableInstructions[right] !== undefined);
    [mutableInstructions[left], mutableInstructions[right]] = [
      mutableInstructions[right],
      mutableInstructions[left],
    ];
    assert.equal(validateInstructionPlan(malformed).valid, false, name);
    const initial = createFreshRuntimeSnapshot(contextual);
    const beforeExecution = structuredClone(initial);
    assert.throws(
      () => run(malformed, initial),
      (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR100",
      name,
    );
    assert.deepEqual(initial, beforeExecution, `${name} rejects before script execution`);
  }

  const contextualPayloadCases = [
    {
      name: "contextual capture pair after prepared text",
      source: [
        'speaker vera { title: "Captain" }',
        "function pace { return 1 }",
        'say as vera "${speaker.title}", pace()',
      ].join("\n"),
      consumerKind: "prepareSayText",
    },
    {
      name: "contextual capture pair after text-side call payload",
      source: [
        'speaker vera { title: "Captain" }',
        "function use(x) { return x.title }",
        "say as vera use(speaker), instant",
      ].join("\n"),
      consumerKind: "callFunction",
    },
    {
      name: "contextual capture pair after prepared text short-circuit payload",
      source: [
        'speaker vera { title: "Captain" }',
        "function pace { return 1 }",
        'say as vera "${true and speaker.title}", pace()',
      ].join("\n"),
      consumerKind: "prepareSayText",
    },
    {
      name: "contextual capture pair after text-side call short-circuit payload",
      source: [
        'speaker vera { title: "Captain" }',
        "function use(x) { return x.title }",
        "say as vera use(true or speaker), instant",
      ].join("\n"),
      consumerKind: "callFunction",
    },
  ] as const;
  for (const scenario of contextualPayloadCases) {
    const canonical = plan(scenario.source);
    assert.equal(validateInstructionPlan(canonical).valid, true, scenario.name);
    const speakerPreparation = canonical.instructions.findIndex(
      (instruction) => instruction.kind === "prepareSaySpeaker",
    );
    const contextualPreparation = canonical.instructions.findIndex(
      (instruction) => instruction.kind === "prepareSayContextualSpeaker",
    );
    const payloadConsumer = canonical.instructions.findIndex(
      (instruction, instructionIndex) =>
        instructionIndex > contextualPreparation && instruction.kind === scenario.consumerKind,
    );
    assert.ok(speakerPreparation >= 0);
    assert.ok(contextualPreparation >= 0);
    assert.ok(payloadConsumer >= 0);
    const malformed = structuredClone(canonical);
    // EVIDENCE: fixture relocates the compiler-produced contextual-speaker preparation pair without changing it.
    const mutableInstructions = malformed.instructions as Instruction[];
    const pair = mutableInstructions.splice(speakerPreparation, 2);
    mutableInstructions.splice(payloadConsumer - 1, 0, ...pair);
    assert.equal(validateInstructionPlan(malformed).valid, false, scenario.name);
    const initial = createFreshRuntimeSnapshot(canonical);
    const beforeExecution = structuredClone(initial);
    assert.throws(
      () => run(malformed, initial),
      (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR100",
      scenario.name,
    );
    assert.deepEqual(initial, beforeExecution, `${scenario.name} rejects before script execution`);
  }

  const malformed = JSON.parse(JSON.stringify(prepared));
  malformed.instructions[pacingStore].temporaryId = say.speakerTemporary;
  malformed.instructions[sayIndex].pacing.temporaryId = say.speakerTemporary;
  let randomCalls = 0;
  const initial = createFreshRuntimeSnapshot(prepared);
  const beforeExecution = structuredClone(initial);
  assert.throws(
    () =>
      run(malformed, initial, {
        random: {
          next: () => {
            randomCalls += 1;
            return 0.5;
          },
        },
      }),
    (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR100",
  );
  assert.deepEqual(
    initial,
    beforeExecution,
    "malformed plan does not mutate canonical runtime state",
  );
  assert.equal(randomCalls, 0, "malformed plan is rejected before source evaluation or events");

  const bypassable = plan(
    [
      'function textValue { return "hello" }',
      "function pace { return 1 }",
      "say false and textValue(), pace()",
    ].join("\n"),
  );
  const bypassSay = bypassable.instructions.findIndex((instruction) => instruction.kind === "say");
  const bypassTextPreparation = bypassable.instructions.findIndex(
    (instruction) => instruction.kind === "prepareSayText",
  );
  const bypassJump = bypassable.instructions.findIndex(
    (instruction, index) => index < bypassTextPreparation && instruction.kind === "jumpIfFalse",
  );
  assert.ok(bypassJump >= 0);
  // EVIDENCE: JSON preserves the compiler-produced plan before its conditional target is redirected.
  const malformedBypass = JSON.parse(JSON.stringify(bypassable)) as InstructionPlan;
  const malformedJump = malformedBypass.instructions[bypassJump];
  assert.ok(malformedJump?.kind === "jumpIfFalse");
  // EVIDENCE: fixture mutates only the validated conditional target so prepared text is bypassed.
  (malformedJump as { target: number }).target = bypassSay;
  assert.equal(validateInstructionPlan(malformedBypass).valid, false, "bypassed prepared text");
});

test("preserves compiler-generated prepared says across control-flow regions", () => {
  const sources = [
    [
      'function textValue { return "hello" }',
      "function pace { return 1 }",
      "say textValue(), instant",
      'say "pacing", pace()',
      "say textValue(), pace()",
    ].join("\n"),
    [
      'function textValue { return "hello" }',
      "function pace { return 1 }",
      "if true {",
      "  say textValue(), pace()",
      "}",
      "repeat 2 {",
      "  say textValue(), pace()",
      "}",
    ].join("\n"),
    [
      'function textValue { return "hello" }',
      "function pace { return 1 }",
      "function speak {",
      "  say textValue(), pace()",
      "}",
      "speak()",
    ].join("\n"),
  ];

  // compileSource validates every plan it produces, so compiling without diagnostics is the oracle.
  for (const source of sources) plan(source);
});

function rootBranchWithTwoFunctions(): string {
  return [
    'function first { say "first" }',
    'function second { say "second" }',
    "if true {",
    '  say "root then"',
    "} else {",
    '  say "root else"',
    "}",
    "exit",
  ].join("\n");
}

function functionBranches(): string {
  return [
    "function first {",
    "  if true {",
    '    say "first then"',
    "  } else {",
    '    say "first else"',
    "  }",
    "}",
    "function second {",
    "  if true {",
    '    say "second then"',
    "  } else {",
    '    say "second else"',
    "  }",
    "}",
    "if true {",
    '  say "root then"',
    "} else {",
    '  say "root else"',
    "}",
    "first()",
    "exit",
  ].join("\n");
}

function functionLoop(): string {
  return ["function looper {", "  repeat 2 {", "    continue", "  }", "}", "looper()", "exit"].join(
    "\n",
  );
}

function rootInstructionIndex(plan: InstructionPlan, kind: Instruction["kind"]): number {
  const index = plan.instructions.findIndex(
    (instruction, instructionIndex) =>
      instructionIndex < plan.rootEndInstruction && instruction.kind === kind,
  );
  assert.notEqual(index, -1, `Expected root ${kind} instruction.`);
  return index;
}

function functionInstructionIndex(
  plan: InstructionPlan,
  functionId: number,
  kind: Instruction["kind"],
): number {
  const definition = plan.functions.find((item) => item.id === functionId);
  assert.ok(definition !== undefined);
  for (let index = definition.entryInstruction; index < definition.endInstruction; index += 1) {
    if (plan.instructions[index]?.kind === kind) return index;
  }
  assert.fail(`Expected function ${functionId} ${kind} instruction.`);
}

function mutateTarget(
  plan: InstructionPlan,
  instructionIndex: number,
  field: "target" | "continueTarget" | "returnInstruction",
  target: number,
): InstructionPlan {
  // EVIDENCE: JSON preserves the compiler-produced plan before the selected control-flow target is changed.
  const clone = JSON.parse(JSON.stringify(plan)) as InstructionPlan;
  // EVIDENCE: the caller selects a numeric control-flow field present on the instruction kind found for this fixture.
  const instruction = clone.instructions[instructionIndex] as Instruction & {
    continueTarget?: number;
    returnInstruction?: number;
    target?: number;
  };
  instruction[field] = target;
  return clone;
}

function targetOf(
  plan: InstructionPlan,
  instructionIndex: number,
  field: "target" | "continueTarget" | "returnInstruction",
): number {
  // EVIDENCE: callers request a numeric control-flow field from an instruction index selected by kind.
  const instruction = plan.instructions[instructionIndex] as Instruction & {
    continueTarget?: number;
    returnInstruction?: number;
    target?: number;
  };
  const target = instruction[field];
  assert.equal(typeof target, "number");
  // EVIDENCE: the immediately preceding assertion narrows the selected control-flow target to number.
  return target as number;
}

function assertRegionError(result: PlanValidationResult, path: string, label?: string): void {
  assert.equal(result.valid, false, label);
  assert.ok(
    result.errors.some((error) => error.code === "TSC002" && error.path === path),
    label,
  );
}
