import assert from "node:assert/strict";

import {
  compileProject,
  compileSource,
  createCheckpoint,
  createRuntimeSession,
  deserializeCheckpoint,
  deserializeRuntimeSession,
  executeInstruction,
  interactionDeadlineMs,
  observeTime,
  pressPermanentButton,
  reportMediaLoad,
  run,
  serializeCheckpoint,
  validateRuntimeSnapshot,
  validateInstructionPlan,
  type InstructionPlan,
  type InterpreterEvent,
  type MediaProgressReport,
  type ProjectImageFile,
  type ProjectSourceFile,
  type RuntimeCallFrameSnapshot,
  type RuntimeScriptStorageEntrySnapshot,
  type RuntimeSession,
  type RuntimeSessionView,
  type RuntimeSnapshot,
} from "../../src/index.js";
import { createImmediatePacingRuntimeSnapshot } from "./immediate-pacing-runtime.js";
import { interruptFrame } from "../../src/runtime/activations.js";
import { executionRunnable } from "../../src/runtime/operations/observe-time.js";

const DEFAULT_EQUIVALENCE_SEED = 0x1234_5678;
const DEFAULT_INSTRUCTION_GUARD = 2_000;

export interface RuntimeResumeEquivalenceOptions {
  readonly scenarioName?: string;
  readonly seed?: number;
  readonly instructionGuard?: number;
  /**
   * Media scenarios: the simulated Player loads every source with this duration and then plays all running media at
   * normal speed, reporting progress on each time observation.
   */
  readonly mediaDurationMs?: number;
  /** The package images that tag queries search. */
  readonly images?: readonly ProjectImageFile[];
  /** The host's stored values when the session starts, such as values an earlier session saved. */
  readonly scriptStorage?: readonly RuntimeScriptStorageEntrySnapshot[];
  /** How the session ends: `halted` by default, or `failed` for a scenario that ends with a runtime error. */
  readonly ending?: "halted" | "failed";
  /**
   * Permanent button scenarios: whenever execution waits, the simulated Player first clicks the button this returns,
   * deciding from the state and every event so far, and observes time only when it returns `null`.
   */
  readonly press?: (
    snapshot: RuntimeSnapshot,
    events: readonly InterpreterEvent[],
  ) => number | null;
}

/** How the simulated Player makes progress while execution waits. */
interface Servicing {
  readonly mediaDurationMs: number | undefined;
  readonly press: RuntimeResumeEquivalenceOptions["press"];
}

/** Spacing of the simulated Player's media progress observations. */
const MEDIA_OBSERVATION_STEP_MS = 250;

/** One host operation: the same step applies to a snapshot through the snapshot API and to a session. */
type HostStep =
  | { readonly kind: "execute" }
  | { readonly kind: "observe"; readonly nowMs: number; readonly reports: MediaProgressReport[] }
  | { readonly kind: "press"; readonly buttonId: number }
  | { readonly kind: "load"; readonly mediaId: number; readonly durationMs: number };

interface Operation {
  readonly events: readonly InterpreterEvent[];
  readonly instructionsExecuted: number;
  readonly outcome?: unknown;
}

export interface RuntimeResumeEquivalenceResult {
  readonly boundaries: readonly RuntimeSnapshot[];
  readonly events: readonly InterpreterEvent[];
  readonly finalSnapshot: RuntimeSnapshot;
}

