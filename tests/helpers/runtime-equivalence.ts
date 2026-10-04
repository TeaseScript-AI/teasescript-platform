import assert from "node:assert/strict";

import {
  compileProject,
  compileSource,
  createCheckpoint,
  deserializeCheckpoint,
  executeInstruction,
  interactionDeadlineMs,
  observeTime,
  reportMediaLoad,
  run,
  serializeCheckpoint,
  validateRuntimeSnapshot,
  validateInstructionPlan,
  type InstructionPlan,
  type InterpreterEvent,
  type ProjectImageFile,
  type ProjectSourceFile,
  type RuntimeCallFrameSnapshot,
  type RuntimeSnapshot,
} from "../../src/index.js";
import { createImmediatePacingRuntimeSnapshot } from "./immediate-pacing-runtime.js";
import { timerHandlerDispatchable } from "../../src/runtime/operations/timer-lifecycle.js";

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
}

/** Spacing of the simulated Player's media progress observations. */
const MEDIA_OBSERVATION_STEP_MS = 250;

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
  const initial = createImmediatePacingRuntimeSnapshot(plan, { seed });
  const initialSnapshotValidation = validateRuntimeSnapshot(initial, plan);
  assert.equal(
    initialSnapshotValidation.valid,
    true,
    `${scenario}: fresh snapshot must validate: ${initialSnapshotValidation.errors.join("; ")}`,
  );

  const mediaDurationMs = options.mediaDurationMs;
  const uninterrupted = runServicingDelays(
    plan,
    initial,
    instructionGuard,
    scenario,
    mediaDurationMs,
  );
  assert.equal(
    uninterrupted.snapshot.status,
    "halted",
    `${scenario}: uninterrupted execution must halt within ${instructionGuard} instructions`,
  );
  assertMonotonicEventSequences(uninterrupted.events, `${scenario}: uninterrupted execution`);

  // The stepping pass starts from its own fresh snapshot, so a baseline that mutated its input cannot hide boundaries.
  const steppingInitial = createImmediatePacingRuntimeSnapshot(plan, { seed });
  assert.deepEqual(
    initial,
    steppingInitial,
    `${scenario}: uninterrupted execution must not change its initial snapshot`,
  );

  const boundaries: RuntimeSnapshot[] = [];
  const accumulatedEvents: InterpreterEvent[] = [];
  let boundarySnapshot = steppingInitial;
  let boundary = 0;

  while (boundarySnapshot.status !== "halted" && boundarySnapshot.status !== "failed") {
    assert.ok(
      boundary < instructionGuard,
      `${scenario}: instruction-boundary execution exceeded guard ${instructionGuard}`,
    );

    let operation: {
      readonly snapshot: RuntimeSnapshot;
      readonly events: readonly InterpreterEvent[];
    };
    if (awaitsTime(boundarySnapshot)) {
      operation = observeDueDelay(
        plan,
        boundarySnapshot,
        `${scenario}: boundary ${boundary + 1}`,
        mediaDurationMs,
      );
    } else {
      const executed = executeInstruction(plan, boundarySnapshot);
      assert.equal(
        executed.instructionsExecuted,
        1,
        `${scenario}: boundary ${boundary + 1} must execute exactly one instruction`,
      );
      operation = executed;
    }
    boundarySnapshot = operation.snapshot;
    accumulatedEvents.push(...operation.events);
    boundary += 1;

    const context = `${scenario}: instruction boundary ${boundary} (next ${boundarySnapshot.nextInstruction})`;
    const checkpointJson = serializeCheckpoint(createCheckpoint(plan, boundarySnapshot));
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
      mediaDurationMs,
    );
    assert.equal(
      resumed.snapshot.status,
      "halted",
      `${context}: resumed execution must halt within ${instructionGuard} instructions`,
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
 * preserved: nothing settles without an observation, and no button is clicked.
 */
function runServicingDelays(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  instructionGuard: number,
  context: string,
  mediaDurationMs: number | undefined,
): { readonly snapshot: RuntimeSnapshot; readonly events: readonly InterpreterEvent[] } {
  const events: InterpreterEvent[] = [];
  let current = snapshot;
  for (let observations = 0; ; observations += 1) {
    assert.ok(observations <= instructionGuard, `${context}: delay servicing exceeded guard`);
    if (awaitsTime(current)) {
      const observed = observeDueDelay(plan, current, context, mediaDurationMs);
      events.push(...observed.events);
      current = observed.snapshot;
      continue;
    }
    const operation = run(plan, current, {}, { instructionBudget: instructionGuard });
    events.push(...operation.events);
    current = operation.snapshot;
    if (current.status !== "waiting") return { snapshot: current, events };
  }
}

/**
 * Waiting with nothing runnable: only a time observation can make progress. A queued expiry block held behind pacing
 * or a running block is not runnable.
 */
function awaitsTime(snapshot: RuntimeSnapshot): boolean {
  return snapshot.status === "waiting" && !timerHandlerDispatchable(snapshot);
}

function observeDueDelay(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  context: string,
  mediaDurationMs: number | undefined,
): { readonly snapshot: RuntimeSnapshot; readonly events: readonly InterpreterEvent[] } {
  const unloaded = snapshot.backgroundActions.find(
    (action) => action.kind === "media" && !action.media.loaded,
  );
  if (unloaded?.kind === "media") {
    assert.ok(mediaDurationMs !== undefined, `${context}: media scenarios need mediaDurationMs`);
    const reported = reportMediaLoad(plan, snapshot, unloaded.media.mediaId, {
      kind: "loaded",
      durationMs: mediaDurationMs,
    });
    assert.equal(reported.outcome.kind, "accepted", `${context}: media load must be accepted`);
    return reported;
  }
  const deadlines: number[] = [];
  const playing = snapshot.backgroundActions.flatMap((action) =>
    action.kind === "media" && action.media.state === "running" ? [action.media] : [],
  );
  if (playing.length > 0) {
    deadlines.push(snapshot.observedSessionTimeMs + MEDIA_OBSERVATION_STEP_MS);
  }
  for (const action of [
    snapshot.foregroundAction,
    ...snapshot.backgroundActions,
    ...functionFrames(snapshot).map((frame) => frame.timerInterruption?.suspendedAction ?? null),
  ]) {
    if (action?.kind === "delay" || action?.kind === "chatPacingGate") {
      deadlines.push(action.deadlineMs);
    }
    if (action?.kind === "timer" && action.timer.deadlineMs !== null) {
      deadlines.push(action.timer.deadlineMs);
    }
  }
  const button = snapshot.foregroundAction;
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
  const observed = observeTime(plan, snapshot, nowMs, reports);
  assert.equal(observed.outcome.kind, "observed", `${context}: delay observation must succeed`);
  assert.notDeepEqual(
    observed.snapshot,
    snapshot,
    `${context}: the observation must make progress`,
  );
  return observed;
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
