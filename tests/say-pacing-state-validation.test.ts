import assert from "node:assert/strict";
import test from "node:test";

import { validateInstructionPlan } from "../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../src/runtime/checkpoint.js";
import { executeInstruction, run } from "../src/runtime/engine.js";
import { completeAction } from "../src/runtime/operations/complete-action.js";
import { observeTime } from "../src/runtime/operations/observe-time.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
  type RuntimeTemporarySnapshot,
} from "../src/runtime/state.js";
import type { SerializableRuntimeObject } from "../src/runtime/serializable-values.js";
import { compileValidPlan as plan } from "./helpers/compile-valid-plan.js";
import { functionFrames } from "./helpers/runtime-equivalence.js";

type Mutable<T> = T extends readonly [infer First, infer Second]
  ? [Mutable<First>, Mutable<Second>]
  : T extends readonly (infer Item)[]
    ? Array<Mutable<Item>>
    : T extends object
      ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
      : T;

function checkpointSnapshot(
  compiled: ReturnType<typeof plan>,
  snapshot: ReturnType<typeof createFreshRuntimeSnapshot>,
): Mutable<RuntimeSnapshot> {
  // EVIDENCE: the serialized checkpoint was created from this validated plan and runtime-produced snapshot.
  return (
    JSON.parse(serializeCheckpoint(createCheckpoint(compiled, snapshot))) as {
      snapshot: Mutable<RuntimeSnapshot>;
    }
  ).snapshot;
}

interface CheckpointFixture {
  snapshot: unknown;
}

function mutateCheckpoint(
  compiled: ReturnType<typeof plan>,
  snapshot: ReturnType<typeof createFreshRuntimeSnapshot>,
  // oxlint-disable-next-line typescript/no-explicit-any -- EVIDENCE: mutation callbacks alter concrete pacing fields to wrong types and obsolete shapes that RuntimeSnapshot intentionally cannot express.
  mutate: (snapshot: any) => void,
): CheckpointFixture {
  // EVIDENCE: serialization created the canonical checkpoint before the callback corrupts selected snapshot fields.
  const checkpoint = JSON.parse(serializeCheckpoint(createCheckpoint(compiled, snapshot))) as {
    snapshot: RuntimeSnapshot;
  };
  mutate(checkpoint.snapshot);
  return checkpoint;
}

function expectInvalidSnapshot(
  label: string,
  compiled: ReturnType<typeof plan>,
  snapshot: unknown,
): void {
  assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, false, label);
  const checkpoint = JSON.stringify({
    ...JSON.parse(
      serializeCheckpoint(createCheckpoint(compiled, createFreshRuntimeSnapshot(compiled))),
    ),
    snapshot,
  });
  assert.throws(() => deserializeCheckpoint(checkpoint), label);
}

function expectCheckpointJsonRoundTrip(
  label: string,
  compiled: ReturnType<typeof plan>,
  snapshot: ReturnType<typeof createFreshRuntimeSnapshot>,
): void {
  assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, true, label);

  const checkpoint = createCheckpoint(compiled, snapshot);
  const restored = deserializeCheckpoint(serializeCheckpoint(checkpoint));

  assert.equal(validateRuntimeSnapshot(restored.snapshot, compiled).valid, true, label);
  assert.deepEqual(restored.snapshot, snapshot, label);
}

function checkpointWithSnapshot(
  baseline: { snapshot: unknown },
  snapshot: unknown,
): CheckpointFixture {
  const checkpoint = structuredClone(baseline);
  checkpoint.snapshot = snapshot;
  return checkpoint;
}

test("explicit exit after a reading time keeps no pacing work, and forged pacing work is rejected", () => {
  for (const source of [
    'say "first", 5 s\nexit',
    'say "first", 5 s\nif true { exit }\nsay "never", instant',
    'say "first", 5 s\nif true { if true { exit } }\nsay "never", instant',
  ]) {
    const compiled = plan(source);
    const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
    const gate = waiting.snapshot.foregroundAction;
    assert.equal(gate?.kind, "chatPacingGate", source);
    const released = completeAction(compiled, waiting.snapshot, {
      actionId: gate!.actionId,
      actionKind: "chatPacingGate",
      payload: { kind: "skip" },
    });
    const exited = run(compiled, released.snapshot);
    assert.equal(exited.snapshot.status, "halted", source);
    expectCheckpointJsonRoundTrip(source, compiled, exited.snapshot);

    const forgedForeground = checkpointSnapshot(compiled, exited.snapshot);
    // EVIDENCE: the preceding kind assertion establishes the runtime-produced reading time copied into invalid state.
    forgedForeground.foregroundAction = structuredClone(gate) as Mutable<typeof gate>;
    expectInvalidSnapshot("halted state cannot hold a reading time", compiled, forgedForeground);

    const forgedBackground = checkpointSnapshot(compiled, exited.snapshot);
    // EVIDENCE: the preceding kind assertion establishes the runtime-produced reading time copied into invalid state.
    forgedBackground.backgroundActions.push(structuredClone(gate) as Mutable<typeof gate>);
    expectInvalidSnapshot("a reading time is never background work", compiled, forgedBackground);
    assert.throws(() => createCheckpoint(compiled, forgedBackground), source);
  }
});

