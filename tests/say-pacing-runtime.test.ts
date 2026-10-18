import assert from "node:assert/strict";
import test from "node:test";

import type { InstructionPlan } from "../src/plan/model.js";
import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/snapshot/checkpoint.js";
import { executeInstruction, run, RuntimeDataError } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import type { RuntimeSnapshot } from "../src/runtime/snapshot/state.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";
import { runUntilExit } from "./helpers/run-until-exit.js";
import { assertRuntimeResumeEquivalent, functionFrames } from "./helpers/runtime-equivalence.js";
import { createFreshRuntimeSnapshot } from "../src/runtime/snapshot/snapshot-construction.js";
import { validateRuntimeSnapshot } from "../src/runtime/snapshot/snapshot-validation.js";

test("say lowers smart, exact, and instant pacing with explicit skip policy", () => {
  const compiled = plan('say skippable "a"\nsay unskippable "b", 1.5 s\nsay "c", instant\nexit');
  const loweredPacing = compiled.instructions.map((instruction) => {
    if (instruction.kind !== "say") return instruction.kind;
    const pacingKind =
      instruction.pacing === "smart" || instruction.pacing === "instant"
        ? instruction.pacing
        : instruction.pacing.kind;
    return [instruction.skipPolicy, pacingKind];
  });

  assert.deepEqual(loweredPacing, [
    ["skippable", "smart"],
    ["unskippable", "duration"],
    [null, "instant"],
    "exit",
    "end",
  ]);
});

test("say lowering preserves contextual skip words as value identifiers", () => {
  const compiled = plan(
    [
      'let skippable = "one"',
      'let unskippable = "two"',
      "say skippable",
      "say unskippable",
      "say skippable, instant",
      "exit",
    ].join("\n"),
  );
  const says = compiled.instructions.filter(
    (instruction): instruction is Extract<typeof instruction, { kind: "say" }> =>
      instruction.kind === "say",
  );

  assert.deepEqual(
    says.map((instruction) => [instruction.skipPolicy, instruction.value.kind, instruction.pacing]),
    [
      [null, "identifier", "smart"],
      [null, "identifier", "smart"],
      [null, "identifier", "instant"],
    ],
  );
});

test("instant remains an identifier when its pacing expression continues", () => {
  const compiled = plan(
    [
      "let instant = { steps: [1 s], pause: 1 s }",
      'say "plus", instant.steps[0] + 1 s',
      'say "index", instant.steps[0]',
      'say "property", instant.pause',
      "exit",
    ].join("\n"),
  );
  const says = compiled.instructions.filter(
    (instruction): instruction is Extract<typeof instruction, { kind: "say" }> =>
      instruction.kind === "say",
  );
  assert.deepEqual(
    says.map((instruction) =>
      typeof instruction.pacing === "object" ? instruction.pacing.kind : instruction.pacing,
    ),
    ["binary", "index", "property"],
  );

  const call = plan('function instant(value) { return value }\nsay "call", instant(2 s)\nexit');
  const callResult = run(call, createFreshRuntimeSnapshot(call));
  const callGate = callResult.snapshot.foregroundAction;
  assert.equal(callGate?.kind, "chatPacingGate");
  if (callGate?.kind === "chatPacingGate") assert.equal(callGate.deadlineMs, 2_000);
});

test("say preparation resumes exactly once across an instruction-call pacing checkpoint", () => {
  const compiled = plan(
    [
      'let log = ""',
      "function textValue {",
      "  let ignored = random()",
      '  log = "${log}text"',
      '  return "hello"',
      "}",
      "function pace {",
      '  log = "${log}pace"',
      "  return 1 s",
      "}",
      "say textValue(), pace()",
      "exit",
    ].join("\n"),
  );
  const log = (snapshot: RuntimeSnapshot) =>
    snapshot.frames[0]?.bindings.find((binding) => binding.name === "log")?.value;

  const pace = compiled.functions.find((definition) => definition.name === "pace");
  assert.ok(pace !== undefined);

  // Checkpoint inside the pacing call, after the text was prepared.
  let snapshot = createFreshRuntimeSnapshot(compiled, { seed: 77 });
  for (
    let step = 0;
    step < compiled.instructions.length * 4 &&
    functionFrames(snapshot).at(-1)?.functionId !== pace.id;
    step += 1
  ) {
    assert.ok(["ready", "running"].includes(snapshot.status) && log(snapshot) !== "textpace");
    snapshot = executeInstruction(compiled, snapshot).snapshot;
  }
  const paceFrame = functionFrames(snapshot).at(-1);
  assert.equal(paceFrame?.functionId, pace.id, "the pacing call must be reached");
  assert.equal(log(snapshot), "text");
  const preparedRng = snapshot.rng.state;
  assert.notEqual(preparedRng, createFreshRuntimeSnapshot(compiled, { seed: 77 }).rng.state);

  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, snapshot)));
  const resumed = run(restored.plan, restored.snapshot);
  const direct = run(compiled, createFreshRuntimeSnapshot(compiled, { seed: 77 }));
  for (const [path, result] of [
    ["direct", direct],
    ["restored", resumed],
  ] as const) {
    assert.deepEqual(
      result.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
      ["hello"],
      path,
    );
    assert.equal(log(result.snapshot), "textpace", path);
    assert.equal(result.snapshot.rng.state, preparedRng, path);
  }
  assert.deepEqual(resumed.events, direct.events);
  assert.deepEqual(resumed.snapshot, direct.snapshot);
});

