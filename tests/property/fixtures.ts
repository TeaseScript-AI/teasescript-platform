import assert from "node:assert/strict";

import {
  MAX_EXTERNAL_RUNTIME_DATA_DEPTH,
  MAX_EXTERNAL_RUNTIME_DATA_WORK,
  MAX_INTERACTION_OPTION_ENTRIES,
  MAX_INTERACTION_STRING_UTF8_BYTES,
  compileSource,
  completeAction,
  createCheckpoint,
  createFreshRuntimeSnapshot,
  executeInstruction,
  observeTime,
  run,
  validateInstructionPlan,
  validateRuntimeSnapshot,
  type ActionCompletionOutcome,
  type InstructionPlan,
  type InteractionAccessibleName,
  type InteractionInstruction,
  type InteractionUiPayload,
  type PendingActionOperationResult,
  type RuntimeCheckpoint,
  type RuntimeSnapshot,
} from "../../src/index.js";

export interface PlanSnapshotFixture {
  readonly name: string;
  readonly plan: InstructionPlan;
  readonly snapshot: RuntimeSnapshot;
}

export interface PropertyFixtureCatalog {
  readonly simplePlan: InstructionPlan;
  readonly fresh: PlanSnapshotFixture;
  readonly running: PlanSnapshotFixture;
  readonly halted: PlanSnapshotFixture;
  readonly failed: PlanSnapshotFixture;
  readonly waitingDelay: PlanSnapshotFixture;
  readonly settledDelay: PlanSnapshotFixture;
  readonly waitingText: PlanSnapshotFixture;
  readonly settledText: PlanSnapshotFixture;
  readonly waitingButton: PlanSnapshotFixture;
  readonly waitingChoice: PlanSnapshotFixture;
  readonly activeSpeaker: PlanSnapshotFixture;
  readonly activeScope: PlanSnapshotFixture;
  readonly activeLoop: PlanSnapshotFixture;
  readonly activeCall: PlanSnapshotFixture;
  readonly validTextCompletion: Readonly<Record<string, unknown>>;
  readonly validDelayCompletion: Readonly<Record<string, unknown>>;
  readonly duplicateTextCompletion: Readonly<Record<string, unknown>>;
  readonly textCompletionResult: PendingActionOperationResult<ActionCompletionOutcome>;
  readonly textCheckpoint: RuntimeCheckpoint;
  readonly exactLimitButtonPlan: InstructionPlan;
  readonly overLimitButtonPlan: InstructionPlan;
  readonly exactLimitChoicePlan: InstructionPlan;
  readonly overLimitChoicePlan: InstructionPlan;
  readonly overAggregateStringPlan: InstructionPlan;
}

export const MAX_PROPERTY_GRAPH_DEPTH = MAX_EXTERNAL_RUNTIME_DATA_DEPTH;
export const MAX_PROPERTY_COLLECTION_SIZE = MAX_EXTERNAL_RUNTIME_DATA_WORK;
export const MAX_PROPERTY_STRING_UTF8_BYTES =
  MAX_INTERACTION_STRING_UTF8_BYTES + 1;

const DEFAULT_ACCESSIBLE_NAMES = {
  button: Object.freeze({ kind: "localizedDefault", key: "continue" }),
  text: Object.freeze({ kind: "localizedDefault", key: "answer" }),
  number: Object.freeze({ kind: "localizedDefault", key: "number" }),
  choice: Object.freeze({ kind: "localizedDefault", key: "chooseOption" }),
} as const satisfies Readonly<Record<string, InteractionAccessibleName>>;

export function compileValidPlan(source: string): InstructionPlan {
  const result = compileSource(source);
  assert.deepEqual(result.diagnostics, [], source);
  assert.notEqual(result.plan, null, source);
  assertValidPlan(result.plan!);
  return result.plan!;
}

