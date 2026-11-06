import { adoptParsedJson } from "../../external-data-capture.js";
import type { InstructionPlan } from "../../plan/model.js";
import { captureOrReuseInstructionPlan } from "../../plan/capture.js";
import { markValidatedImmutableInstructionPlan } from "../../plan/validated-immutable.js";
import { validateCapturedInstructionPlan } from "../../plan/validation.js";
import {
  withFrozenTemporalCaptures,
  type RuntimeSnapshotValidationFailureKind,
  type RuntimeSnapshot,
} from "./state.js";
import {
  CHECKPOINT_FORMAT,
  CHECKPOINT_VERSION,
  type CheckpointErrorInfo,
  checkpointError,
  serializeValidatedRuntimeJson,
} from "./checkpoint-json.js";
import {
  captureRuntimeSnapshotWithValidatedPlan,
  classifyCapturedRuntimeSnapshot,
} from "./snapshot-validation.js";

export {
  CHECKPOINT_FORMAT,
  CHECKPOINT_VERSION,
  CheckpointError,
  type CheckpointErrorInfo,
  serializeValidatedRuntimeJson,
  serializeValidatedRuntimeJsonWithin,
  stateTooLarge,
} from "./checkpoint-json.js";

export interface RuntimeCheckpoint {
  readonly format: typeof CHECKPOINT_FORMAT;
  readonly version: typeof CHECKPOINT_VERSION;
  readonly plan: InstructionPlan;
  readonly snapshot: RuntimeSnapshot;
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
    plan: capturedPlan,
    snapshot: capturedSnapshot,
  });
}

export function serializeCheckpoint(checkpoint: RuntimeCheckpoint): string {
  return serializeValidatedRuntimeJson(restoreCheckpoint(checkpoint));
}

export function restoreCheckpoint(value: unknown): RuntimeCheckpoint {
  const envelope = captureCheckpointEnvelope(value);
  if (envelope.format !== CHECKPOINT_FORMAT) {
    throw checkpointError("TSK001", "Unsupported checkpoint format.", "$.format");
  }
  if (envelope.version !== CHECKPOINT_VERSION) {
    throw checkpointError("TSK001", "Unsupported checkpoint revision.", "$.version");
  }

  const plan = capturePlan(envelope.plan, "$.plan");
  const snapshot = captureSnapshot(envelope.snapshot, plan, "$.snapshot");
  return Object.freeze({ format: CHECKPOINT_FORMAT, version: CHECKPOINT_VERSION, plan, snapshot });
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
        !CHECKPOINT_KEYS.includes(
          /* EVIDENCE: invariant: includes tests membership; it does not assume the external key is accepted. */ key as (typeof CHECKPOINT_KEYS)[number],
        ),
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
      throw checkpointError("TSK002", "Checkpoint contains a non-JSON-safe value.", `$.${key}`);
    }
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw checkpointError("TSK002", "Checkpoint contains a non-JSON-safe value.", `$.${key}`);
    }
    captured[key] = descriptor.value;
  }
  return {
    format: captured.format,
    version: captured.version,
    plan: captured.plan,
    snapshot: captured.snapshot,
  };
}

export function deserializeCheckpoint(json: string): RuntimeCheckpoint {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw checkpointError("TSK003", `Checkpoint JSON is invalid: ${message}`, "$.");
  }
  return restoreParsedCheckpoint(parsed);
}

/**
 * `restoreCheckpoint` of checkpoint data that `JSON.parse` just built, with the same result and errors, without capture's
 * copy: the parsed plan and snapshot are left as capture would leave them (`adoptParsedJson`), and data holding a number
 * that is not finite goes to `restoreCheckpoint` for capture's own error.
 */
function restoreParsedCheckpoint(value: unknown): RuntimeCheckpoint {
  const envelope = captureCheckpointEnvelope(value);
  if (envelope.format !== CHECKPOINT_FORMAT) {
    throw checkpointError("TSK001", "Unsupported checkpoint format.", "$.format");
  }
  if (envelope.version !== CHECKPOINT_VERSION) {
    throw checkpointError("TSK001", "Unsupported checkpoint revision.", "$.version");
  }
  if (!adoptParsedJson(envelope.plan, true)) return restoreCheckpoint(value);
  const planValidation = validateCapturedInstructionPlan(envelope.plan);
  if (!planValidation.valid) {
    const first = planValidation.errors[0];
    throw checkpointError(
      first?.code === "TSC010" ? "TSK001" : "TSK002",
      first?.message ?? "Instruction plan is malformed.",
      `$.plan${first?.path.slice(1) ?? ""}`,
    );
  }
  // EVIDENCE: validation: validateCapturedInstructionPlan accepted this JSON-parsed plan above.
  const plan = markValidatedImmutableInstructionPlan(envelope.plan as InstructionPlan);
  if (!adoptParsedJson(envelope.snapshot, false)) return restoreCheckpoint(value);
  const snapshotValidation = classifyCapturedRuntimeSnapshot(envelope.snapshot, plan);
  if (!snapshotValidation.validation.valid) {
    throw checkpointError(
      checkpointSnapshotErrorCode(snapshotValidation.failureKind),
      snapshotValidation.validation.errors[0] ?? "Runtime snapshot is malformed.",
      "$.snapshot",
    );
  }
  return Object.freeze({
    format: CHECKPOINT_FORMAT,
    version: CHECKPOINT_VERSION,
    plan,
    // EVIDENCE: validation: classified snapshot validation accepted this snapshot against the validated plan above.
    snapshot: withFrozenTemporalCaptures(envelope.snapshot as RuntimeSnapshot),
  });
}

function capturePlan(value: unknown, path: string): InstructionPlan {
  const captured = captureOrReuseInstructionPlan(value);
  if (!captured.validation.valid || captured.plan === null) {
    const first = captured.validation.errors[0];
    throw checkpointError(
      first?.code === "TSC010" ? "TSK001" : "TSK002",
      checkpointExternalDataMessage(
        captured.failureKind,
        first?.message ?? "Instruction plan is malformed.",
      ),
      `${path}${first?.path.slice(1) ?? ""}`,
    );
  }
  return captured.plan;
}

function captureSnapshot(value: unknown, plan: InstructionPlan, path: string): RuntimeSnapshot {
  const captured = captureRuntimeSnapshotWithValidatedPlan(value, plan);
  if (!captured.validation.valid || captured.snapshot === null) {
    const message = checkpointExternalDataMessage(
      captured.failureKind,
      captured.validation.errors[0] ?? "Runtime snapshot is malformed.",
    );
    throw checkpointError(checkpointSnapshotErrorCode(captured.failureKind), message, path);
  }
  return captured.snapshot;
}

function checkpointExternalDataMessage(
  kind: RuntimeSnapshotValidationFailureKind | null,
  fallback: string,
): string {
  switch (kind) {
    case "nonFiniteNumber":
      return "Checkpoint contains a non-finite number.";
    case "nonJsonSafeValue":
      return "Checkpoint contains a non-JSON-safe value.";
    case "cycle":
      return "Checkpoint contains a cycle.";
    case "nonPlainObject":
      return "Checkpoint contains a non-plain object.";
    default:
      return fallback;
  }
}

function checkpointSnapshotErrorCode(
  kind: RuntimeSnapshotValidationFailureKind | null,
): CheckpointErrorInfo["code"] {
  return kind === "unsupported" ? "TSK001" : "TSK002";
}