/** `source` is one source, the `main.tease` of a single-file project, or the files of a project. */
export function assertRuntimeResumeEquivalent(
  source: string | readonly ProjectSourceFile[],
  options: RuntimeResumeEquivalenceOptions = {},
): RuntimeResumeEquivalenceResult {
  const scenario =
    options.scenarioName ??
    describeScenario(typeof source === "string" ? source : (source[0]?.source ?? ""));
  const instructionGuard = options.instructionGuard ?? DEFAULT_INSTRUCTION_GUARD;
  assert.ok(
    Number.isInteger(instructionGuard) && instructionGuard > 0,
    `${scenario}: instructionGuard must be a positive integer`,
  );

  const compileOptions = { images: options.images ?? [] };
  const compiled =
    typeof source === "string"
      ? compileSource(source, compileOptions)
      : compileProject(source, compileOptions);
  assert.deepEqual(
    compiled.diagnostics,
    [],
    `${scenario}: source must compile without diagnostics`,
  );
  assert.notEqual(compiled.plan, null, `${scenario}: compilation must produce a plan`);
  const plan = compiled.plan!;

  const initialPlanValidation = validateInstructionPlan(plan);
  assert.equal(
    initialPlanValidation.valid,
    true,
    `${scenario}: compiled plan must validate: ${formatValidationErrors(initialPlanValidation.errors)}`,
  );

  const seed = options.seed ?? DEFAULT_EQUIVALENCE_SEED;
  const fresh = {
    seed,
    ...(options.scriptStorage === undefined ? {} : { scriptStorage: options.scriptStorage }),
  };
  const initial = createImmediatePacingRuntimeSnapshot(plan, fresh);
  const initialSnapshotValidation = validateRuntimeSnapshot(initial, plan);
  assert.equal(
    initialSnapshotValidation.valid,
    true,
    `${scenario}: fresh snapshot must validate: ${initialSnapshotValidation.errors.join("; ")}`,
  );

  const servicing: Servicing = { mediaDurationMs: options.mediaDurationMs, press: options.press };
  const uninterrupted = runServicingDelays(plan, initial, instructionGuard, scenario, servicing);
  const ending = options.ending ?? "halted";
  assert.equal(
    uninterrupted.snapshot.status,
    ending,
    `${scenario}: uninterrupted execution must end ${ending} within ${instructionGuard} instructions`,
  );
  assertMonotonicEventSequences(uninterrupted.events, `${scenario}: uninterrupted execution`);

  // The stepping pass starts from its own fresh snapshot, so a baseline that mutated its input cannot hide boundaries.
  const steppingInitial = createImmediatePacingRuntimeSnapshot(plan, fresh);
  assert.deepEqual(
    initial,
    steppingInitial,
    `${scenario}: uninterrupted execution must not change its initial snapshot`,
  );

  // Every pass also runs through an engine-owned session (docs/RUNTIME.md#runtime-sessions), which must give the
  // snapshot API's events, outcomes, and checkpoints.
  const session = createRuntimeSession(plan, initial);
  const played = runSessionServicingDelays(session, instructionGuard, scenario, servicing);
  assert.deepEqual(
    played,
    uninterrupted.events,
    `${scenario}: session events differ from the snapshot API`,
  );
  assertSameCheckpoint(
    serializeCheckpoint(session.exportCheckpoint()),
    serializeCheckpoint(createCheckpoint(plan, uninterrupted.snapshot)),
    `${scenario}: session final checkpoint`,
  );
  let stepper = createRuntimeSession(plan, steppingInitial);

  const boundaries: RuntimeSnapshot[] = [];
  const accumulatedEvents: InterpreterEvent[] = [];
  let boundarySnapshot = steppingInitial;
  let boundary = 0;

  while (boundarySnapshot.status !== "halted" && boundarySnapshot.status !== "failed") {
    assert.ok(
      boundary < instructionGuard,
      `${scenario}: instruction-boundary execution exceeded guard ${instructionGuard}`,
    );

    const view = viewOf(boundarySnapshot);
    const step: HostStep = awaitsTime(view)
      ? waitStep(
          view,
          () => boundarySnapshot,
          accumulatedEvents,
          `${scenario}: boundary ${boundary + 1}`,
          servicing,
        )
      : { kind: "execute" };
    const operation = applyStep(plan, boundarySnapshot, step);
    assertStepAccepted(step, operation, `${scenario}: boundary ${boundary + 1}`);
    if (step.kind === "observe") {
      assert.notDeepEqual(
        operation.snapshot,
        boundarySnapshot,
        `${scenario}: boundary ${boundary + 1}: the observation must make progress`,
      );
    }
    const sessionContext = `${scenario}: session boundary ${boundary + 1}`;
    assert.deepEqual(stepper.view(), view, `${sessionContext}: session view differs`);
    const stepped = applySessionStep(stepper, step);
    assert.deepEqual(stepped, sameShape(operation), `${sessionContext}: session operation differs`);
    boundarySnapshot = operation.snapshot;
    accumulatedEvents.push(...operation.events);
    boundary += 1;

    const context = `${scenario}: instruction boundary ${boundary} (next ${boundarySnapshot.nextInstruction})`;
    const checkpointJson = serializeCheckpoint(createCheckpoint(plan, boundarySnapshot));
    assertSameCheckpoint(
      serializeCheckpoint(stepper.exportCheckpoint()),
      checkpointJson,
      `${context}: session checkpoint`,
    );
    // The session continues from a restored copy of this boundary, or from a fork of itself.
    stepper = boundary % 2 === 0 ? deserializeRuntimeSession(checkpointJson) : stepper.fork();
    const restored = deserializeCheckpoint(checkpointJson);

    const restoredPlanValidation = validateInstructionPlan(restored.plan);
    assert.equal(
      restoredPlanValidation.valid,
      true,
      `${context}: restored plan must validate: ${formatValidationErrors(restoredPlanValidation.errors)}`,
    );
    const restoredSnapshotValidation = validateRuntimeSnapshot(restored.snapshot, restored.plan);
    assert.equal(
      restoredSnapshotValidation.valid,
      true,
      `${context}: restored snapshot must validate: ${restoredSnapshotValidation.errors.join("; ")}`,
    );
    assert.deepEqual(restored.plan, plan, `${context}: restored plan changed`);
    assert.deepEqual(
      restored.snapshot,
      boundarySnapshot,
      `${context}: restored snapshot changed during JSON roundtrip`,
    );

    const resumed = runServicingDelays(
      restored.plan,
      restored.snapshot,
      instructionGuard,
      context,
      servicing,
      accumulatedEvents,
    );
    assert.equal(
      resumed.snapshot.status,
      ending,
      `${context}: resumed execution must end ${ending} within ${instructionGuard} instructions`,
    );

    const combinedEvents = [...accumulatedEvents, ...resumed.events];
    assertMonotonicEventSequences(combinedEvents, context);
    assert.deepEqual(
      combinedEvents,
      uninterrupted.events,
      `${context}: resumed events differ from uninterrupted execution`,
    );
    assert.deepEqual(
      resumed.snapshot,
      uninterrupted.snapshot,
      `${context}: resumed final snapshot differs from uninterrupted execution`,
    );

    boundaries.push(boundarySnapshot);
  }
  assert.ok(
    plan.instructions.length === 0 || boundaries.length > 0,
    `${scenario}: a nonempty plan must exercise at least one checkpoint boundary`,
  );

  return Object.freeze({
    boundaries: Object.freeze([...boundaries]),
    events: uninterrupted.events,
    finalSnapshot: uninterrupted.snapshot,
  });
}