export function createInteractionPlan(
  interactionKind: InteractionInstruction["interactionKind"],
  ui: InteractionUiPayload,
  options: { readonly speaker?: string | null } = {},
): InstructionPlan {
  const source = options.speaker === undefined
    ? "wait 1\nexit"
    : `speaker ${options.speaker} {}\nspeaker ${options.speaker}\nwait 1\nexit`;
  const base = compileValidPlan(source);
  const waitIndex = base.instructions.findIndex(
    (instruction) => instruction.kind === "wait",
  );
  assert.notEqual(waitIndex, -1);
  const expectedResult = interactionKind === "button"
    ? "none"
    : interactionKind === "number" ||
        (ui.kind === "choice" && ui.labelType === "number")
      ? "number"
      : "string";
  const interaction: InteractionInstruction = Object.freeze({
    kind: "interaction",
    interactionKind,
    target: "standardChat",
    speaker: options.speaker ?? null,
    destinationTemporary: interactionKind === "button" ? null : 1,
    expectedResult,
    ui,
    span: base.instructions[waitIndex]!.span,
  });
  const plan: InstructionPlan = Object.freeze({
    ...base,
    temporaryCount: interactionKind === "button" ? 0 : 1,
    instructions: Object.freeze(
      base.instructions.map((instruction, index) =>
        index === waitIndex ? interaction : instruction,
      ),
    ),
  });
  assertValidPlan(plan);
  return plan;
}

export function createExactLimitButtonPlan(): InstructionPlan {
  return createInteractionPlan("button", {
    kind: "button",
    buttonLabel: exactUtf8String(MAX_INTERACTION_STRING_UTF8_BYTES),
    accessibleName: DEFAULT_ACCESSIBLE_NAMES.button,
  });
}

export function createOverLimitButtonPlan(): InstructionPlan {
  const valid = createInteractionPlan("button", {
    kind: "button",
    buttonLabel: "x",
    accessibleName: DEFAULT_ACCESSIBLE_NAMES.button,
  });
  const mutated = structuredClone(valid) as InstructionPlan;
  const instruction = mutated.instructions.find(
    (candidate): candidate is InteractionInstruction =>
      candidate.kind === "interaction",
  );
  assert.ok(instruction !== undefined && instruction.ui.kind === "button");
  (instruction.ui as { buttonLabel: string }).buttonLabel = exactUtf8String(
    MAX_INTERACTION_STRING_UTF8_BYTES + 1,
  );
  return mutated;
}

export function createExactLimitChoicePlan(): InstructionPlan {
  return createInteractionPlan("choice", {
    kind: "choice",
    labelType: "number",
    options: Object.freeze(
      Array.from({ length: MAX_INTERACTION_OPTION_ENTRIES }, (_, index) =>
        Object.freeze({ text: "", label: index }),
      ),
    ),
    accessibleName: DEFAULT_ACCESSIBLE_NAMES.choice,
  });
}

export function createOverLimitChoicePlan(): InstructionPlan {
  const valid = createInteractionPlan("choice", {
    kind: "choice",
    labelType: "number",
    options: Object.freeze([{ text: "", label: 0 }]),
    accessibleName: DEFAULT_ACCESSIBLE_NAMES.choice,
  });
  const mutated = structuredClone(valid) as InstructionPlan;
  const instruction = mutated.instructions.find(
    (candidate): candidate is InteractionInstruction =>
      candidate.kind === "interaction",
  );
  assert.ok(instruction !== undefined && instruction.ui.kind === "choice");
  (instruction.ui as unknown as { options: Array<{ text: string; label: number }> }).options =
    Array.from({ length: MAX_INTERACTION_OPTION_ENTRIES + 1 }, (_, index) => ({
      text: "",
      label: index,
    }));
  return mutated;
}