test("prepared say text retains caller temporaries through a suspended text call", () => {
  const compiled = plan(
    [
      "let paceCalls = 0",
      'function prefix { return "prefix " }',
      "function textValue {",
      "  wait 1 ms",
      '  return "hello"',
      "}",
      "function pace { paceCalls = paceCalls + 1\nreturn 1 s }",
      'say "${prefix()}${textValue()}", pace()',
      "exit",
    ].join("\n"),
  );
  const textPreparation = compiled.instructions.find(
    (instruction) => instruction.kind === "prepareSayText",
  );
  assert.ok(textPreparation !== undefined);
  assert.equal(textPreparation.value.kind, "template");
  assert.equal(validateInstructionPlan(compiled).valid, true);

  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled)).snapshot;
  assert.equal(waiting.status, "waiting");
  assert.equal(functionFrames(waiting).at(-1)?.functionName, "textValue");
  assert.equal(validateRuntimeSnapshot(waiting, compiled).valid, true);

  const activeCall = functionFrames(waiting).at(-1)!;
  const preparedTextTemporaryIds = textPreparation.value.parts.flatMap((part) =>
    part.kind === "expression" && part.expression.kind === "temporary"
      ? [part.expression.temporaryId]
      : [],
  );
  const retainedTemporaryId = preparedTextTemporaryIds.find(
    (temporaryId) => temporaryId !== activeCall.destinationTemporary,
  );
  assert.notEqual(retainedTemporaryId, undefined);
  assert.ok(activeCall.callerTemporaries.some((temporary) => temporary.id === retainedTemporaryId));

  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, waiting)));
  assert.deepEqual(restored.snapshot, waiting);

  const delay = waiting.foregroundAction;
  assert.equal(delay?.kind, "delay");
  const uninterrupted = run(compiled, observeTime(compiled, waiting, delay!.deadlineMs).snapshot);
  const resumed = run(
    restored.plan,
    observeTime(restored.plan, restored.snapshot, delay!.deadlineMs).snapshot,
  );
  assert.deepEqual(resumed.events, uninterrupted.events);
  assert.deepEqual(resumed.snapshot, uninterrupted.snapshot);
  assert.deepEqual(
    resumed.events.filter((event) => event.kind === "say").map((event) => event.text),
    ["prefix hello"],
  );
  assert.equal(
    resumed.snapshot.frames[0]?.bindings.find((binding) => binding.name === "paceCalls")?.value,
    1,
  );

  const malformed = structuredClone(waiting);
  const malformedFrame = malformed.callFrames.at(-1);
  assert.ok(malformedFrame !== undefined);
  // EVIDENCE: fixture removes the retained prepared-text temporary from the suspended caller frame.
  (malformedFrame as { callerTemporaries: RuntimeTemporarySnapshot[] }).callerTemporaries =
    malformedFrame.callerTemporaries.filter((temporary) => temporary.id !== retainedTemporaryId);
  expectInvalidSnapshot("missing a prepared say text continuation temporary", compiled, malformed);
});

