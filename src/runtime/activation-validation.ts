import type { InstructionPlan } from "../plan/model.js";
import { nonNegativeSafeInteger } from "../plan/validation-support.js";

/**
 * Restore validation for activations (ADR 0022 §5). Code runs in a context: the root region of an activation's file,
 * or a function or block. A level of the call stack, the number of call frames below it, has one context: the base
 * activation at level 0, and above a call frame the function it entered or the activation of the file it called.
 */
export interface SerializedContext {
  /** The call frame of the context; `null` for the base activation. */
  readonly ownerId: unknown;
  /** The function or block; `null` for a root region. */
  readonly functionId: unknown;
  /** The root whose top-level names the context sees. */
  readonly rootId: unknown;
  /** The file of a root region; a function's file follows from the plan. */
  readonly file: unknown;
}

export function serializedContext(
  snapshot: Record<string, unknown>,
  level: number,
): SerializedContext | undefined {
  const frames = Array.isArray(snapshot.frames) ? snapshot.frames : [];
  const callFrames = Array.isArray(snapshot.callFrames) ? snapshot.callFrames : [];
  if (level === 0) {
    const root = frames[0];
    return isPlainRecord(root)
      ? { ownerId: null, functionId: null, rootId: root.id, file: root.file }
      : undefined;
  }
  const frame = callFrames[level - 1];
  if (!isPlainRecord(frame)) return undefined;
  if (frame.kind === "function") {
    return {
      ownerId: frame.id,
      functionId: frame.functionId,
      rootId: frame.rootScopeId,
      file: null,
    };
  }
  const root = nonNegativeSafeInteger(frame.scopeBaseDepth)
    ? frames[frame.scopeBaseDepth]
    : undefined;
  return isPlainRecord(root)
    ? { ownerId: frame.id, functionId: null, rootId: root.id, file: root.file }
    : undefined;
}

/** The context the running code is in, at the top of the call stack. */
export function serializedTopContext(
  snapshot: Record<string, unknown>,
): SerializedContext | undefined {
  return serializedContext(
    snapshot,
    Array.isArray(snapshot.callFrames) ? snapshot.callFrames.length : 0,
  );
}

/** Whether code of the context may stand at an instruction: its function's region, or its file's root region. */
export function contextHoldsInstruction(
  plan: InstructionPlan,
  context: SerializedContext,
  instruction: number,
): boolean {
  if (context.functionId !== null) {
    const definition = nonNegativeSafeInteger(context.functionId)
      ? plan.functions[context.functionId - 1]
      : undefined;
    return (
      definition !== undefined &&
      instruction >= definition.entryInstruction &&
      instruction < definition.endInstruction
    );
  }
  const file = nonNegativeSafeInteger(context.file) ? plan.files[context.file] : undefined;
  return (
    file !== undefined &&
    instruction >= file.startInstruction &&
    instruction < file.rootEndInstruction
  );
}

/**
 * Whether an owner recorded for code at an instruction fits it: `null` for the base activation's root region, a file
 * call for its file's root region, a function frame for its function. A recorded owner no longer on the stack only
 * needs to have been issued.
 */
export function ownerFitsInstruction(
  plan: InstructionPlan,
  snapshot: Record<string, unknown>,
  ownerId: unknown,
  instruction: number,
): boolean {
  const functionId = plan.functions.find(
    (definition) =>
      instruction >= definition.entryInstruction && instruction < definition.endInstruction,
  )?.id;
  if (ownerId === null) return functionId === undefined;
  if (
    !nonNegativeSafeInteger(ownerId) ||
    ownerId < 1 ||
    !nonNegativeSafeInteger(snapshot.nextCallFrameId) ||
    ownerId >= snapshot.nextCallFrameId
  ) {
    return false;
  }
  const callFrames = Array.isArray(snapshot.callFrames) ? snapshot.callFrames : [];
  const live = callFrames.find((frame) => isPlainRecord(frame) && frame.id === ownerId);
  if (!isPlainRecord(live)) return true;
  return live.kind === "function" ? live.functionId === functionId : functionId === undefined;
}

/** The file of each activation root by scope ID: the stack's roots and those retained for blocks. */
export function serializedRootFiles(snapshot: Record<string, unknown>): Map<number, unknown> {
  const roots = new Map<number, unknown>();
  for (const scopes of [snapshot.frames, snapshot.retainedScopes]) {
    if (!Array.isArray(scopes)) continue;
    for (const frame of scopes) {
      if (isPlainRecord(frame) && frame.file !== null && nonNegativeSafeInteger(frame.id)) {
        roots.set(frame.id, frame.file);
      }
    }
  }
  return roots;
}

/** Whether a root exists for code of this function, one of its file's activations. */
export function rootFitsFunction(
  plan: InstructionPlan | undefined,
  roots: ReadonlyMap<number, unknown>,
  rootId: unknown,
  functionId: unknown,
): boolean {
  if (!nonNegativeSafeInteger(rootId) || !roots.has(rootId)) return false;
  if (plan === undefined) return true;
  const definition = nonNegativeSafeInteger(functionId)
    ? plan.functions[functionId - 1]
    : undefined;
  // A global function and its blocks run for the activation of any file that calls them.
  return (
    definition !== undefined &&
    (definition.global ||
      roots.get(rootId) === fileOfInstruction(plan, definition.entryInstruction))
  );
}

/** Whether an instruction is code of a global function or one of its blocks, which runs for any file's activation. */
export function inGlobalCode(plan: InstructionPlan, instruction: number): boolean {
  return plan.functions.some(
    (definition) =>
      definition.global &&
      instruction >= definition.entryInstruction &&
      instruction < definition.endInstruction,
  );
}

/** The file of each instruction of a plan, built once per plan. */
const instructionFiles = new WeakMap<InstructionPlan, Int32Array>();

/** The index of the file whose instructions include this one, or -1. */
export function fileOfInstruction(plan: InstructionPlan, instruction: number): number {
  let files = instructionFiles.get(plan);
  if (files === undefined) {
    files = new Int32Array(plan.instructions.length).fill(-1);
    plan.files.forEach((file, index) => {
      files!.fill(
        index,
        Math.max(0, file.startInstruction),
        Math.min(plan.instructions.length, file.endInstruction),
      );
    });
    instructionFiles.set(plan, files);
  }
  return Number.isSafeInteger(instruction) && instruction >= 0 && instruction < files.length
    ? files[instruction]!
    : -1;
}

/** The scopes a prepared reference may point into: the stack's and the retained roots. */
export function serializedScopes(snapshot: Record<string, unknown>): unknown[] {
  return [
    ...(Array.isArray(snapshot.frames) ? snapshot.frames : []),
    ...(Array.isArray(snapshot.retainedScopes) ? snapshot.retainedScopes : []),
  ];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
