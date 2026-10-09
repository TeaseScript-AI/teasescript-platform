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
import { runUntilExit } from "./helpers/run-until-exit.js";
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

test("older pacing gate promotes after a newer delay settlement and resumes prepared output once", () => {
  const compiled = plan('say "first"\nwait 1 s\nsay "second"\nexit', {}, ["TSV060"]);
  const initial = run(compiled, createFreshRuntimeSnapshot(compiled));
  const pacing = initial.snapshot.backgroundActions[0];
  const delay = initial.snapshot.foregroundAction;
  assert.equal(pacing?.kind, "chatPacingGate");
  assert.equal(delay?.kind, "delay");
  assert.ok(pacing!.actionId < delay!.actionId);

  const delaySettled = observeTime(compiled, initial.snapshot, delay!.deadlineMs);
  assert.equal(delaySettled.snapshot.lastSettlement?.actionId, delay!.actionId);
  assert.equal(delaySettled.snapshot.backgroundActions[0]?.actionId, pacing!.actionId);

  const promoted = run(compiled, delaySettled.snapshot);
  const gate = promoted.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  assert.equal(gate?.actionId, pacing!.actionId);
  assert.equal(gate?.deadlineMs, pacing?.deadlineMs);
  assert.equal(promoted.events.filter((event) => event.kind === "actionRequested").length, 0);
  assert.equal(validateRuntimeSnapshot(promoted.snapshot, compiled).valid, true);

  const restored = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, promoted.snapshot)),
  );
  assert.deepEqual(restored.snapshot, promoted.snapshot);
  const released = completeAction(restored.plan, restored.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const resumed = run(restored.plan, released.snapshot);
  assert.equal(
    resumed.events.filter((event) => event.kind === "say" && event.text === "second").length,
    1,
  );
});