test("prepared say temporary values reject malformed top-level and caller state", () => {
  const source = [
    'speaker vera { title: "Captain"\ndelay: 1 s }',
    "speaker other {}",
    'function textValue { return "hello" }',
    "function pace { return 1 s }",
    'say as vera "${speaker.title} ${textValue()}", speaker.delay + pace()',
    "exit",
  ].join("\n");
  const compiled = plan(source);
  const say = compiled.instructions.find((instruction) => instruction.kind === "say");
  assert.equal(say?.kind, "say");
  if (
    say?.kind !== "say" ||
    typeof say.speakerTemporary !== "number" ||
    typeof say.textTemporary !== "number" ||
    typeof say.contextualSpeakerTemporary !== "number"
  )
    throw new Error("Expected a fully prepared say.");

  let atSay = createFreshRuntimeSnapshot(compiled);
  while (atSay.nextInstruction !== compiled.instructions.indexOf(say)) {
    atSay = executeInstruction(compiled, atSay).snapshot;
  }
  assert.equal(validateRuntimeSnapshot(atSay, compiled).valid, true);
  const replaceTopLevel = (temporaryId: number, value: unknown): RuntimeSnapshot => {
    const malformed = structuredClone(atSay);
    const temporary = malformed.temporaries.find((entry) => entry.id === temporaryId);
    assert.ok(temporary !== undefined);
    // EVIDENCE: this helper intentionally replaces a prepared temporary with unvalidated boundary data.
    (temporary as { value: unknown }).value = value;
    return malformed;
  };
  const preparedSpeaker = atSay.temporaries.find(
    (temporary) => temporary.id === say.speakerTemporary,
  )!;
  assert.ok(
    typeof preparedSpeaker.value === "object" &&
      preparedSpeaker.value !== null &&
      preparedSpeaker.value.kind === "object",
  );
  const speakerProperties = preparedSpeaker.value.properties;
  const mutateSpeaker = (
    mutate: (properties: SerializableRuntimeObject["properties"]) => void,
  ): RuntimeSnapshot => {
    const malformed = structuredClone(atSay);
    const temporary = malformed.temporaries.find((entry) => entry.id === say.speakerTemporary);
    assert.ok(
      typeof temporary?.value === "object" &&
        temporary.value !== null &&
        temporary.value.kind === "object",
    );
    mutate(temporary.value.properties);
    return malformed;
  };

  expectInvalidSnapshot(
    "prepared speaker with a non-numeric ID",
    compiled,
    mutateSpeaker((properties) => {
      properties.find((property) => property.name === "speakerId")!.value = "bad";
    }),
  );
  expectInvalidSnapshot(
    "prepared speaker with an unknown ID",
    compiled,
    mutateSpeaker((properties) => {
      properties.find((property) => property.name === "speakerId")!.value = 999;
    }),
  );
  expectInvalidSnapshot(
    "prepared speaker with the wrong immutable identifier",
    compiled,
    mutateSpeaker((properties) => {
      properties.find((property) => property.name === "identifier")!.value = "other";
    }),
  );
  expectInvalidSnapshot(
    "prepared speaker with extra fields",
    compiled,
    mutateSpeaker((properties) => {
      properties.push({ name: "extra", value: true });
    }),
  );
  expectInvalidSnapshot(
    "explicit prepared speaker replaced with null",
    compiled,
    replaceTopLevel(say.speakerTemporary, null),
  );
  expectInvalidSnapshot(
    "prepared text with a non-string value",
    compiled,
    replaceTopLevel(say.textTemporary, 123),
  );
  expectInvalidSnapshot(
    "prepared contextual speaker with malformed reference state",
    compiled,
    replaceTopLevel(say.contextualSpeakerTemporary, {
      kind: "speakerReference",
      speakerId: 1,
      identifier: "other",
    }),
  );
  expectInvalidSnapshot(
    "prepared contextual speaker for a different captured speaker",
    compiled,
    replaceTopLevel(say.contextualSpeakerTemporary, {
      kind: "speakerReference",
      speakerId: 2,
      identifier: "other",
    }),
  );
  assert.equal(speakerProperties.find((property) => property.name === "identifier")?.value, "vera");

  const presentationDrift = structuredClone(atSay);
  const presentationSpeaker = presentationDrift.temporaries.find(
    (temporary) => temporary.id === say.speakerTemporary,
  );
  assert.ok(
    typeof presentationSpeaker?.value === "object" &&
      presentationSpeaker.value !== null &&
      presentationSpeaker.value.kind === "object",
  );
  const displayName = presentationSpeaker.value.properties.find(
    (property) => property.name === "displayName",
  );
  assert.ok(displayName !== undefined);
  displayName.value = "Captured before a later mutation";
  expectCheckpointJsonRoundTrip(
    "prepared explicit speaker retains captured mutable presentation fields",
    compiled,
    presentationDrift,
  );

  const forgeExplicitSpeaker = (
    temporaries: Array<Mutable<RuntimeTemporarySnapshot>>,
    speakerTemporary: number,
    contextualSpeakerTemporary: number,
  ): void => {
    const output = temporaries.find((temporary) => temporary.id === speakerTemporary);
    assert.ok(
      typeof output?.value === "object" && output.value !== null && output.value.kind === "object",
    );
    const speakerId = output.value.properties.find((property) => property.name === "speakerId");
    const identifier = output.value.properties.find((property) => property.name === "identifier");
    assert.ok(speakerId !== undefined);
    assert.ok(identifier !== undefined);
    speakerId.value = 2;
    identifier.value = "other";
    const contextual = temporaries.find((temporary) => temporary.id === contextualSpeakerTemporary);
    assert.ok(contextual !== undefined);
    contextual.value = { kind: "speakerReference", speakerId: 2, identifier: "other" };
  };
  const forgedTopLevel = structuredClone(atSay);
  forgeExplicitSpeaker(
    forgedTopLevel.temporaries,
    say.speakerTemporary,
    say.contextualSpeakerTemporary,
  );
  expectInvalidSnapshot(
    "explicit prepared speaker replaced with another valid speaker",
    compiled,
    forgedTopLevel,
  );
  assert.throws(() => createCheckpoint(compiled, forgedTopLevel));
  assert.throws(() => run(compiled, forgedTopLevel), { name: "RuntimeDataError", code: "TSR101" });

  const suspended = plan(
    [
      'speaker vera { title: "Captain"\ndelay: 1 s }',
      "speaker other {}",
      'function textValue { return "hello" }',
      "function pace { wait 1 ms\nreturn 1 s }",
      'say as vera "${speaker.title} ${textValue()}", speaker.delay + pace()',
      "exit",
    ].join("\n"),
  );
  const suspendedSay = suspended.instructions.find((instruction) => instruction.kind === "say");
  assert.equal(suspendedSay?.kind, "say");
  if (
    suspendedSay?.kind !== "say" ||
    typeof suspendedSay.speakerTemporary !== "number" ||
    typeof suspendedSay.textTemporary !== "number" ||
    typeof suspendedSay.contextualSpeakerTemporary !== "number"
  )
    throw new Error("Expected prepared say temporaries.");
  const waiting = run(suspended, createFreshRuntimeSnapshot(suspended)).snapshot;
  assert.equal(waiting.status, "waiting");
  const callerTemporaries = waiting.callFrames.at(-1)?.callerTemporaries;
  assert.ok(callerTemporaries?.some((temporary) => temporary.id === suspendedSay.speakerTemporary));
  assert.ok(callerTemporaries?.some((temporary) => temporary.id === suspendedSay.textTemporary));
  assert.ok(
    callerTemporaries?.some(
      (temporary) => temporary.id === suspendedSay.contextualSpeakerTemporary,
    ),
  );
  const malformedCaller = structuredClone(waiting);
  const callerText = malformedCaller.callFrames
    .at(-1)
    ?.callerTemporaries.find((temporary) => temporary.id === suspendedSay.textTemporary);
  assert.ok(callerText !== undefined);
  callerText.value = 123;
  expectInvalidSnapshot("malformed prepared text in caller state", suspended, malformedCaller);
  const malformedCallerSpeaker = structuredClone(waiting);
  const callerSpeaker = malformedCallerSpeaker.callFrames
    .at(-1)
    ?.callerTemporaries.find((temporary) => temporary.id === suspendedSay.speakerTemporary);
  assert.ok(
    typeof callerSpeaker?.value === "object" &&
      callerSpeaker.value !== null &&
      callerSpeaker.value.kind === "object",
  );
  const callerSpeakerId = callerSpeaker.value.properties.find(
    (property) => property.name === "speakerId",
  );
  assert.ok(callerSpeakerId !== undefined);
  callerSpeakerId.value = "bad";
  expectInvalidSnapshot(
    "malformed prepared speaker in caller state",
    suspended,
    malformedCallerSpeaker,
  );
  const forgedCaller = structuredClone(waiting);
  const forgedCallerFrame = forgedCaller.callFrames.at(-1);
  assert.ok(forgedCallerFrame !== undefined);
  const forgedCallerTemporaries = forgedCallerFrame.callerTemporaries;
  forgeExplicitSpeaker(
    forgedCallerTemporaries,
    suspendedSay.speakerTemporary,
    suspendedSay.contextualSpeakerTemporary,
  );
  expectInvalidSnapshot(
    "explicit prepared speaker replaced with another valid speaker in caller state",
    suspended,
    forgedCaller,
  );
  assert.throws(() => createCheckpoint(suspended, forgedCaller));
  assert.throws(() => run(suspended, forgedCaller), { name: "RuntimeDataError", code: "TSR101" });
});