test("text-side calls capture explicit speaker provenance before they suspend", () => {
  const compiled = plan(
    [
      'speaker vera { displayName: "Before" }',
      "let calls = 0",
      "function mutate {",
      "  calls = calls + 1",
      '  vera.displayName = "After"',
      '  return "hello"',
      "}",
      "say as vera mutate(), instant",
      "exit",
    ].join("\n"),
  );
  const callIndex = compiled.instructions.findIndex(
    (instruction) => instruction.kind === "callFunction",
  );
  assert.ok(callIndex >= 0);

  let checkpointed = createFreshRuntimeSnapshot(compiled);
  while (checkpointed.nextInstruction !== callIndex) {
    checkpointed = executeInstruction(compiled, checkpointed).snapshot;
  }
  checkpointed = executeInstruction(compiled, checkpointed).snapshot;
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, checkpointed)),
  );
  const resumed = run(restored.plan, restored.snapshot);
  const direct = run(compiled, createFreshRuntimeSnapshot(compiled));

  assert.deepEqual(resumed.events, direct.events);
  assert.deepEqual(resumed.snapshot, direct.snapshot);
  const output = resumed.events.find((event) => event.kind === "say");
  assert.equal(output?.kind, "say");
  assert.equal(output?.speaker?.displayName, "Before");
  assert.equal(output?.text, "hello");
  assert.equal(resumed.events.filter((event) => event.kind === "say").length, 1);
  assert.equal(
    resumed.snapshot.frames[0]?.bindings.find((binding) => binding.name === "calls")?.value,
    1,
  );
  assert.equal(
    resumed.snapshot.speakers
      .find((speaker) => speaker.identifier === "vera")
      ?.properties.find((property) => property.name === "displayName")?.value,
    "After",
  );
});

test("prepared says retain contextual speaker identity across text and pacing calls", () => {
  const scenarios = [
    {
      name: "explicit speaker in text before a text-side call",
      speaker: "say as vera",
      text: '"${speaker.title} ${textValue()}"',
      pacing: "instant",
      expected: "Captain hello",
      gateMs: null,
    },
    {
      name: "explicit speaker in text before a pacing-side call",
      speaker: "say as vera",
      text: '"${speaker.title} hello"',
      pacing: "pace()",
      expected: "Captain hello",
      gateMs: 1_000,
    },
    {
      name: "explicit speaker in pacing before a pacing-side call",
      speaker: "say as vera",
      text: '"hello"',
      pacing: "speaker.delay + pace()",
      expected: "hello",
      gateMs: 2_000,
    },
    {
      name: "default speaker in text before a text-side call",
      speaker: "say",
      text: '"${speaker.title} ${textValue()}"',
      pacing: "instant",
      expected: "Captain hello",
      gateMs: null,
    },
    {
      name: "default speaker in pacing before a pacing-side call",
      speaker: "say",
      text: '"hello"',
      pacing: "speaker.delay + pace()",
      expected: "hello",
      gateMs: 2_000,
    },
  ] as const;

  for (const scenario of scenarios) {
    const compiled = plan(
      [
        'speaker vera { title: "Captain"\ndelay: 1 s }',
        "speaker vera",
        'function textValue { return "hello" }',
        "function pace { return 1 s }",
        `${scenario.speaker} ${scenario.text}, ${scenario.pacing}`,
        "exit",
      ].join("\n"),
    );
    const result = runUntilExit(compiled, createFreshRuntimeSnapshot(compiled));
    const output = result.events.find((event) => event.kind === "say");
    assert.equal(output?.kind, "say", scenario.name);
    assert.equal(output?.text, scenario.expected, scenario.name);
    assert.equal(output?.speaker?.identifier, "vera", scenario.name);
    // vera.delay is 1 s and pace() returns 1 s; instant creates no gate.
    const gates = [result.snapshot.foregroundAction, ...result.snapshot.backgroundActions].filter(
      (action) => action?.kind === "chatPacingGate",
    );
    assert.deepEqual(
      gates.map((gate) => gate.deadlineMs - gate.createdAtMs),
      scenario.gateMs === null ? [] : [scenario.gateMs],
      scenario.name,
    );
  }

  const mutated = plan(
    [
      'speaker vera { title: "Captain"\ndisplayName: "Before" }',
      "function mutate {",
      '  vera.displayName = "After"',
      '  return "hello"',
      "}",
      "function pace { return 1 s }",
      'say as vera "${speaker.title} ${mutate()}", pace()',
      "exit",
    ].join("\n"),
  );
  const result = run(mutated, createFreshRuntimeSnapshot(mutated));
  const output = result.events.find((event) => event.kind === "say");
  assert.equal(output?.kind, "say");
  assert.equal(output?.text, "Captain hello");
  assert.equal(output?.speaker?.displayName, "Before");
  assert.equal(
    result.snapshot.speakers
      .find((speaker) => speaker.identifier === "vera")
      ?.properties.find((property) => property.name === "displayName")?.value,
    "After",
  );
});

test("prepared contextual speaker values survive a suspended text call checkpoint", () => {
  const compiled = plan(
    [
      'speaker vera { title: "Captain"\ndelay: 1 s }',
      "function textValue {",
      "  wait 1 ms",
      '  return "hello"',
      "}",
      "function pace { return 1 s }",
      'say as vera "${speaker.title} ${textValue()}", speaker.delay + pace()',
      "exit",
    ].join("\n"),
  );
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled)).snapshot;
  assert.equal(waiting.status, "waiting");
  assert.equal(validateRuntimeSnapshot(waiting, compiled).valid, true);
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, waiting)));
  const delay = waiting.foregroundAction;
  assert.equal(delay?.kind, "delay");
  const direct = run(compiled, observeTime(compiled, waiting, delay!.deadlineMs).snapshot);
  const resumed = run(
    restored.plan,
    observeTime(restored.plan, restored.snapshot, delay!.deadlineMs).snapshot,
  );
  assert.deepEqual(resumed.events, direct.events);
  assert.deepEqual(resumed.snapshot, direct.snapshot);
  assert.equal(resumed.events.find((event) => event.kind === "say")?.kind, "say");
  assert.equal(
    resumed.events.find((event) => event.kind === "say" && event.text === "Captain hello")?.kind,
    "say",
  );
});

