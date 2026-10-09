import assert from "node:assert/strict";
import test from "node:test";

import { compileSource } from "../src/compiler.js";
import type { Instruction, InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  CHECKPOINT_VERSION,
  CheckpointError,
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { executeInstruction, run, type RuntimeBuiltinFunction } from "../src/runtime/engine.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import { RuntimeDataError } from "../src/runtime/operations/support.js";
import type {
  SerializableRuntimeObject,
  SerializableRuntimeValue,
} from "../src/runtime/serializable-values.js";
import {
  createFreshRuntimeSnapshot,
  MAX_SUPPORTED_CALL_DEPTH,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../src/runtime/state.js";
import { assertRuntimeResumeEquivalent, functionFrames } from "./helpers/runtime-equivalence.js";
import { createImmediatePacingRuntimeSnapshot } from "./helpers/immediate-pacing-runtime.js";
import { assertCheckpointRejected } from "./helpers/checkpoint-rejection.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";

test("restores every instruction boundary during defaults and nested calls", () => {
  const { boundaries: observations } = assertRuntimeResumeEquivalent(
    [
      "let count = 0",
      'function next(value) { count = count + 1\nreturn "${value}:${count}" }',
      'function describe(name, title = next(name)) { say "inside:${title}"\nreturn title }',
      'say describe("pet")',
      "exit",
    ].join("\n"),
  );

  assert.ok(
    observations.some(
      (snapshot) =>
        functionFrames(snapshot).at(-1)?.parameterState.phase === "supplied" &&
        functionFrames(snapshot).at(-1)?.parameterState.parameterIndex === 0,
    ),
  );
  assert.ok(
    observations.some((snapshot) =>
      functionFrames(snapshot).some((frame) => frame.parameterState.phase === "defaults"),
    ),
  );
  assert.ok(observations.some((snapshot) => snapshot.callFrames.length >= 2));
  assert.ok(
    observations.some(
      (snapshot) => snapshot.callFrames.length === 0 && snapshot.temporaries.length > 0,
    ),
  );
});

test("checkpoint restoration accepts the configured call-depth ceiling", () => {
  const compiled = plan("exit");
  const snapshot = createFreshRuntimeSnapshot(compiled, { maxCallDepth: MAX_SUPPORTED_CALL_DEPTH });

  assert.equal(
    restoreCheckpoint(createCheckpoint(compiled, snapshot)).snapshot.maxCallDepth,
    MAX_SUPPORTED_CALL_DEPTH,
  );
});

test("restores inside function loops, after continue, and before early return", () => {
  const { boundaries: observations, events } = assertRuntimeResumeEquivalent(
    [
      "function find(limit) {",
      "  for value in 1..=limit {",
      "    if value == 1 { continue }",
      '    say "loop:${value}"',
      "    if value == 3 { return value }",
      "  }",
      "  return null",
      "}",
      "say find(4)",
      "exit",
    ].join("\n"),
  );

  assert.ok(
    observations.some(
      (snapshot) => snapshot.callFrames.length === 1 && snapshot.loopFrames.length === 1,
    ),
  );
  // `continue` skips value 1 and `return` at value 3 prevents value 4.
  assert.deepEqual(
    events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["loop:2", "loop:3", "3"],
  );
});

/** The loops of the context that a call frame suspended. */
function callerLoops(snapshot: RuntimeSnapshot, frameIndex: number) {
  const owner = frameIndex === 0 ? null : snapshot.callFrames[frameIndex - 1]!.id;
  return snapshot.loopFrames
    .slice(0, snapshot.callFrames[frameIndex]!.loopBaseDepth)
    .filter((loop) => loop.callFrameId === owner);
}

test("restores calls suspended in nested loops whose outer loop header called a function", () => {
  const size = "function size(n) {\n  return n\n}";
  const pause = "function pause {\n  wait 1 s\n}";
  const nested = [
    size,
    pause,
    "repeat size(1) {",
    "  repeat 1 {",
    "    pause()",
    "  }",
    "}",
    "exit",
  ];
  // The outer count is cleared once its loop starts; resuming continues the outer loop rather than starting it again.
  const compiled = plan(nested.join("\n"));
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled)).snapshot;
  assert.equal(waiting.status, "waiting");
  assert.equal(callerLoops(waiting, 0).length, 2);
  assert.deepEqual(validateRuntimeSnapshot(waiting, compiled).errors, []);
  assert.equal(observeTime(compiled, waiting, 1_000).outcome.kind, "observed");
  assert.deepEqual(restoreCheckpoint(createCheckpoint(compiled, waiting)).snapshot, waiting);

  for (const source of [
    nested,
    // Loop control around the suspended calls, and a while loop whose condition calls a function on every pass.
    [
      size,
      "function pauseFor(seconds = 1) {\n  wait seconds s\n  return seconds\n}",
      "function ready(value) {\n  return value < 2\n}",
      "let log = []",
      "let count = 0",
      "repeat size(2) {",
      "  for item in [1, 2, 3] {",
      "    if item == 2 {\n      continue\n    }",
      "    log.add(pauseFor())",
      "    if item == 3 {\n      break\n    }",
      "  }",
      "  while ready(count) {",
      "    count += 1",
      "    log.add(pauseFor())",
      "  }",
      "}",
      'say "${log.length}"',
      "exit",
    ],
    // Nested loops of a called function, interrupted by a repeating timer's block while they wait.
    [
      size,
      pause,
      "let ticks = 0",
      "let t = timer(duration: 1500 ms, async: true, repeat: true) {\n  ticks += 1\n  wait 1 s\n}",
      "function rounds(n) {",
      "  repeat size(n) {",
      "    repeat size(1) {",
      "      pause()",
      "    }",
      "  }",
      "  return n",
      "}",
      'say "${rounds(2)}"',
      "t.stop()",
      "exit",
    ],
  ]) {
    const { boundaries } = assertRuntimeResumeEquivalent(source.join("\n"));
    assert.ok(
      boundaries.some((snapshot) =>
        snapshot.callFrames.some((_, index) => callerLoops(snapshot, index).length === 2),
      ),
    );
  }
});

