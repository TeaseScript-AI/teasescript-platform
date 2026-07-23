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
  type SerializableRuntimeList,
  type SerializableRuntimeRange,
  type SerializableRuntimeSet,
  type SerializableRuntimeValue,
} from "./serializable-values.js";

export const RUNTIME_SNAPSHOT_FORMAT = "teasescript-runtime-snapshot";
export const RUNTIME_SNAPSHOT_VERSION = 3;
export const DEFAULT_MAX_CALL_DEPTH = 256;
export const MAX_SUPPORTED_CALL_DEPTH = 4096;

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

interface RuntimeLoopFrameBase {
  readonly loopId: number;
  readonly scopeDepth: number;
  readonly callFrameId: number | null;
}

export interface RuntimeRepeatLoopFrameSnapshot extends RuntimeLoopFrameBase {
  readonly kind: "repeat";
  remaining: number;
}

export interface RuntimeForLoopFrameSnapshot extends RuntimeLoopFrameBase {
  readonly kind: "for";
  readonly variable: string;
  readonly source:
    | SerializableRuntimeList
    | SerializableRuntimeSet
    | SerializableRuntimeRange;
  position: number;
}

export interface RuntimeWhileLoopFrameSnapshot extends RuntimeLoopFrameBase {
  readonly kind: "while";
}

export type RuntimeLoopFrameSnapshot =
  | RuntimeRepeatLoopFrameSnapshot
  | RuntimeForLoopFrameSnapshot
  | RuntimeWhileLoopFrameSnapshot;

export interface RuntimeTemporarySnapshot {
  readonly id: number;
  value: SerializableRuntimeValue;
}

export type RuntimeCallArgumentSnapshot =
  | {
      readonly parameterName: string;
      readonly supplied: false;
    }
  | {
      readonly parameterName: string;
      readonly supplied: true;
      readonly value: SerializableRuntimeValue;
    };

export interface RuntimeParameterStateSnapshot {
  phase: "supplied" | "defaults" | "body";
  parameterIndex: number;
}

export interface RuntimeCallFrameSnapshot {
  readonly id: number;
  readonly functionId: number;
  readonly functionName: string;
  readonly callSiteSpan: SourceSpan;
  readonly returnInstruction: number;
  readonly destinationTemporary: number;
  readonly callerTemporaries: RuntimeTemporarySnapshot[];
  readonly scopeBaseDepth: number;
  readonly loopBaseDepth: number;
  readonly arguments: RuntimeCallArgumentSnapshot[];
  parameterState: RuntimeParameterStateSnapshot;
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
  readonly loopFrames: RuntimeLoopFrameSnapshot[];
  readonly temporaries: RuntimeTemporarySnapshot[];
  readonly callFrames: RuntimeCallFrameSnapshot[];
  nextEventSequence: number;
  nextScopeId: number;
  nextSpeakerId: number;
  nextCallFrameId: number;
  readonly maxCallDepth: number;
  status: RuntimeStatus;
  failure: RuntimeFailureSnapshot | null;
}

