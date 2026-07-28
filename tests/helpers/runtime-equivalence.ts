import assert from "node:assert/strict";

import { compileSource } from "../../src/compiler.js";
import { validateInstructionPlan } from "../../src/plan/validation.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  serializeCheckpoint,
} from "../../src/runtime/checkpoint.js";
import {
  executeInstruction,
  run,
} from "../../src/runtime/engine.js";
import type { InterpreterEvent } from "../../src/runtime/events.js";
import {
  createFreshRuntimeSnapshot,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "../../src/runtime/state.js";

const DEFAULT_EQUIVALENCE_SEED = 0x1234_5678;
const DEFAULT_INSTRUCTION_GUARD = 2_000;

export interface RuntimeResumeEquivalenceOptions {
  readonly scenarioName?: string;
  readonly seed?: number;
  readonly instructionGuard?: number;
}

export interface RuntimeResumeEquivalenceResult {
  readonly boundaries: readonly RuntimeSnapshot[];
  readonly events: readonly InterpreterEvent[];
  readonly finalSnapshot: RuntimeSnapshot;
}

export function assertRuntimeResumeEquivalent(
  source: string,
  options: RuntimeResumeEquivalenceOptions = {},
): RuntimeResumeEquivalenceResult {
  const scenario = options.scenarioName ?? describeScenario(source);
  const instructionGuard = options.instructionGuard ?? DEFAULT_INSTRUCTION_GUARD;
  assert.ok(
    Number.isInteger(instructionGuard) && instructionGuard > 0,
    `${scenario}: instructionGuard must be a positive integer`,
  );

  const compiled = compileSource(source);
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

  const initial = createFreshRuntimeSnapshot(plan, {
    seed: options.seed ?? DEFAULT_EQUIVALENCE_SEED,
  });
  const initialSnapshotValidation = validateRuntimeSnapshot(initial, plan);
  assert.equal(
    initialSnapshotValidation.valid,
    true,
    `${scenario}: fresh snapshot must validate: ${initialSnapshotValidation.errors.join("; ")}`,
  );

  const uninterrupted = run(plan, initial, {}, { instructionBudget: instructionGuard });
  assert.equal(
    uninterrupted.snapshot.status,
    "halted",
    `${scenario}: uninterrupted execution must halt within ${instructionGuard} instructions`,
  );
  assertMonotonicEventSequences(uninterrupted.events, `${scenario}: uninterrupted execution`);

  const boundaries: RuntimeSnapshot[] = [];
  const accumulatedEvents: InterpreterEvent[] = [];
  let boundarySnapshot = initial;
  let boundary = 0;

  while (
    boundarySnapshot.status !== "halted" &&
    boundarySnapshot.status !== "failed"
  ) {
    assert.ok(
      boundary < instructionGuard,
      `${scenario}: instruction-boundary execution exceeded guard ${instructionGuard}`,
    );

    const operation = executeInstruction(plan, boundarySnapshot);
    assert.equal(
      operation.instructionsExecuted,
      1,
      `${scenario}: boundary ${boundary + 1} must execute exactly one instruction`,
    );
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
    const restoredSnapshotValidation = validateRuntimeSnapshot(
      restored.snapshot,
      restored.plan,
    );
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

    const resumed = run(
      restored.plan,
      restored.snapshot,
      {},
      { instructionBudget: instructionGuard },
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

  return Object.freeze({
    boundaries: Object.freeze([...boundaries]),
    events: uninterrupted.events,
    finalSnapshot: uninterrupted.snapshot,
  });
}

function assertMonotonicEventSequences(
  events: readonly InterpreterEvent[],
  context: string,
): void {
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
