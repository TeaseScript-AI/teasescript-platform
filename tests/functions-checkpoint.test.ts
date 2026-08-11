import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { InstructionPlan } from "../src/plan/model.js";
import {
  CHECKPOINT_VERSION,
  CheckpointError,
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import {
  executeInstruction,
  run,
  type RuntimeBuiltinFunction,
} from "../src/runtime/engine.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import type { SerializableRuntimeValue } from "../src/runtime/serializable-values.js";
import {
  createFreshRuntimeSnapshot,
  MAX_SUPPORTED_CALL_DEPTH,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import {
  withValidationTestStatistics,
} from "../src/validation-testing.js";
import { assertRuntimeResumeEquivalent } from "./helpers/runtime-equivalence.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";

test("restores every instruction boundary during defaults and nested calls", () => {
  const { boundaries: observations } = assertRuntimeResumeEquivalent([
    "let count = 0",
    "function next(value) { count = count + 1\nreturn `${value}:${count}` }",
    'function describe(name, title = next(name)) { say `inside:${title}`\nreturn title }',
    'say describe("pet")',
  ].join("\n"));

  assert.ok(observations.some((snapshot) =>
    snapshot.callFrames.at(-1)?.parameterState.phase === "supplied" &&
    snapshot.callFrames.at(-1)?.parameterState.parameterIndex === 0
  ));
  assert.ok(observations.some((snapshot) =>
    snapshot.callFrames.some((frame) => frame.parameterState.phase === "defaults")
  ));
  assert.ok(observations.some((snapshot) => snapshot.callFrames.length >= 2));
  assert.ok(observations.some((snapshot) =>
    snapshot.callFrames.length === 0 && snapshot.temporaries.length > 0
  ));
});

test("checkpoint restoration accepts the configured call-depth ceiling", () => {
  const compiled = plan("exit");
  const snapshot = createFreshRuntimeSnapshot(compiled, {
    maxCallDepth: MAX_SUPPORTED_CALL_DEPTH,
  });

  assert.equal(
    restoreCheckpoint(createCheckpoint(compiled, snapshot)).snapshot.maxCallDepth,
    MAX_SUPPORTED_CALL_DEPTH,
  );
});

test("restores inside function loops, after continue, and before early return", () => {
  const { boundaries: observations } = assertRuntimeResumeEquivalent([
    "function find(limit) {",
    "  for value in 1..=limit {",
    "    if value == 1 { continue }",
    '    say `loop:${value}`',
    "    if value == 3 { return value }",
    "  }",
    "  return null",
    "}",
    "say find(4)",
  ].join("\n"));

  assert.ok(observations.some((snapshot) =>
    snapshot.callFrames.length === 1 && snapshot.loopFrames.length === 1
  ));
  assert.ok(observations.some((snapshot) => {
    const next = snapshot.nextInstruction;
    return snapshot.callFrames.length === 1 && snapshot.loopFrames.length === 1 && next >= 0;
  }));
});

test("restores direct and mutual recursion at every instruction boundary", () => {
  const { boundaries: direct } = assertRuntimeResumeEquivalent([
    "function factorial(value) {",
    "  if value <= 1 { return 1 }",
    "  return value * factorial(value - 1)",
    "}",
    "say factorial(5)",
  ].join("\n"));
  assert.ok(direct.some((snapshot) => snapshot.callFrames.length >= 4));

  const { boundaries: mutual } = assertRuntimeResumeEquivalent([
    "function even(value) { if value == 0 { return true }\nreturn odd(value - 1) }",
    "function odd(value) { if value == 0 { return false }\nreturn even(value - 1) }",
    "say even(5)",
  ].join("\n"));
  assert.ok(mutual.some((snapshot) =>
    snapshot.callFrames.some((frame) => frame.functionName === "even") &&
    snapshot.callFrames.some((frame) => frame.functionName === "odd")
  ));
});

test("restores between nested calls and around say events without duplicates", () => {
  const { boundaries: observations } = assertRuntimeResumeEquivalent([
    "function first { say \"first\"\nreturn 1 }",
    "function second { say \"second\"\nreturn 2 }",
    "say first() + second()",
  ].join("\n"));

  assert.ok(observations.some((snapshot) =>
    snapshot.callFrames.length === 0 &&
    snapshot.temporaries.length > 0 &&
    snapshot.status === "running"
  ));
});

test("restores exact RNG state through nested calls", () => {
  const { boundaries: observations } = assertRuntimeResumeEquivalent([
    "function roll { return randomInteger(1..=6) }",
    "function pair { return roll() + roll() }",
    "say pair()",
    "say roll()",
  ].join("\n"));

  assert.ok(new Set(observations.map((snapshot) => snapshot.rng.state)).size > 1);
});

test("preserves prepared earlier arguments through a later suspension and a suspended callee", () => {
  const compiled = plan([
    "function later { wait 1 ms\nreturn random() }",
    "function combine(first, second) { wait 2 ms\nreturn first + second }",
    "combine(random(), later())",
  ].join("\n"));
  const combine = compiled.functions.find((definition) => definition.name === "combine")!;
  const combineCall = compiled.instructions.find(
    (instruction) => instruction.kind === "callFunction" && instruction.functionId === combine.id,
  );
  assert.equal(combineCall?.kind, "callFunction");
  if (combineCall?.kind !== "callFunction") return;

  const firstPending = run(compiled, createFreshRuntimeSnapshot(compiled, { seed: 0x2468_ace1 }));
  assert.equal(firstPending.snapshot.status, "waiting");
  assert.equal(firstPending.snapshot.callFrames.at(-1)?.functionName, "later");
  assert.equal(combineCall.arguments[0]!.value.kind, "temporary");
  const earlierTemporary = combineCall.arguments[0]!.value.kind === "temporary"
    ? combineCall.arguments[0]!.value.temporaryId
    : -1;
  assert.ok(firstPending.snapshot.callFrames.at(-1)?.callerTemporaries.some(
    (temporary) => temporary.id === earlierTemporary,
  ));
  const firstAction = firstPending.snapshot.foregroundAction;
  assert.equal(firstAction?.kind, "delay");
  const firstRestored = deserializeCheckpoint(serializeCheckpoint(
    createCheckpoint(compiled, firstPending.snapshot),
  ));
  const directSecondPending = run(
    compiled,
    observeTime(compiled, firstPending.snapshot, firstAction!.deadlineMs).snapshot,
  );
  const restoredSecondPending = run(
    firstRestored.plan,
    observeTime(firstRestored.plan, firstRestored.snapshot, firstAction!.deadlineMs).snapshot,
  );
  assert.deepEqual(restoredSecondPending, directSecondPending);
  assert.equal(directSecondPending.snapshot.status, "waiting");
  assert.equal(directSecondPending.snapshot.callFrames.at(-1)?.functionName, "combine");
  assert.deepEqual(
    directSecondPending.snapshot.callFrames.at(-1)?.arguments.map((argument) => argument.supplied),
    [true, true],
  );
  const forgedWaiting = mutableCheckpoint(createCheckpoint(compiled, directSecondPending.snapshot));
  forgedWaiting.snapshot.callFrames.at(-1)!.arguments[0] = {
    parameterName: "first",
    supplied: false,
  };
  assert.equal(validateRuntimeSnapshot(forgedWaiting.snapshot, compiled).valid, false);
  assertCheckpointRejected(forgedWaiting, "TSK002");

  const secondAction = directSecondPending.snapshot.foregroundAction;
  assert.equal(secondAction?.kind, "delay");
  const secondRestored = deserializeCheckpoint(serializeCheckpoint(
    createCheckpoint(compiled, directSecondPending.snapshot),
  ));
  const direct = run(
    compiled,
    observeTime(compiled, directSecondPending.snapshot, secondAction!.deadlineMs).snapshot,
  );
  const resumed = run(
    secondRestored.plan,
    observeTime(secondRestored.plan, secondRestored.snapshot, secondAction!.deadlineMs).snapshot,
  );
  assert.deepEqual(resumed, direct);
  assert.equal(direct.snapshot.status, "halted");
  assert.equal(direct.snapshot.callFrames.length, 0);
  assert.equal(direct.snapshot.temporaries.length, 0);
});

test("builds snapshot indexes once and reuses liveness for same-signature call frames", () => {
  const { plan: compiled, snapshot } = recursiveSnapshot(4);
  const statistics = withValidationTestStatistics((finish) => {
    assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true);
    return finish();
  }).counts;

  assert.equal(statistics.snapshotAnalysisBuilds, 1);
  assert.equal(statistics.defaultBindingIndexBuilds, 1);
  assert.equal(statistics.parameterNameIndexBuilds, 1);
  assert.equal(statistics.livenessComputations, 1);
  assert.equal(statistics.livenessTableAllocations, 1);
  assert.equal(statistics.livenessCacheInsertions, 1);
  assert.equal(statistics.livenessCacheHits, snapshot.callFrames.length - 1);
});

test("validates suspended caller liveness without historical argument-value comparison", () => {
  const compiled = plan([
    "function recurse(value, first, second, third, fourth, fifth) {",
    "  if value == 0 { return first }",
    "  return recurse(value - 1, first, second, third, fourth, fifth)",
    "}",
    "say recurse(3, 1, 2, 3, 4, 5)",
  ].join("\n"));
  const snapshot = executeUntil(compiled, (candidate) => candidate.callFrames.length === 3);
  assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true);

  const missing = structuredClone(snapshot) as any;
  missing.callFrames[0].callerTemporaries = [];
  assert.equal(validateRuntimeSnapshot(missing, compiled).valid, false);
  const changed = structuredClone(snapshot) as any;
  changed.callFrames[0].arguments[0].value = 99;
  assert.equal(validateRuntimeSnapshot(changed, compiled).valid, true);
});