test("a paced say shows its message and holds the script at the say for its reading time", () => {
  const compiled = plan('say "first"\nsay "second"\nexit');
  const fresh = createFreshRuntimeSnapshot(compiled);
  const result = run(compiled, fresh);
  assert.deepEqual(
    result.events.map((event) => event.kind),
    ["say", "actionRequested"],
  );
  assert.equal(result.snapshot.status, "waiting");
  const gate = result.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  assert.equal(gate?.actionId, fresh.nextActionId);
  // Default smart pacing for one word: 1500 + max(1 * 300, 5 * 30) = 1800 ms.
  assert.equal(gate?.deadlineMs, 1_800);
  assert.deepEqual(result.snapshot.backgroundActions, []);
  // Like a wait, the script waits at its own instruction and continues after it.
  assert.equal(result.snapshot.nextInstruction, gate?.owningInstruction);
  assert.equal(compiled.instructions[result.snapshot.nextInstruction]?.kind, "say");
  assert.equal(gate?.continuationInstruction, gate!.owningInstruction + 1);
});

test("a skip ends the reading time and the next say runs at once, directly and after checkpoint restore", () => {
  const compiled = plan('say "${["first", "first-alt"]}"\nsay "${["second", "second-alt"]}"\nexit');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled, { seed: 77 }));
  const gate = waiting.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, waiting.snapshot)),
  );
  const paths = [
    ["direct", { plan: compiled, snapshot: waiting.snapshot }],
    ["restored", restored],
  ] as const;
  const results = paths.map(([path, start]) => {
    const settled = completeAction(start.plan, start.snapshot, {
      actionId: gate!.actionId,
      actionKind: "chatPacingGate",
      payload: { kind: "skip" },
    });
    assert.equal(settled.outcome.kind, "completed", path);
    assert.deepEqual(
      settled.events.map((event) =>
        event.kind === "actionCompleted" ? event.settlement.settlementKind : event.kind,
      ),
      ["skipped"],
      path,
    );
    const resumed = run(start.plan, settled.snapshot);
    const says = resumed.events.flatMap((event) => (event.kind === "say" ? [event.text] : []));
    assert.equal(says.length, 1, path);
    assert.ok(["second", "second-alt"].includes(says[0]!), path);
    return { events: [...settled.events, ...resumed.events], snapshot: resumed.snapshot };
  });
  assert.deepEqual(results[1], results[0]);
});

test("pacing gate survives checkpoint JSON restore and settles through observed time", () => {
  const compiled = plan('say "first"\nsay "second"\nexit');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, waiting.snapshot)),
  );
  const settled = observeTime(restored.plan, restored.snapshot, 1_800);
  assert.deepEqual(
    settled.events.map((event) => event.kind),
    ["actionCompleted"],
  );
  const resumed = run(restored.plan, settled.snapshot);
  assert.ok(resumed.events.some((event) => event.kind === "say" && event.text === "second"));
});

test("positive pacing control-flow paths have equivalent uninterrupted and restored results", () => {
  const scenarios = [
    'if true { say "branch" }\nsay "after"\nexit',
    'repeat 1 { say "loop" }\nsay "after"\nexit',
    'function f { say "call" }\nf()\nsay "after"\nexit',
    'function f(count) { if count == 0 { say "recursive" } else { f(count - 1) } }\nf(1)\nsay "after"\nexit',
  ];

  for (const source of scenarios) {
    const compiled = plan(source);
    const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
    const gate = waiting.snapshot.foregroundAction;
    assert.equal(gate?.kind, "chatPacingGate", source);

    const uninterruptedSettled = observeTime(compiled, waiting.snapshot, gate!.deadlineMs);
    const uninterrupted = run(compiled, uninterruptedSettled.snapshot);
    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(compiled, waiting.snapshot)),
    );
    const restoredSettled = observeTime(restored.plan, restored.snapshot, gate!.deadlineMs);
    const resumed = run(restored.plan, restoredSettled.snapshot);

    assert.deepEqual(
      [...restoredSettled.events, ...resumed.events],
      [...uninterruptedSettled.events, ...uninterrupted.events],
      source,
    );
    assert.deepEqual(resumed.snapshot, uninterrupted.snapshot, source);
    assert.deepEqual(
      resumed.events.flatMap((event) => (event.kind === "say" ? [event.text] : [])),
      ["after"],
      source,
    );
  }
});

test("pacing creation provenance rejects an impossible function owner", () => {
  const compiled = plan('function f { say "first" }\nf()\nexit');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.equal(waiting.snapshot.foregroundAction?.kind, "chatPacingGate");
  // EVIDENCE: fixture: parse a serialized waiting checkpoint into the persisted action-owner shape mutated below.
  const corrupted = JSON.parse(
    serializeCheckpoint(createCheckpoint(compiled, waiting.snapshot)),
  ) as { snapshot: { foregroundAction: { ownerCallFrameId: number | null } } };
  corrupted.snapshot.foregroundAction.ownerCallFrameId = null;

  assert.equal(validateRuntimeSnapshot(corrupted.snapshot, compiled).valid, false);
  assert.throws(() => deserializeCheckpoint(JSON.stringify(corrupted)));
});

test("smart pacing uses the final visible text and captured settings", () => {
  const cases = [
    {
      source: 'let name = "Ada"\nsay \"Hi ${name}\"\nexit',
      options: {},
      text: "Hi Ada",
      deadlineMs: 2_100,
    },
    {
      source: 'let texts = ["short", "selected text"]\nsay "${texts}"\nexit',
      options: { seed: 77 },
      text: "short",
      deadlineMs: 1_800,
    },
    { source: 'say "😀"\nexit', options: {}, text: "😀", deadlineMs: 1_800 },
    {
      source: 'say "one\\ttwo\\nthree"\nexit',
      options: {},
      text: "one\ttwo\nthree",
      deadlineMs: 2_400,
    },
    {
      source: 'say "hello 😀"\nexit',
      options: { baseDelayMs: 7, delayPerWordMs: 11, delayPerCharacterMs: 13 },
      text: "hello 😀",
      deadlineMs: 98,
    },
  ];

  for (const scenario of cases) {
    const compiled = plan(scenario.source);
    const result = run(compiled, createFreshRuntimeSnapshot(compiled, scenario.options));
    const gate = result.snapshot.foregroundAction;
    assert.equal(gate?.kind, "chatPacingGate", scenario.source);
    assert.equal(gate?.deadlineMs, scenario.deadlineMs, scenario.source);
    const sayEvent = result.events.find((event) => event.kind === "say");
    assert.equal(sayEvent?.kind, "say", scenario.source);
    if (sayEvent?.kind !== "say") throw new Error("Expected a say event.");
    assert.equal(sayEvent.text, scenario.text, scenario.source);
  }

  const zero = plan('say "no gate"\nexit');
  const immediate = run(
    zero,
    createFreshRuntimeSnapshot(zero, { baseDelayMs: 0, delayPerWordMs: 0, delayPerCharacterMs: 0 }),
  );
  assert.deepEqual(
    immediate.events.map((event) => event.kind),
    ["say", "exit"],
  );
  assert.equal(immediate.snapshot.nextActionId, 1);
  assert.equal(immediate.snapshot.lastSettlement, null);
});

