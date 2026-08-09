import type { InstructionPlan } from "../../plan/model.js";
import { captureInstructionPlan } from "../../plan/capture.js";
import { createSourceSpan, type SourceSpan } from "../../source.js";
import { RuntimeFault } from "../errors.js";
import type { InterpreterEvent } from "../events.js";
import { cloneSerializableValue, type SerializableRuntimeValue } from "../serializable-values.js";
import {
  captureRuntimeSnapshot,
  type RuntimeSnapshot,
  type RuntimeTemporarySnapshot,
} from "../state.js";
import type { RuntimeActionSettlementSnapshot } from "../actions/model.js";
import type { PendingActionOperationResult, RuntimeOperationResult } from "./model.js";

export class RuntimeDataError extends Error {
  public constructor(
    readonly code: "TSR100" | "TSR101",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeDataError";
  }

  public toInfo(): Readonly<{ code: string; message: string }> {
    return Object.freeze({ code: this.code, message: this.message });
  }
}

export interface CapturedExecutableData {
  readonly plan: InstructionPlan;
  readonly snapshot: RuntimeSnapshot;
}

export function setTemporary(
  temporaries: RuntimeTemporarySnapshot[],
  temporaryId: number,
  value: SerializableRuntimeValue,
): void {
  const existing = temporaries.find((item) => item.id === temporaryId);
  if (existing === undefined) {
    temporaries.push({ id: temporaryId, value: cloneSerializableValue(value) });
  } else {
    existing.value = cloneSerializableValue(value);
  }
}

export function cloneSettlement(settlement: RuntimeActionSettlementSnapshot): RuntimeActionSettlementSnapshot {
  if (settlement.actionKind === "delay") return {
    actionId: settlement.actionId,
    actionKind: "delay",
    settlementKind: "completed",
    owningInstruction: settlement.owningInstruction,
    continuationInstruction: settlement.continuationInstruction,
    requestEventSequence: settlement.requestEventSequence,
    completionEventSequence: settlement.completionEventSequence,
    deadlineMs: settlement.deadlineMs,
    completedAtMs: settlement.completedAtMs,
  };
  if (settlement.actionKind === "chatPacingGate") return { ...settlement };
  return {
    actionId: settlement.actionId,
    actionKind: "interaction",
    interactionKind: settlement.interactionKind,
    settlementKind: "completed",
    owningInstruction: settlement.owningInstruction,
    continuationInstruction: settlement.continuationInstruction,
    ownerCallFrameId: settlement.ownerCallFrameId,
    destinationTemporary: settlement.destinationTemporary,
    requestEventSequence: settlement.requestEventSequence,
    transcriptEventSequence: settlement.transcriptEventSequence,
    completionEventSequence: settlement.completionEventSequence,
    result: settlement.result,
    transcriptText: settlement.transcriptText,
  };
}

export function assertCounterCanAdvance(value: number, field: string): void {
  if (value >= Number.MAX_SAFE_INTEGER) {
    throw new RuntimeDataError(
      "TSR101",
      `Runtime ${field} cannot be advanced safely.`,
    );
  }
}

export function assertEventSequenceCapacity(snapshot: RuntimeSnapshot, count: number, span?: SourceSpan): void {
  if (snapshot.nextEventSequence <= Number.MAX_SAFE_INTEGER - count) return;
  if (span !== undefined) throw new RuntimeFault("TSR051", "Runtime event sequence space is exhausted.", span);
  throw new RuntimeDataError("TSR101", "Runtime nextEventSequence cannot satisfy the pending action atomically.");
}

export function takeSequence(snapshot: RuntimeSnapshot): number {
  assertCounterCanAdvance(snapshot.nextEventSequence, "nextEventSequence");
  const sequence = snapshot.nextEventSequence;
  snapshot.nextEventSequence += 1;
  return sequence;
}

export function captureExecutableData(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): CapturedExecutableData {
  const capturedPlan = captureInstructionPlan(plan);
  if (!capturedPlan.validation.valid || capturedPlan.plan === null) {
    throw new RuntimeDataError(
      "TSR100",
      capturedPlan.validation.errors[0]?.message ?? "Malformed instruction plan.",
    );
  }
  const capturedSnapshot = captureRuntimeSnapshot(snapshot, capturedPlan.plan);
  if (!capturedSnapshot.validation.valid || capturedSnapshot.snapshot === null) {
    throw new RuntimeDataError(
      "TSR101",
      capturedSnapshot.validation.errors[0] ?? "Malformed runtime snapshot.",
    );
  }
  return Object.freeze({
    plan: capturedPlan.plan,
    snapshot: capturedSnapshot.snapshot,
  });
}

export function result(
  snapshot: RuntimeSnapshot,
  events: readonly InterpreterEvent[],
  instructionsExecuted: number,
): RuntimeOperationResult {
  return Object.freeze({
    snapshot,
    events: Object.freeze([...events]),
    instructionsExecuted,
  });
}

export function pendingResult<T>(snapshot: RuntimeSnapshot, events: readonly InterpreterEvent[], outcome: T): PendingActionOperationResult<T> {
  return Object.freeze({ ...result(snapshot, events, 0), outcome });
}

export function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function copySpan(span: SourceSpan): SourceSpan {
  return createSourceSpan(span.start, span.end);
}