test("treats unbound call-frame argument values as canonical resumable state", () => {
  const compiled = plan("function identity(value) { return value }\nsay identity({ outer: { items: [1, 2] } })");
  const snapshot = executeUntil(compiled, (candidate) =>
    candidate.callFrames.at(-1)?.parameterState.phase === "supplied" &&
    candidate.callFrames.at(-1)?.parameterState.parameterIndex === 0
  );
  const changed = structuredClone(snapshot) as any;
  changed.callFrames[0].arguments[0].value.properties[0].value.properties[0].value.items[1] = 99;
  assert.equal(validateRuntimeSnapshot(changed, compiled).valid, true);
  assert.doesNotThrow(() => restoreCheckpoint(createCheckpoint(compiled, changed)));
});

test("detailed validation records liveness work without rejecting valid state", () => {
  const { plan: compiled, snapshot } = recursiveSnapshot(3);
  const checkpoint = createCheckpoint(compiled, snapshot);
  const snapshotBefore = JSON.stringify(snapshot);
  const statistics = withValidationTestStatistics((finish) => {
    assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true);
    assert.doesNotThrow(() => run(compiled, snapshot));
    assert.doesNotThrow(() => restoreCheckpoint(checkpoint));
    return finish();
  }).counts;

  assert.equal(JSON.stringify(snapshot), snapshotBefore);
  assert.ok((statistics.livenessTableAllocations ?? 0) > 0);
  assert.ok((statistics.livenessComputations ?? 0) > 0);
  assert.ok((statistics.livenessCacheInsertions ?? 0) > 0);
  assert.ok((statistics.detailedWorkConsumed ?? 0) > 0);
});