export function createOverAggregateStringPlan(): InstructionPlan {
  const plan = createInteractionPlan("button", {
    kind: "button",
    buttonLabel: "x",
    accessibleName: DEFAULT_ACCESSIBLE_NAMES.button,
  });
  const mutated = structuredClone(plan) as InstructionPlan;
  const instruction = mutated.instructions.find(
    (candidate): candidate is InteractionInstruction =>
      candidate.kind === "interaction",
  );
  assert.ok(instruction !== undefined && instruction.ui.kind === "button");
  const ui = instruction.ui as unknown as {
    buttonLabel: string;
    accessibleName: { kind: "text"; text: string };
  };
  ui.buttonLabel = exactUtf8String((MAX_INTERACTION_STRING_UTF8_BYTES / 2) + 1);
  ui.accessibleName = {
    kind: "text",
    text: exactUtf8String(MAX_INTERACTION_STRING_UTF8_BYTES / 2),
  };
  return mutated;
}

export function createPropertyFixtureCatalog(): PropertyFixtureCatalog {
  const simplePlan = compileValidPlan('let value = 1\nsay `${value}`\nexit');
  const freshSnapshot = createFreshRuntimeSnapshot(simplePlan, { seed: 12345 });
  const runningSnapshot = executeInstruction(simplePlan, freshSnapshot).snapshot;
  const haltedSnapshot = run(simplePlan, freshSnapshot).snapshot;

  const failedPlan = compileValidPlan("let value = []\nsay value.first\nexit");
  const failedSnapshot = run(
    failedPlan,
    createFreshRuntimeSnapshot(failedPlan, { seed: 12345 }),
  ).snapshot;
  assert.equal(failedSnapshot.status, "failed");

  const delayPlan = compileValidPlan("wait 1\nexit");
  const waitingDelayResult = run(
    delayPlan,
    createFreshRuntimeSnapshot(delayPlan, { seed: 12345 }),
  );
  assert.equal(waitingDelayResult.snapshot.status, "waiting");
  const delayActionId = waitingDelayResult.snapshot.foregroundAction?.actionId;
  assert.notEqual(delayActionId, undefined);
  const validDelayCompletion = Object.freeze({
    actionId: delayActionId!,
    actionKind: "delay",
    payload: Object.freeze({ kind: "time", currentSessionTimeMs: 1_000 }),
  });
  const delayCompletion = observeTime(
    delayPlan,
    waitingDelayResult.snapshot,
    1_000,
  );
  assert.equal(delayCompletion.outcome.kind, "observed");

  const textPlan = createInteractionPlan("text", {
    kind: "text",
    hint: "Answer",
    accessibleName: DEFAULT_ACCESSIBLE_NAMES.text,
  });
  const waitingTextResult = run(
    textPlan,
    createFreshRuntimeSnapshot(textPlan, { seed: 12345 }),
  );
  assert.equal(waitingTextResult.snapshot.status, "waiting");
  const textActionId = waitingTextResult.snapshot.foregroundAction?.actionId;
  assert.notEqual(textActionId, undefined);
  const validTextCompletion = Object.freeze({
    actionId: textActionId!,
    actionKind: "interaction",
    interactionKind: "text",
    payload: Object.freeze({ kind: "submittedText", submittedText: "answer" }),
  });
  const textCompletionResult = completeAction(
    textPlan,
    waitingTextResult.snapshot,
    validTextCompletion,
  );
  assert.equal(textCompletionResult.outcome.kind, "completed");
  const duplicateTextCompletion = Object.freeze({
    ...validTextCompletion,
    payload: Object.freeze({ kind: "submittedText", submittedText: "different" }),
  });

  const buttonPlan = createInteractionPlan("button", {
    kind: "button",
    buttonLabel: "Continue",
    accessibleName: DEFAULT_ACCESSIBLE_NAMES.button,
  });
  const waitingButtonResult = run(
    buttonPlan,
    createFreshRuntimeSnapshot(buttonPlan, { seed: 12345 }),
  );

  const choicePlan = createInteractionPlan("choice", {
    kind: "choice",
    labelType: "identifier",
    options: Object.freeze([
      Object.freeze({ text: "One", label: "one" }),
      Object.freeze({ text: "Two", label: "two" }),
    ]),
    accessibleName: DEFAULT_ACCESSIBLE_NAMES.choice,
  });
  const waitingChoiceResult = run(
    choicePlan,
    createFreshRuntimeSnapshot(choicePlan, { seed: 12345 }),
  );

  const speakerPlan = compileValidPlan(
    'speaker vera {}\nspeaker vera\nwait 1\nexit',
  );
  const scopePlan = compileValidPlan("if true {\n  wait 1\n}\nexit");
  const loopPlan = compileValidPlan("repeat 2 {\n  wait 1\n}\nexit");
  const callPlan = compileValidPlan(
    "function hold {\n  wait 1\n  return 1\n}\nhold()\nexit",
  );

  const catalog: PropertyFixtureCatalog = Object.freeze({
    simplePlan,
    fresh: fixture("fresh", simplePlan, freshSnapshot),
    running: fixture("running", simplePlan, runningSnapshot),
    halted: fixture("halted", simplePlan, haltedSnapshot),
    failed: fixture("failed", failedPlan, failedSnapshot),
    waitingDelay: fixture("waiting-delay", delayPlan, waitingDelayResult.snapshot),
    settledDelay: fixture("settled-delay", delayPlan, delayCompletion.snapshot),
    waitingText: fixture("waiting-text", textPlan, waitingTextResult.snapshot),
    settledText: fixture("settled-text", textPlan, textCompletionResult.snapshot),
    waitingButton: fixture("waiting-button", buttonPlan, waitingButtonResult.snapshot),
    waitingChoice: fixture("waiting-choice", choicePlan, waitingChoiceResult.snapshot),
    activeSpeaker: fixture(
      "active-speaker",
      speakerPlan,
      run(speakerPlan, createFreshRuntimeSnapshot(speakerPlan, { seed: 12345 })).snapshot,
    ),
    activeScope: fixture(
      "active-scope",
      scopePlan,
      run(scopePlan, createFreshRuntimeSnapshot(scopePlan, { seed: 12345 })).snapshot,
    ),
    activeLoop: fixture(
      "active-loop",
      loopPlan,
      run(loopPlan, createFreshRuntimeSnapshot(loopPlan, { seed: 12345 })).snapshot,
    ),
    activeCall: fixture(
      "active-call",
      callPlan,
      run(callPlan, createFreshRuntimeSnapshot(callPlan, { seed: 12345 })).snapshot,
    ),
    validTextCompletion,
    validDelayCompletion,
    duplicateTextCompletion,
    textCompletionResult,
    textCheckpoint: createCheckpoint(textPlan, waitingTextResult.snapshot),
    exactLimitButtonPlan: createExactLimitButtonPlan(),
    overLimitButtonPlan: createOverLimitButtonPlan(),
    exactLimitChoicePlan: createExactLimitChoicePlan(),
    overLimitChoicePlan: createOverLimitChoicePlan(),
    overAggregateStringPlan: createOverAggregateStringPlan(),
  });

  for (const entry of [
    catalog.fresh,
    catalog.running,
    catalog.halted,
    catalog.failed,
    catalog.waitingDelay,
    catalog.settledDelay,
    catalog.waitingText,
    catalog.settledText,
    catalog.waitingButton,
    catalog.waitingChoice,
    catalog.activeSpeaker,
    catalog.activeScope,
    catalog.activeLoop,
    catalog.activeCall,
  ]) {
    assertValidPlan(entry.plan);
    assertValidSnapshot(entry.plan, entry.snapshot);
  }
  assert.equal(validateInstructionPlan(catalog.exactLimitButtonPlan).valid, true);
  assert.equal(validateInstructionPlan(catalog.overLimitButtonPlan).valid, false);
  assert.equal(validateInstructionPlan(catalog.exactLimitChoicePlan).valid, true);
  assert.equal(validateInstructionPlan(catalog.overLimitChoicePlan).valid, false);
  assert.equal(validateInstructionPlan(catalog.overAggregateStringPlan).valid, false);
  assertFixtureSemantics(catalog);
  assertPropertyFixtureBounds(catalog);
  deepFreezePropertyFixtureCatalog(catalog);
  return catalog;
}

