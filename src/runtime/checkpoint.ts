import {
  captureInstructionPlan,
  validateCapturedInstructionPlan,
  type InstructionPlan,
} from "../instructions.js";
import {
  EXTERNAL_DATA_DEPTH_MESSAGE,
  EXTERNAL_DATA_WORK_MESSAGE,
  captureExternalData,
  type ExternalDataFailureKind,
} from "../external-data-limits.js";
import {
  captureRuntimeSnapshot,
  cloneCapturedRuntimeSnapshot,
  RUNTIME_SNAPSHOT_FORMAT,
  RUNTIME_SNAPSHOT_VERSION,
  validateCapturedRuntimeSnapshot,
  type RuntimeSnapshot,
} from "./state.js";

export const CHECKPOINT_FORMAT = "teasescript-checkpoint";
export const CHECKPOINT_VERSION = 6;

export interface RuntimeCheckpoint {
  readonly format: typeof CHECKPOINT_FORMAT;
  readonly version: typeof CHECKPOINT_VERSION;
  readonly plan: InstructionPlan;
  readonly snapshot: RuntimeSnapshot;
}

export interface CheckpointErrorInfo {
  readonly code: "TSK001" | "TSK002" | "TSK003";
  readonly message: string;
  readonly path: string;
}

export class CheckpointError extends Error {
  public constructor(readonly info: CheckpointErrorInfo) {
    super(info.message);
    this.name = "CheckpointError";
  }
}

export function createCheckpoint(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): RuntimeCheckpoint {
  const capturedPlan = capturePlan(plan, "$.plan");
  const capturedSnapshot = captureSnapshot(snapshot, capturedPlan, "$.snapshot");
  return Object.freeze({
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    plan: clonePlan(capturedPlan),
    snapshot: cloneCapturedRuntimeSnapshot(capturedSnapshot),
  });
}

export function serializeCheckpoint(checkpoint: RuntimeCheckpoint): string {
  const restored = restoreCheckpoint(checkpoint);
  return JSON.stringify(restored);
}

export function restoreCheckpoint(value: unknown): RuntimeCheckpoint {
  const capture = captureExternalData(value);
  if (!capture.ok) {
    throw checkpointError(
      "TSK002",
      checkpointExternalDataFailureMessage(capture.failure.kind),
      capture.failure.path.startsWith("$.snapshot")
        ? "$.snapshot"
        : capture.failure.path,
    );
  }
  const stable = capture.value;
  if (!isPlainRecord(stable)) {
    throw checkpointError("TSK002", "Checkpoint must be a JSON object.", "$.");
  }
  if (stable.format !== CHECKPOINT_FORMAT) {
    throw checkpointError("TSK001", "Unsupported checkpoint format.", "$.format");
  }
  if (stable.version !== CHECKPOINT_VERSION) {
    throw checkpointError("TSK001", "Unsupported checkpoint version.", "$.version");
  }

  const plan = assertCapturedPlan(stable.plan, "$.plan");
  const snapshot = assertCapturedSnapshot(stable.snapshot, plan, "$.snapshot");
  return Object.freeze({
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    plan: clonePlan(plan),
    snapshot: cloneCapturedRuntimeSnapshot(snapshot),
  });
}

function clonePlan(plan: InstructionPlan): InstructionPlan {
  return deepFreeze(JSON.parse(JSON.stringify(plan)) as InstructionPlan);
}

export function deserializeCheckpoint(json: string): RuntimeCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw checkpointError("TSK003", `Checkpoint JSON is invalid: ${message}`, "$.");
  }
  return restoreCheckpoint(parsed);
}

function capturePlan(value: unknown, path: string): InstructionPlan {
  const captured = captureInstructionPlan(value);
  if (!captured.validation.valid || captured.plan === null) {
    const first = captured.validation.errors[0];
    throw checkpointError(
      first?.code === "TSC001" ? "TSK001" : "TSK002",
      first?.message ?? "Instruction plan is malformed.",
      `${path}${first?.path.slice(1) ?? ""}`,
    );
  }
  return captured.plan;
}

function captureSnapshot(
  value: unknown,
  plan: InstructionPlan,
  path: string,
): RuntimeSnapshot {
  const captured = captureRuntimeSnapshot(value, plan);
  if (!captured.validation.valid || captured.snapshot === null) {
    const message = captured.validation.errors[0] ?? "Runtime snapshot is malformed.";
    const unsupported = message.includes("Unsupported runtime-snapshot");
    throw checkpointError(unsupported ? "TSK001" : "TSK002", message, path);
  }
  return captured.snapshot;
}

function assertCapturedPlan(value: unknown, path: string): InstructionPlan {
  const validation = validateCapturedInstructionPlan(value);
  if (!validation.valid) {
    const first = validation.errors[0];
    throw checkpointError(
      first?.code === "TSC001" ? "TSK001" : "TSK002",
      first?.message ?? "Instruction plan is malformed.",
      `${path}${first?.path.slice(1) ?? ""}`,
    );
  }
  return value as InstructionPlan;
}

function assertCapturedSnapshot(
  value: unknown,
  plan: InstructionPlan,
  path: string,
): RuntimeSnapshot {
  const validation = validateCapturedRuntimeSnapshot(value, plan);
  if (!validation.valid) {
    const message = validation.errors[0] ?? "Runtime snapshot is malformed.";
    const unsupported =
      message.includes("Unsupported runtime-snapshot") ||
      (isPlainRecord(value) &&
        (value.format !== RUNTIME_SNAPSHOT_FORMAT ||
          value.version !== RUNTIME_SNAPSHOT_VERSION));
    throw checkpointError(unsupported ? "TSK001" : "TSK002", message, path);
  }
  return value as RuntimeSnapshot;
}

function checkpointExternalDataFailureMessage(
  kind: ExternalDataFailureKind,
): string {
  switch (kind) {
    case "depth":
      return EXTERNAL_DATA_DEPTH_MESSAGE;
    case "work":
      return EXTERNAL_DATA_WORK_MESSAGE;
    case "nonFiniteNumber":
      return "Checkpoint contains a non-finite number.";
    case "nonJsonSafeValue":
      return "Checkpoint contains a non-JSON-safe value.";
    case "cycle":
      return "Checkpoint contains a cycle.";
    case "nonPlainObject":
      return "Checkpoint contains a non-plain object.";
  }
}

function checkpointError(
  code: CheckpointErrorInfo["code"],
  message: string,
  path: string,
): CheckpointError {
  return new CheckpointError(Object.freeze({ code, message, path }));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