export interface FreshRuntimeOptions {
  readonly seed?: number;
  readonly globals?: Readonly<Record<string, SerializableRuntimeValue>>;
  readonly maxCallDepth?: number;
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
  const maxCallDepth = options.maxCallDepth ?? DEFAULT_MAX_CALL_DEPTH;
  if (
    !Number.isInteger(maxCallDepth) ||
    maxCallDepth < 1 ||
    maxCallDepth > MAX_SUPPORTED_CALL_DEPTH
  ) {
    throw new RangeError(
      `maxCallDepth must be an integer from 1 through ${MAX_SUPPORTED_CALL_DEPTH}.`,
    );
  }
  for (const [name, value] of Object.entries(options.globals ?? {})) {
    if (name.length === 0) throw new TypeError("Global binding names must not be empty.");
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
    loopFrames: [],
    temporaries: [],
    callFrames: [],
    nextEventSequence: 1,
    nextScopeId: 1,
    nextSpeakerId: 1,
    nextCallFrameId: 1,
    maxCallDepth,
    status: plan.rootEndInstruction === 0 ? "halted" : "ready",
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
    loopFrames: snapshot.loopFrames.map((frame) => {
      if (frame.kind === "repeat") return { ...frame };
      if (frame.kind === "while") return { ...frame };
      return {
        ...frame,
        source: cloneSerializableValue(frame.source) as RuntimeForLoopFrameSnapshot["source"],
      };
    }),
    temporaries: snapshot.temporaries.map(cloneTemporary),
    callFrames: snapshot.callFrames.map((frame) => ({
      id: frame.id,
      functionId: frame.functionId,
      functionName: frame.functionName,
      callSiteSpan: copySpan(frame.callSiteSpan),
      returnInstruction: frame.returnInstruction,
      destinationTemporary: frame.destinationTemporary,
      callerTemporaries: frame.callerTemporaries.map(cloneTemporary),
      scopeBaseDepth: frame.scopeBaseDepth,
      loopBaseDepth: frame.loopBaseDepth,
      arguments: frame.arguments.map((argument) =>
        argument.supplied
          ? {
              parameterName: argument.parameterName,
              supplied: true,
              value: cloneSerializableValue(argument.value),
            }
          : { parameterName: argument.parameterName, supplied: false },
      ),
      parameterState: { ...frame.parameterState },
    })),
    nextEventSequence: snapshot.nextEventSequence,
    nextScopeId: snapshot.nextScopeId,
    nextSpeakerId: snapshot.nextSpeakerId,
    nextCallFrameId: snapshot.nextCallFrameId,
    maxCallDepth: snapshot.maxCallDepth,
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
  validateTemporaries(value.temporaries, plan, "Runtime temporaries", errors);
  const callFrameIds = validateCallFrames(
    value.callFrames,
    value.frames,
    value.loopFrames,
    value.nextInstruction,
    value.maxCallDepth,
    plan,
    errors,
  );
  validateSpeakerReferences(
    value.frames,
    value.speakers,
    value.loopFrames,
    value.temporaries,
    value.callFrames,
    speakerIds,
    errors,
  );
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
  validateLoopFrames(
    value.loopFrames,
    value.frames,
    value.nextInstruction,
    value.callFrames,
    callFrameIds,
    plan,
    errors,
  );
  if (!nonNegativeInteger(value.nextEventSequence) || value.nextEventSequence < 1) {
    errors.push("Runtime nextEventSequence must be a positive integer.");
  }
  const frameIds = Array.isArray(value.frames)
    ? value.frames
        .filter(isPlainRecord)
        .map((frame) => frame.id)
        .filter(nonNegativeInteger)
    : [];
  if (
    !nonNegativeInteger(value.nextScopeId) ||
    value.nextScopeId < 1 ||
    frameIds.some((id) => id >= (value.nextScopeId as number))
  ) {
    errors.push("Runtime nextScopeId must be a positive unused ID.");
  }
  if (
    !nonNegativeInteger(value.nextSpeakerId) ||
    value.nextSpeakerId < 1 ||
    [...speakerIds].some((id) => id >= (value.nextSpeakerId as number))
  ) {
    errors.push("Runtime nextSpeakerId is invalid.");
  }
  if (
    !nonNegativeInteger(value.nextCallFrameId) ||
    value.nextCallFrameId < 1 ||
    [...callFrameIds].some((id) => id >= (value.nextCallFrameId as number))
  ) {
    errors.push("Runtime nextCallFrameId is invalid.");
  }
  if (
    !nonNegativeInteger(value.maxCallDepth) ||
    value.maxCallDepth < 1 ||
    value.maxCallDepth > MAX_SUPPORTED_CALL_DEPTH
  ) {
    errors.push("Runtime maxCallDepth is outside the supported range.");
  }
  if (!["ready", "running", "halted", "failed"].includes(String(value.status))) {
    errors.push("Runtime status is invalid.");
  }
  validateFailure(value.failure, value.status, errors);
  validateStatusConsistency(value, plan, errors);
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

function validateLoopFrames(
  value: unknown,
  frames: unknown,
  nextInstruction: unknown,
  callFrames: unknown,
  callFrameIds: ReadonlySet<number>,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push("Runtime loopFrames must be an array.");
    return;
  }
  const frameCount = Array.isArray(frames) ? frames.length : 0;
  const loopIds = new Set<number>();
  let previousDepth = 0;
  const plannedLoops = new Map<number, {
    kind: "repeat" | "for" | "while";
    variable?: string;
    start: number;
    continueStart: number;
    target: number;
    functionId: number | null;
  }>();
  plan?.instructions.forEach((instruction, index) => {
    if (instruction.kind === "loopStart") {
      plannedLoops.set(instruction.loopId, {
        kind: instruction.loopKind,
        ...(instruction.loopKind === "for" ? { variable: instruction.variable } : {}),
        start: index,
        continueStart: instruction.continueTarget,
        target: instruction.target,
        functionId:
          plan.functions.find(
            (definition) =>
              index >= definition.entryInstruction &&
              index < definition.endInstruction,
          )?.id ?? null,
      });
    }
  });
  for (const frame of value) {
    if (
      !isPlainRecord(frame) ||
      !nonNegativeInteger(frame.loopId) ||
      frame.loopId < 1 ||
      !nonNegativeInteger(frame.scopeDepth) ||
      frame.scopeDepth < 1 ||
      frame.scopeDepth > frameCount
    ) {
      errors.push("Runtime loop frame is malformed.");
      continue;
    }
    if (
      frame.callFrameId !== null &&
      (!nonNegativeInteger(frame.callFrameId) || !callFrameIds.has(frame.callFrameId))
    ) {
      errors.push("Runtime loop frame has an unknown call-frame owner.");
    }
    if (loopIds.has(frame.loopId)) errors.push("Runtime loop IDs must be unique.");
    loopIds.add(frame.loopId);
    if (frame.scopeDepth < previousDepth) {
      errors.push("Runtime loop frame scope depths are out of order.");
    }
    previousDepth = frame.scopeDepth;
    const planned = plannedLoops.get(frame.loopId);
    const owner = Array.isArray(callFrames)
      ? callFrames.find(
          (candidate) =>
            isPlainRecord(candidate) && candidate.id === frame.callFrameId,
        )
      : undefined;
    const currentOwner = Array.isArray(callFrames) && callFrames.length > 0
      ? (isPlainRecord(callFrames.at(-1)) ? callFrames.at(-1)!.id : undefined)
      : null;
    if (
      plan !== undefined &&
      (planned === undefined ||
        planned.kind !== frame.kind ||
        (planned.kind === "for" && planned.variable !== frame.variable) ||
        (planned.functionId === null
          ? frame.callFrameId !== null
          : !isPlainRecord(owner) || owner.functionId !== planned.functionId) ||
        (frame.callFrameId === currentOwner &&
          (!nonNegativeInteger(nextInstruction) ||
            nextInstruction < planned.continueStart ||
            nextInstruction >= planned.target)))
    ) {
      errors.push("Runtime loop frame does not match the instruction plan.");
    }
    if (frame.kind === "repeat") {
      if (!nonNegativeInteger(frame.remaining)) {
        errors.push("Runtime repeat-loop state is malformed.");
      }
    } else if (frame.kind === "while") {
      // While loops need no additional hidden state.
    } else if (frame.kind === "for") {
      const failure = validateSerializableValue(frame.source, "loop.source");
      if (
        typeof frame.variable !== "string" ||
        frame.variable.length === 0 ||
        failure !== null ||
        !isPlainRecord(frame.source) ||
        !["list", "set", "range"].includes(String(frame.source.kind)) ||
        !nonNegativeInteger(frame.position) ||
        frame.position > iterationLength(frame.source)
      ) {
        errors.push("Runtime for-loop iterator state is malformed.");
      }
    } else {
      errors.push("Runtime loop kind is unsupported.");
    }
  }
}

function iterationLength(source: Record<string, unknown>): number {
  if ((source.kind === "list" || source.kind === "set") && Array.isArray(source.items)) {
    return source.items.length;
  }
  if (
    source.kind === "range" &&
    Number.isInteger(source.start) &&
    Number.isInteger(source.end) &&
    typeof source.inclusive === "boolean"
  ) {
    const size = (source.end as number) - (source.start as number) +
      (source.inclusive ? 1 : 0);
    return Math.max(0, size);
  }
  return -1;
}

function validateTemporaries(
  value: unknown,
  plan: InstructionPlan | undefined,
  label: string,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return;
  }
  const ids = new Set<number>();
  for (const temporary of value) {
    if (
      !isPlainRecord(temporary) ||
      !nonNegativeInteger(temporary.id) ||
      temporary.id < 1 ||
      (plan !== undefined && temporary.id > plan.temporaryCount)
    ) {
      errors.push(`${label} contain an invalid temporary ID.`);
      continue;
    }
    if (ids.has(temporary.id)) errors.push(`${label} contain duplicate temporary IDs.`);
    ids.add(temporary.id);
    const failure = validateSerializableValue(temporary.value);
    if (failure !== null) errors.push(failure);
  }
}

