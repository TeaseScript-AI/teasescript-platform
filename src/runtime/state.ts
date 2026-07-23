import type { InstructionPlan } from "../instructions.js";
import { validateInstructionPlan } from "../instructions.js";
import { createSourceSpan, type SourceSpan } from "../source.js";
import {
  createXorShift32State,
  DEFAULT_PLAYGROUND_SEED,
  XORSHIFT32_ALGORITHM,
  type XorShift32State,
} from "./random.js";
import {
  cloneSerializableValue,
  validateSerializableValue,
  type SerializableRuntimeProperty,
  type SerializableRuntimeValue,
} from "./serializable-values.js";

export const RUNTIME_SNAPSHOT_FORMAT = "teasescript-runtime-snapshot";
export const RUNTIME_SNAPSHOT_VERSION = 1;

export type RuntimeStatus = "ready" | "running" | "halted" | "failed";

export interface RuntimeBindingSnapshot {
  readonly name: string;
  value: SerializableRuntimeValue;
}

export interface RuntimeScopeFrameSnapshot {
  readonly id: number;
  readonly bindings: RuntimeBindingSnapshot[];
}

export interface RuntimeSpeakerSnapshot {
  readonly id: number;
  readonly identifier: string;
  readonly properties: SerializableRuntimeProperty[];
}

export interface RuntimeFailureSnapshot {
  readonly code: string;
  readonly message: string;
  readonly span: SourceSpan;
}

export interface RuntimeSnapshot {
  readonly format: typeof RUNTIME_SNAPSHOT_FORMAT;
  readonly version: typeof RUNTIME_SNAPSHOT_VERSION;
  nextInstruction: number;
  readonly frames: RuntimeScopeFrameSnapshot[];
  readonly speakers: RuntimeSpeakerSnapshot[];
  defaultSpeaker: number | null;
  contextualSpeaker: number | null;
  readonly rng: XorShift32State;
  readonly warnedSpeakerIds: number[];
  nextEventSequence: number;
  nextScopeId: number;
  nextSpeakerId: number;
  status: RuntimeStatus;
  failure: RuntimeFailureSnapshot | null;
}

export interface FreshRuntimeOptions {
  readonly seed?: number;
  readonly globals?: Readonly<Record<string, SerializableRuntimeValue>>;
}

export interface SnapshotValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export function createFreshRuntimeSnapshot(
  plan: InstructionPlan,
  options: FreshRuntimeOptions = {},
): RuntimeSnapshot {
  const planValidation = validateInstructionPlan(plan);
  if (!planValidation.valid) {
    throw new TypeError(planValidation.errors[0]?.message ?? "Malformed instruction plan.");
  }
  const bindings: RuntimeBindingSnapshot[] = [];
  for (const [name, value] of Object.entries(options.globals ?? {})) {
    const failure = validateSerializableValue(value, `globals.${name}`);
    if (failure !== null) throw new TypeError(failure);
    if (bindings.some((binding) => binding.name === name)) {
      throw new TypeError(`Duplicate global '${name}'.`);
    }
    bindings.push({ name, value: cloneSerializableValue(value) });
  }
  return {
    format: RUNTIME_SNAPSHOT_FORMAT,
    version: RUNTIME_SNAPSHOT_VERSION,
    nextInstruction: 0,
    frames: [{ id: 0, bindings }],
    speakers: [],
    defaultSpeaker: null,
    contextualSpeaker: null,
    rng: createXorShift32State(options.seed ?? DEFAULT_PLAYGROUND_SEED),
    warnedSpeakerIds: [],
    nextEventSequence: 1,
    nextScopeId: 1,
    nextSpeakerId: 1,
    status: plan.instructions.length === 0 ? "halted" : "ready",
    failure: null,
  };
}

export function cloneRuntimeSnapshot(snapshot: RuntimeSnapshot): RuntimeSnapshot {
  return {
    format: RUNTIME_SNAPSHOT_FORMAT,
    version: RUNTIME_SNAPSHOT_VERSION,
    nextInstruction: snapshot.nextInstruction,
    frames: snapshot.frames.map((frame) => ({
      id: frame.id,
      bindings: frame.bindings.map((binding) => ({
        name: binding.name,
        value: cloneSerializableValue(binding.value),
      })),
    })),
    speakers: snapshot.speakers.map((speaker) => ({
      id: speaker.id,
      identifier: speaker.identifier,
      properties: speaker.properties.map((property) => ({
        name: property.name,
        value: cloneSerializableValue(property.value),
      })),
    })),
    defaultSpeaker: snapshot.defaultSpeaker,
    contextualSpeaker: snapshot.contextualSpeaker,
    rng: { algorithm: XORSHIFT32_ALGORITHM, state: snapshot.rng.state },
    warnedSpeakerIds: [...snapshot.warnedSpeakerIds],
    nextEventSequence: snapshot.nextEventSequence,
    nextScopeId: snapshot.nextScopeId,
    nextSpeakerId: snapshot.nextSpeakerId,
    status: snapshot.status,
    failure:
      snapshot.failure === null
        ? null
        : {
            code: snapshot.failure.code,
            message: snapshot.failure.message,
            span: copySpan(snapshot.failure.span),
          },
  };
}

