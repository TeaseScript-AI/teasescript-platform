import {
  validateInstructionPlan,
  type InstructionPlan,
} from "../instructions.js";
import {
  cloneRuntimeSnapshot,
  RUNTIME_SNAPSHOT_FORMAT,
  RUNTIME_SNAPSHOT_VERSION,
  validateRuntimeSnapshot,
  type RuntimeSnapshot,
} from "./state.js";

export const CHECKPOINT_FORMAT = "teasescript-checkpoint";
export const CHECKPOINT_VERSION = 2;

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
  assertPlan(plan, "$.plan");
  assertSnapshot(snapshot, plan, "$.snapshot");
  return Object.freeze({
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    plan: clonePlan(plan),
    snapshot: cloneRuntimeSnapshot(snapshot),
  });
}

export function serializeCheckpoint(checkpoint: RuntimeCheckpoint): string {
  const restored = restoreCheckpoint(checkpoint);
  return JSON.stringify(restored);
}

export function restoreCheckpoint(value: unknown): RuntimeCheckpoint {
  if (!isPlainRecord(value)) {
    throw checkpointError("TSK002", "Checkpoint must be a JSON object.", "$.");
  }
  if (value.format !== CHECKPOINT_FORMAT) {
    throw checkpointError("TSK001", "Unsupported checkpoint format.", "$.format");
  }
  if (value.version !== CHECKPOINT_VERSION) {
    throw checkpointError("TSK001", "Unsupported checkpoint version.", "$.version");
  }
  assertPlan(value.plan, "$.plan");
  const plan = value.plan as InstructionPlan;
  assertSnapshot(value.snapshot, plan, "$.snapshot");
  return Object.freeze({
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    plan: clonePlan(value.plan as InstructionPlan),
    snapshot: cloneRuntimeSnapshot(value.snapshot as RuntimeSnapshot),
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

function assertPlan(value: unknown, path: string): asserts value is InstructionPlan {
  const validation = validateInstructionPlan(value);
  if (!validation.valid) {
    const first = validation.errors[0];
    throw checkpointError(
      first?.code === "TSC001" ? "TSK001" : "TSK002",
      first?.message ?? "Instruction plan is malformed.",
      `${path}${first?.path.slice(1) ?? ""}`,
    );
  }
}

function assertSnapshot(
  value: unknown,
  plan: InstructionPlan,
  path: string,
): asserts value is RuntimeSnapshot {
  const validation = validateRuntimeSnapshot(value, plan);
  if (!validation.valid) {
    const message = validation.errors[0] ?? "Runtime snapshot is malformed.";
    const unsupported =
      message.includes("Unsupported runtime-snapshot") ||
      (isPlainRecord(value) &&
        (value.format !== RUNTIME_SNAPSHOT_FORMAT ||
          value.version !== RUNTIME_SNAPSHOT_VERSION));
    throw checkpointError(unsupported ? "TSK001" : "TSK002", message, path);
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