function validateCallFrames(
  value: unknown,
  frames: unknown,
  loopFrames: unknown,
  nextInstruction: unknown,
  maxCallDepth: unknown,
  plan: InstructionPlan | undefined,
  errors: string[],
): Set<number> {
  const ids = new Set<number>();
  if (!Array.isArray(value)) {
    errors.push("Runtime callFrames must be an array.");
    return ids;
  }
  if (nonNegativeInteger(maxCallDepth) && value.length > maxCallDepth) {
    errors.push("Runtime call stack exceeds maxCallDepth.");
  }
  const frameCount = Array.isArray(frames) ? frames.length : 0;
  const loopCount = Array.isArray(loopFrames) ? loopFrames.length : 0;
  let previousId = 0;
  let previousScopeBase = 0;
  let previousLoopBase = 0;
  value.forEach((frame, frameIndex) => {
    if (!isPlainRecord(frame)) {
      errors.push("Runtime call frame is malformed.");
      return;
    }
    if (!nonNegativeInteger(frame.id) || frame.id < 1 || ids.has(frame.id)) {
      errors.push("Runtime call-frame IDs must be unique positive integers.");
    } else {
      if (frame.id <= previousId) errors.push("Runtime call-frame IDs are out of order.");
      previousId = frame.id;
      ids.add(frame.id);
    }
    const definition = plan?.functions.find((item) => item.id === frame.functionId);
    if (
      !nonNegativeInteger(frame.functionId) ||
      frame.functionId < 1 ||
      (plan !== undefined && definition === undefined) ||
      typeof frame.functionName !== "string" ||
      frame.functionName.length === 0 ||
      (definition !== undefined && frame.functionName !== definition.name) ||
      !validSpan(frame.callSiteSpan)
    ) {
      errors.push("Runtime call frame refers to a malformed or unknown function.");
    }
    if (
      !nonNegativeInteger(frame.returnInstruction) ||
      frame.returnInstruction < 1 ||
      (plan !== undefined && frame.returnInstruction > plan.instructions.length)
    ) {
      errors.push("Runtime call frame has an invalid return instruction.");
    } else if (plan !== undefined) {
      const call = plan.instructions[frame.returnInstruction - 1];
      if (
        call?.kind !== "callFunction" ||
        call.functionId !== frame.functionId ||
        call.destinationTemporary !== frame.destinationTemporary ||
        call.returnInstruction !== frame.returnInstruction
      ) {
        errors.push("Runtime call frame return target does not match its call instruction.");
      }
    }
    if (
      !nonNegativeInteger(frame.destinationTemporary) ||
      frame.destinationTemporary < 1 ||
      (plan !== undefined && frame.destinationTemporary > plan.temporaryCount)
    ) {
      errors.push("Runtime call frame has an invalid result destination.");
    }
    validateTemporaries(
      frame.callerTemporaries,
      plan,
      "Runtime caller temporaries",
      errors,
    );
    if (
      !nonNegativeInteger(frame.scopeBaseDepth) ||
      frame.scopeBaseDepth < 1 ||
      frame.scopeBaseDepth >= frameCount ||
      frame.scopeBaseDepth <= previousScopeBase
    ) {
      errors.push("Runtime call frame has an impossible scope base.");
    }
    if (nonNegativeInteger(frame.scopeBaseDepth)) previousScopeBase = frame.scopeBaseDepth;
    if (
      !nonNegativeInteger(frame.loopBaseDepth) ||
      frame.loopBaseDepth > loopCount ||
      frame.loopBaseDepth < previousLoopBase
    ) {
      errors.push("Runtime call frame has an impossible loop base.");
    }
    if (nonNegativeInteger(frame.loopBaseDepth)) previousLoopBase = frame.loopBaseDepth;
    validateCallArguments(frame.arguments, definition, errors);
    validateParameterState(frame.parameterState, definition, errors);

    if (frameIndex === value.length - 1 && definition !== undefined) {
      if (
        !nonNegativeInteger(nextInstruction) ||
        nextInstruction < definition.entryInstruction ||
        nextInstruction >= definition.endInstruction
      ) {
        errors.push("Runtime next instruction is outside the active function.");
      } else {
        validateCurrentParameterPosition(
          frame.parameterState,
          definition,
          nextInstruction,
          plan!,
          errors,
        );
      }
    }
  });
  return ids;
}