test("say pacing expression temporaries restore after the reading time before them", () => {
  const compiled = plan(
    [
      "function pace(value) { return value }",
      'say "first", 5 s',
      'say "second", pace(5 s)',
      "exit",
    ].join("\n"),
  );
  const say = compiled.instructions.find(
    (instruction) =>
      instruction.kind === "say" &&
      typeof instruction.pacing === "object" &&
      instruction.pacing.kind === "temporary",
  );
  assert.notEqual(say, undefined);
  assert.equal(say?.kind, "say");
  if (say?.kind !== "say" || typeof say.pacing !== "object" || say.pacing.kind !== "temporary") {
    throw new Error("Expected a materialized say pacing expression.");
  }

  const pacingTemporary = say.pacing.temporaryId;
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled)).snapshot;
  assert.equal(waiting.foregroundAction?.kind, "chatPacingGate");
  // The pacing call of the second say runs only after the first message's reading time.
  assert.equal(
    waiting.temporaries.some((temporary) => temporary.id === pacingTemporary),
    false,
  );
  let pending = observeTime(compiled, waiting, 5_000).snapshot;
  while (pending.nextInstruction !== compiled.instructions.indexOf(say)) {
    pending = executeInstruction(compiled, pending).snapshot;
  }
  assert.ok(pending.temporaries.some((temporary) => temporary.id === pacingTemporary));
  assert.equal(validateRuntimeSnapshot(pending, compiled).valid, true);

  // The restored say keeps the pacing value computed before the checkpoint.
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, pending)));
  const shown = executeInstruction(restored.plan, restored.snapshot);
  assert.deepEqual(
    shown.events.map((event) => (event.kind === "say" ? event.text : event.kind)),
    ["second", "actionRequested"],
  );
  const gate = shown.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  assert.equal(gate!.deadlineMs - gate!.createdAtMs, 5_000);
});

test("prepared say text is live instead of its already-consumed source expression", () => {
  const compiled = plan(
    [
      'function textValue { return "hello" }',
      "function pace { return 1 s }",
      "say textValue(), pace()",
      "exit",
    ].join("\n"),
  );
  const say = compiled.instructions.find((instruction) => instruction.kind === "say");
  assert.equal(say?.kind, "say");
  if (
    say?.kind !== "say" ||
    typeof say.textTemporary !== "number" ||
    typeof say.speakerTemporary !== "number"
  ) {
    throw new Error("Expected a fully prepared say.");
  }
  const pacingTemporary =
    typeof say.pacing === "object" && say.pacing.kind === "temporary"
      ? say.pacing.temporaryId
      : null;
  assert.equal(typeof pacingTemporary, "number");

  let pending = createFreshRuntimeSnapshot(compiled);
  while (pending.nextInstruction !== compiled.instructions.indexOf(say)) {
    pending = executeInstruction(compiled, pending).snapshot;
    assert.equal(validateRuntimeSnapshot(pending, compiled).valid, true);
  }
  expectCheckpointJsonRoundTrip("prepared say before pacing return", compiled, pending);
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, pending)));
  const resumed = run(restored.plan, restored.snapshot);
  const direct = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.deepEqual(resumed.events, direct.events);
  assert.deepEqual(resumed.snapshot, direct.snapshot);
  assert.equal(resumed.events.filter((event) => event.kind === "say").length, 1);

  let boundary = createFreshRuntimeSnapshot(compiled);
  while (boundary.status !== "halted") {
    const gate = boundary.foregroundAction;
    boundary =
      gate?.kind === "chatPacingGate"
        ? observeTime(compiled, boundary, gate.deadlineMs).snapshot
        : executeInstruction(compiled, boundary).snapshot;
    assert.equal(validateRuntimeSnapshot(boundary, compiled).valid, true);
  }

  for (const temporaryId of [pacingTemporary, say.textTemporary, say.speakerTemporary]) {
    const missing = structuredClone(pending);
    // EVIDENCE: fixture removes one live prepared or pacing temporary before snapshot validation.
    (missing as { temporaries: RuntimeTemporarySnapshot[] }).temporaries =
      missing.temporaries.filter((temporary) => temporary.id !== temporaryId);
    assert.equal(validateRuntimeSnapshot(missing, compiled).valid, false);
  }
});

test("pacing creation provenance requires a positive historical scope depth", () => {
  const rootPlan = plan('say "root", 5 s\nexit');
  const root = executeInstruction(rootPlan, createFreshRuntimeSnapshot(rootPlan)).snapshot;
  assert.equal(root.foregroundAction?.kind, "chatPacingGate");
  assert.equal(root.foregroundAction?.scopeDepth, 1);
  assert.equal(validateRuntimeSnapshot(root, rootPlan).valid, true);
  assert.doesNotThrow(() => createCheckpoint(rootPlan, root));

  const zeroDepth = structuredClone(root);
  const zeroDepthGate = zeroDepth.foregroundAction;
  assert.ok(zeroDepthGate?.kind === "chatPacingGate");
  // EVIDENCE: fixture changes only pacing provenance depth to the invalid zero value.
  (zeroDepthGate as { scopeDepth: number }).scopeDepth = 0;
  assert.equal(validateRuntimeSnapshot(zeroDepth, rootPlan).valid, false);
  assert.throws(() => createCheckpoint(rootPlan, zeroDepth));

  // A reading time inside a function holds the call: its gate belongs to the function's frame.
  const functionPlan = plan('function f { say "inside", 5 s }\nf()\nexit');
  const inside = run(functionPlan, createFreshRuntimeSnapshot(functionPlan)).snapshot;
  const gate = inside.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  assert.equal(gate?.ownerCallFrameId, functionFrames(inside).at(-1)?.id);
  assert.equal(gate?.scopeDepth, inside.frames.length);
  assert.equal(validateRuntimeSnapshot(inside, functionPlan).valid, true);
  assert.doesNotThrow(() => createCheckpoint(functionPlan, inside));
});

