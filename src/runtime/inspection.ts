import { captureOrReuseInstructionPlan } from "../plan/capture.js";
import type { InstructionPlan } from "../plan/model.js";
import { planLocationToSourceSpan } from "../plan/source-location.js";
import type { SourceSpan } from "../source.js";
import type {
  RuntimeActionSettlementSnapshot,
  RuntimePendingActionSnapshot,
  RuntimePreparedSayOutputSnapshot,
} from "./actions/model.js";
import {
  captureRuntimeSnapshotWithValidatedPlan,
  type ChatPacingSettings,
  type RuntimeSnapshot,
  type RuntimeStatus,
} from "./state.js";

export interface RuntimeInspectionError {
  readonly kind: "plan" | "snapshot";
  readonly message: string;
}

export interface RuntimeActionInspection {
  readonly action: RuntimePendingActionSnapshot;
  readonly sourceSpan: SourceSpan | null;
}

export interface RuntimeSettlementInspection {
  readonly settlement: RuntimeActionSettlementSnapshot;
  readonly sourceSpan: SourceSpan | null;
}

export interface RuntimePreparedSayInspection {
  readonly output: RuntimePreparedSayOutputSnapshot;
  readonly sourceSpan: SourceSpan | null;
}

export interface RuntimeStateInspection {
  readonly valid: true;
  readonly status: RuntimeStatus;
  readonly nextInstruction: number;
  readonly nextInstructionSourceSpan: SourceSpan | null;
  readonly currentSessionTimeMs: number;
  readonly chatPacingSettings: ChatPacingSettings;
  readonly foregroundAction: RuntimeActionInspection | null;
  readonly backgroundActions: readonly RuntimeActionInspection[];
  readonly preparedSayOutput: RuntimePreparedSayInspection | null;
  readonly lastSettlement: RuntimeSettlementInspection | null;
}

export interface InvalidRuntimeStateInspection {
  readonly valid: false;
  readonly errors: readonly RuntimeInspectionError[];
}

export type RuntimeInspectionResult = RuntimeStateInspection | InvalidRuntimeStateInspection;

/**
 * Captures external plan/snapshot data and exposes a detached read-only debugger
 * view. It never settles, resumes, normalizes, or executes the runtime.
 */
export function inspectRuntimeState(
  planValue: unknown,
  snapshotValue: unknown,
): RuntimeInspectionResult {
  const capturedPlan = captureOrReuseInstructionPlan(planValue);
  if (!capturedPlan.validation.valid || capturedPlan.plan === null) {
    return invalid(
      "plan",
      capturedPlan.validation.errors.map((error) => error.message),
    );
  }

  const capturedSnapshot = captureRuntimeSnapshotWithValidatedPlan(
    snapshotValue,
    capturedPlan.plan,
  );
  if (!capturedSnapshot.validation.valid || capturedSnapshot.snapshot === null) {
    return invalid("snapshot", capturedSnapshot.validation.errors);
  }

  return buildInspection(capturedPlan.plan, capturedSnapshot.snapshot);
}

function invalid(
  kind: RuntimeInspectionError["kind"],
  messages: readonly string[],
): InvalidRuntimeStateInspection {
  return Object.freeze({
    valid: false,
    errors: Object.freeze(messages.map((message) => Object.freeze({ kind, message }))),
  });
}

function buildInspection(plan: InstructionPlan, snapshot: RuntimeSnapshot): RuntimeStateInspection {
  const inspection: RuntimeStateInspection = {
    valid: true,
    status: snapshot.status,
    nextInstruction: snapshot.nextInstruction,
    nextInstructionSourceSpan: instructionSpan(plan, snapshot.nextInstruction),
    currentSessionTimeMs: snapshot.currentSessionTimeMs,
    chatPacingSettings: detached(snapshot.chatPacingSettings),
    foregroundAction:
      snapshot.foregroundAction === null ? null : actionInspection(plan, snapshot.foregroundAction),
    backgroundActions: Object.freeze(
      snapshot.backgroundActions.map((action) => actionInspection(plan, action)),
    ),
    preparedSayOutput:
      snapshot.preparedSayOutput === null
        ? null
        : preparedSayInspection(plan, snapshot.preparedSayOutput),
    lastSettlement:
      snapshot.lastSettlement === null ? null : settlementInspection(plan, snapshot.lastSettlement),
  };
  return deepFreeze(inspection);
}

function actionInspection(
  plan: InstructionPlan,
  action: RuntimePendingActionSnapshot,
): RuntimeActionInspection {
  return deepFreeze({
    action: detached(action),
    sourceSpan: instructionSpan(plan, action.owningInstruction),
  });
}

function settlementInspection(
  plan: InstructionPlan,
  settlement: RuntimeActionSettlementSnapshot,
): RuntimeSettlementInspection {
  return deepFreeze({
    settlement: detached(settlement),
    sourceSpan: instructionSpan(plan, settlement.owningInstruction),
  });
}

function preparedSayInspection(
  plan: InstructionPlan,
  output: RuntimePreparedSayOutputSnapshot,
): RuntimePreparedSayInspection {
  return deepFreeze({
    output: detached(output),
    sourceSpan: instructionSpan(plan, output.owningInstruction),
  });
}

function instructionSpan(plan: InstructionPlan, index: number): SourceSpan | null {
  const instruction = plan.instructions[index];
  return instruction === undefined ? null : planLocationToSourceSpan(instruction.span);
}

/**
 * Inspection data comes from the captured snapshot, which is already detached from the caller's data, so it is
 * reused rather than copied again.
 */
function detached<T>(value: T): T {
  return value;
}

/** Freezes a graph iteratively, so deeply nested runtime values cannot exhaust the native stack. */
function deepFreeze<T>(value: T): T {
  const work: unknown[] = [value];
  while (work.length > 0) {
    const current = work.pop();
    if (current === null || typeof current !== "object" || Object.isFrozen(current)) continue;
    Object.freeze(current);
    // EVIDENCE: the object guard narrows this value to a non-null object before enumeration.
    for (const child of Object.values(current as Record<string, unknown>)) work.push(child);
  }
  return value;
}