test("checkpoint creation defensively isolates the supplied plan", () => {
  const original = mutablePlan(plan("function value { return 1 }\nsay value()"));
  const snapshot = createImmediatePacingRuntimeSnapshot(original as InstructionPlan);
  const checkpoint = createCheckpoint(original as InstructionPlan, snapshot);
  const originalName = checkpoint.plan.functions[0]!.name;

  original.functions[0]!.name = "mutated";
  assert.equal(checkpoint.plan.functions[0]!.name, originalName);
});

test("rejects malformed active call-frame identity and return state", () => {
  const { plan: compiled, snapshot } = recursiveSnapshot(3);
  const cases: Array<(checkpoint: MutableCheckpoint) => void> = [
    (checkpoint) => { checkpoint.snapshot.callFrames[0]!.functionId = 999; },
    (checkpoint) => { checkpoint.snapshot.callFrames[0]!.returnInstruction = 999; },
    (checkpoint) => {
      checkpoint.snapshot.callFrames[1]!.id = checkpoint.snapshot.callFrames[0]!.id;
    },
    (checkpoint) => { checkpoint.snapshot.callFrames[0]!.scopeBaseDepth = 0; },
    (checkpoint) => { checkpoint.snapshot.callFrames[0]!.loopBaseDepth = 999; },
    (checkpoint) => { checkpoint.snapshot.callFrames[0]!.destinationTemporary = 0; },
    (checkpoint) => {
      checkpoint.snapshot.callFrames.at(-1)!.parameterState.parameterIndex = 999;
    },
    (checkpoint) => { checkpoint.snapshot.maxCallDepth = 1; },
  ];

  for (const mutate of cases) {
    const checkpoint = mutableCheckpoint(createCheckpoint(compiled, snapshot));
    mutate(checkpoint);
    assertCheckpointRejected(checkpoint, "TSK002");
  }
});