test("a reading time has the exact shape of a gate", () => {
  const compiled = plan(
    'speaker vera { displayName: "Vera" }\nsay as vera "first"\nsay as vera "second"\nexit',
  );
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  assert.equal(waiting.snapshot.foregroundAction?.kind, "chatPacingGate");

  const preparedOutput = mutateCheckpoint(compiled, waiting.snapshot, (snapshot) => {
    snapshot.foregroundAction.preparedOutput = null;
  });
  const skippable = mutateCheckpoint(compiled, waiting.snapshot, (snapshot) => {
    snapshot.foregroundAction.skippable = "yes";
  });
  for (const [label, corrupted] of [
    ["obsolete prepared output", preparedOutput],
    ["non-boolean skip policy", skippable],
  ] as const) {
    assert.equal(validateRuntimeSnapshot(corrupted.snapshot, compiled).valid, false, label);
    assert.throws(() => deserializeCheckpoint(JSON.stringify(corrupted)), label);
  }
});

test("snapshot and checkpoint reject representative malformed pacing action state", () => {
  const pacingPlan = plan('say "first"\nsay "second"\nexit');
  const waiting = run(pacingPlan, createFreshRuntimeSnapshot(pacingPlan));
  assert.equal(waiting.snapshot.foregroundAction?.kind, "chatPacingGate");
  const settled = completeAction(pacingPlan, waiting.snapshot, {
    actionId: waiting.snapshot.foregroundAction!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const functionPlan = plan('function f { say "first" }\nf()\nexit');
  const inFunction = run(functionPlan, createFreshRuntimeSnapshot(functionPlan));

  const corruptions = [
    {
      name: "action identity",
      plan: pacingPlan,
      checkpoint: mutateCheckpoint(pacingPlan, waiting.snapshot, (snapshot) => {
        snapshot.foregroundAction.actionId = 0;
      }),
    },
    {
      name: "action kind",
      plan: pacingPlan,
      checkpoint: mutateCheckpoint(pacingPlan, waiting.snapshot, (snapshot) => {
        snapshot.foregroundAction.kind = "delay";
      }),
    },
    {
      name: "deadline",
      plan: pacingPlan,
      checkpoint: mutateCheckpoint(pacingPlan, waiting.snapshot, (snapshot) => {
        snapshot.foregroundAction.deadlineMs = 0;
      }),
    },
    {
      name: "request sequence",
      plan: pacingPlan,
      checkpoint: mutateCheckpoint(pacingPlan, waiting.snapshot, (snapshot) => {
        snapshot.foregroundAction.requestEventSequence = snapshot.nextEventSequence;
      }),
    },
    {
      name: "waiting status ownership",
      plan: pacingPlan,
      checkpoint: mutateCheckpoint(pacingPlan, waiting.snapshot, (snapshot) => {
        snapshot.status = "running";
      }),
    },
    {
      name: "the script waits at the say",
      plan: pacingPlan,
      checkpoint: mutateCheckpoint(pacingPlan, waiting.snapshot, (snapshot) => {
        snapshot.nextInstruction = snapshot.foregroundAction.continuationInstruction;
      }),
    },
    {
      name: "continuation after the say",
      plan: pacingPlan,
      checkpoint: mutateCheckpoint(pacingPlan, waiting.snapshot, (snapshot) => {
        snapshot.foregroundAction.continuationInstruction += 1;
      }),
    },
    {
      name: "a gate belongs to a say",
      plan: pacingPlan,
      checkpoint: mutateCheckpoint(pacingPlan, waiting.snapshot, (snapshot) => {
        snapshot.foregroundAction.owningInstruction = 2;
        snapshot.foregroundAction.continuationInstruction = 3;
        snapshot.nextInstruction = 2;
      }),
    },
    {
      name: "pacing settlement",
      plan: pacingPlan,
      checkpoint: mutateCheckpoint(pacingPlan, settled.snapshot, (snapshot) => {
        snapshot.lastSettlement.actionKind = "delay";
      }),
    },
    {
      name: "settlement completed time",
      plan: pacingPlan,
      checkpoint: mutateCheckpoint(pacingPlan, settled.snapshot, (snapshot) => {
        snapshot.lastSettlement.completedAtMs = snapshot.currentSessionTimeMs + 1;
      }),
    },
    {
      name: "function provenance",
      plan: functionPlan,
      checkpoint: mutateCheckpoint(functionPlan, inFunction.snapshot, (snapshot) => {
        snapshot.foregroundAction.ownerCallFrameId = snapshot.nextCallFrameId;
      }),
    },
    {
      name: "function scope depth",
      plan: functionPlan,
      checkpoint: mutateCheckpoint(functionPlan, inFunction.snapshot, (snapshot) => {
        snapshot.foregroundAction.scopeDepth -= 1;
      }),
    },
  ];

  for (const corruption of corruptions) {
    const snapshot = corruption.checkpoint.snapshot;
    assert.equal(validateRuntimeSnapshot(snapshot, corruption.plan).valid, false, corruption.name);
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(corruption.checkpoint)),
      corruption.name,
    );
  }
});