test("say skip policy follows explicit, speaker, and fallback precedence", () => {
  const cases = [
    ['speaker vera { defaultSaySkippable: false }\nsay skippable "text"\nexit', true],
    ['speaker vera { defaultSaySkippable: true }\nsay unskippable "text"\nexit', false],
    ['speaker vera { defaultSaySkippable: false }\nsay as vera "text"\nexit', false],
    ['speaker vera { defaultSaySkippable: true }\nsay as vera "text"\nexit', true],
    ['say "text"\nexit', true],
  ] as const;
  for (const [source, expected] of cases) {
    const compiled = plan(source);
    const result = run(compiled, createFreshRuntimeSnapshot(compiled));
    const gate = result.snapshot.foregroundAction;
    assert.equal(gate?.kind, "chatPacingGate", source);
    if (gate?.kind === "chatPacingGate") {
      assert.equal(gate.skippable, expected, source);
    }
  }

  // Each message's reading time has its own skip policy.
  const sequencePlan = plan(
    [
      "speaker vera { defaultSaySkippable: false }",
      'say as vera "first"',
      'say as vera skippable "second"',
      "exit",
    ].join("\n"),
  );
  const waiting = run(sequencePlan, createFreshRuntimeSnapshot(sequencePlan));
  const gate = waiting.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  assert.equal(gate?.skippable, false);
  const settled = observeTime(sequencePlan, waiting.snapshot, gate!.deadlineMs);
  const resumed = run(sequencePlan, settled.snapshot);
  const replacement = resumed.snapshot.foregroundAction;
  assert.equal(replacement?.kind, "chatPacingGate");
  if (replacement?.kind === "chatPacingGate") assert.equal(replacement.skippable, true);

  // A host value hides the number from the compiler, which rejects a known non-boolean value itself (#552).
  const invalid = plan("speaker vera { defaultSaySkippable: flag }\nexit", { globals: ["flag"] });
  const rejected = run(invalid, createFreshRuntimeSnapshot(invalid, { globals: { flag: 1 } }));
  assert.equal(rejected.snapshot.status, "failed");
  assert.equal(rejected.snapshot.speakers.length, 0);
  // Only the host value is a global; the failed declaration commits nothing.
  assert.deepEqual(
    rejected.snapshot.globals.map((binding) => binding.name),
    ["flag"],
  );
});

test("invalid runtime pacing fails without committing say evaluation effects", () => {
  const compiled = plan(
    [
      "speaker vera { }",
      'say as vera "first"',
      "function dynamic(value) {\n    return value\n}",
      "let pacing = dynamic(-1 s)",
      "say as vera random(), pacing",
      "exit",
    ].join("\n"),
  );
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled, { seed: 77 }));
  assert.deepEqual(
    waiting.events.map((event) => event.kind),
    ["developerWarning", "say", "actionRequested"],
  );
  const gate = waiting.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  const result = run(compiled, observeTime(compiled, waiting.snapshot, gate!.deadlineMs).snapshot);

  assert.equal(result.snapshot.status, "failed");
  assert.equal(result.snapshot.rng.state, 77);
  assert.equal(result.snapshot.foregroundAction, null);
  // The failed say shows nothing and warns about the speaker no second time.
  assert.deepEqual(
    result.events.map((event) => event.kind),
    ["runtimeFailure"],
  );

  const noWarning = plan(
    [
      "speaker ada {}",
      "function dynamic(value) {\n    return value\n}",
      "let pacing = dynamic(-1 s)",
      "say as ada random(), pacing",
      "exit",
    ].join("\n"),
  );
  const noWarningResult = run(noWarning, createFreshRuntimeSnapshot(noWarning, { seed: 77 }));
  assert.equal(noWarningResult.snapshot.rng.state, 77);
  assert.deepEqual(
    noWarningResult.events.map((event) => event.kind),
    ["runtimeFailure"],
  );
});

test("unsupported and overflowing runtime pacing leave message evaluation uncommitted", () => {
  const unsupported = plan("say random(), 9007199254740991 s\nexit");
  const unsupportedResult = run(unsupported, createFreshRuntimeSnapshot(unsupported, { seed: 77 }));
  assert.equal(unsupportedResult.snapshot.status, "failed");
  assert.equal(unsupportedResult.snapshot.rng.state, 77);
  assert.deepEqual(
    unsupportedResult.events.map((event) => event.kind),
    ["runtimeFailure"],
  );

  const nonFinite = plan(
    "function dynamic(value) {\n    return value\n}\nlet zero = dynamic(0)\nsay random(), 1 s / zero\nexit",
  );
  const nonFiniteResult = run(nonFinite, createFreshRuntimeSnapshot(nonFinite, { seed: 77 }));
  assert.equal(nonFiniteResult.snapshot.status, "failed");
  assert.equal(nonFiniteResult.snapshot.rng.state, 77);
  assert.deepEqual(
    nonFiniteResult.events.map((event) => event.kind),
    ["runtimeFailure"],
  );

  const overflow = plan("say random(), 1 s\nexit");
  const overflowResult = run(
    overflow,
    createFreshRuntimeSnapshot(overflow, {
      seed: 77,
      initialSessionTimeMs: Number.MAX_SAFE_INTEGER,
    }),
  );
  assert.equal(overflowResult.snapshot.status, "failed");
  assert.equal(
    overflowResult.snapshot.failure?.message,
    "Scene time has reached its limit, so this say cannot pause. Use 'instant' instead.",
  );
  assert.equal(overflowResult.snapshot.rng.state, 77);
  assert.deepEqual(
    overflowResult.events.map((event) => event.kind),
    ["runtimeFailure"],
  );
});

