import { createCapturedArray } from "../external-data-capture.js";
import { MAX_TEXT_LENGTH } from "./text-length.js";
import { type InstructionPlan } from "../plan/model.js";
import { captureOrReuseInstructionPlan } from "../plan/capture.js";
import { freezeInstructionPlan } from "../plan/freeze.js";
import { markValidatedImmutableInstructionPlan } from "../plan/validated-immutable.js";
import { validateCapturedInstructionPlan } from "../plan/validation.js";
import {
  captureRuntimeSnapshotWithValidatedPlan,
  classifyCapturedRuntimeSnapshot,
  withFrozenTemporalCaptures,
  type RuntimeSnapshotValidationFailureKind,
  type RuntimeSnapshot,
} from "./state.js";

export const CHECKPOINT_FORMAT = "teasescript-checkpoint";
export const CHECKPOINT_VERSION = 99;

export interface RuntimeCheckpoint {
  readonly format: typeof CHECKPOINT_FORMAT;
  readonly version: typeof CHECKPOINT_VERSION;
  readonly plan: InstructionPlan;
  readonly snapshot: RuntimeSnapshot;
}

export interface CheckpointErrorInfo {
  readonly code: "TSK001" | "TSK002" | "TSK003" | "TSK004";
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
    plan: capturedPlan,
    snapshot: capturedSnapshot,
  });
}

export function serializeCheckpoint(checkpoint: RuntimeCheckpoint): string {
  return serializeValidatedRuntimeJson(restoreCheckpoint(checkpoint));
}

/**
 * JSON of plain runtime data that checkpoint validation produced, such as a checkpoint or one of its snapshots, without
 * validating it again. Native JSON writes it as the iterative writer does, unless a host hook could apply or the data is
 * deeper than the host stack allows. JSON longer than a text can be (`MAX_TEXT_LENGTH`) fails with `TSK004` in every
 * host, as V8 cannot build it.
 */
export function serializeValidatedRuntimeJson(value: unknown): string {
  return serializeValidatedRuntimeJsonWithin(value, MAX_TEXT_LENGTH);
}

/** `serializeValidatedRuntimeJson` with `limit` as the longest JSON it writes; tests give a small one. */
export function serializeValidatedRuntimeJsonWithin(value: unknown, limit: number): string {
  if (!inheritsToJson()) {
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch (error) {
      if (isStringLengthExhaustion(error)) throw stateTooLarge();
      if (!isStackExhaustion(error)) throw error;
    }
    if (json !== undefined) {
      if (json.length > limit) throw stateTooLarge();
      return json;
    }
  }
  return serializeJsonIterative(value, limit);
}

/** V8's failure to build a string longer than it holds. */
function isStringLengthExhaustion(error: unknown): boolean {
  return error instanceof RangeError && error.message === "Invalid string length";
}

function stateTooLarge(): CheckpointError {
  return checkpointError(
    "TSK004",
    `The state is too large to save: as text it would be longer than the limit of ${MAX_TEXT_LENGTH.toLocaleString("en-US")} characters.`,
    "$",
  );
}

/**
 * Whether native `JSON.stringify` would consult a `toJSON` that validated checkpoint data inherits. Its containers are
 * plain data whose prototype is `Object.prototype`, `Array.prototype`, the frozen prototype of captured arrays, or
 * null. `in` on these ordinary objects runs no getter.
 */
function inheritsToJson(): boolean {
  return (
    Object.getPrototypeOf(Array.prototype) !== Object.prototype ||
    "toJSON" in Array.prototype ||
    "toJSON" in createCapturedArray(0)
  );
}

/** A native stack overflow: a `RangeError` in V8 and JavaScriptCore, an `InternalError` in SpiderMonkey. */
function isStackExhaustion(error: unknown): boolean {
  return (
    error instanceof Error &&
    ((error.name === "RangeError" && /call stack/i.test(error.message)) ||
      (error.name === "InternalError" && /recursion/i.test(error.message)))
  );
}

function serializeJsonIterative(value: unknown, limit: number): string {
  const out: string[] = [];
  // Counted as it grows, so JSON too long to join fails before the join.
  let length = 0;
  const write = (piece: string) => {
    length += piece.length;
    if (length > limit) throw stateTooLarge();
    out.push(piece);
  };
  const stack: Array<{ value: unknown; state: "value" } | { value: string; state: "close" }> = [
    { value, state: "value" },
  ];
  while (stack.length > 0) {
    // EVIDENCE: stack is non-empty because the loop condition was checked immediately before pop.
    const frame = stack.pop()!;
    if (frame.state === "close") {
      write(frame.value);
      continue;
    }
    const current = frame.value;
    if (current === null || typeof current !== "object") {
      let encoded: string | undefined;
      try {
        encoded = JSON.stringify(current);
      } catch (error) {
        throw isStringLengthExhaustion(error) ? stateTooLarge() : error;
      }
      if (encoded === undefined) throw new TypeError("Checkpoint contains a non-JSON-safe value.");
      write(encoded);
      continue;
    }
    if (Array.isArray(current)) {
      write("[");
      stack.push({ value: "]", state: "close" });
      for (let i = current.length - 1; i >= 0; i--) {
        if (i < current.length - 1) stack.push({ value: ",", state: "close" });
        stack.push({ value: current[i], state: "value" });
      }
      continue;
    }
    // EVIDENCE: validated checkpoint containers are plain JSON objects at this boundary.
    const keys = Object.keys(current as Record<string, unknown>);
    write("{");
    stack.push({ value: "}", state: "close" });
    for (let i = keys.length - 1; i >= 0; i--) {
      const key = keys[i]!;
      if (i < keys.length - 1) stack.push({ value: ",", state: "close" });
      // EVIDENCE: validated checkpoint containers are plain JSON objects at this boundary.
      const entry = (current as Record<string, unknown>)[key];
      stack.push({ value: entry, state: "value" });
      stack.push({ value: ":", state: "close" });
      stack.push({ value: JSON.stringify(key), state: "close" });
    }
  }
  return out.join("");
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

function restoreParsedCheckpoint(value: unknown): RuntimeCheckpoint {
  const envelope = captureCheckpointEnvelope(value);
  if (envelope.format !== CHECKPOINT_FORMAT) {
    throw checkpointError("TSK001", "Unsupported checkpoint format.", "$.format");
  }
  if (envelope.version !== CHECKPOINT_VERSION) {
    throw checkpointError("TSK001", "Unsupported checkpoint version.", "$.version");
  }
  const planValidation = validateCapturedInstructionPlan(envelope.plan);
  if (!planValidation.valid) {
    const first = planValidation.errors[0];
    throw checkpointError(
      first?.code === "TSC001" ? "TSK001" : "TSK002",
      first?.message ?? "Instruction plan is malformed.",
      `$.plan${first?.path.slice(1) ?? ""}`,
    );
  }
  // EVIDENCE: validation: validateCapturedInstructionPlan accepted this JSON-parsed plan above.
  const plan = markValidatedImmutableInstructionPlan(
    freezeInstructionPlan(envelope.plan as InstructionPlan),
  );
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
      first?.code === "TSC001" ? "TSK001" : "TSK002",
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

function checkpointError(
  code: CheckpointErrorInfo["code"],
  message: string,
  path: string,
): CheckpointError {
  return new CheckpointError(Object.freeze({ code, message, path }));
}