export function validateRuntimeSnapshot(
  value: unknown,
  plan?: InstructionPlan,
): SnapshotValidationResult {
  const errors: string[] = [];
  const jsonFailure = findJsonSafetyFailure(value, new Set<object>());
  if (jsonFailure !== null) {
    return Object.freeze({ valid: false, errors: Object.freeze([jsonFailure]) });
  }
  if (!isPlainRecord(value)) {
    return Object.freeze({ valid: false, errors: Object.freeze(["Runtime snapshot must be an object."]) });
  }
  if (value.format !== RUNTIME_SNAPSHOT_FORMAT) errors.push("Unsupported runtime-snapshot format.");
  if (value.version !== RUNTIME_SNAPSHOT_VERSION) errors.push("Unsupported runtime-snapshot version.");
  const instructionLimit = plan?.instructions.length;
  if (
    !nonNegativeInteger(value.nextInstruction) ||
    (instructionLimit !== undefined && value.nextInstruction > instructionLimit)
  ) {
    errors.push("Runtime nextInstruction is outside the plan.");
  }
  validateFrames(value.frames, errors);
  const speakerIds = validateSpeakers(value.speakers, errors);
  validateSpeakerReferences(value.frames, value.speakers, speakerIds, errors);
  if (value.defaultSpeaker !== null && !nonNegativeInteger(value.defaultSpeaker)) {
    errors.push("Runtime defaultSpeaker must be a speaker ID or null.");
  } else if (
    typeof value.defaultSpeaker === "number" &&
    !speakerIds.has(value.defaultSpeaker)
  ) {
    errors.push("Runtime defaultSpeaker refers to an unknown speaker.");
  }
  if (value.contextualSpeaker !== null && !nonNegativeInteger(value.contextualSpeaker)) {
    errors.push("Runtime contextualSpeaker must be a speaker ID or null.");
  } else if (
    typeof value.contextualSpeaker === "number" &&
    !speakerIds.has(value.contextualSpeaker)
  ) {
    errors.push("Runtime contextualSpeaker refers to an unknown speaker.");
  }
  if (
    !isPlainRecord(value.rng) ||
    value.rng.algorithm !== XORSHIFT32_ALGORITHM ||
    !unsigned32(value.rng.state)
  ) {
    errors.push("Runtime RNG state is malformed or unsupported.");
  }
  if (
    !Array.isArray(value.warnedSpeakerIds) ||
    value.warnedSpeakerIds.some((item) => !nonNegativeInteger(item)) ||
    new Set(value.warnedSpeakerIds).size !== value.warnedSpeakerIds.length ||
    value.warnedSpeakerIds.some((item) => !speakerIds.has(item))
  ) {
    errors.push("Runtime warning-deduplication state is malformed.");
  }
  if (!nonNegativeInteger(value.nextEventSequence) || value.nextEventSequence < 1) {
    errors.push("Runtime nextEventSequence must be a positive integer.");
  }
  if (!nonNegativeInteger(value.nextScopeId) || value.nextScopeId < 1) {
    errors.push("Runtime nextScopeId must be a positive integer.");
  }
  if (
    !nonNegativeInteger(value.nextSpeakerId) ||
    value.nextSpeakerId < 1 ||
    [...speakerIds].some((id) => id >= (value.nextSpeakerId as number))
  ) {
    errors.push("Runtime nextSpeakerId is invalid.");
  }
  if (!["ready", "running", "halted", "failed"].includes(String(value.status))) {
    errors.push("Runtime status is invalid.");
  }
  validateFailure(value.failure, value.status, errors);
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

function validateFrames(value: unknown, errors: string[]): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("Runtime frames must be a non-empty array.");
    return;
  }
  const frameIds = new Set<number>();
  for (const frame of value) {
    if (!isPlainRecord(frame) || !nonNegativeInteger(frame.id) || !Array.isArray(frame.bindings)) {
      errors.push("Runtime scope frame is malformed.");
      continue;
    }
    if (frameIds.has(frame.id)) errors.push("Runtime scope frame IDs must be unique.");
    frameIds.add(frame.id);
    const names = new Set<string>();
    for (const binding of frame.bindings) {
      if (!isPlainRecord(binding) || typeof binding.name !== "string") {
        errors.push("Runtime binding is malformed.");
        continue;
      }
      if (names.has(binding.name)) errors.push("Runtime frame contains a duplicate binding.");
      names.add(binding.name);
      const failure = validateSerializableValue(binding.value);
      if (failure !== null) errors.push(failure);
    }
  }
}