function validateCallArguments(
  value: unknown,
  definition: InstructionPlan["functions"][number] | undefined,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push("Runtime call-frame arguments must be an array.");
    return;
  }
  if (definition !== undefined && value.length !== definition.parameters.length) {
    errors.push("Runtime call-frame arguments do not match function parameters.");
  }
  value.forEach((argument, index) => {
    const parameter = definition?.parameters[index];
    if (
      !isPlainRecord(argument) ||
      typeof argument.parameterName !== "string" ||
      argument.parameterName.length === 0 ||
      typeof argument.supplied !== "boolean" ||
      (parameter !== undefined && argument.parameterName !== parameter.name)
    ) {
      errors.push("Runtime call-frame argument state is malformed.");
      return;
    }
    if (argument.supplied) {
      if (!("value" in argument)) {
        errors.push("Supplied runtime argument is missing its value.");
      } else {
        const failure = validateSerializableValue(argument.value);
        if (failure !== null) errors.push(failure);
      }
    } else if ("value" in argument) {
      errors.push("Missing runtime argument must not contain a value.");
    }
  });
}

function validateParameterState(
  value: unknown,
  definition: InstructionPlan["functions"][number] | undefined,
  errors: string[],
): void {
  if (
    !isPlainRecord(value) ||
    !["supplied", "defaults", "body"].includes(String(value.phase)) ||
    !nonNegativeInteger(value.parameterIndex) ||
    (definition !== undefined && value.parameterIndex > definition.parameters.length) ||
    (value.phase === "body" &&
      definition !== undefined &&
      value.parameterIndex !== definition.parameters.length)
  ) {
    errors.push("Runtime parameter-prologue state is malformed.");
  }
}

