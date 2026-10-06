import assert from "node:assert/strict";
import test from "node:test";

import {
  RuntimeDataError,
  createFreshRuntimeSnapshot,
  observeTime,
  run,
  validateInstructionPlan,
  validateRuntimeSnapshot,
  type InstructionPlan,
  type RuntimeSnapshot,
} from "../src/index.js";
import { snapshotValidationAnalysis } from "../src/runtime/snapshot-validation-analysis.js";
import { classifyCapturedRuntimeSnapshot } from "../src/runtime/state.js";
import { withValidationTestStatistics } from "../src/validation-testing.js";
import { compileValidPlan } from "./helpers/compile-valid-plan.js";
import {
  assertRuntimeResumeEquivalent,
  functionFrames,
  type RuntimeResumeEquivalenceResult,
} from "./helpers/runtime-equivalence.js";

/**
 * Loops at the root and in a called function around suspended calls, with default parameters, prepared references and
 * say output, and timer and media blocks that interrupt the waiting functions: every place where snapshot validation
 * reads what it derived from the plan. Each loop header calls a function, so what a continuation needs depends on
 * the loop it runs in.
 */
const SCENARIO = [
  'speaker vera { title: "Miss" }',
  "label again",
  "fallback again",
  'let record = { total: 0, items: ["", ""] }',
  'function pause(seconds, note = "pause ${seconds}") {',
  "  wait seconds",
  "  return note",
  "}",
  "function size(value) {",
  "  return value",
  "}",
  "function lap(count) {",
  "  let laps = []",
  "  for index in 1..=size(count) {",
  '    record.items[0] = pause(1, "first")',
  '    say as vera "lap ${index} ${pause(1)}"',
  "    laps.add(index)",
  "  }",
  "  return laps.length",
  "}",
  "let ticks = 0",
  "let t = timer(duration: 2500 ms, async: true, repeat: true) {",
  "  ticks += 1",
  "  wait 1",
  "}",
  'let m = playAudio(file: "a.mp3", async: true) {',
  "  at 500 ms {",
  '    say "media ${pause(1)}"',
  "  }",
  "}",
  "function rounds {",
  "  return 2",
  "}",
  "repeat rounds() {",
  "  record.total = lap(1)",
  '  say "total ${record.total}"',
  "}",
  "t.stop()",
  "exit",
].join("\n");

let scenarioResult: RuntimeResumeEquivalenceResult | undefined;

function scenario(): RuntimeResumeEquivalenceResult {
  scenarioResult ??= assertRuntimeResumeEquivalent(SCENARIO, { mediaDurationMs: 1_000 });
  return scenarioResult;
}

function allTemporaries(snapshot: RuntimeSnapshot) {
  return [
    ...snapshot.temporaries,
    ...snapshot.callFrames.flatMap((frame) => frame.callerTemporaries),
  ];
}

test("restores loops at the root and in a called function around interrupted calls", () => {
  const { boundaries, events } = scenario();
  const plan = compileValidPlan(SCENARIO);
  const preparedSay = new Set(
    plan.instructions.flatMap((instruction) =>
      instruction.kind === "prepareSaySpeaker" || instruction.kind === "prepareSayText"
        ? [instruction.destinationTemporary]
        : [],
    ),
  );
  const preparedReferences = new Set(
    plan.instructions.flatMap((instruction) =>
      instruction.kind === "prepareReference" ? [instruction.destinationTemporary] : [],
    ),
  );
  const interrupted = (snapshot: RuntimeSnapshot, owner: "timerId" | "mediaId") =>
    functionFrames(snapshot).some(
      (frame) => frame.timerInterruption !== null && owner in frame.timerInterruption,
    );

  assert.deepEqual(
    events.flatMap((event) =>
      event.kind === "say" && !event.text.startsWith("media") ? [event.text] : [],
    ),
    ["lap 1 pause 1", "total 1", "lap 1 pause 1", "total 1"],
  );
  for (const [covered, description] of [
    [(s: RuntimeSnapshot) => s.loopFrames.some((loop) => loop.callFrameId === null), "root"],
    [(s: RuntimeSnapshot) => s.loopFrames.some((loop) => loop.callFrameId !== null), "function"],
    [
      (s: RuntimeSnapshot) =>
        functionFrames(s).some((frame) => frame.parameterState.phase === "defaults"),
      "defaults",
    ],
    [(s: RuntimeSnapshot) => allTemporaries(s).some((t) => preparedReferences.has(t.id)), "ref"],
    [(s: RuntimeSnapshot) => allTemporaries(s).some((t) => preparedSay.has(t.id)), "say"],
    [(s: RuntimeSnapshot) => interrupted(s, "timerId") && s.loopFrames.length === 2, "timer"],
    [(s: RuntimeSnapshot) => interrupted(s, "mediaId"), "media"],
  ] as const) {
    // Each kind of state is held while a call made from inside another call is suspended.
    assert.ok(
      boundaries.some((snapshot) => snapshot.callFrames.length >= 2 && covered(snapshot)),
      description,
    );
  }
});