test("resumes a nested-loop call after which a break falls through to the outer loop", () => {
  const compiled = mutablePlan(
    plan(
      [
        "function size {\n  return 1\n}",
        "function pause {\n  wait 1 s\n}",
        "repeat size() {",
        "  repeat 1 {",
        "    pause()",
        "    break",
        "  }",
        "}",
        "exit",
      ].join("\n"),
    ),
  );
  // Without the inner loop's unreachable closing `continue`, the break leads straight to the outer one's.
  const breakIndex = compiled.instructions.findIndex(
    (instruction: Instruction) =>
      instruction.kind === "loopControl" && instruction.action === "break",
  );
  const removed = breakIndex + 1;
  assert.equal(compiled.instructions[removed].action, "continue");
  compiled.instructions.splice(removed, 1);
  const shift = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    for (const [key, nested] of Object.entries(value)) {
      if (typeof nested === "number" && INSTRUCTION_ADDRESS_FIELDS.has(key) && nested > removed) {
        // EVIDENCE: the fixture owns this JSON plan copy and moves every address past the removed instruction.
        (value as Record<string, number>)[key] = nested - 1;
      } else shift(nested);
    }
  };
  shift(compiled);
  assert.equal(compiled.instructions[breakIndex].target, breakIndex + 1);
  assert.equal(validateInstructionPlan(compiled).valid, true);

  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled)).snapshot;
  assert.equal(callerLoops(waiting, 0).length, 2);
  assert.deepEqual(validateRuntimeSnapshot(waiting, compiled).errors, []);
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, waiting)));
  const observed = observeTime(restored.plan, restored.snapshot, 1_000).snapshot;
  assert.equal(run(restored.plan, observed).snapshot.status, "halted");
});

test("restores direct and mutual recursion at every instruction boundary", () => {
  const { boundaries: direct } = assertRuntimeResumeEquivalent(
    [
      "function factorial(value) {",
      "  if value <= 1 { return 1 }",
      "  return value * factorial(value - 1)",
      "}",
      "say factorial(5)",
      "exit",
    ].join("\n"),
  );
  assert.ok(direct.some((snapshot) => snapshot.callFrames.length >= 4));

  const { boundaries: mutual } = assertRuntimeResumeEquivalent(
    [
      "function even(value) { if value == 0 { return true }\nreturn odd(value - 1) }",
      "function odd(value) { if value == 0 { return false }\nreturn even(value - 1) }",
      "say even(5)",
      "exit",
    ].join("\n"),
  );
  assert.ok(
    mutual.some(
      (snapshot) =>
        functionFrames(snapshot).some((frame) => frame.functionName === "even") &&
        functionFrames(snapshot).some((frame) => frame.functionName === "odd"),
    ),
  );
});

test("restores between nested calls, around say events, and after parameter reassignment", () => {
  const { boundaries: observations, events } = assertRuntimeResumeEquivalent(
    [
      'function first { say "first"\nreturn 1 }',
      'function second { say "second"\nreturn 2 }',
      "say first() + second()",
      "function bump(value) { value += 1\nsay value\nreturn value }",
      "say bump(1)",
      "exit",
    ].join("\n"),
  );

  assert.ok(
    observations.some(
      (snapshot) =>
        snapshot.callFrames.length === 0 &&
        snapshot.temporaries.length > 0 &&
        snapshot.status === "running",
    ),
  );
  // The stored argument stays the supplied value while the body's binding changes, and both remain valid state.
  assert.ok(
    observations.some((snapshot) => {
      const frame = functionFrames(snapshot).at(-1);
      const binding = snapshot.frames[frame?.scopeBaseDepth ?? -1]?.bindings.find(
        (candidate) => candidate.name === "value",
      );
      return (
        frame?.functionName === "bump" &&
        frame.parameterState.phase === "body" &&
        frame.arguments[0]?.supplied === true &&
        frame.arguments[0].value === 1 &&
        binding?.value === 2
      );
    }),
  );
  assert.deepEqual(
    events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["first", "second", "3", "2", "2"],
  );
});