test("rejects inconsistent argument supply and parameter bindings", () => {
  const compiled = plan("function echo(input) { return input }\necho(1)");
  const call = compiled.instructions.find(
    (instruction) => instruction.kind === "callFunction",
  );
  assert.equal(call?.kind, "callFunction");
  if (call?.kind !== "callFunction") return;
  const occupiedBeforeCall = structuredClone(createFreshRuntimeSnapshot(compiled));
  occupiedBeforeCall.temporaries.push({
    id: call.destinationTemporary,
    value: null,
  });
  assert.equal(validateRuntimeSnapshot(occupiedBeforeCall, compiled).valid, false);

  let snapshot = createFreshRuntimeSnapshot(compiled);
  snapshot = executeInstruction(compiled, snapshot).snapshot;
  snapshot = executeInstruction(compiled, snapshot).snapshot;

  const changedArgument = mutableCheckpoint(createCheckpoint(compiled, snapshot));
  changedArgument.snapshot.callFrames[0]!.arguments[0]!.value = 99;
  assert.equal(validateRuntimeSnapshot(changedArgument.snapshot, compiled).valid, true);
  assert.doesNotThrow(() => restoreCheckpoint(changedArgument));

  const inconsistentSupply = mutableCheckpoint(createCheckpoint(compiled, snapshot));
  inconsistentSupply.snapshot.callFrames[0]!.arguments[0] = {
    parameterName: "input",
    supplied: false,
  };
  assert.equal(validateRuntimeSnapshot(inconsistentSupply.snapshot, compiled).valid, false);
  assertCheckpointRejected(inconsistentSupply, "TSK002");

  const wrongParameter = mutableCheckpoint(createCheckpoint(compiled, snapshot));
  wrongParameter.snapshot.callFrames[0]!.arguments[0]!.parameterName = "forged";
  assert.equal(validateRuntimeSnapshot(wrongParameter.snapshot, compiled).valid, false);
  assertCheckpointRejected(wrongParameter, "TSK002");

  const duplicateParameter = mutableCheckpoint(createCheckpoint(compiled, snapshot));
  duplicateParameter.snapshot.callFrames[0]!.arguments.push(
    structuredClone(duplicateParameter.snapshot.callFrames[0]!.arguments[0]!),
  );
  assert.equal(validateRuntimeSnapshot(duplicateParameter.snapshot, compiled).valid, false);
  assertCheckpointRejected(duplicateParameter, "TSK002");

  const occupiedDestination = mutableCheckpoint(createCheckpoint(compiled, snapshot));
  const frame = occupiedDestination.snapshot.callFrames[0]!;
  frame.callerTemporaries.push({ id: frame.destinationTemporary, value: null });
  assertCheckpointRejected(occupiedDestination, "TSK002");

  const optional = plan("function sample(required, optional = 2) { return required }\nsample(1)");
  const optionalFrame = executeUntil(optional, (candidate) => candidate.callFrames.length === 1);
  const forgedSupplied = mutableCheckpoint(createCheckpoint(optional, optionalFrame));
  forgedSupplied.snapshot.callFrames[0]!.arguments[1] = {
    parameterName: "optional",
    supplied: true,
    value: 2,
  };
  assert.equal(validateRuntimeSnapshot(forgedSupplied.snapshot, optional).valid, false);
  assertCheckpointRejected(forgedSupplied, "TSK002");

  snapshot = executeInstruction(compiled, snapshot).snapshot;
  const missingBinding = mutableCheckpoint(createCheckpoint(compiled, snapshot));
  missingBinding.snapshot.frames[1]!.bindings = [];
  assertCheckpointRejected(missingBinding, "TSK002");
});

test("rejects a missing temporary required by the next instruction", () => {
  const compiled = plan("function value { return 1 }\nlet result = value()");
  let snapshot = createFreshRuntimeSnapshot(compiled);
  while (snapshot.callFrames.length > 0 || snapshot.temporaries.length === 0) {
    snapshot = executeInstruction(compiled, snapshot).snapshot;
  }

  const checkpoint = mutableCheckpoint(createCheckpoint(compiled, snapshot));
  checkpoint.snapshot.temporaries = [];
  assertCheckpointRejected(checkpoint, "TSK002");
});

test("restores between assignment-target and right-hand call evaluation", () => {
  const { boundaries: observations } = assertRuntimeResumeEquivalent([
    "let order = []",
    "let items = [0]",
    'function indexFunction { order.add("index")\nreturn 0 }',
    'function valueFunction { order.add("value")\nreturn 7 }',
    "items[indexFunction()] = valueFunction()",
    "let randomItems = [0, 0]",
    "randomItems[randomInteger(0..=1)] = randomInteger(7..=9)",
    "say `${order[0]}:${order[1]}:${items[0]}`",
  ].join("\n"));

  assert.ok(observations.some((snapshot) =>
    snapshot.callFrames.at(-1)?.functionName === "valueFunction" &&
    snapshot.callFrames.at(-1)!.callerTemporaries.length > 0
  ));
});