export function assertPropertyFixtureBounds(value: unknown): void {
  const ancestors = new WeakSet<object>();
  const encoder = new TextEncoder();

  function visit(current: unknown, depth: number, path: string): void {
    assert.ok(
      depth <= MAX_PROPERTY_GRAPH_DEPTH,
      `${path} exceeds property fixture depth ${MAX_PROPERTY_GRAPH_DEPTH}.`,
    );
    if (typeof current === "string") {
      assert.ok(
        encoder.encode(current).byteLength <= MAX_PROPERTY_STRING_UTF8_BYTES,
        `${path} exceeds property fixture string bytes ${MAX_PROPERTY_STRING_UTF8_BYTES}.`,
      );
      return;
    }
    if ((typeof current !== "object" || current === null) && typeof current !== "function") return;
    if (typeof current === "function") return;
    if (ancestors.has(current)) return;
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        assert.ok(
          current.length <= MAX_PROPERTY_COLLECTION_SIZE,
          `${path} exceeds property fixture collection size ${MAX_PROPERTY_COLLECTION_SIZE}.`,
        );
      }
      for (const key of Reflect.ownKeys(current)) {
        if (Array.isArray(current) && key === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(current, key);
        assert.notEqual(descriptor, undefined, `${path} lost own property ${String(key)}.`);
        assert.ok(
          descriptor !== undefined && "value" in descriptor,
          `${path}.${String(key)} must not contain an accessor fixture property.`,
        );
        visit(
          descriptor.value,
          depth + 1,
          typeof key === "symbol" ? `${path}[${String(key)}]` : `${path}.${key}`,
        );
      }
    } finally {
      ancestors.delete(current);
    }
  }

  visit(value, 0, "$fixtures");
}