test("preserves prepared earlier arguments through a later suspension and a suspended callee", () => {
  const source = [
    "function later { wait 1 ms\nreturn random() }",
    "function combine(first, second) { wait 2 ms\nreturn first + second }",
    "combine(random(), later())",
    "exit",
  ].join("\n");
  const { boundaries, events } = assertRuntimeResumeEquivalent(source, { seed: 0x2468_ace1 });

  // While `later` waits, the caller retains the already evaluated first argument.
  assert.ok(
    boundaries.some((snapshot) => {
      const frame = functionFrames(snapshot).at(-1);
      return (
        snapshot.status === "waiting" &&
        frame?.functionName === "later" &&
        frame.callerTemporaries.length > 0
      );
    }),
  );
  const combineWaiting = boundaries.find(
    (snapshot) =>
      snapshot.status === "waiting" &&
      functionFrames(snapshot).at(-1)?.functionName === "combine" &&
      functionFrames(snapshot)
        .at(-1)
        ?.arguments.every((argument) => argument.supplied),
  );
  assert.ok(combineWaiting !== undefined);
  // The last boundary runs the exit, which clears frames and temporaries, so the one before it shows what the call left.
  assert.equal(events.at(-1)?.kind, "exit");
  const beforeExit = boundaries.at(-2)!;
  assert.equal(beforeExit.callFrames.length, 0);
  assert.equal(beforeExit.temporaries.length, 0);

  const compiled = plan(source);
  const forgedWaiting = mutableCheckpoint(createCheckpoint(compiled, combineWaiting));
  forgedWaiting.snapshot.callFrames.at(-1)!.arguments[0] = {
    parameterName: "first",
    supplied: false,
  };
  assert.equal(validateRuntimeSnapshot(forgedWaiting.snapshot, compiled).valid, false);
  assertCheckpointRejected(forgedWaiting, "TSK002");
});

test("validates and resumes deep suspended recursive continuations", () => {
  const compiled = plan(
    [
      "function addUp(value) {",
      "  if value == 0 { return 0 }",
      "  return value + addUp(value - 1)",
      "}",
      "say addUp(32)",
      "exit",
    ].join("\n"),
  );
  for (const depth of [16, 32]) {
    const snapshot = executeUntil(compiled, (candidate) => candidate.callFrames.length === depth);
    const before = JSON.stringify(snapshot);
    assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true, `depth ${depth}`);
    const restored = restoreCheckpoint(createCheckpoint(compiled, snapshot));

    for (const completion of [run(compiled, snapshot), run(restored.plan, restored.snapshot)]) {
      assert.equal(completion.snapshot.status, "halted", `depth ${depth}`);
      // 32 + 31 + ... + 1 = 32 * 33 / 2.
      assert.deepEqual(
        completion.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
        ["528"],
        `depth ${depth}`,
      );
    }
    assert.equal(JSON.stringify(snapshot), before, `depth ${depth}`);
  }
});

test("treats unbound call-frame argument values as canonical resumable state", () => {
  const compiled = plan(
    "function identity(value) { return value }\nsay identity({ outer: { items: [1, 2] } }).outer.items[1]\nexit",
  );
  const snapshot = executeUntil(
    compiled,
    (candidate) =>
      functionFrames(candidate).at(-1)?.parameterState.phase === "supplied" &&
      functionFrames(candidate).at(-1)?.parameterState.parameterIndex === 0,
  );
  const changed: any = structuredClone(snapshot); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: fixture changes a deeply nested unbound call argument while preserving its canonical surrounding snapshot.
  changed.callFrames[0].arguments[0].value.properties[0].value.properties[0].value.items[1] = 99;
  assert.equal(validateRuntimeSnapshot(changed, compiled).valid, true);
  const restored = restoreCheckpoint(createCheckpoint(compiled, changed));
  assert.deepEqual(restored.snapshot, changed);

  const resumed = run(restored.plan, restored.snapshot);
  assert.equal(resumed.snapshot.status, "halted");
  assert.deepEqual(
    resumed.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
    ["99"],
  );
});

test("checkpoint creation defensively isolates the supplied plan", () => {
  const original = mutablePlan(plan("function value { return 1 }\nsay value()\nexit"));
  const snapshot = createImmediatePacingRuntimeSnapshot(original);
  const checkpoint = createCheckpoint(original, snapshot);
  const originalName = checkpoint.plan.functions[0]!.name;

  original.functions[0]!.name = "mutated";
  assert.equal(checkpoint.plan.functions[0]!.name, originalName);
});