test("restores mixed ordinary and user-call evaluation at every instruction boundary", () => {
  const { boundaries: observations } = assertRuntimeResumeEquivalent([
    "let order = []",
    "let first = { nested: [0] }",
    "let second = { nested: [0] }",
    "let target = first",
    "function mark(value) { order.add(value)\nreturn value }",
    "function retarget { target = second\nreturn 7 }",
    'let listValue = [random(), mark("list")]',
    'let setValue = set[randomInteger(1..=3), mark("set")]',
    'let objectValue = { first: random(), second: mark("object") }',
    'let templateValue = `${random()}:${mark("template")}`',
    "let binaryValue = random() + mark(2)",
    "let rangeValue = randomInteger(0..=1)..mark(3)",
    "target.nested[0] = retarget()",
    "target.nested.add(mark(8))",
    "say `${first.nested[0]}:${second.nested[0]}:${target.nested.length}:${order.length}`",
  ].join("\n"));

  assert.ok(observations.some((snapshot) =>
    snapshot.temporaries.some((temporary) =>
      serializedObjectProperty(temporary.value, "marker") === "preparedReference"
    ) || snapshot.callFrames.some((frame) =>
      frame.callerTemporaries.some((temporary) =>
        serializedObjectProperty(temporary.value, "marker") === "preparedReference"
      )
    )
  ));
});

test("restores prepared speaker aliases before and after nested identity mutations", () => {
  const { boundaries: observations } = assertRuntimeResumeEquivalent([
    "speaker vera {",
    "  config: { value: 0 }",
    "  items: [{ value: 0 }, { value: 1 }]",
    "}",
    "let alias = vera",
    "function replaceConfig { alias.config = { value: 2 }\nreturn 7 }",
    "function shiftItems { alias.items.removeFirst()\nreturn 9 }",
    "vera.config.value = replaceConfig()",
    "vera.items[0].value = shiftItems()",
    "say `${vera.config.value}:${vera.items[0].value}`",
  ].join("\n"));

  assert.ok(observations.some((snapshot) =>
    [...snapshot.temporaries, ...snapshot.callFrames.flatMap((frame) => frame.callerTemporaries)]
      .some((temporary) =>
        serializedObjectProperty(temporary.value, "marker") === "preparedReference" &&
        serializedObjectProperty(temporary.value, "detached") === true
      )
  ));
});

test("restores retained prepared list items across structural index shifts", () => {
  const { boundaries: observations } = assertRuntimeResumeEquivalent([
    "let direct = [0, 1, { value: 2 }]",
    "speaker vera { items: [{ value: 0 }, { value: 1 }] }",
    "let alias = vera",
    "function removeMiddle { direct.remove(1)\nreturn 8 }",
    "function shiftAlias { alias.items.removeFirst()\nreturn 9 }",
    "direct[2].value = removeMiddle()",
    "vera.items[1].value = shiftAlias()",
    "say `${direct[1].value}:${vera.items[0].value}`",
  ].join("\n"));

  assert.ok(observations.some((snapshot) =>
    [...snapshot.temporaries, ...snapshot.callFrames.flatMap((frame) => frame.callerTemporaries)]
      .some((temporary) =>
        serializedObjectProperty(temporary.value, "marker") === "preparedReference" &&
        serializedObjectProperty(temporary.value, "detached") === false
      )
  ));
});

test("rejects malformed prepared-reference state in active and suspended temporaries", () => {
  const compiled = plan([
    "let target = { nested: [0] }",
    "function replacement { return 7 }",
    "target.nested[0] = replacement()",
  ].join("\n"));

  const active = executeUntil(compiled, (candidate) =>
    candidate.callFrames.length === 0 &&
    candidate.temporaries.some((temporary) =>
      serializedObjectProperty(temporary.value, "marker") === "preparedReference"
    )
  );
  const activeCheckpoint = mutableCheckpoint(createCheckpoint(compiled, active));
  const activeReference = preparedReferenceValue(activeCheckpoint.snapshot.temporaries);
  removeSerializedObjectProperty(activeReference, "marker");
  assertCheckpointRejected(activeCheckpoint, "TSK002");

  const suspended = executeUntil(compiled, (candidate) =>
    candidate.callFrames.at(-1)?.functionName === "replacement" &&
    candidate.callFrames.at(-1)!.callerTemporaries.some((temporary) =>
      serializedObjectProperty(temporary.value, "marker") === "preparedReference"
    )
  );
  const base = mutableCheckpoint(createCheckpoint(compiled, suspended));
  const mutations: Array<(descriptor: any) => void> = [
    (descriptor) => {
      descriptor.properties.push({ name: "unexpected", value: null });
    },
    (descriptor) => {
      setSerializedObjectProperty(descriptor, "rootFrameId", -1);
    },
    (descriptor) => {
      setSerializedObjectProperty(descriptor, "rootName", "missing");
    },
    (descriptor) => {
      const path = serializedObjectProperty(descriptor, "path");
      const firstStep = path.items[0];
      setSerializedObjectProperty(firstStep, "name", "");
    },
    (descriptor) => {
      setSerializedObjectProperty(descriptor, "rootFrameId", null);
      setSerializedObjectProperty(descriptor, "rootName", null);
      setSerializedObjectProperty(descriptor, "detached", false);
    },
    (descriptor) => {
      setSerializedObjectProperty(descriptor, "capturedRoot", null);
    },
  ];

  for (const mutate of mutations) {
    const checkpoint = structuredClone(base);
    const descriptor = preparedReferenceValue(
      checkpoint.snapshot.callFrames.at(-1)!.callerTemporaries,
    );
    mutate(descriptor);
    assertCheckpointRejected(checkpoint, "TSK002");
  }
});