test("background actions require dense JSON-safe array entries and hold no reading time", () => {
  const compiled = plan('say "first"\nexit');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  // EVIDENCE: serialization creates the canonical checkpoint before array-shape corruptions are applied.
  const baselineCheckpoint = JSON.parse(
    serializeCheckpoint(createCheckpoint(compiled, waiting.snapshot)),
  ) as { snapshot: Mutable<RuntimeSnapshot> };

  const sparseSnapshot = structuredClone(baselineCheckpoint.snapshot);
  sparseSnapshot.backgroundActions = new Array(1);
  assert.equal(validateRuntimeSnapshot(sparseSnapshot, compiled).valid, false);
  assert.throws(() => createCheckpoint(compiled, sparseSnapshot));

  const undefinedEntrySnapshot = structuredClone(baselineCheckpoint.snapshot);
  // EVIDENCE: fixture widens only backgroundActions to inject an undefined direct-state entry.
  (undefinedEntrySnapshot as { backgroundActions: unknown }).backgroundActions = [undefined];

  const nullEntrySnapshot = structuredClone(baselineCheckpoint.snapshot);
  // EVIDENCE: fixture widens only backgroundActions to inject a null direct-state entry.
  (nullEntrySnapshot as { backgroundActions: unknown }).backgroundActions = [null];

  const nonObjectEntrySnapshot = structuredClone(baselineCheckpoint.snapshot);
  // EVIDENCE: fixture widens only backgroundActions to inject a numeric direct-state entry.
  (nonObjectEntrySnapshot as { backgroundActions: unknown }).backgroundActions = [42];

  // The reading time moved into the background, where the script would run on during it.
  const movedSnapshot = structuredClone(baselineCheckpoint.snapshot);
  movedSnapshot.backgroundActions.push(movedSnapshot.foregroundAction!);
  movedSnapshot.foregroundAction = null;
  movedSnapshot.status = "running";
  movedSnapshot.nextInstruction += 1;

  const corruptions = [
    { name: "undefined direct snapshot entry", snapshot: undefinedEntrySnapshot },
    { name: "null background entry", snapshot: nullEntrySnapshot },
    { name: "non-object background entry", snapshot: nonObjectEntrySnapshot },
    { name: "reading time as background work", snapshot: movedSnapshot },
  ];

  for (const corruption of corruptions) {
    assert.equal(
      validateRuntimeSnapshot(corruption.snapshot, compiled).valid,
      false,
      corruption.name,
    );
    assert.throws(
      () =>
        deserializeCheckpoint(
          JSON.stringify(checkpointWithSnapshot(baselineCheckpoint, corruption.snapshot)),
        ),
      corruption.name,
    );
  }
});

test("persisted arrays reject custom own keys that JSON would omit", () => {
  const backgroundPlan = plan('say "first"\nexit');
  const background = run(backgroundPlan, createFreshRuntimeSnapshot(backgroundPlan));
  const speakerPlan = plan('speaker vera { custom: "kept" }\nexit');
  const speakerState = run(speakerPlan, createFreshRuntimeSnapshot(speakerPlan));

  const backgroundExtra = structuredClone(background.snapshot);
  // EVIDENCE: fixture adds an own key to the persisted background-action array for canonical-array rejection.
  (
    backgroundExtra.backgroundActions as typeof backgroundExtra.backgroundActions &
      Record<string, unknown>
  ).extra = "lost";

  const speakersExtra = structuredClone(speakerState.snapshot);
  // EVIDENCE: fixture adds an own key to the persisted speakers array for canonical-array rejection.
  (speakersExtra.speakers as typeof speakersExtra.speakers & Record<string, unknown>).extra =
    "lost";

  const propertiesExtra = structuredClone(speakerState.snapshot);
  // EVIDENCE: fixture adds an own key to the persisted speaker-properties array for canonical-array rejection.
  (
    propertiesExtra.speakers[0]!.properties as (typeof propertiesExtra.speakers)[0]["properties"] &
      Record<string, unknown>
  ).extra = "lost";

  const corruptions = [
    { name: "backgroundActions custom key", compiled: backgroundPlan, snapshot: backgroundExtra },
    { name: "speakers custom key", compiled: speakerPlan, snapshot: speakersExtra },
    { name: "speaker properties custom key", compiled: speakerPlan, snapshot: propertiesExtra },
  ];

  for (const corruption of corruptions) {
    assert.equal(
      validateRuntimeSnapshot(corruption.snapshot, corruption.compiled).valid,
      false,
      corruption.name,
    );
    assert.throws(
      () => createCheckpoint(corruption.compiled, corruption.snapshot),
      corruption.name,
    );
  }
});

test("ready snapshots reject pacing progress", () => {
  const compiled = plan('say "first", 5 s\nexit');
  const afterSay = executeInstruction(compiled, createFreshRuntimeSnapshot(compiled));
  const forged = structuredClone(afterSay.snapshot);
  forged.status = "ready";
  forged.nextInstruction = 0;
  assert.equal(validateRuntimeSnapshot(forged, compiled).valid, false);
  assert.throws(() => createCheckpoint(compiled, forged));
});