test("rejects malformed active call-frame identity and return state", () => {
  const { plan: compiled, snapshot } = recursiveSnapshot(3);
  const cases: Array<(checkpoint: MutableCheckpoint) => void> = [
    (checkpoint) => {
      checkpoint.snapshot.callFrames[0]!.functionId = 999;
    },
    (checkpoint) => {
      checkpoint.snapshot.callFrames[0]!.returnInstruction = 999;
    },
    (checkpoint) => {
      checkpoint.snapshot.callFrames[1]!.id = checkpoint.snapshot.callFrames[0]!.id;
    },
    (checkpoint) => {
      checkpoint.snapshot.callFrames[0]!.scopeBaseDepth = 0;
    },
    (checkpoint) => {
      checkpoint.snapshot.callFrames[0]!.loopBaseDepth = 999;
    },
    (checkpoint) => {
      checkpoint.snapshot.callFrames[0]!.destinationTemporary = 0;
    },
    (checkpoint) => {
      checkpoint.snapshot.callFrames.at(-1)!.parameterState.parameterIndex = 999;
    },
    (checkpoint) => {
      checkpoint.snapshot.maxCallDepth = 1;
    },
  ];

  for (const mutate of cases) {
    const checkpoint = mutableCheckpoint(createCheckpoint(compiled, snapshot));
    mutate(checkpoint);
    assertCheckpointRejected(checkpoint, "TSK002");
  }
});

test("rejects inconsistent argument supply and parameter bindings", () => {
  const compiled = plan("function echo(input) { return input }\necho(1)\nexit");
  const call = compiled.instructions.find((instruction) => instruction.kind === "callFunction");
  assert.equal(call?.kind, "callFunction");
  if (call?.kind !== "callFunction") return;
  const occupiedBeforeCall = structuredClone(createFreshRuntimeSnapshot(compiled));
  occupiedBeforeCall.temporaries.push({ id: call.destinationTemporary, value: null });
  assert.equal(validateRuntimeSnapshot(occupiedBeforeCall, compiled).valid, false);

  const suppliedPhase = (parameterIndex: number) => (candidate: RuntimeSnapshot) =>
    candidate.callFrames.length === 1 &&
    functionFrames(candidate)[0]!.parameterState.phase === "supplied" &&
    functionFrames(candidate)[0]!.parameterState.parameterIndex === parameterIndex;
  const snapshot = executeUntil(compiled, suppliedPhase(0));
  assert.deepEqual(snapshot.frames[1]?.bindings, []);

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

  const optional = plan(
    "function sample(required, optional = 2) { return required }\nsample(1)\nexit",
  );
  const optionalFrame = executeUntil(optional, (candidate) => candidate.callFrames.length === 1);
  const forgedSupplied = mutableCheckpoint(createCheckpoint(optional, optionalFrame));
  forgedSupplied.snapshot.callFrames[0]!.arguments[1] = {
    parameterName: "optional",
    supplied: true,
    value: 2,
  };
  assert.equal(validateRuntimeSnapshot(forgedSupplied.snapshot, optional).valid, false);
  assertCheckpointRejected(forgedSupplied, "TSK002");

  const bound = executeUntil(compiled, suppliedPhase(1));
  assert.deepEqual(
    bound.frames[1]?.bindings.map((binding) => binding.name),
    ["input"],
  );
  const missingBinding = mutableCheckpoint(createCheckpoint(compiled, bound));
  missingBinding.snapshot.frames[1]!.bindings = [];
  assertCheckpointRejected(missingBinding, "TSK002");
});

test("rejects a missing temporary required by the next instruction", () => {
  const compiled = plan("function value { return 1 }\nlet result = value()\nexit");
  let snapshot = createFreshRuntimeSnapshot(compiled);
  while (snapshot.callFrames.length > 0 || snapshot.temporaries.length === 0) {
    snapshot = executeInstruction(compiled, snapshot).snapshot;
  }

  const checkpoint = mutableCheckpoint(createCheckpoint(compiled, snapshot));
  checkpoint.snapshot.temporaries = [];
  assertCheckpointRejected(checkpoint, "TSK002");
});

test("restores between assignment-target and right-hand call evaluation", () => {
  const { boundaries: observations } = assertRuntimeResumeEquivalent(
    [
      "let order = []",
      "let items = [0]",
      'function indexFunction { order.add("index")\nreturn 0 }',
      'function valueFunction { order.add("value")\nreturn 7 }',
      "items[indexFunction()] = valueFunction()",
      "let randomItems = [0, 0]",
      "randomItems[randomInteger(0..=1)] = randomInteger(7..=9)",
      'say "${order[0]}:${order[1]}:${items[0]}"',
      "exit",
    ].join("\n"),
  );

  assert.ok(
    observations.some(
      (snapshot) =>
        functionFrames(snapshot).at(-1)?.functionName === "valueFunction" &&
        snapshot.callFrames.at(-1)!.callerTemporaries.length > 0,
    ),
  );
});