test("collection changes and random draws of a rejected say roll back, directly and after restore", () => {
  // Each say draws or removes before its pacing is rejected; the binding keeps its unchanged collection.
  const cases = [
    [
      "function dynamic(value) {\n    return value\n}\nlet items = [1, 2]\nlet pacing = dynamic(-1 s)\nsay items.removeFirst(), pacing\nexit",
      { kind: "list", items: [1, 2] },
    ],
    [
      'function dynamic(value) {\n    return value\n}\nlet items = dict { a: 1, b: 2 }\nlet pacing = dynamic(-1 s)\nsay items.remove("a"), pacing\nexit',
      {
        kind: "dict",
        entries: [
          { key: "a", value: 1 },
          { key: "b", value: 2 },
        ],
      },
    ],
    [
      "function dynamic(value) {\n    return value\n}\nlet pacing = dynamic(-1 s)\nsay random(), pacing\nexit",
      null,
    ],
  ] as const;
  for (const [source, items] of cases) {
    const { events, finalSnapshot } = assertRuntimeResumeEquivalent(source, {
      ending: "failed",
      seed: 77,
    });
    assert.equal(finalSnapshot.failure?.code, "TSR050", source);
    assert.equal(
      finalSnapshot.failure?.message,
      "Say pacing must be a duration of at least 0 seconds, but this is -1 second.",
      source,
    );
    assert.deepEqual(
      events.map((event) => event.kind),
      ["runtimeFailure"],
      source,
    );
    assert.equal(finalSnapshot.rng.state, 77, source);
    if (items !== null) {
      const binding = finalSnapshot.frames[0]?.bindings.find(({ name }) => name === "items");
      assert.deepEqual(binding?.value, items, source);
    }
  }
});

test("say output that evaluates no expression stages atomically, directly and after restore", () => {
  const resumedFromCheckpoint = (compiled: InstructionPlan, snapshot: RuntimeSnapshot) => {
    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(compiled, snapshot)),
    );
    return run(restored.plan, restored.snapshot);
  };

  // A speaker without a display name warns before the overflowing smart pacing deadline rejects the say.
  const rejected = plan('speaker vera { }\nsay as vera "first"\nexit');
  let beforeSay = createFreshRuntimeSnapshot(rejected, {
    initialSessionTimeMs: Number.MAX_SAFE_INTEGER,
  });
  while (rejected.instructions[beforeSay.nextInstruction]?.kind !== "say") {
    beforeSay = executeInstruction(rejected, beforeSay).snapshot;
  }
  const rejectedResult = run(rejected, beforeSay);
  assert.equal(rejectedResult.snapshot.failure?.code, "TSR050");
  assert.equal(
    rejectedResult.snapshot.failure?.message,
    "Scene time has reached its limit, so this say cannot pause. Use 'instant' instead.",
  );
  assert.deepEqual(rejectedResult.snapshot.warnedSpeakerIds, []);
  assert.equal(rejectedResult.snapshot.foregroundAction, null);
  assert.deepEqual(
    rejectedResult.events.map((event) => event.kind),
    ["runtimeFailure"],
  );
  assert.deepEqual(resumedFromCheckpoint(rejected, beforeSay), rejectedResult);

  // Each smart message holds the script for its reading time; the instant one after them creates none.
  const flow = plan(
    'speaker vera { }\nsay as vera "first"\nsay as vera "second"\nsay "third", instant\nexit',
  );
  const waiting = run(flow, createFreshRuntimeSnapshot(flow));
  assert.deepEqual(resumedFromCheckpoint(flow, createFreshRuntimeSnapshot(flow)), waiting);
  assert.deepEqual(
    waiting.events.map((event) => event.kind),
    ["developerWarning", "say", "actionRequested"],
  );
  const gate = waiting.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  const released = observeTime(flow, waiting.snapshot, gate!.deadlineMs).snapshot;
  const second = run(flow, released);
  assert.deepEqual(resumedFromCheckpoint(flow, released), second);
  assert.deepEqual(
    second.events.map((event) => (event.kind === "say" ? event.text : event.kind)),
    ["second", "actionRequested"],
  );
  const secondGate = second.snapshot.foregroundAction;
  assert.equal(secondGate?.kind, "chatPacingGate");
  const releasedAgain = observeTime(flow, second.snapshot, secondGate!.deadlineMs).snapshot;
  const finished = run(flow, releasedAgain);
  assert.deepEqual(resumedFromCheckpoint(flow, releasedAgain), finished);
  assert.equal(finished.snapshot.status, "halted");
  assert.deepEqual(
    finished.events.map((event) => (event.kind === "say" ? event.text : event.kind)),
    ["third", "exit"],
  );
  assert.deepEqual(finished.snapshot.warnedSpeakerIds, [waiting.snapshot.speakers[0]!.id]);
  assert.deepEqual(finished.snapshot.backgroundActions, []);
});