function validateSpeakers(value: unknown, errors: string[]): Set<number> {
  const ids = new Set<number>();
  if (!Array.isArray(value)) {
    errors.push("Runtime speakers must be an array.");
    return ids;
  }
  for (const speaker of value) {
    if (
      !isPlainRecord(speaker) ||
      !nonNegativeInteger(speaker.id) ||
      typeof speaker.identifier !== "string" ||
      !Array.isArray(speaker.properties)
    ) {
      errors.push("Runtime speaker is malformed.");
      continue;
    }
    if (ids.has(speaker.id)) errors.push("Runtime speaker IDs must be unique.");
    ids.add(speaker.id);
    const names = new Set<string>();
    for (const property of speaker.properties) {
      if (!isPlainRecord(property) || typeof property.name !== "string") {
        errors.push("Runtime speaker property is malformed.");
        continue;
      }
      if (names.has(property.name)) errors.push("Runtime speaker property names must be unique.");
      names.add(property.name);
      const failure = validateSerializableValue(property.value);
      if (failure !== null) errors.push(failure);
    }
  }
  return ids;
}

function validateFailure(value: unknown, status: unknown, errors: string[]): void {
  if (value === null) {
    if (status === "failed") errors.push("Failed runtime status requires failure information.");
    return;
  }
  if (
    !isPlainRecord(value) ||
    typeof value.code !== "string" ||
    typeof value.message !== "string" ||
    !validSpan(value.span)
  ) {
    errors.push("Runtime failure information is malformed.");
  }
  if (status !== "failed") errors.push("Runtime failure information requires failed status.");
}

function validateSpeakerReferences(
  frames: unknown,
  speakers: unknown,
  speakerIds: ReadonlySet<number>,
  errors: string[],
): void {
  const values: unknown[] = [];
  if (Array.isArray(frames)) {
    for (const frame of frames) {
      if (!isPlainRecord(frame) || !Array.isArray(frame.bindings)) continue;
      for (const binding of frame.bindings) {
        if (isPlainRecord(binding)) values.push(binding.value);
      }
    }
  }
  if (Array.isArray(speakers)) {
    for (const speaker of speakers) {
      if (!isPlainRecord(speaker) || !Array.isArray(speaker.properties)) continue;
      for (const property of speaker.properties) {
        if (isPlainRecord(property)) values.push(property.value);
      }
    }
  }
  const referencedIds = new Set<number>();
  for (const value of values) collectSpeakerReferenceIds(value, referencedIds);
  for (const id of referencedIds) {
    if (!speakerIds.has(id)) {
      errors.push("Runtime value refers to an unknown speaker ID.");
      return;
    }
  }
}

function collectSpeakerReferenceIds(value: unknown, output: Set<number>): void {
  if (!isPlainRecord(value)) return;
  if (value.kind === "speakerReference" && nonNegativeInteger(value.speakerId)) {
    output.add(value.speakerId);
    return;
  }
  if (value.kind === "list" && Array.isArray(value.items)) {
    for (const item of value.items) collectSpeakerReferenceIds(item, output);
  } else if (value.kind === "object" && Array.isArray(value.properties)) {
    for (const property of value.properties) {
      if (isPlainRecord(property)) collectSpeakerReferenceIds(property.value, output);
    }
  }
}

function validSpan(value: unknown): value is SourceSpan {
  return (
    isPlainRecord(value) &&
    validPosition(value.start) &&
    validPosition(value.end) &&
    (value.end as { offset: number }).offset >= (value.start as { offset: number }).offset
  );
}

function validPosition(value: unknown): boolean {
  return (
    isPlainRecord(value) &&
    nonNegativeInteger(value.offset) &&
    nonNegativeInteger(value.line) &&
    nonNegativeInteger(value.column)
  );
}

function copySpan(span: SourceSpan): SourceSpan {
  return createSourceSpan(span.start, span.end);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function unsigned32(value: unknown): value is number {
  return nonNegativeInteger(value) && value <= 0xffff_ffff;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function findJsonSafetyFailure(value: unknown, active: Set<object>): string | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? null : "Runtime snapshot contains a non-finite number.";
  }
  if (typeof value !== "object") return "Runtime snapshot contains a non-JSON-safe value.";
  if (active.has(value)) return "Runtime snapshot contains a cycle.";
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return "Runtime snapshot contains a non-plain object.";
  }
  active.add(value);
  try {
    for (const nested of Object.values(value)) {
      const failure = findJsonSafetyFailure(nested, active);
      if (failure !== null) return failure;
    }
  } finally {
    active.delete(value);
  }
  return null;
}