test("rejects missing temporaries in every suspended caller continuation", () => {
  const sources = [
    [
      "function one { return 1 }",
      "function two { return 2 }",
      "function three { return 3 }",
      "function total { return one() + two() + three() }",
      "say total()",
    ],
    [
      "function one { return 1 }",
      "function two { return 2 }",
      "function three { return 3 }",
      "function total(value = one() + two() + three()) { return value }",
      "say total()",
    ],
  ];

  for (const source of sources) {
    const compiled = plan(source.join("\n"));
    const snapshot = executeUntil(compiled, (candidate) =>
      candidate.callFrames.map((frame) => frame.functionName).join(",") === "total,two"
    );
    const checkpoint = mutableCheckpoint(createCheckpoint(compiled, snapshot));
    checkpoint.snapshot.callFrames.at(-1)!.callerTemporaries = [];
    assertCheckpointRejected(checkpoint, "TSK002");
  }
});

test("rejects missing suspended results at multiple recursion depths", () => {
  const compiled = plan([
    "function one { return 1 }",
    "function recurse(depth) {",
    "  if depth == 0 { return 0 }",
    "  return one() + recurse(depth - 1)",
    "}",
    "say recurse(4)",
  ].join("\n"));
  const snapshot = executeUntil(compiled, (candidate) =>
    candidate.callFrames.length >= 4 &&
    candidate.callFrames.every((frame) => frame.functionName === "recurse")
  );

  for (let frameIndex = 1; frameIndex < snapshot.callFrames.length; frameIndex += 1) {
    const checkpoint = mutableCheckpoint(createCheckpoint(compiled, snapshot));
    const frame = checkpoint.snapshot.callFrames[frameIndex]!;
    const call = checkpoint.plan.instructions[frame.returnInstruction - 1];
    assert.equal(call.kind, "callFunction");
    const argumentIds = new Set(call.arguments.flatMap((argument: any) =>
      argument.value.kind === "temporary" ? [argument.value.temporaryId] : []
    ));
    const missingIndex = frame.callerTemporaries.findIndex(
      (temporary: any) => !argumentIds.has(temporary.id),
    );
    assert.ok(missingIndex >= 0);
    frame.callerTemporaries.splice(missingIndex, 1);
    assertCheckpointRejected(checkpoint, "TSK002");
  }
});

test("rejects parameter progress that disagrees with exact default segments", () => {
  const compiled = plan([
    "function helper { return 1 }",
    "function sample(first = helper(), second = helper()) { return first + second }",
    "say sample()",
  ].join("\n"));
  const snapshot = executeUntil(compiled, (candidate) => {
    const frame = candidate.callFrames.at(-1);
    return frame?.functionName === "sample" &&
      frame.parameterState.phase === "defaults" &&
      frame.parameterState.parameterIndex === 1;
  });

  for (const corruptedIndex of [0, 2]) {
    const checkpoint = mutableCheckpoint(createCheckpoint(compiled, snapshot));
    checkpoint.snapshot.callFrames.at(-1)!.parameterState.parameterIndex = corruptedIndex;
    assertCheckpointRejected(checkpoint, "TSK002");
  }
});

test("rejects corrupted outer default progress while an inner call is active", () => {
  const compiled = plan([
    "function inner { return 1 }",
    "function outer(value = inner()) { return value }",
    "say outer()",
  ].join("\n"));
  const snapshot = executeUntil(compiled, (candidate) =>
    candidate.callFrames.map((frame) => frame.functionName).join(",") === "outer,inner"
  );
  const checkpoint = mutableCheckpoint(createCheckpoint(compiled, snapshot));
  checkpoint.snapshot.callFrames[0]!.parameterState.parameterIndex = 1;
  assertCheckpointRejected(checkpoint, "TSK002");
});