/**
 * Runs to completion, observing time at the next deadline whenever execution waits: a foreground or interrupted
 * delay (`wait` or blocking `timer`), a running async timer, or a presented button's timeout. Blocking behavior is
 * preserved: nothing settles without an observation, and no foreground button is clicked; only `press` clicks
 * permanent buttons. `priorEvents` are the events before `snapshot`, which `press` decides from.
 */
function runServicingDelays(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  instructionGuard: number,
  context: string,
  servicing: Servicing,
  priorEvents: readonly InterpreterEvent[] = [],
): { readonly snapshot: RuntimeSnapshot; readonly events: readonly InterpreterEvent[] } {
  const events: InterpreterEvent[] = [];
  let current = snapshot;
  for (let observations = 0; ; observations += 1) {
    assert.ok(observations <= instructionGuard, `${context}: delay servicing exceeded guard`);
    const view = viewOf(current);
    if (awaitsTime(view)) {
      const step = waitStep(view, () => current, [...priorEvents, ...events], context, servicing);
      const serviced = applyStep(plan, current, step);
      assertStepAccepted(step, serviced, context);
      if (step.kind === "observe") {
        assert.notDeepEqual(
          serviced.snapshot,
          current,
          `${context}: the observation must make progress`,
        );
      }
      events.push(...serviced.events);
      current = serviced.snapshot;
      continue;
    }
    const operation = run(plan, current, {}, { instructionBudget: instructionGuard });
    events.push(...operation.events);
    current = operation.snapshot;
    if (current.status !== "waiting") return { snapshot: current, events };
  }
}