test("runtime-produced pacing states validate and checkpoint through their lifecycle", () => {
  const positive = plan('say "first"\nexit');
  const reading = executeInstruction(positive, createFreshRuntimeSnapshot(positive));
  assert.equal(reading.snapshot.status, "waiting");
  assert.equal(reading.snapshot.foregroundAction?.kind, "chatPacingGate");
  const timed = observeTime(positive, reading.snapshot, 1_800);
  const skipped = completeAction(positive, reading.snapshot, {
    actionId: reading.snapshot.foregroundAction!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });

  const waitPlan = plan('say "first"\nwait 10 s\nexit');
  const waitAfterReading = run(
    waitPlan,
    observeTime(waitPlan, run(waitPlan, createFreshRuntimeSnapshot(waitPlan)).snapshot, 1_800)
      .snapshot,
  );
  assert.equal(waitAfterReading.snapshot.foregroundAction?.kind, "delay");

  // A message used as a value has its handle while its reading time runs.
  const handlePlan = plan('let line = say "first"\nline.text = "changed"\nexit');
  const handleReading = run(handlePlan, createFreshRuntimeSnapshot(handlePlan));
  assert.equal(handleReading.snapshot.foregroundAction?.kind, "chatPacingGate");
  assert.equal(handleReading.snapshot.liveMessages.length, 1);

  // A timer that expires during a reading time queues its block until the reading time ends.
  const timerPlan = plan('let t = timer async 1 s { say "Ping", instant }\nsay "first"\nexit');
  const timerQueued = observeTime(
    timerPlan,
    run(timerPlan, createFreshRuntimeSnapshot(timerPlan)).snapshot,
    1_500,
  );
  assert.equal(timerQueued.snapshot.foregroundAction?.kind, "chatPacingGate");
  assert.equal(timerQueued.snapshot.pendingTimerHandlers.length, 1);

  const placedPlans = [
    plan('if true { say "branch" }\nexit'),
    plan('repeat 1 { say "loop" }\nexit'),
    plan('function f { say "call" }\nf()\nexit'),
  ];
  const placed = placedPlans.map((compiled) => ({
    compiled,
    snapshot: run(compiled, createFreshRuntimeSnapshot(compiled)).snapshot,
  }));
  for (const { snapshot } of placed) {
    assert.equal(snapshot.foregroundAction?.kind, "chatPacingGate");
  }

  const states: Array<[string, ReturnType<typeof plan>, RuntimeSnapshot]> = [
    ["reading time", positive, reading.snapshot],
    ["reading time ended by time", positive, timed.snapshot],
    ["reading time ended by skip", positive, skipped.snapshot],
    ["wait after a reading time", waitPlan, waitAfterReading.snapshot],
    ["reading time of a message used as a value", handlePlan, handleReading.snapshot],
    ["reading time with a queued expiry block", timerPlan, timerQueued.snapshot],
    ["reading time in a branch", placed[0]!.compiled, placed[0]!.snapshot],
    ["reading time in a loop", placed[1]!.compiled, placed[1]!.snapshot],
    ["reading time in a function", placed[2]!.compiled, placed[2]!.snapshot],
  ];

  for (const [label, compiled, snapshot] of states) {
    expectCheckpointJsonRoundTrip(label, compiled, snapshot);
  }
});

test("pacing state validation rejects relational identity and property corruption", () => {
  const timerPlan = plan('let t = timer async 60 s { }\nsay "first"\nwait 10 s\nexit');
  const waiting = run(timerPlan, createFreshRuntimeSnapshot(timerPlan));
  const gate = waiting.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  assert.equal(waiting.snapshot.backgroundActions[0]?.kind, "timer");
  const skipped = completeAction(timerPlan, waiting.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const retained = run(timerPlan, skipped.snapshot);
  assert.equal(retained.snapshot.foregroundAction?.kind, "delay");
  assert.equal(retained.snapshot.lastSettlement?.actionKind, "chatPacingGate");

  const speakerPlan = plan('speaker vera { defaultSaySkippable: true\ncustom: "kept" }\nexit');
  const speakerState = run(speakerPlan, createFreshRuntimeSnapshot(speakerPlan));
  assert.equal(validateRuntimeSnapshot(speakerState.snapshot, speakerPlan).valid, true);
  const falseSpeakerCheckpoint = mutateCheckpoint(
    speakerPlan,
    speakerState.snapshot,
    (snapshot) => {
      snapshot.speakers[0].properties[0].value = false;
    },
  );
  assert.equal(validateRuntimeSnapshot(falseSpeakerCheckpoint.snapshot, speakerPlan).valid, true);
  assert.doesNotThrow(() => deserializeCheckpoint(JSON.stringify(falseSpeakerCheckpoint)));

  const corruptions = [
    {
      name: "duplicate active action ID",
      compiled: timerPlan,
      checkpoint: mutateCheckpoint(timerPlan, waiting.snapshot, (snapshot) => {
        snapshot.foregroundAction.actionId = snapshot.backgroundActions[0].actionId;
      }),
    },
    {
      name: "duplicate active request sequence",
      compiled: timerPlan,
      checkpoint: mutateCheckpoint(timerPlan, waiting.snapshot, (snapshot) => {
        snapshot.foregroundAction.requestEventSequence =
          snapshot.backgroundActions[0].requestEventSequence;
      }),
    },
    {
      name: "active ID equals settlement ID",
      compiled: timerPlan,
      checkpoint: mutateCheckpoint(timerPlan, retained.snapshot, (snapshot) => {
        snapshot.foregroundAction.actionId = snapshot.lastSettlement.actionId;
      }),
    },
    {
      name: "active request equals settlement request",
      compiled: timerPlan,
      checkpoint: mutateCheckpoint(timerPlan, retained.snapshot, (snapshot) => {
        snapshot.foregroundAction.requestEventSequence =
          snapshot.lastSettlement.requestEventSequence;
      }),
    },
    {
      name: "active request equals settlement completion",
      compiled: timerPlan,
      checkpoint: mutateCheckpoint(timerPlan, retained.snapshot, (snapshot) => {
        snapshot.foregroundAction.requestEventSequence =
          snapshot.lastSettlement.completionEventSequence;
      }),
    },
    {
      name: "malformed settlement events",
      compiled: timerPlan,
      checkpoint: mutateCheckpoint(timerPlan, retained.snapshot, (snapshot) => {
        snapshot.lastSettlement.requestEventSequence =
          snapshot.lastSettlement.completionEventSequence;
      }),
    },
    {
      name: "invalid speaker default string",
      compiled: speakerPlan,
      checkpoint: mutateCheckpoint(speakerPlan, speakerState.snapshot, (snapshot) => {
        snapshot.speakers[0].properties[0].value = "false";
      }),
    },
    {
      name: "invalid speaker default null",
      compiled: speakerPlan,
      checkpoint: mutateCheckpoint(speakerPlan, speakerState.snapshot, (snapshot) => {
        snapshot.speakers[0].properties[0].value = null;
      }),
    },
  ];

  for (const corruption of corruptions) {
    const snapshot = corruption.checkpoint.snapshot;
    assert.equal(
      validateRuntimeSnapshot(snapshot, corruption.compiled).valid,
      false,
      corruption.name,
    );
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(corruption.checkpoint)),
      corruption.name,
    );
  }
});