test("rejects structurally valid non-parameter bindings during a prologue", () => {
  const compiled = plan("function sample(value = 1) { return value }\nsay sample()");
  const snapshot = executeUntil(compiled, (candidate) =>
    candidate.callFrames.at(-1)?.parameterState.phase === "defaults"
  );
  const checkpoint = mutableCheckpoint(createCheckpoint(compiled, snapshot));
  const frame = checkpoint.snapshot.callFrames.at(-1)!;
  checkpoint.snapshot.frames[frame.scopeBaseDepth]!.bindings.push({
    name: "unexpected",
    value: null,
  });
  assertCheckpointRejected(checkpoint, "TSK002");
});

test("rejects malformed function-region plans inside checkpoints", () => {
  const defaults = plan([
    "function helper { return 1 }",
    "function sample(value = helper()) { say value\nreturn value }",
    "say sample()",
  ].join("\n"));
  const sample = defaults.functions.find((definition) => definition.name === "sample")!;
  const plans: any[] = [];

  const statementInDefault = mutablePlan(defaults);
  const clearIndex = statementInDefault.instructions.findIndex(
    (instruction: any, index: number) =>
      index >= sample.entryInstruction &&
      index < sample.bodyEntryInstruction &&
      instruction.kind === "clearTemporary",
  );
  statementInDefault.instructions[clearIndex] = {
    kind: "returnVoid",
    span: statementInDefault.instructions[clearIndex].span,
  };
  plans.push(statementInDefault);

  const suppliedInBody = mutablePlan(defaults);
  suppliedInBody.instructions[sample.bodyEntryInstruction] = {
    kind: "bindSuppliedParameter",
    functionId: sample.id,
    parameterIndex: 0,
    span: suppliedInBody.instructions[sample.bodyEntryInstruction].span,
  };
  plans.push(suppliedInBody);

  const returnBeforeBody = mutablePlan(defaults);
  const bindIndex = returnBeforeBody.instructions.findIndex(
    (instruction: any, index: number) =>
      index >= sample.entryInstruction &&
      index < sample.bodyEntryInstruction &&
      instruction.kind === "bindDefaultParameter",
  );
  returnBeforeBody.instructions[bindIndex] = {
    kind: "returnValue",
    value: returnBeforeBody.instructions[bindIndex].value,
    span: returnBeforeBody.instructions[bindIndex].span,
  };
  plans.push(returnBeforeBody);

  const calls = plan("function pair(left, right) { return left + right }\nsay pair(1, 2)");
  const aliasedDestination = mutablePlan(calls);
  const aliasedCall = aliasedDestination.instructions.find(
    (instruction: any) => instruction.kind === "callFunction",
  );
  aliasedCall.arguments[0].value = {
    kind: "temporary",
    temporaryId: aliasedCall.destinationTemporary,
    span: aliasedCall.arguments[0].value.span,
  };
  plans.push(aliasedDestination);

  const duplicateArgument = mutablePlan(calls);
  const duplicateCall = duplicateArgument.instructions.find(
    (instruction: any) => instruction.kind === "callFunction",
  );
  duplicateCall.arguments[1].parameterName = duplicateCall.arguments[0].parameterName;
  plans.push(duplicateArgument);

  for (const malformedPlan of plans) {
    assertCheckpointRejected({
      format: "teasescript-checkpoint",
      version: CHECKPOINT_VERSION,
      plan: malformedPlan,
      snapshot: createImmediatePacingRuntimeSnapshot(
        malformedPlan === aliasedDestination || malformedPlan === duplicateArgument
          ? calls
          : defaults,
      ),
    }, "TSK002");
  }
});

test("rejects empty serialized names and impossible status combinations", () => {
  const compiled = plan("let value = 1\nfunction read(input) { return input }\nread(value)");
  let active = createFreshRuntimeSnapshot(compiled);
  active = executeInstruction(compiled, active).snapshot;
  const bindingCheckpoint = mutableCheckpoint(createCheckpoint(compiled, active));
  bindingCheckpoint.snapshot.frames[0]!.bindings[0]!.name = "";
  assertCheckpointRejected(bindingCheckpoint, "TSK002");

  const functionCheckpoint = mutableCheckpoint(createCheckpoint(compiled, active));
  functionCheckpoint.plan.functions[0]!.name = "";
  assertCheckpointRejected(functionCheckpoint, "TSK002");

  const parameterCheckpoint = mutableCheckpoint(createCheckpoint(compiled, active));
  parameterCheckpoint.plan.functions[0]!.parameters[0]!.name = "";
  assertCheckpointRejected(parameterCheckpoint, "TSK002");

  active = executeInstruction(compiled, active).snapshot;
  const statusCheckpoint = mutableCheckpoint(createCheckpoint(compiled, active));
  statusCheckpoint.snapshot.status = "halted";
  assertCheckpointRejected(statusCheckpoint, "TSK002");
});