export function assertPropertyFixtureCatalogFrozen(value: unknown): void {
  const seen = new WeakSet<object>();
  function visit(current: unknown, path: string): void {
    if (
      ((typeof current !== "object" || current === null) && typeof current !== "function") ||
      seen.has(current as object)
    ) return;
    if (typeof current === "function") return;
    seen.add(current);
    assert.equal(Object.isFrozen(current), true, `${path} is not frozen.`);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined && "value" in descriptor) {
        visit(descriptor.value, `${path}.${String(key)}`);
      }
    }
  }
  visit(value, "$fixtures");
}

export function exactUtf8String(byteLength: number): string {
  assert.ok(Number.isSafeInteger(byteLength) && byteLength >= 0);
  const twoByteCharacters = Math.floor(byteLength / 2);
  return "é".repeat(twoByteCharacters) + (byteLength % 2 === 0 ? "" : "a");
}

function assertFixtureSemantics(catalog: PropertyFixtureCatalog): void {
  assertFixtureState(catalog.fresh, "ready", null);
  assertFixtureState(catalog.running, "running", null);
  assertFixtureState(catalog.halted, "halted", null);
  assertFixtureState(catalog.failed, "failed", null);
  assertFixtureState(catalog.waitingDelay, "waiting", "delay");
  assertFixtureState(catalog.settledDelay, "running", null);
  assert.equal(catalog.settledDelay.snapshot.lastSettlement?.actionKind, "delay");
  assertFixtureState(catalog.waitingText, "waiting", "interaction", "text");
  assertFixtureState(catalog.settledText, "running", null);
  assert.equal(catalog.settledText.snapshot.lastSettlement?.actionKind, "interaction");
  assertFixtureState(catalog.waitingButton, "waiting", "interaction", "button");
  assertFixtureState(catalog.waitingChoice, "waiting", "interaction", "choice");
  assertFixtureState(catalog.activeSpeaker, "waiting", "delay");
  assert.equal(catalog.activeSpeaker.snapshot.speakers.length, 1);
  assertFixtureState(catalog.activeScope, "waiting", "delay");
  assert.equal(catalog.activeScope.snapshot.frames.length, 2);
  assertFixtureState(catalog.activeLoop, "waiting", "delay");
  assert.equal(catalog.activeLoop.snapshot.loopFrames.length, 1);
  assertFixtureState(catalog.activeCall, "waiting", "delay");
  assert.equal(catalog.activeCall.snapshot.callFrames.length, 1);
}