/** `runServicingDelays` through a session, deciding from its view; returns the events. */
function runSessionServicingDelays(
  session: RuntimeSession,
  instructionGuard: number,
  context: string,
  servicing: Servicing,
): readonly InterpreterEvent[] {
  const events: InterpreterEvent[] = [];
  for (let observations = 0; ; observations += 1) {
    assert.ok(observations <= instructionGuard, `${context}: session servicing exceeded guard`);
    const view = session.view();
    if (awaitsTime(view)) {
      const step = waitStep(view, () => session.exportSnapshot(), events, context, servicing);
      const serviced = applySessionStep(session, step);
      assertStepAccepted(step, serviced, context);
      events.push(...serviced.events);
      continue;
    }
    events.push(...session.run({ instructionBudget: instructionGuard }).events);
    if (session.view().status !== "waiting") return events;
  }
}

function applyStep(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  step: HostStep,
): Operation & { readonly snapshot: RuntimeSnapshot } {
  switch (step.kind) {
    case "execute":
      return executeInstruction(plan, snapshot);
    case "observe":
      return observeTime(plan, snapshot, step.nowMs, step.reports);
    case "press":
      return pressPermanentButton(plan, snapshot, step.buttonId);
    case "load":
      return reportMediaLoad(plan, snapshot, step.mediaId, {
        kind: "loaded",
        durationMs: step.durationMs,
      });
  }
}

function applySessionStep(session: RuntimeSession, step: HostStep): Operation {
  switch (step.kind) {
    case "execute":
      return session.executeInstruction();
    case "observe":
      return session.observeTime(step.nowMs, step.reports);
    case "press":
      return session.pressPermanentButton(step.buttonId);
    case "load":
      return session.reportMediaLoad(step.mediaId, { kind: "loaded", durationMs: step.durationMs });
  }
}

/** The parts of an operation result that a session result also has. */
function sameShape(operation: Operation): Operation {
  return "outcome" in operation
    ? {
        events: operation.events,
        instructionsExecuted: operation.instructionsExecuted,
        outcome: operation.outcome,
      }
    : { events: operation.events, instructionsExecuted: operation.instructionsExecuted };
}

function assertStepAccepted(step: HostStep, operation: Operation, context: string): void {
  if (step.kind === "execute")
    assert.equal(
      operation.instructionsExecuted,
      1,
      `${context} must execute exactly one instruction`,
    );
  const outcome =
    typeof operation.outcome === "object" &&
    operation.outcome !== null &&
    "kind" in operation.outcome
      ? operation.outcome.kind
      : undefined;
  if (step.kind === "observe")
    assert.equal(outcome, "observed", `${context}: delay observation must succeed`);
  if (step.kind === "press")
    assert.equal(outcome, "pressed", `${context}: the simulated click must be accepted`);
  if (step.kind === "load")
    assert.equal(outcome, "accepted", `${context}: media load must be accepted`);
}

/** The session view of a snapshot, which the simulated Player decides from. */
function viewOf(snapshot: RuntimeSnapshot): RuntimeSessionView {
  return {
    status: snapshot.status,
    failure: snapshot.failure,
    nextInstruction: snapshot.nextInstruction,
    currentSessionTimeMs: snapshot.currentSessionTimeMs,
    observedSessionTimeMs: snapshot.observedSessionTimeMs,
    runnable: executionRunnable(snapshot),
    foregroundAction: snapshot.foregroundAction,
    backgroundActions: snapshot.backgroundActions,
    suspendedAction: interruptFrame(snapshot)?.timerInterruption?.suspendedAction ?? null,
    cameraView: snapshot.cameraView,
    queuedBlocks: snapshot.pendingTimerHandlers.length,
    debugMode: snapshot.debugMode,
  };
}

/**
 * Waiting with nothing runnable: only a time observation or a click can make progress. A queued block held behind
 * pacing or a running block is not runnable.
 */
function awaitsTime(view: RuntimeSessionView): boolean {
  return view.status === "waiting" && !view.runnable;
}