test("rejects cyclic runtime state without overflowing validation", () => {
  const compiled = plan("let value = [1]\nexit");
  const snapshot = createFreshRuntimeSnapshot(compiled);
  const checkpoint = {
    format: "teasescript-checkpoint",
    version: CHECKPOINT_VERSION,
    plan: compiled,
    snapshot,
  } as Record<string, unknown>;
  const cyclic = { kind: "list", items: [] as unknown[] };
  cyclic.items.push(cyclic);
  snapshot.frames[0]!.bindings.push({
    name: "cyclic",
    value: cyclic as SerializableRuntimeValue,
  });

  assertCheckpointRejected(checkpoint, "TSK002");
});

test("cyclic builtin results become source-associated runtime failures", () => {
  const compiledResult = compileSource("say cyclic()", { builtins: ["cyclic"] });
  assert.deepEqual(compiledResult.diagnostics, []);
  const compiled = compiledResult.plan!;
  const cyclic = { kind: "list", items: [] as unknown[] };
  cyclic.items.push(cyclic);
  const builtin: RuntimeBuiltinFunction = () => cyclic as SerializableRuntimeValue;
  const result = run(
    compiled,
    createImmediatePacingRuntimeSnapshot(compiled),
    { builtins: { cyclic: builtin } },
  );

  assert.equal(result.snapshot.status, "failed");
  assert.equal(result.snapshot.failure?.code, "TSR013");
  assert.ok(result.snapshot.failure?.span.start.offset !== undefined);
});

function recursiveSnapshot(depth: number): {
  readonly plan: InstructionPlan;
  readonly snapshot: RuntimeSnapshot;
} {
  const compiled = plan("function recurse { return recurse() }\nrecurse()");
  let snapshot = createFreshRuntimeSnapshot(compiled, { maxCallDepth: 16 });
  while (snapshot.callFrames.length < depth) {
    snapshot = executeInstruction(compiled, snapshot).snapshot;
  }
  return { plan: compiled, snapshot };
}

function executeUntil(
  compiled: InstructionPlan,
  predicate: (snapshot: RuntimeSnapshot) => boolean,
): RuntimeSnapshot {
  let snapshot = createImmediatePacingRuntimeSnapshot(compiled);
  let guard = 0;
  while (!predicate(snapshot)) {
    assert.notEqual(snapshot.status, "halted");
    assert.notEqual(snapshot.status, "failed");
    snapshot = executeInstruction(compiled, snapshot).snapshot;
    guard += 1;
    assert.ok(guard < 2_000, "checkpoint fixture did not reach its target state");
  }
  return snapshot;
}

function plan(source: string): InstructionPlan {
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.plan, null);
  return result.plan!;
}

type MutableCheckpoint = ReturnType<typeof mutableCheckpoint>;

function mutableCheckpoint(checkpoint: ReturnType<typeof createCheckpoint>): any {
  return JSON.parse(JSON.stringify(checkpoint));
}

function mutablePlan(compiled: InstructionPlan): any {
  return JSON.parse(JSON.stringify(compiled));
}

function preparedReferenceValue(temporaries: any[]): any {
  const temporary = temporaries.find(
    (candidate) =>
      serializedObjectProperty(candidate.value, "marker") === "preparedReference",
  );
  assert.ok(temporary !== undefined);
  return temporary.value;
}

function serializedObjectProperty(value: any, name: string): any {
  if (value?.kind !== "object" || !Array.isArray(value.properties)) return undefined;
  return value.properties.find((property: any) => property.name === name)?.value;
}

function setSerializedObjectProperty(value: any, name: string, replacement: any): void {
  assert.equal(value?.kind, "object");
  const property = value.properties.find((candidate: any) => candidate.name === name);
  assert.ok(property !== undefined);
  property.value = replacement;
}

function removeSerializedObjectProperty(value: any, name: string): void {
  assert.equal(value?.kind, "object");
  const index = value.properties.findIndex((candidate: any) => candidate.name === name);
  assert.ok(index >= 0);
  value.properties.splice(index, 1);
}

function assertCheckpointRejected(value: unknown, code: string): void {
  assert.throws(
    () => restoreCheckpoint(value),
    (error: unknown) => error instanceof CheckpointError && error.info.code === code,
  );
}