type Mutable<T> = T extends readonly (infer Item)[]
  ? Array<Mutable<Item>>
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

/** An equal plan that the caller owns and the validated-plan registry does not know. */
function externalCopy(plan: InstructionPlan): InstructionPlan {
  // EVIDENCE: JSON round-trips a compiler-produced plan, which is JSON data, into a fresh mutable graph.
  return JSON.parse(JSON.stringify(plan)) as InstructionPlan;
}

function mutableCopy(snapshot: RuntimeSnapshot): Mutable<RuntimeSnapshot> {
  // EVIDENCE: a runtime snapshot is JSON data, so its JSON copy is the same state for the fixture to corrupt.
  return JSON.parse(JSON.stringify(snapshot)) as Mutable<RuntimeSnapshot>;
}

/** Single-field corruptions of a valid snapshot that the plan's analysis decides. */
function corruptions(snapshot: RuntimeSnapshot): Mutable<RuntimeSnapshot>[] {
  const variants: Mutable<RuntimeSnapshot>[] = [];
  const variant = (change: (copy: Mutable<RuntimeSnapshot>) => void): void => {
    const copy = mutableCopy(snapshot);
    change(copy);
    variants.push(copy);
  };
  snapshot.callFrames.forEach((frame, index) => {
    frame.callerTemporaries.forEach((_, position) => {
      variant((copy) => copy.callFrames[index]!.callerTemporaries.splice(position, 1));
      variant((copy) => {
        copy.callFrames[index]!.callerTemporaries[position]!.value = 0;
      });
    });
    if (frame.kind !== "function") return;
    variant((copy) => {
      const copied = copy.callFrames[index]!;
      if (copied.kind === "function") copied.parameterState.parameterIndex += 1;
    });
    variant((copy) => {
      copy.frames[frame.scopeBaseDepth]!.bindings.push({ name: "extra", value: 0 });
    });
  });
  snapshot.loopFrames.forEach((_, index) => {
    variant((copy) => {
      copy.loopFrames[index]!.loopId += 100;
    });
    variant((copy) => {
      copy.loopFrames.splice(index, 1);
    });
  });
  snapshot.temporaries.forEach((_, index) => {
    variant((copy) => {
      copy.temporaries[index]!.value = 0;
    });
  });
  snapshot.frames.forEach((frame, index) => {
    if (frame.entry === null) return;
    variant((copy) => {
      copy.frames[index]!.entry = frame.entry! + 1;
    });
  });
  const fallback = snapshot.fallback;
  if (fallback !== null && "target" in fallback) {
    variant((copy) => {
      copy.fallback = { file: fallback.file, target: fallback.target + 1 };
    });
  }
  return variants;
}