/** The simulated Player's click when `press` gives one, else a media load or a time observation. */
function waitStep(
  view: RuntimeSessionView,
  snapshot: () => RuntimeSnapshot,
  events: readonly InterpreterEvent[],
  context: string,
  servicing: Servicing,
): HostStep {
  const buttonId = servicing.press?.(snapshot(), events) ?? null;
  if (buttonId !== null) return { kind: "press", buttonId };
  return dueDelayStep(view, context, servicing.mediaDurationMs);
}

function dueDelayStep(
  view: RuntimeSessionView,
  context: string,
  mediaDurationMs: number | undefined,
): HostStep {
  const unloaded = view.backgroundActions.find(
    (action) => action.kind === "media" && !action.media.loaded,
  );
  if (unloaded?.kind === "media") {
    assert.ok(mediaDurationMs !== undefined, `${context}: media scenarios need mediaDurationMs`);
    return { kind: "load", mediaId: unloaded.media.mediaId, durationMs: mediaDurationMs };
  }
  const deadlines: number[] = [];
  const playing = view.backgroundActions.flatMap((action) =>
    action.kind === "media" && action.media.state === "running" ? [action.media] : [],
  );
  if (playing.length > 0) {
    deadlines.push(view.observedSessionTimeMs + MEDIA_OBSERVATION_STEP_MS);
  }
  for (const action of [view.foregroundAction, ...view.backgroundActions, view.suspendedAction]) {
    if (action?.kind === "delay" || action?.kind === "chatPacingGate") {
      deadlines.push(action.deadlineMs);
    }
    if (action?.kind === "timer" && action.timer.deadlineMs !== null) {
      deadlines.push(action.timer.deadlineMs);
    }
  }
  const button = view.foregroundAction;
  const buttonDeadlineMs = button?.kind === "interaction" ? interactionDeadlineMs(button) : null;
  if (buttonDeadlineMs !== null) deadlines.push(buttonDeadlineMs);
  assert.ok(
    deadlines.length > 0,
    `${context}: only delays, pacing, timers, media, and button timeouts can be serviced`,
  );
  const nowMs = Math.min(...deadlines);
  // The simulated Player plays at normal speed from each media's latest sample.
  const reports = playing.flatMap((media) => {
    const last = media.points.at(-1)!;
    return nowMs > last.atMs
      ? [
          {
            mediaId: media.mediaId,
            segment: media.segment,
            progressMs: last.progressMs + (nowMs - last.atMs),
          },
        ]
      : [];
  });
  return { kind: "observe", nowMs, reports };
}

/** Checkpoint JSON equality, reporting where the bytes first differ rather than both complete checkpoints. */
function assertSameCheckpoint(actual: string, expected: string, context: string): void {
  if (actual === expected) return;
  let index = 0;
  while (index < actual.length && actual[index] === expected[index]) index += 1;
  const around = (text: string) => text.slice(Math.max(0, index - 120), index + 120);
  assert.fail(
    `${context} differs at byte ${index}:\n  actual:   ${around(actual)}\n  expected: ${around(expected)}`,
  );
}

function assertMonotonicEventSequences(events: readonly InterpreterEvent[], context: string): void {
  for (let index = 1; index < events.length; index += 1) {
    assert.ok(
      events[index]!.sequence > events[index - 1]!.sequence,
      `${context}: event sequence must increase at index ${index}`,
    );
  }
}

function describeScenario(source: string): string {
  const firstLine = source.split(/\r?\n/u).find((line) => line.trim().length > 0);
  return firstLine === undefined
    ? "runtime resume equivalence"
    : `runtime resume equivalence for ${JSON.stringify(firstLine.trim())}`;
}

function formatValidationErrors(errors: readonly unknown[]): string {
  return errors.length === 0 ? "none" : JSON.stringify(errors);
}

/** The function and block frames of the call stack, without file calls. */
export function functionFrames(
  snapshot: Pick<RuntimeSnapshot, "callFrames">,
): RuntimeCallFrameSnapshot[] {
  return snapshot.callFrames.filter(
    (frame): frame is RuntimeCallFrameSnapshot => frame.kind === "function",
  );
}