test("cross-field pacing snapshot corruption rejects at direct and checkpoint boundaries", () => {
  const pacingPlan = plan('say "first"\nwait 10 s\nexit');
  const waiting = run(pacingPlan, createFreshRuntimeSnapshot(pacingPlan));
  assert.equal(waiting.snapshot.foregroundAction?.kind, "chatPacingGate");
  const speakerPlan = plan("speaker vera { defaultSaySkippable: true }\nexit");
  const speakerState = run(speakerPlan, createFreshRuntimeSnapshot(speakerPlan));
  const interactionPlan = plan('say "first", instant\nshowButton "Continue"\nwait 10 s\nexit');
  const interactionWaiting = run(interactionPlan, createFreshRuntimeSnapshot(interactionPlan));
  const interaction = interactionWaiting.snapshot.foregroundAction;
  assert.equal(interaction?.kind, "interaction");
  const interactionSettled = completeAction(interactionPlan, interactionWaiting.snapshot, {
    actionId: interaction!.actionId,
    actionKind: "interaction",
    interactionKind: "button",
    payload: { kind: "activate" },
  });
  const laterWait = run(interactionPlan, interactionSettled.snapshot);

  const corruptions = [
    {
      name: "next action ID reuses active identity",
      plan: pacingPlan,
      checkpoint: mutateCheckpoint(pacingPlan, waiting.snapshot, (snapshot) => {
        snapshot.nextActionId = snapshot.foregroundAction.actionId;
      }),
    },
    {
      name: "next event sequence reuses request identity",
      plan: pacingPlan,
      checkpoint: mutateCheckpoint(pacingPlan, waiting.snapshot, (snapshot) => {
        snapshot.nextEventSequence = snapshot.foregroundAction.requestEventSequence;
      }),
    },
    {
      name: "extra pacing setting",
      plan: pacingPlan,
      checkpoint: mutateCheckpoint(pacingPlan, waiting.snapshot, (snapshot) => {
        snapshot.chatPacingSettings.extra = 1;
      }),
    },
    {
      name: "missing pacing setting",
      plan: pacingPlan,
      checkpoint: mutateCheckpoint(pacingPlan, waiting.snapshot, (snapshot) => {
        delete snapshot.chatPacingSettings.baseDelayMs;
      }),
    },
    {
      name: "duplicate speaker pacing property",
      plan: speakerPlan,
      checkpoint: mutateCheckpoint(speakerPlan, speakerState.snapshot, (snapshot) => {
        snapshot.speakers[0].properties.push(structuredClone(snapshot.speakers[0].properties[0]));
      }),
    },
    {
      name: "active request collides with interaction transcript",
      plan: interactionPlan,
      checkpoint: mutateCheckpoint(interactionPlan, laterWait.snapshot, (snapshot) => {
        snapshot.foregroundAction.requestEventSequence =
          snapshot.lastSettlement.transcriptEventSequence;
      }),
    },
  ];

  for (const corruption of corruptions) {
    const snapshot = corruption.checkpoint.snapshot;
    assert.equal(validateRuntimeSnapshot(snapshot, corruption.plan).valid, false, corruption.name);
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(corruption.checkpoint)),
      corruption.name,
    );
  }
});

test("pacing settlements are completed at their deadline or skipped before it", () => {
  const compiled = plan('say "first"\nsay "second"\nexit');
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  const gate = waiting.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  const completed = observeTime(compiled, waiting.snapshot, gate!.deadlineMs);
  const skipped = completeAction(compiled, waiting.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });

  for (const [name, snapshot, kind] of [
    ["time completion", completed.snapshot, "completed"],
    ["typed skip", skipped.snapshot, "skipped"],
  ] as const) {
    const settlement = snapshot.lastSettlement;
    assert.equal(settlement?.actionKind, "chatPacingGate", name);
    assert.equal(settlement?.settlementKind, kind, name);
    expectCheckpointJsonRoundTrip(name, compiled, snapshot);
  }

  const corruptions = [
    {
      name: "a reading time is no longer consumed by an interaction",
      checkpoint: mutateCheckpoint(compiled, skipped.snapshot, (snapshot) => {
        snapshot.lastSettlement.settlementKind = "consumedByForegroundInteraction";
      }),
    },
    {
      name: "a reading time is no longer superseded by instant output",
      checkpoint: mutateCheckpoint(compiled, skipped.snapshot, (snapshot) => {
        snapshot.lastSettlement.settlementKind = "supersededByInstantOutput";
      }),
    },
    {
      name: "a pacing settlement releases no prepared output",
      checkpoint: mutateCheckpoint(compiled, skipped.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutputInstruction = null;
      }),
    },
    {
      name: "a skip cannot complete after its deadline",
      checkpoint: mutateCheckpoint(compiled, skipped.snapshot, (snapshot) => {
        snapshot.lastSettlement.completedAtMs = snapshot.lastSettlement.deadlineMs + 1;
      }),
    },
    {
      name: "time settlement cannot complete before its deadline",
      checkpoint: mutateCheckpoint(compiled, completed.snapshot, (snapshot) => {
        snapshot.lastSettlement.completedAtMs = snapshot.lastSettlement.deadlineMs - 1;
      }),
    },
  ];

  for (const corruption of corruptions) {
    const snapshot = corruption.checkpoint.snapshot;
    assert.equal(validateRuntimeSnapshot(snapshot, compiled).valid, false, corruption.name);
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(corruption.checkpoint)),
      corruption.name,
    );
  }
});