test("a validated plan's kept analysis judges corrupted snapshots like a fresh analysis", () => {
  const plan = compileValidPlan(SCENARIO);
  // Every validation against an unrecognized plan analyses it afresh.
  const unrecognized = externalCopy(plan);
  const errors = (snapshot: unknown, against: InstructionPlan) =>
    classifyCapturedRuntimeSnapshot(snapshot, against).validation.errors;
  const { boundaries } = scenario();
  // Accepting every boundary first keeps the continuations that the corruptions below revisit.
  for (const snapshot of boundaries) assert.deepEqual(errors(snapshot, plan), []);

  const rejections: string[] = [];
  for (const snapshot of boundaries) {
    for (const corrupted of corruptions(snapshot)) {
      const kept = errors(corrupted, plan);
      assert.deepEqual(kept, errors(corrupted, unrecognized));
      rejections.push(...kept);
    }
  }
  for (const rule of [
    "Runtime caller temporaries cannot resume the suspended continuation.",
    "Runtime parameter progress does not match its exact instruction position.",
    "Runtime function prologue contains a non-parameter binding.",
    "Runtime loop frame does not match the instruction plan.",
    "Runtime state is missing a loop that its position runs in.",
    "contain malformed prepared-reference state",
    "contain malformed prepared-say state.",
    "Runtime scope frame is malformed.",
    "Runtime fallback is malformed.",
  ]) {
    assert.ok(
      rejections.some((error) => error.includes(rule)),
      rule,
    );
  }
});

const LOOPS_SOURCE = [
  "function pause(seconds = 1) {",
  "  wait seconds",
  "}",
  "repeat 3 {",
  "  pause()",
  "}",
  "repeat 1 {",
  "  pause()",
  "}",
  "exit",
].join("\n");

/**
 * Runs to the end, observing each wait at its deadline, and returns the number of operations. Every wait is in a
 * function called from a loop.
 */
function finishWaits(plan: InstructionPlan): number {
  let snapshot = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
  let operations = 1;
  while (snapshot.status === "waiting") {
    snapshot = observeTime(plan, snapshot, snapshot.currentSessionTimeMs + 1_000).snapshot;
    snapshot = run(plan, snapshot).snapshot;
    operations += 2;
  }
  assert.equal(snapshot.status, "halted");
  return operations;
}

test("operations on a validated plan analyse it once and each continuation once", () => {
  const plan = compileValidPlan(LOOPS_SOURCE);
  // Four waits, each observed and then continued.
  const operations = 9;
  const kept = withValidationTestStatistics((finish) => {
    assert.equal(finishWaits(plan), operations);
    return finish().counts;
  });
  // Scoped regression oracle, not a performance requirement: the plan is analysed once, and liveness is computed once
  // for the continuation in each of the two loops however often it is validated.
  assert.equal(kept.snapshotValidationAnalyses, 1);
  assert.equal(kept.continuationLivenessAnalyses, 2);

  const fresh = withValidationTestStatistics((finish) => {
    assert.equal(finishWaits(externalCopy(plan)), operations);
    return finish().counts;
  });
  // An external plan is captured and analysed afresh by every operation, all of them inside a call.
  assert.ok(fresh.snapshotValidationAnalyses! >= operations);
  assert.ok(fresh.continuationLivenessAnalyses! >= operations - 1);
});

test("a mutated external plan is validated against its new content", () => {
  const external = externalCopy(compileValidPlan(LOOPS_SOURCE));
  const waiting = run(external, createFreshRuntimeSnapshot(external)).snapshot;
  assert.equal(waiting.loopFrames.length, 1);
  assert.equal(observeTime(external, waiting, 0).outcome.kind, "observed");

  const loopId = waiting.loopFrames[0]!.loopId;
  // Renumbering every reference to the loop keeps the plan valid.
  for (const instruction of external.instructions) {
    if ("loopId" in instruction && instruction.loopId === loopId) {
      // EVIDENCE: the caller owns this JSON copy, whose instructions are mutable.
      (instruction as { loopId: number }).loopId += 100;
    }
  }
  assert.equal(validateInstructionPlan(external).valid, true);
  assert.throws(
    () => observeTime(external, waiting, 0),
    (error: unknown) => error instanceof RuntimeDataError && error.code === "TSR101",
  );
});

