import {
  type InstructionPlan,
} from "../plan/model.js";
import { captureInstructionPlan } from "../plan/capture.js";
import {
  captureRuntimeSnapshot,
  cloneCapturedRuntimeSnapshot,
  type RuntimeSnapshot,
} from "./state.js";

export const CHECKPOINT_FORMAT = "teasescript-checkpoint";
export const CHECKPOINT_VERSION = 19;

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
  const envelope = captureCheckpointEnvelope(value);
  if (envelope.format !== CHECKPOINT_FORMAT) {
    throw checkpointError("TSK001", "Unsupported checkpoint format.", "$.format");
  }
  if (envelope.version !== CHECKPOINT_VERSION) {
    throw checkpointError("TSK001", "Unsupported checkpoint version.", "$.version");
  }

  const plan = capturePlan(envelope.plan, "$.plan");
  const snapshot = captureSnapshot(envelope.snapshot, plan, "$.snapshot");
  return Object.freeze({
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    plan: clonePlan(plan),
    snapshot: cloneCapturedRuntimeSnapshot(snapshot),
  });
}

interface CheckpointEnvelope {
  readonly format: unknown;
  readonly version: unknown;
  readonly plan: unknown;
  readonly snapshot: unknown;
}

const CHECKPOINT_KEYS = ["format", "version", "plan", "snapshot"] as const;

function captureCheckpointEnvelope(value: unknown): CheckpointEnvelope {
  if (typeof value !== "object" || value === null) {
    throw checkpointError("TSK002", "Checkpoint must be a JSON object.", "$.");
  }

  let array: boolean;
  let prototype: object | null;
  let keys: readonly (string | symbol)[];
  try {
    array = Array.isArray(value);
    prototype = Reflect.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
  } catch {
    throw checkpointError("TSK002", "Checkpoint contains a non-JSON-safe value.", "$.");
  }
  if (array) {
    throw checkpointError("TSK002", "Checkpoint must be a JSON object.", "$.");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw checkpointError("TSK002", "Checkpoint must be a JSON object.", "$.");
  }
  if (
    keys.length !== CHECKPOINT_KEYS.length ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !CHECKPOINT_KEYS.includes(key as typeof CHECKPOINT_KEYS[number]),
    )
  ) {
    throw checkpointError(
      "TSK002",
      "Checkpoint contains unsupported fields or omits required fields.",
      "$.",
    );
  }

  const captured: Record<string, unknown> = {};
  for (const key of CHECKPOINT_KEYS) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    } catch {
      throw checkpointError(
        "TSK002",
        "Checkpoint contains a non-JSON-safe value.",
        `$.${key}`,
      );
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw checkpointError(
        "TSK002",
        "Checkpoint contains a non-JSON-safe value.",
        `$.${key}`,
      );
    }
    captured[key] = descriptor.value;
  }
  return captured as unknown as CheckpointEnvelope;
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
      checkpointComponentCaptureMessage(
        first?.message ?? "Instruction plan is malformed.",
      ),
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
    const message = checkpointComponentCaptureMessage(
      captured.validation.errors[0] ?? "Runtime snapshot is malformed.",
    );
    const unsupported = message.includes("Unsupported runtime-snapshot");
    throw checkpointError(unsupported ? "TSK001" : "TSK002", message, path);
  }
  return captured.snapshot;
}

function checkpointComponentCaptureMessage(message: string): string {
  if (
    message === "Plan contains a non-finite number." ||
    message === "Runtime snapshot contains a non-finite number."
  ) {
    return "Checkpoint contains a non-finite number.";
  }
  if (
    message === "Plan contains a non-JSON-safe value." ||
    message === "Runtime snapshot contains a non-JSON-safe value."
  ) {
    return "Checkpoint contains a non-JSON-safe value.";
  }
  if (
    message === "Plan contains a cycle." ||
    message === "Runtime snapshot contains a cycle."
  ) {
    return "Checkpoint contains a cycle.";
  }
  if (
    message === "Plan contains a non-plain object." ||
    message === "Runtime snapshot contains a non-plain object."
  ) {
    return "Checkpoint contains a non-plain object.";
  }
  return message;
}

function checkpointError(
  code: CheckpointErrorInfo["code"],
  message: string,
  path: string,
): CheckpointError {
  return new CheckpointError(Object.freeze({ code, message, path }));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