test("unskippable pacing rejects typed skips without mutating state", () => {
  const compiled = plan('say unskippable "first"\nsay "second"\nexit');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const gate = waiting.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  const rejected = completeAction(compiled, waiting.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(rejected.outcome.kind, "invalidPayload");
  assert.deepEqual(rejected.events, []);
  assert.deepEqual(rejected.snapshot, waiting.snapshot);
});

test("a late observation settles the reading time at its deadline and the wait after it starts then", () => {
  const compiled = plan('say "first"\nwait 1 s\nexit');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const gate = waiting.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  assert.equal(gate?.deadlineMs, 1_800);

  const observed = observeTime(compiled, waiting.snapshot, 5_000);
  assert.deepEqual(
    observed.events.map((event) =>
      event.kind === "actionCompleted" ? event.settlement.actionKind : event.kind,
    ),
    ["chatPacingGate"],
  );
  // The script can continue, so scene time stops at the reading time's end until it waits again.
  assert.equal(observed.snapshot.status, "running");
  assert.equal(observed.snapshot.currentSessionTimeMs, 1_800);
  assert.equal(observed.snapshot.observedSessionTimeMs, 5_000);
  assert.equal(validateRuntimeSnapshot(observed.snapshot, compiled).valid, true);

  const exited = run(compiled, observed.snapshot);
  assert.deepEqual(
    exited.events.map((event) => event.kind),
    ["actionRequested", "actionCompleted", "exit"],
  );
  const delay = exited.events[0];
  assert.deepEqual(
    delay?.kind === "actionRequested" && delay.action.kind === "delay"
      ? [delay.action.createdAtMs, delay.action.deadlineMs]
      : null,
    [1_800, 2_800],
  );
  assert.equal(exited.snapshot.currentSessionTimeMs, 5_000);
});

test("an observation while a settled reading time's continuation is pending settles nothing until the script runs", () => {
  const compiled = plan('say "first", 5 s\nwait 1 ms\nexit');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const pacing = waiting.snapshot.foregroundAction;
  assert.equal(pacing?.kind, "chatPacingGate");

  const observed = observeTime(compiled, waiting.snapshot, pacing!.deadlineMs);
  assert.deepEqual(
    observed.events.map((event) =>
      event.kind === "actionCompleted" ? event.settlement.actionId : null,
    ),
    [pacing!.actionId],
  );
  assert.equal(observed.snapshot.status, "running");
  const again = observeTime(compiled, observed.snapshot, pacing!.deadlineMs + 1);
  assert.deepEqual(again.events, []);
  assert.equal(again.snapshot.currentSessionTimeMs, pacing!.deadlineMs);
  assert.equal(again.snapshot.observedSessionTimeMs, pacing!.deadlineMs + 1);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, again.snapshot)),
  );
  assert.deepEqual(restored.snapshot, again.snapshot);

  // The wait starts when the reading time ends; scene time then catches up through it to the exit.
  const completed = run(restored.plan, restored.snapshot);
  assert.deepEqual(
    completed.events.map((event) => event.kind),
    ["actionRequested", "actionCompleted", "exit"],
  );
  assert.equal(completed.snapshot.currentSessionTimeMs, pacing!.deadlineMs + 1);
  assert.equal(completed.snapshot.status, "halted");
  assert.equal(validateRuntimeSnapshot(completed.snapshot, restored.plan).valid, true);
});

test("exit after a paced say ends the session only after its reading time", () => {
  const compiled = plan('say "first", 5 s\nexit');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.deepEqual(
    waiting.events.map((event) => event.kind),
    ["say", "actionRequested"],
  );
  assert.equal(waiting.snapshot.status, "waiting");
  const gate = waiting.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  assert.deepEqual(observeTime(compiled, waiting.snapshot, 4_999).events, []);

  const released = observeTime(compiled, waiting.snapshot, gate!.deadlineMs);
  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, released.snapshot)),
  );
  const exited = run(restored.plan, restored.snapshot);
  assert.deepEqual(
    exited.events.map((event) => event.kind),
    ["exit"],
  );
  assert.equal(exited.snapshot.status, "halted");
  assert.equal(validateRuntimeSnapshot(exited.snapshot, compiled).valid, true);
  assert.doesNotThrow(() =>
    deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, exited.snapshot))),
  );

  const replay = completeAction(compiled, exited.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(replay.outcome.kind, "alreadySettled");
  assert.equal(replay.events.length, 0);
});

test("exact and zero pacing create only the required actions", () => {
  const exact = plan('say "first", 0.5 s\nexit');
  const exactResult = run(exact, createFreshRuntimeSnapshot(exact));
  assert.equal(exactResult.snapshot.foregroundAction?.kind, "chatPacingGate");
  assert.equal(exactResult.snapshot.foregroundAction?.deadlineMs, 500);

  const zero = plan('say "now", 0 s\nexit');
  const zeroResult = run(zero, createFreshRuntimeSnapshot(zero));
  assert.deepEqual(
    zeroResult.events.map((event) => event.kind),
    ["say", "exit"],
  );
  assert.equal(zeroResult.snapshot.nextActionId, 1);
  assert.equal(zeroResult.snapshot.lastSettlement, null);
});