test("restores mixed ordinary and user-call evaluation at every instruction boundary", () => {
  const { boundaries: observations } = assertRuntimeResumeEquivalent(
    [
      "let order = []",
      "let first = { nested: [0] }",
      "let second = { nested: [0] }",
      "let target = first",
      "function mark(value) { order.add(value)\nreturn value }",
      "function retarget { target = second\nreturn 7 }",
      "function roll { return randomInteger(1..=6) }",
      'let listValue = [random(), mark("list")]',
      'let setValue = set[randomInteger(1..=3), mark("set")]',
      'let objectValue = { first: random(), second: mark("object") }',
      'let templateValue = "${random()}:${mark(\"template\")}"',
      "let binaryValue = random() + mark(2)",
      "let rolled = roll() + mark(4)",
      "let rangeValue = randomInteger(0..=1)..mark(3)",
      "target.nested[0] = retarget()",
      "target.nested.add(mark(8))",
      'say "${first.nested[0]}:${second.nested[0]}:${target.nested.length}:${order.length}"',
      "exit",
    ].join("\n"),
  );

  assert.ok(
    observations.some(
      (snapshot) =>
        snapshot.temporaries.some(
          (temporary) =>
            serializedObjectProperty(temporary.value, "marker") === "preparedReference",
        ) ||
        snapshot.callFrames.some((frame) =>
          frame.callerTemporaries.some(
            (temporary) =>
              serializedObjectProperty(temporary.value, "marker") === "preparedReference",
          ),
        ),
    ),
  );
});

test("restores prepared speaker aliases before and after nested identity mutations", () => {
  const { boundaries: observations } = assertRuntimeResumeEquivalent(
    [
      "speaker vera {",
      "  config: { value: 0 }",
      "  items: [{ value: 0 }, { value: 1 }]",
      "}",
      "let alias = vera",
      "function replaceConfig { alias.config = { value: 2 }\nreturn 7 }",
      "function shiftItems { alias.items.removeFirst()\nreturn 9 }",
      "vera.config.value = replaceConfig()",
      "vera.items[0].value = shiftItems()",
      'say "${vera.config.value}:${vera.items[0].value}"',
      "exit",
    ].join("\n"),
  );

  assert.ok(
    observations.some((snapshot) =>
      [
        ...snapshot.temporaries,
        ...snapshot.callFrames.flatMap((frame) => frame.callerTemporaries),
      ].some(
        (temporary) =>
          serializedObjectProperty(temporary.value, "marker") === "preparedReference" &&
          serializedObjectProperty(temporary.value, "detached") === true,
      ),
    ),
  );
});

test("restores retained prepared list items across structural index shifts", () => {
  const { boundaries: observations } = assertRuntimeResumeEquivalent(
    [
      "let direct = [{ value: 0 }, { value: 1 }, { value: 2 }]",
      "speaker vera { items: [{ value: 0 }, { value: 1 }] }",
      "let alias = vera",
      "function removeMiddle { direct.remove({ value: 1 })\nreturn 8 }",
      "function shiftAlias { alias.items.removeFirst()\nreturn 9 }",
      "let positions = [{ value: 0 }, { value: 1 }, { value: 2 }]",
      "function removePosition { positions.removeAt(0)\nreturn 6 }",
      "direct[2].value = removeMiddle()",
      "vera.items[1].value = shiftAlias()",
      "positions[2].value = removePosition()",
      'say "${direct[1].value}:${vera.items[0].value}:${positions[1].value}"',
      "exit",
    ].join("\n"),
  );

  assert.ok(
    observations.some((snapshot) =>
      [
        ...snapshot.temporaries,
        ...snapshot.callFrames.flatMap((frame) => frame.callerTemporaries),
      ].some(
        (temporary) =>
          serializedObjectProperty(temporary.value, "marker") === "preparedReference" &&
          serializedObjectProperty(temporary.value, "detached") === false,
      ),
    ),
  );
});