function validateCurrentParameterPosition(
  value: unknown,
  definition: InstructionPlan["functions"][number],
  nextInstruction: number,
  plan: InstructionPlan,
  errors: string[],
): void {
  if (!isPlainRecord(value) || !nonNegativeInteger(value.parameterIndex)) return;
  if (value.phase === "body") {
    if (nextInstruction < definition.bodyEntryInstruction) {
      errors.push("Runtime function body state precedes the body entry.");
    }
    return;
  }
  if (value.phase === "supplied") {
    const instruction = plan.instructions[nextInstruction];
    if (value.parameterIndex < definition.parameters.length) {
      if (
        instruction?.kind !== "bindSuppliedParameter" ||
        instruction.parameterIndex !== value.parameterIndex
      ) {
        errors.push("Runtime supplied-parameter progress does not match the next instruction.");
      }
    } else if (instruction?.kind !== "beginFunctionDefaults") {
      errors.push("Runtime supplied-parameter phase has an invalid boundary.");
    }
    return;
  }
  if (value.phase === "defaults") {
    const beginDefaults = plan.instructions.findIndex(
      (instruction, index) =>
        index >= definition.entryInstruction &&
        index < definition.bodyEntryInstruction &&
        instruction.kind === "beginFunctionDefaults",
    );
    if (
      beginDefaults < 0 ||
      nextInstruction <= beginDefaults ||
      nextInstruction >= definition.bodyEntryInstruction
    ) {
      errors.push("Runtime default-parameter progress does not match the next instruction.");
    }
  }
}