test("explicit exit cleans released pacing lineage without admitting forged pacing work", () => {
  const compiled = plan('say "first", 5\nsay "second", 5\nexit');
  const promoted = run(compiled, createFreshRuntimeSnapshot(compiled));
  const gate = promoted.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  const released = completeAction(compiled, promoted.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const beforeExit = executeInstruction(compiled, released.snapshot);
  const replacement = beforeExit.snapshot.backgroundActions[0];
  assert.equal(replacement?.kind, "chatPacingGate");
  const exited = executeInstruction(compiled, beforeExit.snapshot);

  assert.equal(exited.snapshot.status, "halted");
  assert.equal(validateRuntimeSnapshot(exited.snapshot, compiled).valid, true);
  expectCheckpointJsonRoundTrip(
    "explicit exit after released pacing output",
    compiled,
    exited.snapshot,
  );

  const forgedPacing = checkpointSnapshot(compiled, exited.snapshot);
  // EVIDENCE: the preceding kind assertion establishes the runtime-produced pacing action copied into invalid state.
  forgedPacing.backgroundActions.push(structuredClone(replacement) as Mutable<typeof replacement>);
  expectInvalidSnapshot("explicit exit cannot retain pacing work", compiled, forgedPacing);

  const forgedPreparedOutput = checkpointSnapshot(compiled, exited.snapshot);
  // EVIDENCE: released is runtime-produced state, and this test deliberately copies its prepared output into halted state.
  forgedPreparedOutput.preparedSayOutput = structuredClone(
    released.snapshot.preparedSayOutput,
  ) as Mutable<typeof released.snapshot.preparedSayOutput>;
  expectInvalidSnapshot(
    "explicit exit cannot retain prepared pacing output",
    compiled,
    forgedPreparedOutput,
  );
});

test("branch-local and nested explicit exits reject forged retained pacing work", () => {
  for (const source of [
    'say "first", 5\nif true { exit }\nsay "never", instant',
    'say "first", 5\nif true { if true { exit } }\nsay "never", instant',
  ]) {
    const compiled = plan(source);
    const created = executeInstruction(compiled, createFreshRuntimeSnapshot(compiled));
    const pacing = created.snapshot.backgroundActions[0];
    assert.equal(pacing?.kind, "chatPacingGate");
    const exited = run(compiled, created.snapshot);
    assert.equal(exited.snapshot.status, "halted");
    assert.notEqual(exited.snapshot.nextInstruction, compiled.files[0]!.rootEndInstruction);
    assert.equal(validateRuntimeSnapshot(exited.snapshot, compiled).valid, true);

    const forged = checkpointSnapshot(compiled, exited.snapshot);
    // EVIDENCE: the preceding kind assertion establishes the runtime-produced pacing action copied into invalid state.
    forged.backgroundActions.push(structuredClone(pacing) as Mutable<typeof pacing>);
    expectInvalidSnapshot("branch-local explicit exit cannot retain pacing work", compiled, forged);
    assert.throws(() => createCheckpoint(compiled, forged));
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
      "function pace { paceCalls = paceCalls + 1\nreturn 1 }",
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
    'speaker vera { title: "Captain"\ndelay: 1 }',
    "speaker other {}",
    'function textValue { return "hello" }',
    "function pace { return 1 }",
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
      'speaker vera { title: "Captain"\ndelay: 1 }',
      "speaker other {}",
      'function textValue { return "hello" }',
      "function pace { wait 1 ms\nreturn 1 }",
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

test("say pacing expression temporaries restore behind an older pacing gate", () => {
  const compiled = plan(
    [
      "function pace(value) { return value }",
      'say "first", 5',
      'say "second", pace(5)',
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
  let pending = createFreshRuntimeSnapshot(compiled);
  while (pending.nextInstruction !== compiled.instructions.indexOf(say)) {
    pending = executeInstruction(compiled, pending).snapshot;
  }
  assert.ok(pending.temporaries.some((temporary) => temporary.id === pacingTemporary));
  const olderGate = pending.backgroundActions[0];
  assert.equal(olderGate?.kind, "chatPacingGate");
  assert.equal(validateRuntimeSnapshot(pending, compiled).valid, true);

  // The restored say promotes the older gate and keeps the pacing value computed before the checkpoint.
  const restored = deserializeCheckpoint(serializeCheckpoint(createCheckpoint(compiled, pending)));
  const promoted = executeInstruction(restored.plan, restored.snapshot);
  const gate = promoted.snapshot.foregroundAction;
  assert.equal(gate?.kind, "chatPacingGate");
  assert.equal(gate?.actionId, olderGate?.actionId);
  assert.equal(gate?.preparedOutput?.text, "second");
  assert.equal(gate?.preparedOutput?.durationMs, 5_000);
});

test("prepared say text is live instead of its already-consumed source expression", () => {
  const compiled = plan(
    [
      'function textValue { return "hello" }',
      "function pace { return 1 }",
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
    boundary = executeInstruction(compiled, boundary).snapshot;
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
  const rootPlan = plan('say "root", 5\nexit');
  const root = executeInstruction(rootPlan, createFreshRuntimeSnapshot(rootPlan)).snapshot;
  assert.equal(root.backgroundActions[0]?.kind, "chatPacingGate");
  assert.equal(root.backgroundActions[0]?.scopeDepth, 1);
  assert.equal(validateRuntimeSnapshot(root, rootPlan).valid, true);
  assert.doesNotThrow(() => createCheckpoint(rootPlan, root));

  const zeroDepth = structuredClone(root);
  const zeroDepthGate = zeroDepth.backgroundActions[0];
  assert.ok(zeroDepthGate?.kind === "chatPacingGate");
  // EVIDENCE: fixture changes only pacing provenance depth to the invalid zero value.
  (zeroDepthGate as { scopeDepth: number }).scopeDepth = 0;
  assert.equal(validateRuntimeSnapshot(zeroDepth, rootPlan).valid, false);
  assert.throws(() => createCheckpoint(rootPlan, zeroDepth));

  const functionPlan = plan('function f { say "inside", 5 }\nf()\nexit');
  const unwound = runUntilExit(functionPlan, createFreshRuntimeSnapshot(functionPlan)).snapshot;
  assert.equal(functionPlan.instructions[unwound.nextInstruction]?.kind, "exit");
  assert.equal(unwound.frames.length, 1);
  assert.equal(unwound.backgroundActions[0]?.kind, "chatPacingGate");
  assert.ok((unwound.backgroundActions[0]?.scopeDepth ?? 0) > unwound.frames.length);
  assert.equal(validateRuntimeSnapshot(unwound, functionPlan).valid, true);
  assert.doesNotThrow(() => createCheckpoint(functionPlan, unwound));
});

test("snapshot and checkpoint reject malformed pacing prepared output", () => {
  const compiled = plan(
    'speaker vera { displayName: "Vera" }\nsay as vera "first"\nsay as vera "second"\nexit',
  );
  const waiting = run(compiled, createFreshRuntimeSnapshot(compiled));
  // EVIDENCE: serialization produces this active pacing action and prepared-output shape before corruption.
  const corrupted = JSON.parse(
    serializeCheckpoint(createCheckpoint(compiled, waiting.snapshot)),
  ) as {
    snapshot: {
      foregroundAction: {
        preparedOutput: { speaker: Record<string, unknown>; durationMs: number };
      };
    };
  };
  corrupted.snapshot.foregroundAction.preparedOutput.speaker.extra = "unexpected";

  assert.equal(validateRuntimeSnapshot(corrupted.snapshot, compiled).valid, false);
  assert.throws(() => deserializeCheckpoint(JSON.stringify(corrupted)));

  delete corrupted.snapshot.foregroundAction.preparedOutput.speaker.extra;
  corrupted.snapshot.foregroundAction.preparedOutput.durationMs = 0;
  assert.equal(validateRuntimeSnapshot(corrupted.snapshot, compiled).valid, false);
  assert.throws(() => deserializeCheckpoint(JSON.stringify(corrupted)));

  corrupted.snapshot.foregroundAction.preparedOutput.durationMs = 1;
  // EVIDENCE: fixture adds the removed `skippable` action field to verify exact-schema rejection.
  const corruptedAction = corrupted.snapshot
    .foregroundAction as typeof corrupted.snapshot.foregroundAction & { skippable?: unknown };
  corruptedAction.skippable = "yes";
  assert.equal(validateRuntimeSnapshot(corrupted.snapshot, compiled).valid, false);
  assert.throws(() => deserializeCheckpoint(JSON.stringify(corrupted)));
});

test("snapshot and checkpoint reject representative malformed pacing action state", () => {
  // The wait keeps the session waiting, not runnable, while the say's pacing is in the background.
  const backgroundPlan = plan('say "first"\nwait 10 s\nexit');
  const background = run(backgroundPlan, createFreshRuntimeSnapshot(backgroundPlan));
  const foregroundPlan = plan('say "first"\nsay "second"\nexit');
  const foreground = run(foregroundPlan, createFreshRuntimeSnapshot(foregroundPlan));
  const foregroundGate = foreground.snapshot.foregroundAction;
  assert.equal(foregroundGate?.kind, "chatPacingGate");
  if (foregroundGate?.kind !== "chatPacingGate")
    throw new Error("Expected a promoted pacing gate.");
  const functionPlan = plan('function f { say "first" }\nf()\nexit');
  const functionBackground = runUntilExit(functionPlan, createFreshRuntimeSnapshot(functionPlan));
  const settled = completeAction(backgroundPlan, background.snapshot, {
    actionId: background.snapshot.backgroundActions[0]!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });

  const corruptions = [
    {
      name: "action identity",
      plan: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].actionId = 0;
      }),
    },
    {
      name: "action kind",
      plan: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].kind = "delay";
      }),
    },
    {
      name: "deadline",
      plan: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].deadlineMs = 0;
      }),
    },
    {
      name: "request sequence",
      plan: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].requestEventSequence = snapshot.nextEventSequence;
      }),
    },
    {
      name: "background prepared output",
      plan: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, background.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].preparedOutput = structuredClone(
          foregroundGate.preparedOutput,
        );
      }),
    },
    {
      name: "foreground prepared output ownership",
      plan: foregroundPlan,
      checkpoint: mutateCheckpoint(foregroundPlan, foreground.snapshot, (snapshot) => {
        snapshot.foregroundAction.preparedOutput = null;
      }),
    },
    {
      name: "waiting status ownership",
      plan: foregroundPlan,
      checkpoint: mutateCheckpoint(foregroundPlan, foreground.snapshot, (snapshot) => {
        snapshot.status = "running";
      }),
    },
    {
      name: "prepared continuation",
      plan: foregroundPlan,
      checkpoint: mutateCheckpoint(foregroundPlan, foreground.snapshot, (snapshot) => {
        snapshot.foregroundAction.preparedOutput.continuationInstruction += 1;
      }),
    },
    {
      name: "pacing settlement",
      plan: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, settled.snapshot, (snapshot) => {
        snapshot.lastSettlement.actionKind = "delay";
      }),
    },
    {
      name: "settlement completed time",
      plan: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, settled.snapshot, (snapshot) => {
        snapshot.lastSettlement.completedAtMs = snapshot.currentSessionTimeMs + 1;
      }),
    },
    {
      name: "unwound function provenance",
      plan: functionPlan,
      checkpoint: mutateCheckpoint(functionPlan, functionBackground.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].ownerCallFrameId = snapshot.nextCallFrameId;
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

test("background pacing actions require dense JSON-safe array entries", () => {
  const compiled = plan('say "first"\nexit');
  const background = runUntilExit(compiled, createFreshRuntimeSnapshot(compiled));
  // EVIDENCE: serialization creates the canonical checkpoint before array-shape corruptions are applied.
  const baselineCheckpoint = JSON.parse(
    serializeCheckpoint(createCheckpoint(compiled, background.snapshot)),
  ) as { snapshot: Mutable<RuntimeSnapshot> };

  const sparseSnapshot = structuredClone(baselineCheckpoint.snapshot);
  sparseSnapshot.backgroundActions = new Array(1);
  assert.equal(validateRuntimeSnapshot(sparseSnapshot, compiled).valid, false);
  assert.throws(() => createCheckpoint(compiled, sparseSnapshot));

  const foregroundPlan = plan('say "first"\nsay "second"\nexit');
  const foreground = run(foregroundPlan, createFreshRuntimeSnapshot(foregroundPlan));
  // EVIDENCE: serialization creates the canonical foreground checkpoint used as an envelope baseline below.
  const foregroundCheckpoint = JSON.parse(
    serializeCheckpoint(createCheckpoint(foregroundPlan, foreground.snapshot)),
  ) as { snapshot: RuntimeSnapshot };

  const undefinedEntrySnapshot = structuredClone(baselineCheckpoint.snapshot);
  // EVIDENCE: fixture widens only backgroundActions to inject an undefined direct-state entry.
  (undefinedEntrySnapshot as { backgroundActions: unknown }).backgroundActions = [undefined];

  const nullEntrySnapshot = structuredClone(baselineCheckpoint.snapshot);
  // EVIDENCE: fixture widens only backgroundActions to inject a null direct-state entry.
  (nullEntrySnapshot as { backgroundActions: unknown }).backgroundActions = [null];

  const nonObjectEntrySnapshot = structuredClone(baselineCheckpoint.snapshot);
  // EVIDENCE: fixture widens only backgroundActions to inject a numeric direct-state entry.
  (nonObjectEntrySnapshot as { backgroundActions: unknown }).backgroundActions = [42];

  const preparedOutputArraySnapshot = checkpointSnapshot(foregroundPlan, foreground.snapshot);
  assert.notEqual(preparedOutputArraySnapshot.foregroundAction, null);
  // EVIDENCE: fixture widens only preparedOutput to inject an array where an output object is required.
  (preparedOutputArraySnapshot.foregroundAction as { preparedOutput: unknown }).preparedOutput = [];

  const corruptions = [
    {
      name: "undefined direct snapshot entry",
      compiled,
      snapshot: undefinedEntrySnapshot,
      checkpoint: checkpointWithSnapshot(baselineCheckpoint, undefinedEntrySnapshot),
    },
    {
      name: "null background entry",
      compiled,
      snapshot: nullEntrySnapshot,
      checkpoint: checkpointWithSnapshot(baselineCheckpoint, nullEntrySnapshot),
    },
    {
      name: "non-object background entry",
      compiled,
      snapshot: nonObjectEntrySnapshot,
      checkpoint: checkpointWithSnapshot(baselineCheckpoint, nonObjectEntrySnapshot),
    },
    {
      name: "array prepared output",
      compiled: foregroundPlan,
      snapshot: preparedOutputArraySnapshot,
      checkpoint: checkpointWithSnapshot(foregroundCheckpoint, preparedOutputArraySnapshot),
    },
  ];

  for (const corruption of corruptions) {
    assert.equal(
      validateRuntimeSnapshot(corruption.snapshot, corruption.compiled).valid,
      false,
      corruption.name,
    );
    assert.throws(
      () => deserializeCheckpoint(JSON.stringify(corruption.checkpoint)),
      corruption.name,
    );
  }
});

test("persisted arrays reject custom own keys that JSON would omit", () => {
  const backgroundPlan = plan('say "first"\nexit');
  const background = runUntilExit(backgroundPlan, createFreshRuntimeSnapshot(backgroundPlan));
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
  const compiled = plan('say "first", 5\nexit');
  const afterSay = executeInstruction(compiled, createFreshRuntimeSnapshot(compiled));
  const forged = structuredClone(afterSay.snapshot);
  forged.status = "ready";
  forged.nextInstruction = 0;
  assert.equal(validateRuntimeSnapshot(forged, compiled).valid, false);
  assert.throws(() => createCheckpoint(compiled, forged));
});

test("runtime-produced pacing states validate and checkpoint through their lifecycle", () => {
  const positive = plan('say "first"\nexit');
  const background = executeInstruction(positive, createFreshRuntimeSnapshot(positive));
  assert.equal(background.snapshot.status, "running");
  assert.equal(background.snapshot.backgroundActions[0]?.kind, "chatPacingGate");

  const waitPlan = plan('say "first"\nwait 10 s\nexit');
  const withWait = run(waitPlan, createFreshRuntimeSnapshot(waitPlan));
  const waitGate = withWait.snapshot.backgroundActions[0];
  assert.equal(waitGate?.kind, "chatPacingGate");
  const backgroundSkipped = completeAction(waitPlan, withWait.snapshot, {
    actionId: waitGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const backgroundTimed = observeTime(waitPlan, withWait.snapshot, 1_800);

  const shortWaitPlan = plan('say "first"\nwait 1 s\nexit', {}, ["TSV060"]);
  const shortWait = run(shortWaitPlan, createFreshRuntimeSnapshot(shortWaitPlan));
  const delaySettled = observeTime(shortWaitPlan, shortWait.snapshot, 1_000);

  const interactionPlan = plan('say "first"\nshowButton "Continue"\nexit');
  const interaction = run(interactionPlan, createFreshRuntimeSnapshot(interactionPlan));

  const instantPlan = plan('say "first"\nsay "now", instant\nexit');
  const instant = run(instantPlan, createFreshRuntimeSnapshot(instantPlan));

  const promotionPlan = plan('say "first"\nsay "second"\nexit');
  const promoted = run(promotionPlan, createFreshRuntimeSnapshot(promotionPlan));
  const promotedGate = promoted.snapshot.foregroundAction;
  assert.equal(promotedGate?.kind, "chatPacingGate");
  const releasedByTime = observeTime(promotionPlan, promoted.snapshot, promotedGate!.deadlineMs);
  const releasedBySkip = completeAction(promotionPlan, promoted.snapshot, {
    actionId: promotedGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  // Exit clears pacing work, so these rows stop before it to keep the replacement and the unwound gates.
  const replacement = runUntilExit(promotionPlan, releasedBySkip.snapshot);
  const unwoundPlans = [
    plan('if true { say "branch" }\nexit'),
    plan('repeat 1 { say "loop" }\nexit'),
    plan('function f { say "call" }\nf()\nexit'),
  ];
  const unwound = unwoundPlans.map((compiled) => ({
    compiled,
    snapshot: runUntilExit(compiled, createFreshRuntimeSnapshot(compiled)).snapshot,
  }));
  for (const { snapshot } of unwound) {
    assert.equal(snapshot.backgroundActions[0]?.kind, "chatPacingGate");
  }

  const states: Array<[string, ReturnType<typeof plan>, RuntimeSnapshot]> = [
    ["initial background gate", positive, background.snapshot],
    ["background gate with foreground wait", waitPlan, withWait.snapshot],
    ["background skip while wait remains", waitPlan, backgroundSkipped.snapshot],
    ["background time settlement while wait remains", waitPlan, backgroundTimed.snapshot],
    [
      "foreground delay settlement with older background gate",
      shortWaitPlan,
      delaySettled.snapshot,
    ],
    ["interaction consumption", interactionPlan, interaction.snapshot],
    ["instant supersession", instantPlan, instant.snapshot],
    ["later say promotion", promotionPlan, promoted.snapshot],
    ["foreground pacing time release", promotionPlan, releasedByTime.snapshot],
    ["foreground pacing skip release", promotionPlan, releasedBySkip.snapshot],
    ["prepared output normal re-entry", promotionPlan, replacement.snapshot],
    ["branch unwind", unwound[0]!.compiled, unwound[0]!.snapshot],
    ["loop unwind", unwound[1]!.compiled, unwound[1]!.snapshot],
    ["function unwind", unwound[2]!.compiled, unwound[2]!.snapshot],
  ];

  for (const [label, compiled, snapshot] of states) {
    expectCheckpointJsonRoundTrip(label, compiled, snapshot);
  }
});

test("pacing state validation rejects relational identity, property, duration, and prepared-output corruption", () => {
  const waitPlan = plan('say "first"\nwait 10 s\nexit');
  const waiting = run(waitPlan, createFreshRuntimeSnapshot(waitPlan));
  const gate = waiting.snapshot.backgroundActions[0];
  assert.equal(gate?.kind, "chatPacingGate");
  const retained = completeAction(waitPlan, waiting.snapshot, {
    actionId: gate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });

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

  const preparedPlan = plan('say "first"\nsay "second"\nexit');
  const promoted = run(preparedPlan, createFreshRuntimeSnapshot(preparedPlan));
  const promotedGate = promoted.snapshot.foregroundAction;
  assert.equal(promotedGate?.kind, "chatPacingGate");
  const prepared = completeAction(preparedPlan, promoted.snapshot, {
    actionId: promotedGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.notEqual(prepared.snapshot.preparedSayOutput, null);

  const validMaximumDuration = mutateCheckpoint(preparedPlan, promoted.snapshot, (snapshot) => {
    snapshot.foregroundAction.preparedOutput.durationMs = Number.MAX_SAFE_INTEGER;
  });
  assert.equal(validateRuntimeSnapshot(validMaximumDuration.snapshot, preparedPlan).valid, true);
  assert.doesNotThrow(() => deserializeCheckpoint(JSON.stringify(validMaximumDuration)));
  const nonFiniteDuration = mutateCheckpoint(preparedPlan, promoted.snapshot, (snapshot) => {
    snapshot.foregroundAction.preparedOutput.durationMs = Number.POSITIVE_INFINITY;
  });
  assert.equal(validateRuntimeSnapshot(nonFiniteDuration.snapshot, preparedPlan).valid, false);

  const corruptions = [
    {
      name: "duplicate active action ID",
      compiled: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].actionId = snapshot.foregroundAction.actionId;
      }),
    },
    {
      name: "duplicate active request sequence",
      compiled: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].requestEventSequence =
          snapshot.foregroundAction.requestEventSequence;
      }),
    },
    {
      name: "active ID equals settlement ID",
      compiled: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, retained.snapshot, (snapshot) => {
        snapshot.foregroundAction.actionId = snapshot.lastSettlement.actionId;
      }),
    },
    {
      name: "active request equals settlement request",
      compiled: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, retained.snapshot, (snapshot) => {
        snapshot.foregroundAction.requestEventSequence =
          snapshot.lastSettlement.requestEventSequence;
      }),
    },
    {
      name: "active request equals settlement completion",
      compiled: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, retained.snapshot, (snapshot) => {
        snapshot.foregroundAction.requestEventSequence =
          snapshot.lastSettlement.completionEventSequence;
      }),
    },
    {
      name: "malformed settlement events",
      compiled: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, retained.snapshot, (snapshot) => {
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
    {
      name: "prepared duration exceeds supported domain",
      compiled: preparedPlan,
      checkpoint: mutateCheckpoint(preparedPlan, promoted.snapshot, (snapshot) => {
        snapshot.foregroundAction.preparedOutput.durationMs = Number.MAX_SAFE_INTEGER + 1;
      }),
    },
    {
      name: "top-level prepared output without release settlement",
      compiled: preparedPlan,
      checkpoint: mutateCheckpoint(preparedPlan, prepared.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutputInstruction = null;
      }),
    },
    {
      name: "top-level prepared output with incompatible status",
      compiled: preparedPlan,
      checkpoint: mutateCheckpoint(preparedPlan, prepared.snapshot, (snapshot) => {
        snapshot.status = "waiting";
      }),
    },
    {
      name: "top-level prepared output with a background gate",
      compiled: preparedPlan,
      checkpoint: mutateCheckpoint(preparedPlan, prepared.snapshot, (snapshot) => {
        snapshot.backgroundActions.push(structuredClone(waiting.snapshot.backgroundActions[0]));
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
  const waitPlan = plan('say "first"\nwait 10 s\nexit');
  const waiting = run(waitPlan, createFreshRuntimeSnapshot(waitPlan));
  const promotedPlan = plan('say "first"\nsay "second"\nexit');
  const promoted = run(promotedPlan, createFreshRuntimeSnapshot(promotedPlan));
  const promotedGate = promoted.snapshot.foregroundAction;
  assert.equal(promotedGate?.kind, "chatPacingGate");
  const speakerPlan = plan("speaker vera { defaultSaySkippable: true }\nexit");
  const speakerState = run(speakerPlan, createFreshRuntimeSnapshot(speakerPlan));
  const interactionPlan = plan('say "first"\nshowButton "Continue"\nwait 10 s\nexit');
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
      name: "foreground gate moved to background",
      plan: promotedPlan,
      checkpoint: mutateCheckpoint(promotedPlan, promoted.snapshot, (snapshot) => {
        snapshot.backgroundActions.push(snapshot.foregroundAction);
        snapshot.foregroundAction = null;
      }),
    },
    {
      name: "prepared output moved to top level while foreground remains",
      plan: promotedPlan,
      checkpoint: mutateCheckpoint(promotedPlan, promoted.snapshot, (snapshot) => {
        snapshot.preparedSayOutput = snapshot.foregroundAction.preparedOutput;
      }),
    },
    {
      name: "next action ID reuses active identity",
      plan: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
        snapshot.nextActionId = snapshot.foregroundAction.actionId;
      }),
    },
    {
      name: "next event sequence reuses request identity",
      plan: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
        snapshot.nextEventSequence = snapshot.foregroundAction.requestEventSequence;
      }),
    },
    {
      name: "prepared continuation is not say",
      plan: promotedPlan,
      checkpoint: mutateCheckpoint(promotedPlan, promoted.snapshot, (snapshot) => {
        snapshot.foregroundAction.preparedOutput.owningInstruction = 2;
        snapshot.foregroundAction.preparedOutput.continuationInstruction = 3;
        snapshot.nextInstruction = 2;
      }),
    },
    {
      name: "extra pacing setting",
      plan: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
        snapshot.chatPacingSettings.extra = 1;
      }),
    },
    {
      name: "missing pacing setting",
      plan: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waiting.snapshot, (snapshot) => {
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

test("active pacing locations allow only runtime-produced foreground and background compositions", () => {
  const waitPlan = plan('say "first"\nwait 10 s\nexit');
  const waitState = run(waitPlan, createFreshRuntimeSnapshot(waitPlan));
  const backgroundPacing = waitState.snapshot.backgroundActions[0];
  const foregroundDelay = waitState.snapshot.foregroundAction;
  assert.equal(backgroundPacing?.kind, "chatPacingGate");
  assert.equal(foregroundDelay?.kind, "delay");
  assert.equal(validateRuntimeSnapshot(waitState.snapshot, waitPlan).valid, true);
  assert.doesNotThrow(() =>
    deserializeCheckpoint(serializeCheckpoint(createCheckpoint(waitPlan, waitState.snapshot))),
  );

  const promotionPlan = plan('say "first"\nsay "second"\nexit');
  const promoted = run(promotionPlan, createFreshRuntimeSnapshot(promotionPlan));
  const foregroundPacing = promoted.snapshot.foregroundAction;
  assert.equal(foregroundPacing?.kind, "chatPacingGate");

  const interactionPlan = plan('say "first"\nshowButton "Continue"\nexit');
  const afterFirst = executeInstruction(
    interactionPlan,
    createFreshRuntimeSnapshot(interactionPlan),
  );
  assert.equal(afterFirst.snapshot.backgroundActions[0]?.kind, "chatPacingGate");
  assert.equal(validateRuntimeSnapshot(afterFirst.snapshot, interactionPlan).valid, true);

  const interactionState = run(interactionPlan, afterFirst.snapshot);
  assert.equal(interactionState.snapshot.foregroundAction?.kind, "interaction");
  assert.equal(interactionState.snapshot.backgroundActions.length, 0);
  assert.equal(
    interactionState.snapshot.lastSettlement?.settlementKind,
    "consumedByForegroundInteraction",
  );
  assert.equal(validateRuntimeSnapshot(interactionState.snapshot, interactionPlan).valid, true);
  assert.doesNotThrow(() =>
    deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(interactionPlan, interactionState.snapshot)),
    ),
  );

  // Each forged gate takes fresh identities, so only the active-location rules can reject it.
  const corruptions = [
    {
      name: "background cannot retain two pacing gates",
      compiled: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waitState.snapshot, (snapshot) => {
        const duplicate = structuredClone(snapshot.backgroundActions[0]);
        duplicate.actionId = snapshot.nextActionId;
        duplicate.requestEventSequence = snapshot.nextEventSequence;
        snapshot.nextActionId += 1;
        snapshot.nextEventSequence += 1;
        snapshot.backgroundActions.push(duplicate);
      }),
    },
    {
      name: "foreground and background cannot retain two pacing gates",
      compiled: promotionPlan,
      checkpoint: mutateCheckpoint(promotionPlan, promoted.snapshot, (snapshot) => {
        const duplicate = structuredClone(snapshot.foregroundAction);
        duplicate.actionId = snapshot.nextActionId;
        duplicate.requestEventSequence = snapshot.nextEventSequence;
        duplicate.preparedOutput = null;
        snapshot.nextActionId += 1;
        snapshot.nextEventSequence += 1;
        snapshot.backgroundActions.push(duplicate);
      }),
    },
    {
      name: "foreground interaction cannot retain a background pacing gate",
      compiled: interactionPlan,
      checkpoint: mutateCheckpoint(interactionPlan, interactionState.snapshot, (snapshot) => {
        const sourceGate = afterFirst.snapshot.backgroundActions[0];
        assert.ok(sourceGate?.kind === "chatPacingGate");
        // EVIDENCE: structuredClone preserves the runtime-produced pacing gate while this fixture changes its identity fields.
        const replacement = structuredClone(sourceGate) as Mutable<typeof sourceGate>;
        replacement.actionId = snapshot.nextActionId;
        replacement.requestEventSequence = snapshot.nextEventSequence;
        snapshot.nextActionId += 1;
        snapshot.nextEventSequence += 1;
        snapshot.backgroundActions.push(replacement);
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

test("pacing settlement release provenance and chronology accept only canonical lifecycle states", () => {
  const backgroundPlan = plan('say "first"\nsay "second"\nexit');
  const background = executeInstruction(backgroundPlan, createFreshRuntimeSnapshot(backgroundPlan));
  const backgroundGate = background.snapshot.backgroundActions[0];
  assert.equal(backgroundGate?.kind, "chatPacingGate");
  // Time completes a background gate only while the script waits; a runnable script continues first.
  const waitingPlan = plan('say "first"\nwait 10 s\nexit');
  const waiting = run(waitingPlan, createFreshRuntimeSnapshot(waitingPlan));
  const waitingGate = waiting.snapshot.backgroundActions[0];
  assert.equal(waitingGate?.kind, "chatPacingGate");
  const backgroundCompleted = observeTime(waitingPlan, waiting.snapshot, waitingGate!.deadlineMs);
  const backgroundSkipped = completeAction(backgroundPlan, background.snapshot, {
    actionId: backgroundGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });

  const interactionPlan = plan('say "first"\nshowButton "Continue"\nexit');
  const interaction = run(interactionPlan, createFreshRuntimeSnapshot(interactionPlan));
  const instantPlan = plan('say "first"\nsay "second", instant\nexit');
  const superseded = run(instantPlan, createFreshRuntimeSnapshot(instantPlan));

  const promotionPlan = plan('say "first"\nsay "second"\nexit');
  const promoted = run(promotionPlan, createFreshRuntimeSnapshot(promotionPlan));
  const foregroundGate = promoted.snapshot.foregroundAction;
  assert.equal(foregroundGate?.kind, "chatPacingGate");
  const foregroundCompleted = observeTime(
    promotionPlan,
    promoted.snapshot,
    foregroundGate!.deadlineMs,
  );
  const foregroundSkipped = completeAction(promotionPlan, promoted.snapshot, {
    actionId: foregroundGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });

  const cases = [
    {
      name: "background time completion",
      compiled: waitingPlan,
      snapshot: backgroundCompleted.snapshot,
      kind: "completed",
      releasedPreparedOutputInstruction: null,
      hasPreparedOutput: false,
    },
    {
      name: "background typed skip",
      compiled: backgroundPlan,
      snapshot: backgroundSkipped.snapshot,
      kind: "skipped",
      releasedPreparedOutputInstruction: null,
      hasPreparedOutput: false,
    },
    {
      name: "interaction consumes background pacing",
      compiled: interactionPlan,
      snapshot: interaction.snapshot,
      kind: "consumedByForegroundInteraction",
      releasedPreparedOutputInstruction: null,
      hasPreparedOutput: false,
    },
    {
      name: "instant output supersedes background pacing",
      compiled: instantPlan,
      snapshot: superseded.snapshot,
      kind: "supersededByInstantOutput",
      releasedPreparedOutputInstruction: null,
      hasPreparedOutput: false,
    },
    {
      name: "foreground time completion releases prepared output",
      compiled: promotionPlan,
      snapshot: foregroundCompleted.snapshot,
      kind: "completed",
      releasedPreparedOutputInstruction: 1,
      hasPreparedOutput: true,
    },
    {
      name: "foreground typed skip releases prepared output",
      compiled: promotionPlan,
      snapshot: foregroundSkipped.snapshot,
      kind: "skipped",
      releasedPreparedOutputInstruction: 1,
      hasPreparedOutput: true,
    },
  ] as const;

  for (const scenario of cases) {
    const settlement = scenario.snapshot.lastSettlement;
    assert.equal(settlement?.actionKind, "chatPacingGate", scenario.name);
    if (settlement?.actionKind !== "chatPacingGate") throw new Error(scenario.name);
    assert.equal(settlement?.settlementKind, scenario.kind, scenario.name);
    assert.equal(
      settlement?.releasedPreparedOutputInstruction,
      scenario.releasedPreparedOutputInstruction,
      scenario.name,
    );
    assert.equal(
      scenario.snapshot.preparedSayOutput !== null,
      scenario.hasPreparedOutput,
      scenario.name,
    );
    assert.equal(
      validateRuntimeSnapshot(scenario.snapshot, scenario.compiled).valid,
      true,
      scenario.name,
    );
    const restored = deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(scenario.compiled, scenario.snapshot)),
    );
    assert.deepEqual(restored.snapshot, scenario.snapshot, scenario.name);
  }

  const advancedAfterSkip = observeTime(backgroundPlan, backgroundSkipped.snapshot, 2_000);
  const corruptions = [
    {
      name: "background skip cannot falsely claim prepared-output release",
      compiled: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, backgroundSkipped.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutputInstruction = 1;
      }),
    },
    {
      name: "background skip cannot release injected prepared output",
      compiled: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, backgroundSkipped.snapshot, (snapshot) => {
        snapshot.preparedSayOutput = structuredClone(foregroundSkipped.snapshot.preparedSayOutput);
      }),
    },
    {
      name: "consumption cannot claim prepared-output release",
      compiled: interactionPlan,
      checkpoint: mutateCheckpoint(interactionPlan, interaction.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutputInstruction = 1;
      }),
    },
    {
      name: "supersession cannot claim prepared-output release",
      compiled: instantPlan,
      checkpoint: mutateCheckpoint(instantPlan, superseded.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutputInstruction = 1;
      }),
    },
    {
      name: "non-time settlement cannot complete at its deadline",
      compiled: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, advancedAfterSkip.snapshot, (snapshot) => {
        snapshot.lastSettlement.completedAtMs = snapshot.lastSettlement.deadlineMs;
      }),
    },
    {
      name: "non-time settlement cannot complete after its deadline",
      compiled: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, advancedAfterSkip.snapshot, (snapshot) => {
        snapshot.lastSettlement.completedAtMs = snapshot.lastSettlement.deadlineMs + 1;
      }),
    },
    {
      name: "time settlement cannot complete before its deadline",
      compiled: promotionPlan,
      checkpoint: mutateCheckpoint(promotionPlan, foregroundCompleted.snapshot, (snapshot) => {
        snapshot.lastSettlement.completedAtMs = snapshot.lastSettlement.deadlineMs - 1;
      }),
    },
    {
      name: "pacing settlement requires boolean release evidence",
      compiled: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, backgroundSkipped.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutputInstruction = "1";
      }),
    },
    {
      name: "pacing settlement requires the release evidence key",
      compiled: backgroundPlan,
      checkpoint: mutateCheckpoint(backgroundPlan, backgroundSkipped.snapshot, (snapshot) => {
        delete snapshot.lastSettlement.releasedPreparedOutputInstruction;
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

test("instruction boundaries preserve pacing release provenance before and after promotion", () => {
  const compiled = plan('say ["first", "first-alt"]\nsay ["second", "second-alt"]\nexit');
  const afterFirst = executeInstruction(
    compiled,
    createFreshRuntimeSnapshot(compiled, { seed: 77 }),
  );
  const backgroundGate = afterFirst.snapshot.backgroundActions[0];
  assert.equal(backgroundGate?.kind, "chatPacingGate");

  const restoredBackground = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, afterFirst.snapshot)),
  );
  const backgroundSkip = completeAction(restoredBackground.plan, restoredBackground.snapshot, {
    actionId: backgroundGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(backgroundSkip.snapshot.lastSettlement?.actionKind, "chatPacingGate");
  if (backgroundSkip.snapshot.lastSettlement?.actionKind !== "chatPacingGate")
    throw new Error("Expected pacing settlement.");
  assert.equal(backgroundSkip.snapshot.lastSettlement.releasedPreparedOutputInstruction, null);
  assert.equal(backgroundSkip.snapshot.preparedSayOutput, null);

  const secondAsFreshOutput = executeInstruction(compiled, backgroundSkip.snapshot);
  assert.equal(secondAsFreshOutput.events.filter((event) => event.kind === "say").length, 1);
  assert.ok(secondAsFreshOutput.snapshot.backgroundActions[0]!.actionId > backgroundGate!.actionId);

  const promoted = run(restoredBackground.plan, restoredBackground.snapshot);
  const foregroundGate = promoted.snapshot.foregroundAction;
  assert.equal(foregroundGate?.kind, "chatPacingGate");
  assert.equal(foregroundGate?.actionId, backgroundGate?.actionId);
  assert.equal(foregroundGate?.deadlineMs, backgroundGate?.deadlineMs);
  assert.equal(promoted.events.filter((event) => event.kind === "actionRequested").length, 0);

  const released = completeAction(compiled, promoted.snapshot, {
    actionId: foregroundGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(released.snapshot.lastSettlement?.actionKind, "chatPacingGate");
  if (released.snapshot.lastSettlement?.actionKind !== "chatPacingGate")
    throw new Error("Expected pacing settlement.");
  assert.equal(released.snapshot.lastSettlement.releasedPreparedOutputInstruction, 1);
  assert.notEqual(released.snapshot.preparedSayOutput, null);

  const restoredRelease = deserializeCheckpoint(
    serializeCheckpoint(createCheckpoint(compiled, released.snapshot)),
  );
  const resumed = executeInstruction(restoredRelease.plan, restoredRelease.snapshot);
  assert.equal(resumed.events.filter((event) => event.kind === "say").length, 1);
  assert.equal(
    resumed.snapshot.backgroundActions[0]?.actionId,
    secondAsFreshOutput.snapshot.backgroundActions[0]?.actionId,
  );
  assert.equal(resumed.snapshot.rng.state, secondAsFreshOutput.snapshot.rng.state);
});

test("pacing settlements retain exact prepared-output lineage through release and consumption", () => {
  const threeSays = plan('say "first"\nsay "second"\nsay "third"\nexit');
  const promoted = run(threeSays, createFreshRuntimeSnapshot(threeSays));
  const firstGate = promoted.snapshot.foregroundAction;
  assert.equal(firstGate?.kind, "chatPacingGate");

  const released = completeAction(threeSays, promoted.snapshot, {
    actionId: firstGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  assert.equal(
    released.snapshot.lastSettlement?.actionKind === "chatPacingGate" &&
      released.snapshot.lastSettlement.releasedPreparedOutputInstruction,
    1,
  );
  assert.equal(released.snapshot.preparedSayOutput?.owningInstruction, 1);
  assert.equal(validateRuntimeSnapshot(released.snapshot, threeSays).valid, true);
  assert.doesNotThrow(() =>
    deserializeCheckpoint(serializeCheckpoint(createCheckpoint(threeSays, released.snapshot))),
  );

  const forgedThird = checkpointSnapshot(threeSays, released.snapshot);
  assert.ok(forgedThird.preparedSayOutput !== null);
  forgedThird.preparedSayOutput.owningInstruction = 2;
  forgedThird.preparedSayOutput.continuationInstruction = 3;
  forgedThird.nextInstruction = 2;
  expectInvalidSnapshot(
    "settlement lineage must match the released prepared say",
    threeSays,
    forgedThird,
  );

  const consumed = executeInstruction(threeSays, released.snapshot);
  const replacement = consumed.snapshot.backgroundActions[0];
  assert.equal(replacement?.kind, "chatPacingGate");
  assert.equal(replacement?.owningInstruction, 1);
  assert.ok(replacement!.actionId > firstGate!.actionId);
  assert.equal(validateRuntimeSnapshot(consumed.snapshot, threeSays).valid, true);
  assert.doesNotThrow(() =>
    deserializeCheckpoint(serializeCheckpoint(createCheckpoint(threeSays, consumed.snapshot))),
  );

  const promotedReplacement = run(threeSays, consumed.snapshot);
  assert.equal(promotedReplacement.snapshot.foregroundAction?.kind, "chatPacingGate");
  assert.equal(promotedReplacement.snapshot.foregroundAction?.actionId, replacement?.actionId);
  assert.equal(validateRuntimeSnapshot(promotedReplacement.snapshot, threeSays).valid, true);

  const waitPlan = plan('say "first"\nsay "second"\nwait 10 s\nexit');
  const waitPromoted = run(waitPlan, createFreshRuntimeSnapshot(waitPlan));
  const waitGate = waitPromoted.snapshot.foregroundAction;
  assert.equal(waitGate?.kind, "chatPacingGate");
  const waitReleased = completeAction(waitPlan, waitPromoted.snapshot, {
    actionId: waitGate!.actionId,
    actionKind: "chatPacingGate",
    payload: { kind: "skip" },
  });
  const replacementWithWait = run(waitPlan, waitReleased.snapshot);
  assert.equal(replacementWithWait.snapshot.backgroundActions[0]?.owningInstruction, 1);
  assert.equal(replacementWithWait.snapshot.foregroundAction?.kind, "delay");
  assert.equal(validateRuntimeSnapshot(replacementWithWait.snapshot, waitPlan).valid, true);
  assert.doesNotThrow(() =>
    deserializeCheckpoint(
      serializeCheckpoint(createCheckpoint(waitPlan, replacementWithWait.snapshot)),
    ),
  );

  const corruptions = [
    {
      name: "top-level prepared output requires a matching lineage instruction",
      compiled: threeSays,
      checkpoint: mutateCheckpoint(threeSays, released.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutputInstruction = 2;
      }),
    },
    {
      name: "released lineage cannot remain without prepared output or replacement gate",
      compiled: threeSays,
      checkpoint: mutateCheckpoint(threeSays, released.snapshot, (snapshot) => {
        snapshot.preparedSayOutput = null;
      }),
    },
    {
      name: "replacement gate must belong to the released prepared say",
      compiled: threeSays,
      checkpoint: mutateCheckpoint(threeSays, consumed.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].owningInstruction = 0;
        snapshot.backgroundActions[0].continuationInstruction = 1;
      }),
    },
    {
      name: "replacement gate must be newer than its releasing settlement",
      compiled: threeSays,
      checkpoint: mutateCheckpoint(threeSays, consumed.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].actionId = snapshot.lastSettlement.actionId;
      }),
    },
    {
      name: "replacement request must follow the releasing completion",
      compiled: threeSays,
      checkpoint: mutateCheckpoint(threeSays, consumed.snapshot, (snapshot) => {
        snapshot.backgroundActions[0].requestEventSequence =
          snapshot.lastSettlement.completionEventSequence;
      }),
    },
    {
      name: "lineage instruction must be a say in the current plan",
      compiled: threeSays,
      checkpoint: mutateCheckpoint(threeSays, released.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutputInstruction = 3;
      }),
    },
    {
      name: "lineage instruction must be non-negative",
      compiled: threeSays,
      checkpoint: mutateCheckpoint(threeSays, released.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutputInstruction = -1;
      }),
    },
    {
      name: "lineage instruction cannot name a non-say instruction",
      compiled: waitPlan,
      checkpoint: mutateCheckpoint(waitPlan, waitReleased.snapshot, (snapshot) => {
        snapshot.lastSettlement.releasedPreparedOutputInstruction = 2;
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