test("a malformed loop context cannot enlarge the continuation analysis", () => {
  const source = [
    "function pause {\n  wait 1\n}",
    "let total = 0",
    "while total < 1 {",
    "  repeat 1 {",
    "    pause()",
    "  }",
    "  total += 1",
    "}",
    "exit",
  ].join("\n");
  const nodes = (snapshot: unknown) =>
    withValidationTestStatistics((finish) => {
      const validation = validateRuntimeSnapshot(snapshot, compileValidPlan(source));
      return { valid: validation.valid, nodes: finish().counts.continuationLivenessNodes };
    });
  const waiting = run(
    compileValidPlan(source),
    createFreshRuntimeSnapshot(compileValidPlan(source)),
  ).snapshot;
  const valid = nodes(waiting);
  assert.equal(valid.valid, true);

  // A session's loops are planned and nested; copies of the inner loop's frame are neither.
  const corrupted = mutableCopy(waiting);
  const [outer, inner] = corrupted.loopFrames;
  corrupted.loopFrames = [outer!, ...Array.from({ length: 64 }, () => ({ ...inner! }))];
  corrupted.callFrames[0]!.loopBaseDepth = corrupted.loopFrames.length;
  const malformed = nodes(corrupted);
  assert.equal(malformed.valid, false);
  // Scoped regression oracle: the query of a context with one planned loop is no larger than that of the session's
  // two, rather than growing with the number of copies.
  assert.ok(malformed.nodes! <= valid.nodes!);
});

test("impossible loop contexts of one snapshot share one continuation analysis", () => {
  const source = [
    "function pause {\n  wait 1\n}",
    "repeat 1 {",
    "  repeat 1 {",
    "    repeat 1 {",
    "      repeat 1 {",
    "        pause()",
    "      }",
    "    }",
    "  }",
    "}",
    "exit",
  ].join("\n");
  const waiting = run(
    compileValidPlan(source),
    createFreshRuntimeSnapshot(compileValidPlan(source)),
  ).snapshot;
  const template = mutableCopy(waiting);
  const loops = template.loopFrames;
  const call = template.callFrames[0]!;
  assert.equal(loops.length, 4);
  // Eight calls stand at the same position, each in a context of the innermost loop and its own subset of the outer
  // three; only the context with all four is one that a session can have there.
  const corrupted = mutableCopy(waiting);
  corrupted.loopFrames = [];
  corrupted.callFrames = [];
  for (let subset = 0; subset < 8; subset += 1) {
    const owner = subset === 0 ? null : subset;
    for (const [index, loop] of loops.entries()) {
      if (index === 3 || (subset & (1 << index)) !== 0) {
        corrupted.loopFrames.push({ ...loop, callFrameId: owner });
      }
    }
    corrupted.callFrames.push({
      ...call,
      id: subset + 1,
      loopBaseDepth: corrupted.loopFrames.length,
    });
  }
  corrupted.nextCallFrameId = 9;
  const counts = withValidationTestStatistics((finish) => {
    assert.equal(validateRuntimeSnapshot(corrupted, compileValidPlan(source)).valid, false);
    return finish().counts;
  });
  // Scoped regression oracle: one analysis for the possible context and one shared by every impossible one, rather
  // than one per listed context.
  assert.ok(counts.continuationLivenessAnalyses! <= 2);
});

test("rejected snapshots add nothing to the kept continuation requirements", () => {
  const plan = compileValidPlan(LOOPS_SOURCE);
  const waiting = run(plan, createFreshRuntimeSnapshot(plan)).snapshot;
  assert.equal(validateRuntimeSnapshot(waiting, plan).valid, true);
  const kept = () => [...snapshotValidationAnalysis(plan).continuationRequirements.keys()];
  const before = kept();
  assert.equal(before.length, 1);

  for (let offset = 1; offset <= 20; offset += 1) {
    const corrupted = mutableCopy(waiting);
    // A loop the plan does not have, and a return position no call has.
    corrupted.loopFrames[0]!.loopId += offset;
    corrupted.callFrames[0]!.returnInstruction += offset;
    assert.equal(validateRuntimeSnapshot(corrupted, plan).valid, false);
  }
  assert.deepEqual(kept(), before);
});