test("pacing completion preserves active-first, replay, stale, unknown, and wait-rejection outcomes", () => {
  const compiled = plan('say "first"\nwait 10 s\nexit');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const gate = waiting.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");

  const skipped = completeAction(compiled, waiting.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(skipped.outcome.kind, "completed");
  assert.equal(
    skipped.events.some((event) => event.kind === "playerTranscript"),
    false,
  );

  const duplicate = completeAction(compiled, skipped.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(duplicate.outcome.kind, "alreadySettled");
  assert.deepEqual(duplicate.events, []);

  const delayed = run(compiled, skipped.snapshot);
  const delay = delayed.snapshot.foregroundAction;
  assert.equal(delay?.kind, "delay");
  const wrongKind = completeAction(compiled, delayed.snapshot, {
    actionId: delay!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  // A wait accepts no host completion, whatever kind the request claims.
  assert.equal(wrongKind.outcome.kind, "invalidPayload");
  assert.deepEqual(wrongKind.snapshot, delayed.snapshot);

  const newer = observeTime(compiled, delayed.snapshot, 10_000);
  const stale = completeAction(compiled, newer.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.deepEqual(stale.outcome, { kind: "staleAction", actionId: gate!.actionId });
  const unknown = completeAction(compiled, newer.snapshot, {
    actionId: 99,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.deepEqual(unknown.outcome, { kind: "unknownAction", actionId: 99 });
});

test("pacing capacity and action-ID failures do not partially commit transitions", () => {
  const max = Number.MAX_SAFE_INTEGER;

  const initialPlan = plan("say random()\nexit");
  const initial = createFreshRuntimeSnapshot(initialPlan, { seed: 77 });
  initial.nextEventSequence = max - 1;
  const initialFailure = run(initialPlan, initial);
  assert.equal(initialFailure.snapshot.status, "failed");
  assert.equal(initialFailure.snapshot.rng.state, 77);
  assert.equal(initialFailure.snapshot.foregroundAction, null);
  assert.equal(initialFailure.snapshot.nextActionId, 1);
  assert.deepEqual(
    initialFailure.events.map((event) => event.kind),
    ["runtimeFailure"],
  );

  const exhaustedId = createFreshRuntimeSnapshot(initialPlan, { seed: 77 });
  exhaustedId.nextActionId = max;
  const idFailure = run(initialPlan, exhaustedId);
  assert.equal(idFailure.snapshot.status, "failed");
  assert.equal(idFailure.snapshot.rng.state, 77);
  assert.equal(idFailure.snapshot.foregroundAction, null);
  assert.equal(idFailure.snapshot.nextActionId, max);
});

test("a reading time reserves the event its completion needs", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const pacingPlan = plan('say "first", 5 s\nexit');

  const justEnough = createFreshRuntimeSnapshot(pacingPlan);
  justEnough.nextEventSequence = max - 3;
  const created = executeInstruction(pacingPlan, justEnough);
  assert.equal(created.snapshot.foregroundAction?.kind, "chatPacingGate");
  assert.equal(validateRuntimeSnapshot(created.snapshot, pacingPlan).valid, true);

  const oneLess = createFreshRuntimeSnapshot(pacingPlan);
  oneLess.nextEventSequence = max - 2;
  const rejected = run(pacingPlan, oneLess);
  assert.equal(rejected.snapshot.status, "failed");
  assert.equal(rejected.snapshot.foregroundAction, null);

  const settlementInput = structuredClone(created.snapshot);
  settlementInput.nextEventSequence = max - 1;
  const gate = settlementInput.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  const settled = completeAction(pacingPlan, settlementInput, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(settled.outcome.kind, "completed");
  assert.equal(settled.snapshot.nextEventSequence, max);
  assert.equal(validateRuntimeSnapshot(settled.snapshot, pacingPlan).valid, true);
});

test("say transitions reserve their own and future action events atomically", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const exhausted = (error: unknown) =>
    error instanceof RuntimeDataError && error.code === "TSR101";

  // A positive pacing gate needs the say, its request, and its future completion.
  const positive = plan('say "last", 5 s\nexit');
  const positiveEnough = createFreshRuntimeSnapshot(positive);
  positiveEnough.nextEventSequence = max - 3;
  const positiveCompleted = executeInstruction(positive, positiveEnough);
  assert.deepEqual(
    positiveCompleted.events.map((event) => event.kind),
    ["say", "actionRequested"],
  );
  assert.equal(positiveCompleted.snapshot.foregroundAction?.kind, "chatPacingGate");
  assert.equal(validateRuntimeSnapshot(positiveCompleted.snapshot, positive).valid, true);

  const positiveOneLess = createFreshRuntimeSnapshot(positive);
  positiveOneLess.nextEventSequence = max - 2;
  const positiveRejected = executeInstruction(positive, positiveOneLess);
  assert.equal(positiveRejected.snapshot.status, "failed");
  assert.equal(positiveRejected.snapshot.nextInstruction, 0);
  assert.equal(positiveRejected.snapshot.foregroundAction, null);
  assert.deepEqual(
    positiveRejected.events.map((event) => event.kind),
    ["runtimeFailure"],
  );
  assert.equal(validateRuntimeSnapshot(positiveRejected.snapshot, positive).valid, true);

  for (const pacing of ["0 s", "instant"]) {
    // An immediate say needs only itself; without that event no failure can be reported either.
    const immediate = plan(`say "last", ${pacing}\nexit`);
    const enough = createFreshRuntimeSnapshot(immediate);
    enough.nextEventSequence = max - 1;
    const completed = executeInstruction(immediate, enough);
    assert.deepEqual(
      completed.events.map((event) => event.kind),
      ["say"],
      pacing,
    );

    const oneLess = createFreshRuntimeSnapshot(immediate);
    oneLess.nextEventSequence = max;
    const before = JSON.stringify(oneLess);
    assert.throws(() => executeInstruction(immediate, oneLess), exhausted, pacing);
    assert.equal(JSON.stringify(oneLess), before, pacing);
  }
});

test("speaker assignment keeps defaultSaySkippable boolean", () => {
  // `dynamic` hides the text from the compiler, which rejects a known non-boolean value itself (#552).
  const assignmentPlan = plan(
    'function dynamic(value) { return value }\nspeaker vera { defaultSaySkippable: true }\nvera.defaultSaySkippable = dynamic("no")\nexit',
  );
  const rejected = run(assignmentPlan, createFreshRuntimeSnapshot(assignmentPlan));
  assert.equal(rejected.snapshot.status, "failed");
  assert.equal(
    rejected.snapshot.speakers[0]?.properties.find(
      (property) => property.name === "defaultSaySkippable",
    )?.value,
    true,
  );

  const booleanPlan = plan(
    "speaker vera { defaultSaySkippable: true }\nvera.defaultSaySkippable = false\nexit",
  );
  const accepted = run(booleanPlan, createFreshRuntimeSnapshot(booleanPlan));
  assert.equal(
    accepted.snapshot.speakers[0]?.properties.find(
      (property) => property.name === "defaultSaySkippable",
    )?.value,
    false,
  );
});

test("say instruction plans and public pacing failures stay at their validation boundaries", () => {
  const base = plan('speaker vera {}\nsay as vera skippable "text", 1 s\nexit');
  const sayIndex = base.instructions.findIndex((instruction) => instruction.kind === "say");
  const say = `$.instructions[${sayIndex}]`;
  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: fixture table: each callback deliberately violates a different persisted say-instruction field before runtime validation.
  const invalidPlans: Array<[string, string, (candidate: any) => void]> = [
    [
      "missing skip policy",
      `${say}.skipPolicy`,
      (candidate) => {
        delete candidate.instructions[sayIndex].skipPolicy;
      },
    ],
    [
      "invalid skip policy",
      `${say}.skipPolicy`,
      (candidate) => {
        candidate.instructions[sayIndex].skipPolicy = "later";
      },
    ],
    [
      "missing pacing",
      `${say}.pacing`,
      (candidate) => {
        delete candidate.instructions[sayIndex].pacing;
      },
    ],
    [
      "malformed pacing expression",
      `${say}.pacing`,
      (candidate) => {
        candidate.instructions[sayIndex].pacing = { kind: "missing" };
      },
    ],
    [
      "invalid speaker",
      `${say}.speaker`,
      (candidate) => {
        candidate.instructions[sayIndex].speaker = 123;
      },
    ],
    [
      "malformed value",
      `${say}.value`,
      (candidate) => {
        candidate.instructions[sayIndex].value = { kind: "literal", value: () => "bad" };
      },
    ],
    [
      "malformed location",
      `${say}.span`,
      (candidate) => {
        candidate.instructions[sayIndex].span.so = -1;
      },
    ],
  ];
  for (const [label, path, mutate] of invalidPlans) {
    // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: fixture: expose the cloned say instruction to the deliberate invalid mutation selected above.
    const hostile = structuredClone(base) as any;
    mutate(hostile);
    const validation = validateInstructionPlan(hostile);
    assert.equal(validation.valid, false, label);
    assert.ok(
      validation.errors.some(
        (error) =>
          error.code === "TSC002" && (error.path === path || error.path.startsWith(`${path}.`)),
      ),
      label,
    );
  }

  const pacingPlan = plan('say "first"\nexit');
  const pending = run(pacingPlan, createFreshRuntimeSnapshot(pacingPlan));
  const baseline = JSON.stringify(pending.snapshot);
  const gate = pending.snapshot.foregroundAction;
  const failures = [
    [
      "wrongActionKind",
      completeAction(pacingPlan, pending.snapshot, {
        actionId: gate!.actionId,
        actionKind: "delay",
        payload: { kind: "time", currentSessionTimeMs: 0 },
      }),
    ],
    [
      "invalidPayload",
      completeAction(pacingPlan, pending.snapshot, {
        actionId: gate!.actionId,
        actionKind: "chatPacingGate",
        payload: { kind: "wrong" },
      }),
    ],
    [
      "invalidPayload",
      completeAction(pacingPlan, pending.snapshot, {
        actionId: 0,
        actionKind: "chatPacingGate",
        payload: { kind: "skip" },
      }),
    ],
    ["invalidObservation", observeTime(pacingPlan, pending.snapshot, Number.POSITIVE_INFINITY)],
    ["invalidObservation", observeTime(pacingPlan, pending.snapshot, -1)],
  ] as const;
  for (const [kind, result] of failures) {
    assert.equal(result.outcome.kind, kind);
    assert.deepEqual(result.events, []);
    assert.equal(JSON.stringify(result.snapshot), baseline);
  }
});

test("bounded replay advances across pacing, delay, and interaction settlements", () => {
  const compiled = plan('say "first"\nwait 1 s\nshowButton "Continue"\nexit');
  const initial = run(compiled, createFreshRuntimeSnapshot(compiled));
  const pacing = initial.snapshot.foregroundAction;
  assert.equal(pacing?.kind, "chatPacingGate");

  const pacingSettled = completeAction(compiled, initial.snapshot, {
    actionId: pacing!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(pacingSettled.snapshot.lastSettlement?.actionId, pacing?.actionId);
  assert.equal(
    completeAction(compiled, pacingSettled.snapshot, {
      actionId: pacing!.actionId,
      actionKind: "chatPacingGate",
      payload: { kind: "skip" },
    }).outcome.kind,
    "alreadySettled",
  );

  const delayWaiting = run(compiled, pacingSettled.snapshot);
  const delay = delayWaiting.snapshot.foregroundAction;
  assert.equal(delay?.kind, "delay");
  const delaySettled = observeTime(compiled, delayWaiting.snapshot, 1_000);
  assert.equal(delaySettled.snapshot.lastSettlement?.actionId, delay?.actionId);
  assert.equal(
    completeAction(compiled, delaySettled.snapshot, {
      actionId: delay!.actionId,
      actionKind: "delay",
      payload: { kind: "time", currentSessionTimeMs: 1_000 },
    }).outcome.kind,
    "alreadySettled",
  );
  assert.equal(
    completeAction(compiled, delaySettled.snapshot, {
      actionId: pacing!.actionId,
      actionKind: "chatPacingGate",
      payload: { kind: "skip" },
    }).outcome.kind,
    "staleAction",
  );

  const interactionWaiting = run(compiled, delaySettled.snapshot);
  const interaction = interactionWaiting.snapshot.foregroundAction;
  assert.equal(interaction?.kind, "interaction");
  const interactionSettled = completeAction(compiled, interactionWaiting.snapshot, {
    actionId: interaction!.actionId,
    actionKind: "interaction",
    interactionKind: "button",
    payload: { kind: "activate" },
  });
  assert.equal(interactionSettled.snapshot.lastSettlement?.actionId, interaction?.actionId);
  assert.equal(
    completeAction(compiled, interactionSettled.snapshot, {
      actionId: delay!.actionId,
      actionKind: "delay",
      payload: { kind: "time", currentSessionTimeMs: 1_000 },
    }).outcome.kind,
    "staleAction",
  );
  assert.equal(
    completeAction(compiled, interactionSettled.snapshot, {
      actionId: 999,
      actionKind: "chatPacingGate",
      payload: { kind: "skip" },
    }).outcome.kind,
    "unknownAction",
  );
});