function validateStatusConsistency(
  value: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  const calls = Array.isArray(value.callFrames) ? value.callFrames.length : 0;
  const loops = Array.isArray(value.loopFrames) ? value.loopFrames.length : 0;
  const temporaries = Array.isArray(value.temporaries) ? value.temporaries.length : 0;
  const scopes = Array.isArray(value.frames) ? value.frames.length : 0;
  if (value.contextualSpeaker !== null) {
    errors.push("Runtime contextual speaker must be cleared between instructions.");
  }
  if (value.status === "ready") {
    if (
      value.nextInstruction !== 0 ||
      calls !== 0 ||
      loops !== 0 ||
      temporaries !== 0 ||
      scopes !== 1 ||
      value.failure !== null
    ) {
      errors.push("Ready runtime state contains execution progress.");
    }
  } else if (value.status === "halted") {
    if (calls !== 0 || loops !== 0 || temporaries !== 0 || scopes !== 1 || value.failure !== null) {
      errors.push("Halted runtime state retains active execution state.");
    }
  } else if (value.status === "running") {
    if (value.failure !== null) errors.push("Running runtime state contains failure information.");
    if (
      plan !== undefined &&
      calls === 0 &&
      (!nonNegativeInteger(value.nextInstruction) || value.nextInstruction >= plan.rootEndInstruction)
    ) {
      errors.push("Root execution position is outside the root instruction range.");
    }
  }
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
      if (
        !isPlainRecord(binding) ||
        typeof binding.name !== "string" ||
        binding.name.length === 0
      ) {
        errors.push("Runtime binding is malformed.");
        continue;
      }
      if (names.has(binding.name)) errors.push("Runtime frame contains a duplicate binding.");
      names.add(binding.name);
      const failure = validateSerializableValue(binding.value);
      if (failure !== null) errors.push(failure);
    }
  }
  if (isPlainRecord(value[0]) && value[0].id !== 0) {
    errors.push("Runtime root scope frame must have ID 0.");
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
      speaker.identifier.length === 0 ||
      !Array.isArray(speaker.properties)
    ) {
      errors.push("Runtime speaker is malformed.");
      continue;
    }
    if (ids.has(speaker.id)) errors.push("Runtime speaker IDs must be unique.");
    ids.add(speaker.id);
    const names = new Set<string>();
    for (const property of speaker.properties) {
      if (
        !isPlainRecord(property) ||
        typeof property.name !== "string" ||
        property.name.length === 0
      ) {
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
  loopFrames: unknown,
  temporaries: unknown,
  callFrames: unknown,
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
  if (Array.isArray(loopFrames)) {
    for (const loop of loopFrames) {
      if (isPlainRecord(loop) && loop.kind === "for") values.push(loop.source);
    }
  }
  if (Array.isArray(temporaries)) {
    for (const temporary of temporaries) {
      if (isPlainRecord(temporary)) values.push(temporary.value);
    }
  }
  if (Array.isArray(callFrames)) {
    for (const frame of callFrames) {
      if (!isPlainRecord(frame)) continue;
      if (Array.isArray(frame.callerTemporaries)) {
        for (const temporary of frame.callerTemporaries) {
          if (isPlainRecord(temporary)) values.push(temporary.value);
        }
      }
      if (Array.isArray(frame.arguments)) {
        for (const argument of frame.arguments) {
          if (isPlainRecord(argument) && argument.supplied === true) {
            values.push(argument.value);
          }
        }
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

function cloneTemporary(
  temporary: RuntimeTemporarySnapshot,
): RuntimeTemporarySnapshot {
  return {
    id: temporary.id,
    value: cloneSerializableValue(temporary.value),
  };
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