test("rejects malformed prepared-reference state in active and suspended temporaries", () => {
  const compiled = plan(
    [
      "let target = { nested: [0] }",
      "function replacement { return 7 }",
      "target.nested[0] = replacement()",
      "exit",
    ].join("\n"),
  );

  const active = executeUntil(
    compiled,
    (candidate) =>
      candidate.callFrames.length === 0 &&
      candidate.temporaries.some(
        (temporary) => serializedObjectProperty(temporary.value, "marker") === "preparedReference",
      ),
  );
  const activeCheckpoint = mutableCheckpoint(createCheckpoint(compiled, active));
  const activeReference = preparedReferenceValue(activeCheckpoint.snapshot.temporaries);
  removeSerializedObjectProperty(activeReference, "marker");
  assertCheckpointRejected(activeCheckpoint, "TSK002");

  const suspended = executeUntil(
    compiled,
    (candidate) =>
      functionFrames(candidate).at(-1)?.functionName === "replacement" &&
      candidate.callFrames
        .at(-1)!
        .callerTemporaries.some(
          (temporary) =>
            serializedObjectProperty(temporary.value, "marker") === "preparedReference",
        ),
  );
  const base = mutableCheckpoint(createCheckpoint(compiled, suspended));
  const mutations: Array<(descriptor: SerializableRuntimeObject) => void> = [
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
      assert.ok(path?.kind === "list");
      const firstStep = path.items[0];
      assert.ok(firstStep?.kind === "object");
      setSerializedObjectProperty(firstStep, "name", "");
    },
    (descriptor) => {
      setSerializedObjectProperty(descriptor, "rootFrameId", null);
      setSerializedObjectProperty(descriptor, "rootName", null);
      setSerializedObjectProperty(descriptor, "detached", false);
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

test("a prepared reference keeps a copy of its root only where a later call in its preparation can read it", () => {
  // `rows[pick()]` is prepared before `pick` runs. Its extension evaluates `removeFirst` after reading the root, so
  // both keep a copy; `target.nested` in `target.nested[0] = replacement()` keeps none.
  for (const [source, keepsRoot] of [
    [
      "let rows = [[[0]], [[1]]]\nfunction pick { return 0 }\nrows[pick()][rows[1][0].removeFirst() - 1][0] = 7",
      true,
    ],
    [
      "let target = { nested: [0] }\nfunction replacement { return 7 }\ntarget.nested[0] = replacement()",
      false,
    ],
  ] as const) {
    const compiled = plan(`${source}\nexit`);
    const suspended = executeUntil(compiled, (candidate) => functionFrames(candidate).length === 1);
    const base = mutableCheckpoint(createCheckpoint(compiled, suspended));
    const descriptor = preparedReferenceValue(base.snapshot.callFrames.at(-1)!.callerTemporaries);
    assert.equal(serializedObjectProperty(descriptor, "detached"), false, source);
    assert.equal(
      serializedObjectProperty(descriptor, "capturedRoot") !== undefined,
      keepsRoot,
      source,
    );
    if (keepsRoot) removeSerializedObjectProperty(descriptor, "capturedRoot");
    else {
      // The variable's own value: a root the path leads through, so only the plan's rule refuses it.
      const root = base.snapshot.frames[0].bindings.find(
        (binding: { name: string }) => binding.name === "target",
      ).value;
      descriptor.properties.splice(4, 0, { name: "capturedRoot", value: root });
    }
    assert.throws(
      () => restoreCheckpoint(base),
      (error: unknown) =>
        error instanceof CheckpointError &&
        error.info.code === "TSK002" &&
        error.message.includes(
          keepsRoot
            ? "the captured root is missing."
            : "an attached descriptor keeps a captured root where the plan keeps none.",
        ),
      source,
    );
  }
});

test("rejects missing temporaries in every suspended caller continuation", () => {
  const functions = [
    "function one { return 1 }",
    "function two { return 2 }",
    "function three { return 3 }",
  ];
  for (const { continuation, source, frames } of [
    { continuation: "root", source: "say one() + two() + three()", frames: "two" },
    {
      continuation: "function body",
      source: "function total { return one() + two() + three() }\nsay total()",
      frames: "total,two",
    },
    {
      continuation: "parameter default",
      source: "function total(value = one() + two() + three()) { return value }\nsay total()",
      frames: "total,two",
    },
  ]) {
    const compiled = plan([...functions, source, "exit"].join("\n"));
    const snapshot = executeUntil(
      compiled,
      (candidate) =>
        functionFrames(candidate)
          .map((frame) => frame.functionName)
          .join(",") === frames,
    );
    const checkpoint = mutableCheckpoint(createCheckpoint(compiled, snapshot));
    // The caller of `two` retains the result of `one`; removing it leaves the continuation without input.
    assert.ok(checkpoint.snapshot.callFrames.at(-1)!.callerTemporaries.length > 0, continuation);
    checkpoint.snapshot.callFrames.at(-1)!.callerTemporaries = [];
    assertCheckpointRejected(checkpoint, "TSK002");
  }
});

test("rejects a nested-loop continuation without a temporary it still reads", () => {
  const compiled = plan(
    [
      "function one {\n  return 1\n}",
      "function pause {\n  wait 1 s\n  return 2\n}",
      "function size(n) {\n  return n\n}",
      "repeat size(2) {",
      "  for item in [1, 2] {",
      '    say "${one()} ${pause()}"',
      "  }",
      "}",
      "exit",
    ].join("\n"),
  );
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled)).snapshot;
  assert.equal(callerLoops(waiting, 0).length, 2);
  // The caller holds the result of `one()` until `pause()` returns.
  const checkpoint = mutableCheckpoint(createCheckpoint(compiled, waiting));
  assert.ok(checkpoint.snapshot.callFrames[0].callerTemporaries.length > 0);
  checkpoint.snapshot.callFrames[0].callerTemporaries = [];
  assertCheckpointRejected(checkpoint, "TSK002");
  assert.throws(
    () => observeTime(compiled, checkpoint.snapshot, 1_000),
    (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR101",
  );
});

test("rejects missing suspended results at multiple recursion depths", () => {
  const compiled = plan(
    [
      "function one { return 1 }",
      "function recurse(depth) {",
      "  if depth == 0 { return 0 }",
      "  return one() + recurse(depth - 1)",
      "}",
      "say recurse(4)",
      "exit",
    ].join("\n"),
  );
  const snapshot = executeUntil(
    compiled,
    (candidate) =>
      candidate.callFrames.length >= 4 &&
      functionFrames(candidate).every((frame) => frame.functionName === "recurse"),
  );

  for (let frameIndex = 1; frameIndex < snapshot.callFrames.length; frameIndex += 1) {
    const checkpoint = mutableCheckpoint(createCheckpoint(compiled, snapshot));
    const frame = checkpoint.snapshot.callFrames[frameIndex]!;
    const call: Instruction = checkpoint.plan.instructions[frame.returnInstruction - 1];
    assert.ok(call.kind === "callFunction");
    const argumentIds = new Set(
      call.arguments.flatMap((argument) =>
        argument.value.kind === "temporary" ? [argument.value.temporaryId] : [],
      ),
    );
    const missingIndex = frame.callerTemporaries.findIndex(
      (temporary: { id: number }) => !argumentIds.has(temporary.id),
    );
    assert.ok(missingIndex >= 0);
    frame.callerTemporaries.splice(missingIndex, 1);
    assertCheckpointRejected(checkpoint, "TSK002");
  }
});

test("rejects parameter progress that disagrees with exact default segments", () => {
  const compiled = plan(
    [
      "function helper { return 1 }",
      "function sample(first = helper(), second = helper()) { return first + second }",
      "say sample()",
      "exit",
    ].join("\n"),
  );
  const snapshot = executeUntil(compiled, (candidate) => {
    const frame = functionFrames(candidate).at(-1);
    return (
      frame?.functionName === "sample" &&
      frame.parameterState.phase === "defaults" &&
      frame.parameterState.parameterIndex === 1
    );
  });

  for (const corruptedIndex of [0, 2]) {
    const checkpoint = mutableCheckpoint(createCheckpoint(compiled, snapshot));
    checkpoint.snapshot.callFrames.at(-1)!.parameterState.parameterIndex = corruptedIndex;
    assertCheckpointRejected(checkpoint, "TSK002");
  }
});

test("rejects corrupted outer default progress while an inner call is active", () => {
  const compiled = plan(
    [
      "function inner { return 1 }",
      "function outer(value = inner()) { return value }",
      "say outer()",
      "exit",
    ].join("\n"),
  );
  const snapshot = executeUntil(
    compiled,
    (candidate) =>
      functionFrames(candidate)
        .map((frame) => frame.functionName)
        .join(",") === "outer,inner",
  );
  const checkpoint = mutableCheckpoint(createCheckpoint(compiled, snapshot));
  checkpoint.snapshot.callFrames[0]!.parameterState.parameterIndex = 1;
  assertCheckpointRejected(checkpoint, "TSK002");
});

test("rejects structurally valid non-parameter bindings during a prologue", () => {
  const compiled = plan("function sample(value = 1) { return value }\nsay sample()\nexit");
  const snapshot = executeUntil(
    compiled,
    (candidate) => functionFrames(candidate).at(-1)?.parameterState.phase === "defaults",
  );
  const checkpoint = mutableCheckpoint(createCheckpoint(compiled, snapshot));
  const frame = checkpoint.snapshot.callFrames.at(-1)!;
  checkpoint.snapshot.frames[frame.scopeBaseDepth]!.bindings.push({
    name: "unexpected",
    value: null,
  });
  assertCheckpointRejected(checkpoint, "TSK002");
});

test("rejects empty serialized names and impossible status combinations", () => {
  const compiled = plan("let value = 1\nfunction read(input) { return input }\nread(value)\nexit");
  let active = createFreshRuntimeSnapshot(compiled);
  active = executeInstruction(compiled, active).snapshot;
  const bindingCheckpoint = mutableCheckpoint(createCheckpoint(compiled, active));
  bindingCheckpoint.snapshot.frames[0]!.bindings[0]!.name = "";
  assertCheckpointRejected(bindingCheckpoint, "TSK002");

  const functionCheckpoint = mutableCheckpoint(createCheckpoint(compiled, active));
  functionCheckpoint.plan.functions[0]!.name = "";
  assertCheckpointRejected(functionCheckpoint, "TSK002", "$.plan.functions[0].name");

  const parameterCheckpoint = mutableCheckpoint(createCheckpoint(compiled, active));
  parameterCheckpoint.plan.functions[0]!.parameters[0]!.name = "";
  assertCheckpointRejected(parameterCheckpoint, "TSK002", "$.plan.functions[0].parameters[0].name");

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
  };
  const cyclic: { kind: "list"; items: unknown[] } = { kind: "list", items: [] };
  cyclic.items.push(cyclic);
  snapshot.frames[0]!.bindings.push({
    name: "cyclic",
    // EVIDENCE: fixture intentionally presents this self-referential list as runtime data to test cycle rejection.
    value: cyclic as SerializableRuntimeValue,
  });

  assertCheckpointRejected(checkpoint, "TSK002");
});

test("cyclic builtin results become source-associated runtime failures", () => {
  const source = "say cyclic()\nexit";
  const call = "cyclic()";
  const compiledResult = compileSource(source, { builtins: ["cyclic"] });
  assert.deepEqual(compiledResult.diagnostics, []);
  const compiled = compiledResult.plan!;
  const cyclic: { kind: "list"; items: unknown[] } = { kind: "list", items: [] };
  cyclic.items.push(cyclic);
  const builtin: RuntimeBuiltinFunction = () => {
    // EVIDENCE: fixture intentionally returns the self-referential list through the builtin result boundary.
    return cyclic as SerializableRuntimeValue;
  };
  const result = run(compiled, createImmediatePacingRuntimeSnapshot(compiled), {
    builtins: { cyclic: builtin },
  });

  assert.equal(result.snapshot.status, "failed");
  const failure = result.snapshot.failure;
  assert.equal(failure?.code, "TSR013");
  assert.deepEqual(
    [failure?.span.start.offset, failure?.span.end.offset],
    [source.indexOf(call), source.indexOf(call) + call.length],
  );
  assert.deepEqual(
    result.events.flatMap((event) =>
      event.kind === "runtimeFailure"
        ? [{ code: event.code, message: event.message, path: event.path, span: event.span }]
        : [],
    ),
    [failure],
  );
});

function recursiveSnapshot(depth: number): {
  readonly plan: InstructionPlan;
  readonly snapshot: RuntimeSnapshot;
} {
  const compiled = plan("function recurse { return recurse() }\nrecurse()\nexit");
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

type MutableCheckpoint = ReturnType<typeof mutableCheckpoint>;

// oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: checkpoint fixtures mutate readonly and invalid fields across the checkpoint validation matrix.
function mutableCheckpoint(checkpoint: ReturnType<typeof createCheckpoint>): any {
  return JSON.parse(JSON.stringify(checkpoint));
}

/** Plan fields that hold an instruction address. */
const INSTRUCTION_ADDRESS_FIELDS = new Set([
  "target",
  "continueTarget",
  "returnInstruction",
  "startInstruction",
  "entryInstruction",
  "rootEndInstruction",
  "endInstruction",
  "bodyEntryInstruction",
  "implicitReturnInstruction",
]);

// oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: plan fixtures mutate readonly and invalid instruction fields across the plan validation matrix.
function mutablePlan(compiled: InstructionPlan): any {
  return JSON.parse(JSON.stringify(compiled));
}

// oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: helper locates the serialized prepared-reference object whose malformed properties are the fixture under test.
function preparedReferenceValue(temporaries: any[]): any {
  const temporary = temporaries.find(
    (candidate) => serializedObjectProperty(candidate.value, "marker") === "preparedReference",
  );
  assert.ok(temporary !== undefined);
  return temporary.value;
}

// oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: helper reads named properties from serialized object fixtures before their shape is mutated.
function serializedObjectProperty(value: any, name: string): any {
  if (value?.kind !== "object" || !Array.isArray(value.properties)) return undefined;
  return value.properties.find((property: any) => property.name === name)?.value; // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: serialized property entries are selected by their runtime `name` field.
}

// oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: fixture helper mutates named fields within serialized prepared-reference objects to invalid values.
function setSerializedObjectProperty(value: any, name: string, replacement: any): void {
  assert.equal(value?.kind, "object");
  const property = value.properties.find((candidate: any) => candidate.name === name); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: serialized property entries are selected by their runtime `name` field.
  assert.ok(property !== undefined);
  property.value = replacement;
}

// oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: fixture helper removes a required named field from a serialized prepared-reference object.
function removeSerializedObjectProperty(value: any, name: string): void {
  assert.equal(value?.kind, "object");
  const index = value.properties.findIndex((candidate: any) => candidate.name === name); // oxlint-disable-line typescript/no-explicit-any -- EVIDENCE: serialized property entries are selected by their runtime `name` field.
  assert.ok(index >= 0);
  value.properties.splice(index, 1);
}