function assertFixtureState(
  fixtureValue: PlanSnapshotFixture,
  status: RuntimeSnapshot["status"],
  actionKind: "delay" | "interaction" | null,
  interactionKind?: InteractionInstruction["interactionKind"],
): void {
  assert.equal(fixtureValue.snapshot.status, status, fixtureValue.name);
  assert.equal(fixtureValue.snapshot.foregroundAction?.kind ?? null, actionKind, fixtureValue.name);
  if (interactionKind !== undefined) {
    const action = fixtureValue.snapshot.foregroundAction;
    assert.ok(action !== null && action.kind === "interaction", fixtureValue.name);
    assert.equal(action.interactionKind, interactionKind, fixtureValue.name);
  }
}

function deepFreezePropertyFixtureCatalog(value: unknown): void {
  const seen = new WeakSet<object>();
  function freeze(current: unknown): void {
    if ((typeof current !== "object" || current === null) && typeof current !== "function") return;
    if (typeof current === "function" || seen.has(current)) return;
    seen.add(current);
    for (const key of Reflect.ownKeys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor !== undefined && "value" in descriptor) freeze(descriptor.value);
    }
    Object.freeze(current);
  }
  freeze(value);
}

export function summarizePropertyFixtureCatalog(
  fixtures: PropertyFixtureCatalog,
): string {
  return JSON.stringify({
    planVersion: fixtures.simplePlan.version,
    snapshots: [
      fixtures.fresh,
      fixtures.running,
      fixtures.halted,
      fixtures.failed,
      fixtures.waitingDelay,
      fixtures.settledDelay,
      fixtures.waitingText,
      fixtures.settledText,
      fixtures.waitingButton,
      fixtures.waitingChoice,
      fixtures.activeSpeaker,
      fixtures.activeScope,
      fixtures.activeLoop,
      fixtures.activeCall,
    ].map((fixtureValue) => ({
      name: fixtureValue.name,
      status: fixtureValue.snapshot.status,
      nextInstruction: fixtureValue.snapshot.nextInstruction,
      foregroundAction: fixtureValue.snapshot.foregroundAction?.kind ?? null,
      lastSettlement: fixtureValue.snapshot.lastSettlement?.actionKind ?? null,
    })),
  });
}

export function summarizeFixture(fixtureValue: PlanSnapshotFixture): string {
  const action = fixtureValue.snapshot.foregroundAction;
  return JSON.stringify({
    name: fixtureValue.name,
    planVersion: fixtureValue.plan.version,
    snapshotVersion: fixtureValue.snapshot.version,
    status: fixtureValue.snapshot.status,
    nextInstruction: fixtureValue.snapshot.nextInstruction,
    foregroundAction: action === null
      ? null
      : { kind: action.kind, actionId: action.actionId },
    lastSettlement: fixtureValue.snapshot.lastSettlement === null
      ? null
      : {
          kind: fixtureValue.snapshot.lastSettlement.actionKind,
          actionId: fixtureValue.snapshot.lastSettlement.actionId,
        },
    frames: fixtureValue.snapshot.frames.length,
    speakers: fixtureValue.snapshot.speakers.length,
    loops: fixtureValue.snapshot.loopFrames.length,
    calls: fixtureValue.snapshot.callFrames.length,
    temporaries: fixtureValue.snapshot.temporaries.length,
  });
}

function fixture(
  name: string,
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): PlanSnapshotFixture {
  return Object.freeze({ name, plan, snapshot });
}

function assertValidPlan(plan: InstructionPlan): void {
  const validation = validateInstructionPlan(plan);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
}

function assertValidSnapshot(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): void {
  const validation = validateRuntimeSnapshot(snapshot, plan);
  assert.equal(validation.valid, true, JSON.stringify(validation.errors));
}
