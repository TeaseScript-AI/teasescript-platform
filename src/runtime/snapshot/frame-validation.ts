import type {
  SnapshotValidationAnalysis,
  PreparedSayTemporaryOwnership,
} from "./snapshot-validation-analysis.js";
import { isPlainRecord } from "../values/plain-data.js";
import {
  nonNegativeSafeInteger,
  validSpan,
  hasExactKeys,
  positiveSafeInteger,
  validSessionTime,
  type RuntimeParameterStateSnapshot,
} from "./state.js";
import { validateCapturedSerializableValue } from "../values/serializable-values.js";
import { isOneOf } from "../../plan/validation-support.js";
import {
  serializedContext,
  contextHoldsInstruction,
  serializedRootFiles,
  rootFitsFunction,
} from "../scopes/activation-validation.js";
import type { InstructionPlan, Instruction, CompiledFunctionDefinition } from "../../plan/model.js";
import {
  validatePreparedReferenceTemporaries,
  validatePreparedSayTemporaries,
  type ReferenceScopesById,
} from "./prepared-temporary-validation.js";
import { interruptibleActionRecord } from "../actions/interrupts.js";
import { validForegroundActionState } from "../actions/action-validation.js";
import { recordValidationTestWork } from "../../validation-testing.js";
import {
  requiredInstructionTemporaries,
  instructionKilledTemporaries,
  temporariesLiveBefore,
} from "../../plan/temporary-uses.js";
import { solveBackward, setUnion, sameSet } from "../../plan/dataflow.js";
import type { FlowEdge } from "../../plan/control-flow.js";

// The call, loop, and continuation invariants of a captured snapshot: its call and loop frames, temporaries,
// parameters, timer block frames, and the temporaries a suspended continuation still needs.

export function validateLoopFrames(
  value: unknown,
  frames: unknown,
  nextInstruction: unknown,
  callFrames: unknown,
  callFrameIds: ReadonlySet<number>,
  analysis: SnapshotValidationAnalysis | undefined,
  snapshotValue: Record<string, unknown>,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push("Runtime loopFrames must be an array.");
    return;
  }
  const frameCount = Array.isArray(frames) ? frames.length : 0;
  let previousDepth = 0;
  for (const frame of value) {
    if (
      !isPlainRecord(frame) ||
      !nonNegativeSafeInteger(frame.loopId) ||
      frame.loopId < 1 ||
      !nonNegativeSafeInteger(frame.scopeDepth) ||
      frame.scopeDepth < 1 ||
      frame.scopeDepth > frameCount
    ) {
      errors.push("Runtime loop frame is malformed.");
      continue;
    }
    if (
      frame.callFrameId !== null &&
      (!nonNegativeSafeInteger(frame.callFrameId) || !callFrameIds.has(frame.callFrameId))
    ) {
      errors.push("Runtime loop frame has an unknown call-frame owner.");
    }
    if (frame.scopeDepth < previousDepth) {
      errors.push("Runtime loop frame scope depths are out of order.");
    }
    previousDepth = frame.scopeDepth;
    if (frame.kind === "repeat") {
      if (!nonNegativeSafeInteger(frame.remaining)) {
        errors.push("Runtime repeat-loop state is malformed.");
      }
    } else if (frame.kind === "while") {
      // While loops need no additional hidden state.
    } else if (frame.kind === "for") {
      const failure = validateCapturedSerializableValue(frame.source, "loop.source");
      const pair = "valueVariable" in frame;
      if (
        typeof frame.variable !== "string" ||
        frame.variable.length === 0 ||
        (pair &&
          (typeof frame.valueVariable !== "string" ||
            frame.valueVariable.length === 0 ||
            frame.valueVariable === frame.variable)) ||
        failure !== null ||
        !isPlainRecord(frame.source) ||
        // A pair loop goes through a dict; any other through a list, set, or range.
        !(pair
          ? frame.source.kind === "dict"
          : isOneOf(frame.source.kind, ["list", "set", "range"])) ||
        !nonNegativeSafeInteger(frame.position) ||
        frame.position > iterationLength(frame.source)
      ) {
        errors.push("Runtime for-loop iterator state is malformed.");
      }
    } else {
      errors.push("Runtime loop kind is unsupported.");
    }
  }
  if (Array.isArray(callFrames)) {
    validateLoopContexts(
      value,
      frames,
      nextInstruction,
      callFrames,
      analysis,
      snapshotValue,
      errors,
    );
  }
}

/**
 * Each context owns the loops between its call frame's loop base and the next call frame's, and runs them in its own
 * scopes. At the position where a context stands (the next instruction, or the call or interrupted position it resumes
 * from), exactly the loops whose body holds that position are active, in nesting order; a loop whose header holds it
 * may be active. Loops are identified per context, so a recursive call runs its own instance of the same loop.
 */
function validateLoopContexts(
  loops: readonly unknown[],
  frames: unknown,
  nextInstruction: unknown,
  callFrames: readonly unknown[],
  analysis: SnapshotValidationAnalysis | undefined,
  snapshotValue: Record<string, unknown>,
  errors: string[],
): void {
  const frameList = Array.isArray(frames) ? frames : [];
  const plan = analysis?.plan;
  const plannedLoops = analysis?.loops ?? new Map<number, never>();
  const depth = (frame: unknown, key: "loopBaseDepth" | "scopeBaseDepth", fallback: number) =>
    isPlainRecord(frame) && nonNegativeSafeInteger(frame[key]) ? frame[key] : fallback;
  // The call frames' own checks report impossible bases; only real, ordered partitions are walked.
  let previousBase = 0;
  for (const frame of callFrames) {
    const base = depth(frame, "loopBaseDepth", -1);
    if (base < previousBase || base > loops.length) return;
    previousBase = base;
  }
  for (let level = 0; level <= callFrames.length; level += 1) {
    const below = level === 0 ? undefined : callFrames[level - 1];
    const above = callFrames[level];
    const owner = level === 0 ? null : isPlainRecord(below) ? below.id : undefined;
    const loopStart = depth(below, "loopBaseDepth", 0);
    const loopEnd = level === callFrames.length ? loops.length : depth(above, "loopBaseDepth", 0);
    const scopeStart = depth(below, "scopeBaseDepth", 0);
    const scopeEnd =
      level === callFrames.length ? frameList.length : depth(above, "scopeBaseDepth", 0);
    // A call stands at its call instruction; an interrupted context resumes where it was interrupted. After `exit`
    // the position follows the exit wherever it stood, with no loops left.
    const position =
      level === callFrames.length
        ? snapshotValue.status === "halted"
          ? undefined
          : nextInstruction
        : isPlainRecord(above) && nonNegativeSafeInteger(above.returnInstruction)
          ? isPlainRecord(above.timerInterruption)
            ? above.returnInstruction
            : above.returnInstruction - 1
          : undefined;
    const context = serializedContext(snapshotValue, level);
    const active = new Set<number>();
    let previousStart = -1;
    // A loop runs in the scopes above those of the loop around it, whose body opened a scope of its own.
    let outerDepth = scopeStart;
    for (let index = loopStart; index < loopEnd; index += 1) {
      const frame = loops[index];
      if (!isPlainRecord(frame) || !nonNegativeSafeInteger(frame.loopId)) continue;
      const planned = plannedLoops.get(frame.loopId);
      const scopeDepth = nonNegativeSafeInteger(frame.scopeDepth) ? frame.scopeDepth : -1;
      const inBody =
        planned !== undefined &&
        nonNegativeSafeInteger(position) &&
        position > planned.start &&
        position < planned.target;
      // Without a plan, the position cannot tell whether the loop's body, with its own scope, holds it.
      if (
        frame.callFrameId !== owner ||
        active.has(frame.loopId) ||
        scopeDepth <= outerDepth ||
        (plan === undefined
          ? scopeDepth > scopeEnd
          : inBody
            ? scopeDepth >= scopeEnd
            : scopeDepth !== scopeEnd) ||
        (scopeDepth < frameList.length &&
          (!isPlainRecord(frameList[scopeDepth]) || frameList[scopeDepth].file !== null))
      ) {
        errors.push("Runtime loop frame does not belong to its call context.");
      }
      active.add(frame.loopId);
      if (scopeDepth > outerDepth) outerDepth = scopeDepth;
      if (plan === undefined) continue;
      if (
        planned === undefined ||
        planned.kind !== frame.kind ||
        (planned.kind === "for" &&
          (planned.variable !== frame.variable || planned.valueVariable !== frame.valueVariable)) ||
        context === undefined ||
        !contextHoldsInstruction(plan, context, planned.start) ||
        planned.start <= previousStart ||
        !nonNegativeSafeInteger(position) ||
        position < planned.continueStart ||
        position >= planned.target
      ) {
        errors.push("Runtime loop frame does not match the instruction plan.");
      }
      previousStart = planned?.start ?? previousStart;
    }
    if (plan === undefined || context === undefined || !nonNegativeSafeInteger(position)) continue;
    for (const [loopId, planned] of plannedLoops) {
      if (
        position > planned.start &&
        position < planned.target &&
        !active.has(loopId) &&
        contextHoldsInstruction(plan, context, planned.start)
      ) {
        errors.push("Runtime state is missing a loop that its position runs in.");
        break;
      }
    }
  }
}

function iterationLength(source: Record<string, unknown>): number {
  if ((source.kind === "list" || source.kind === "set") && Array.isArray(source.items)) {
    return source.items.length;
  }
  if (source.kind === "dict" && Array.isArray(source.entries)) return source.entries.length;
  if (
    source.kind === "range" &&
    Number.isSafeInteger(source.start) &&
    Number.isSafeInteger(source.end) &&
    typeof source.inclusive === "boolean"
  ) {
    // EVIDENCE: validation: both range endpoints passed Number.isSafeInteger above.
    const size = (source.end as number) - (source.start as number) + (source.inclusive ? 1 : 0);
    return Number.isSafeInteger(size) ? Math.max(0, size) : -1;
  }
  return -1;
}

export function validateTemporaries(
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
      !nonNegativeSafeInteger(temporary.id) ||
      temporary.id < 1 ||
      (plan !== undefined && temporary.id > plan.temporaryCount)
    ) {
      errors.push(`${label} contain an invalid temporary ID.`);
      continue;
    }
    if (ids.has(temporary.id)) errors.push(`${label} contain duplicate temporary IDs.`);
    ids.add(temporary.id);
    const failure = validateCapturedSerializableValue(temporary.value);
    if (failure !== null) errors.push(failure);
  }
}

export function validateCallFrames(
  value: unknown,
  frames: unknown,
  speakers: unknown,
  loopFrames: unknown,
  nextInstruction: unknown,
  maxCallDepth: unknown,
  plan: InstructionPlan | undefined,
  analysis: SnapshotValidationAnalysis | undefined,
  continuationRequests: ContinuationRequests,
  scopesById: ReferenceScopesById,
  preparedReferenceTemporaries: ReadonlyMap<number, boolean> | undefined,
  preparedSayTemporaryOwnership: PreparedSayTemporaryOwnership | undefined,
  snapshotValue: Record<string, unknown>,
  errors: string[],
): Set<number> {
  const ids = new Set<number>();
  let handlerFrameSeen = false;
  if (!Array.isArray(value)) {
    errors.push("Runtime callFrames must be an array.");
    return ids;
  }
  // An expiry block's interrupt frame is not an author call, so it may exceed the call-depth limit by one.
  const interruptFrames = value.filter(
    (frame) => isPlainRecord(frame) && isPlainRecord(frame.timerInterruption),
  ).length;
  if (
    nonNegativeSafeInteger(maxCallDepth) &&
    value.length > maxCallDepth + Math.min(1, interruptFrames)
  ) {
    errors.push("Runtime call stack exceeds maxCallDepth.");
  }
  const frameCount = Array.isArray(frames) ? frames.length : 0;
  const loopCount = Array.isArray(loopFrames) ? loopFrames.length : 0;
  const roots = serializedRootFiles(snapshotValue);
  let previousId = 0;
  let previousScopeBase = 0;
  let previousLoopBase = 0;
  value.forEach((frame, frameIndex) => {
    if (!isPlainRecord(frame)) {
      errors.push("Runtime call frame is malformed.");
      return;
    }
    if (!nonNegativeSafeInteger(frame.id) || frame.id < 1 || ids.has(frame.id)) {
      errors.push("Runtime call-frame IDs must be unique positive integers.");
    } else {
      if (frame.id <= previousId) errors.push("Runtime call-frame IDs are out of order.");
      previousId = frame.id;
      ids.add(frame.id);
    }
    if (frame.kind !== "function" && frame.kind !== "file") {
      errors.push("Runtime call frame is malformed.");
      return;
    }
    // A file call has no function: it continues after its `call` when the called file ends.
    const isFunction = frame.kind === "function";
    if (!isFunction) validateFileCallFrame(frame, frames, plan, errors);
    const definition =
      isFunction && nonNegativeSafeInteger(frame.functionId)
        ? analysis?.functionsById.get(frame.functionId)
        : undefined;
    const interruption = isFunction ? frame.timerInterruption : null;
    // A function sees the top-level names of the activation it was called in; a block, those of its creator's.
    if (
      isFunction &&
      (!rootFitsFunction(plan, roots, frame.rootScopeId, frame.functionId) ||
        (!isPlainRecord(interruption) &&
          frame.rootScopeId !== serializedContext(snapshotValue, frameIndex)?.rootId))
    ) {
      errors.push("Runtime call frame refers to an impossible activation.");
    }
    if (!isFunction) {
      // Validated above.
    } else if (
      !Object.hasOwn(frame, "timerInterruption") ||
      (interruption !== null && !isPlainRecord(interruption)) ||
      (definition !== undefined && (definition.handler !== null) !== (interruption !== null))
    ) {
      errors.push("Runtime call frame does not match its function kind.");
    }
    if (isPlainRecord(interruption)) {
      if (handlerFrameSeen) errors.push("Runtime timer expiry blocks must not nest.");
      handlerFrameSeen = true;
      validateTimerHandlerFrame(
        frame,
        interruption,
        frameIndex,
        value,
        frames,
        loopFrames,
        snapshotValue,
        plan,
        errors,
      );
    }
    let callInstruction: Instruction | undefined;
    if (
      isFunction &&
      (!nonNegativeSafeInteger(frame.functionId) ||
        frame.functionId < 1 ||
        (plan !== undefined && definition === undefined) ||
        typeof frame.functionName !== "string" ||
        frame.functionName.length === 0 ||
        (definition !== undefined && frame.functionName !== definition.name) ||
        !validSpan(frame.callSiteSpan))
    ) {
      errors.push("Runtime call frame refers to a malformed or unknown function.");
    }
    if (isPlainRecord(interruption)) {
      // Validated with the interrupted position above.
    } else if (
      !nonNegativeSafeInteger(frame.returnInstruction) ||
      frame.returnInstruction < 1 ||
      (plan !== undefined && frame.returnInstruction > plan.instructions.length)
    ) {
      errors.push("Runtime call frame has an invalid return instruction.");
    } else if (plan !== undefined && !isFunction) {
      // The called activation may have gone to another file since, so its root need not be the call's file.
      const call = plan.instructions[frame.returnInstruction - 1];
      if (call?.kind !== "transfer" || call.mode !== "call") {
        errors.push("Runtime call frame return target does not match its call instruction.");
      }
    } else if (plan !== undefined) {
      const call = plan.instructions[frame.returnInstruction - 1];
      if (
        call?.kind !== "callFunction" ||
        call.functionId !== frame.functionId ||
        call.destinationTemporary !== frame.destinationTemporary ||
        call.returnInstruction !== frame.returnInstruction
      ) {
        errors.push("Runtime call frame return target does not match its call instruction.");
      } else {
        callInstruction = call;
      }
    }
    if (!isFunction) {
      // A file call has no result.
    } else if (
      isPlainRecord(interruption)
        ? frame.destinationTemporary !== null
        : !nonNegativeSafeInteger(frame.destinationTemporary) ||
          frame.destinationTemporary < 1 ||
          (plan !== undefined && frame.destinationTemporary > plan.temporaryCount)
    ) {
      errors.push("Runtime call frame has an invalid result destination.");
    }
    validateTemporaries(frame.callerTemporaries, plan, "Runtime caller temporaries", errors);
    validatePreparedReferenceTemporaries(
      frame.callerTemporaries,
      scopesById,
      speakers,
      preparedReferenceTemporaries,
      "Runtime caller temporaries",
      errors,
    );
    validatePreparedSayTemporaries(
      frame.callerTemporaries,
      speakers,
      preparedSayTemporaryOwnership,
      "Runtime caller temporaries",
      errors,
    );
    if (
      nonNegativeSafeInteger(frame.destinationTemporary) &&
      Array.isArray(frame.callerTemporaries) &&
      createTemporaryMap(frame.callerTemporaries).has(frame.destinationTemporary)
    ) {
      errors.push("Runtime caller temporaries already contain the result destination.");
    }
    if (
      !nonNegativeSafeInteger(frame.scopeBaseDepth) ||
      frame.scopeBaseDepth < 1 ||
      frame.scopeBaseDepth >= frameCount ||
      frame.scopeBaseDepth <= previousScopeBase
    ) {
      errors.push("Runtime call frame has an impossible scope base.");
    }
    if (nonNegativeSafeInteger(frame.scopeBaseDepth)) previousScopeBase = frame.scopeBaseDepth;
    if (
      !nonNegativeSafeInteger(frame.loopBaseDepth) ||
      frame.loopBaseDepth > loopCount ||
      frame.loopBaseDepth < previousLoopBase
    ) {
      errors.push("Runtime call frame has an impossible loop base.");
    }
    if (nonNegativeSafeInteger(frame.loopBaseDepth)) previousLoopBase = frame.loopBaseDepth;
    if (isFunction) {
      validateCallArguments(frame.arguments, frame.parameterState, definition, errors);
      validateCallArgumentSupply(frame.arguments, callInstruction, errors);
      validateParameterState(frame.parameterState, definition, errors);
      validateParameterBindings(frame, frames, definition, analysis, errors);
    }

    if (
      plan !== undefined &&
      nonNegativeSafeInteger(frame.returnInstruction) &&
      (!isFunction ||
        nonNegativeSafeInteger(frame.destinationTemporary) ||
        isPlainRecord(interruption)) &&
      Array.isArray(frame.callerTemporaries)
    ) {
      validateSuspendedContinuationTemporaries(
        frame.callerTemporaries,
        nonNegativeSafeInteger(frame.destinationTemporary) ? frame.destinationTemporary : null,
        frame.returnInstruction,
        // The caller stands at its call, or where it was interrupted.
        isPlainRecord(interruption) ? frame.returnInstruction : frame.returnInstruction - 1,
        contextLoopIds(
          Array.isArray(loopFrames) ? loopFrames : [],
          nonNegativeSafeInteger(frame.loopBaseDepth) ? frame.loopBaseDepth : 0,
          callContextOwner(value, frameIndex),
        ),
        analysis!,
        continuationRequests,
        errors,
      );
    }

    if (
      plan !== undefined &&
      nonNegativeSafeInteger(frame.returnInstruction) &&
      !isPlainRecord(interruption)
    ) {
      const caller = serializedContext(snapshotValue, frameIndex);
      if (
        caller === undefined ||
        !contextHoldsInstruction(plan, caller, frame.returnInstruction - 1)
      ) {
        errors.push("Runtime call frame return instruction is outside its caller.");
      }
    }

    if (definition !== undefined) {
      const child = frameIndex < value.length - 1 ? value[frameIndex + 1] : undefined;
      if (
        frameIndex === value.length - 1 &&
        (!nonNegativeSafeInteger(nextInstruction) ||
          nextInstruction < definition.entryInstruction ||
          nextInstruction >= definition.endInstruction)
      ) {
        errors.push("Runtime next instruction is outside the active function.");
      } else if (frameIndex === value.length - 1 && nonNegativeSafeInteger(nextInstruction)) {
        validateExactParameterPosition(
          frame.parameterState,
          definition,
          nextInstruction,
          analysis!,
          errors,
        );
      } else if (
        isPlainRecord(child) &&
        nonNegativeSafeInteger(child.returnInstruction) &&
        isPlainRecord(child.timerInterruption)
      ) {
        // An expiry block interrupted this function exactly at its recorded position.
        if (
          child.returnInstruction < definition.entryInstruction ||
          child.returnInstruction >= definition.endInstruction
        ) {
          errors.push("Runtime timer expiry block interrupted outside its caller.");
        } else {
          validateExactParameterPosition(
            frame.parameterState,
            definition,
            child.returnInstruction,
            analysis!,
            errors,
          );
        }
      } else if (isPlainRecord(child) && nonNegativeSafeInteger(child.returnInstruction)) {
        validateExactParameterPosition(
          frame.parameterState,
          definition,
          child.returnInstruction - 1,
          analysis!,
          errors,
        );
        validateExactParameterPosition(
          frame.parameterState,
          definition,
          child.returnInstruction,
          analysis!,
          errors,
        );
      }
    }
  });
  return ids;
}

const FILE_CALL_FRAME_KEYS = [
  "kind",
  "id",
  "callSiteSpan",
  "returnInstruction",
  "callerTemporaries",
  "scopeBaseDepth",
  "loopBaseDepth",
] as const;

/** A file call's own fields; its return and caller state are validated with every call frame. */
function validateFileCallFrame(
  frame: Record<string, unknown>,
  frames: unknown,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  const root =
    Array.isArray(frames) && nonNegativeSafeInteger(frame.scopeBaseDepth)
      ? frames[frame.scopeBaseDepth]
      : undefined;
  if (
    !hasExactKeys(frame, FILE_CALL_FRAME_KEYS) ||
    !validSpan(frame.callSiteSpan) ||
    !isPlainRecord(root) ||
    !nonNegativeSafeInteger(root.file) ||
    (plan !== undefined && root.file >= plan.files.length)
  ) {
    errors.push("Runtime file call frame is malformed.");
  }
}

/**
 * An expiry-block frame records the interrupted position, the scene time the block started, for a timer's block the
 * rounds that ran out wholly inside it, and, while it is still pending, the interrupted foreground action. That
 * action is validated against the interrupted context: the caller's scopes, loops, call frames, and temporaries at the
 * recorded position, at the time the block started.
 */
function validateTimerHandlerFrame(
  frame: Record<string, unknown>,
  interruption: Record<string, unknown>,
  frameIndex: number,
  callFrames: unknown[],
  frames: unknown,
  loopFrames: unknown,
  snapshotValue: Record<string, unknown>,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  const now = snapshotValue.currentSessionTimeMs;
  const owner = Object.hasOwn(interruption, "mediaId")
    ? "mediaId"
    : Object.hasOwn(interruption, "buttonId")
      ? "buttonId"
      : "timerId";
  // A timer's block also records the rounds that ran out wholly inside it.
  const keys = [owner, "dueAtMs", "startedAtMs", "suspendedAction"];
  if (owner === "timerId") keys.push("currentRoundInBlock", "endedRoundMs");
  const endedRoundMs = interruption.endedRoundMs ?? null;
  if (
    !hasExactKeys(interruption, keys) ||
    (owner === "timerId" && typeof interruption.currentRoundInBlock !== "boolean") ||
    (endedRoundMs !== null &&
      !(typeof endedRoundMs === "number" && Number.isFinite(endedRoundMs) && endedRoundMs >= 0)) ||
    !positiveSafeInteger(interruption[owner]) ||
    !validSessionTime(interruption.dueAtMs) ||
    !validSessionTime(interruption.startedAtMs) ||
    !validSessionTime(now) ||
    interruption.dueAtMs > interruption.startedAtMs ||
    interruption.startedAtMs > now ||
    !Array.isArray(frame.arguments) ||
    frame.arguments.length !== 0
  ) {
    errors.push("Runtime timer expiry-block frame is malformed.");
    return;
  }
  const resume = frame.returnInstruction;
  const caller = serializedContext(snapshotValue, frameIndex);
  if (
    !nonNegativeSafeInteger(resume) ||
    (plan !== undefined && (caller === undefined || !contextHoldsInstruction(plan, caller, resume)))
  ) {
    errors.push("Runtime timer expiry block interrupted outside its caller.");
    return;
  }
  const scopeBase = frame.scopeBaseDepth;
  const loopBase = frame.loopBaseDepth;
  if (!nonNegativeSafeInteger(scopeBase) || !nonNegativeSafeInteger(loopBase)) return;
  const interruptedLoops = Array.isArray(loopFrames) ? loopFrames.slice(0, loopBase) : [];
  const action = interruption.suspendedAction;
  validateCurrentTemporaryRequirements(
    frame.callerTemporaries,
    activeLoopIdOf(interruptedLoops, callContextOwner(callFrames, frameIndex)),
    resume,
    "running",
    isPlainRecord(action) && action.kind === "chatPacingGate",
    plan,
    errors,
  );
  validateSelfHandleBinding(frame, interruption, frames, plan, errors);
  if (action === null) return;
  // The suspended action stands still from the block's start, so its time is checked as of then.
  const view = {
    ...snapshotValue,
    currentSessionTimeMs: interruption.startedAtMs,
    nextInstruction: resume,
    frames: Array.isArray(frames) ? frames.slice(0, scopeBase) : frames,
    loopFrames: interruptedLoops,
    callFrames: callFrames.slice(0, frameIndex),
    temporaries: frame.callerTemporaries,
    foregroundAction: action,
    status: "waiting",
  };
  if (
    !isPlainRecord(action) ||
    !interruptibleActionRecord(action) ||
    !validForegroundActionState(action, view, plan, true)
  ) {
    errors.push("Runtime suspended foreground action is malformed.");
  }
}

/**
 * Until a media block's body starts, its self-handle local holds exactly its own media's handle; afterwards the
 * block may reassign it like any local.
 */
function validateSelfHandleBinding(
  frame: Record<string, unknown>,
  interruption: Record<string, unknown>,
  frames: unknown,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  if (plan === undefined || !nonNegativeSafeInteger(frame.functionId)) return;
  const definition = plan.functions[frame.functionId - 1];
  if (
    definition?.selfHandle == null ||
    !isPlainRecord(frame.parameterState) ||
    frame.parameterState.phase === "body"
  )
    return;
  const scope =
    Array.isArray(frames) && nonNegativeSafeInteger(frame.scopeBaseDepth)
      ? frames[frame.scopeBaseDepth]
      : undefined;
  const binding =
    isPlainRecord(scope) && Array.isArray(scope.bindings)
      ? scope.bindings.find(
          (candidate) => isPlainRecord(candidate) && candidate.name === definition.selfHandle,
        )
      : undefined;
  const value = isPlainRecord(binding) ? binding.value : undefined;
  if (
    !isPlainRecord(value) ||
    value.kind !== "mediaHandle" ||
    value.mediaId !== interruption.mediaId
  ) {
    errors.push("Runtime media block self-handle binding is malformed.");
  }
}

function validateCallArgumentSupply(
  argumentsValue: unknown,
  callInstruction: Instruction | undefined,
  errors: string[],
): void {
  if (!Array.isArray(argumentsValue) || callInstruction?.kind !== "callFunction") {
    return;
  }
  const suppliedParameters = new Set(
    callInstruction.arguments.map((argument) => argument.parameterName),
  );
  for (const argument of argumentsValue) {
    if (
      !isPlainRecord(argument) ||
      typeof argument.parameterName !== "string" ||
      typeof argument.supplied !== "boolean"
    )
      continue;
    if (argument.supplied !== suppliedParameters.has(argument.parameterName)) {
      errors.push("Runtime supplied arguments do not match the call instruction.");
    }
  }
}

function createTemporaryMap(
  temporaries: readonly unknown[],
): ReadonlyMap<number, Record<string, unknown>> {
  const result = new Map<number, Record<string, unknown>>();
  for (const temporary of temporaries) {
    if (isPlainRecord(temporary) && nonNegativeSafeInteger(temporary.id)) {
      result.set(temporary.id, temporary);
    }
  }
  return result;
}

function validateParameterBindings(
  frame: Record<string, unknown>,
  frames: unknown,
  definition: CompiledFunctionDefinition | undefined,
  analysis: SnapshotValidationAnalysis | undefined,
  errors: string[],
): void {
  if (
    definition === undefined ||
    !Array.isArray(frames) ||
    !nonNegativeSafeInteger(frame.scopeBaseDepth) ||
    !Array.isArray(frame.arguments) ||
    !isPlainRecord(frame.parameterState) ||
    !nonNegativeSafeInteger(frame.parameterState.parameterIndex)
  ) {
    return;
  }
  const scope = frames[frame.scopeBaseDepth];
  if (!isPlainRecord(scope) || !Array.isArray(scope.bindings)) return;
  const argumentsList = frame.arguments;
  const parameterState = frame.parameterState;
  const bindingNames = new Set(
    scope.bindings
      .filter(isPlainRecord)
      .map((binding) => binding.name)
      .filter((name): name is string => typeof name === "string"),
  );
  if (
    parameterState.phase !== "body" &&
    [...bindingNames].some((name) => !analysis?.parameterNames.get(definition.id)?.has(name))
  ) {
    errors.push("Runtime function prologue contains a non-parameter binding.");
  }
  definition.parameters.forEach((parameter, index) => {
    const argument = argumentsList[index];
    if (!isPlainRecord(argument) || typeof argument.supplied !== "boolean") return;
    const phase = parameterState.phase;
    // EVIDENCE: validation: parameterIndex passed nonNegativeSafeInteger before iterating parameters.
    const progress = parameterState.parameterIndex as number;
    const shouldBeBound = argument.supplied
      ? suppliedParameterBound(parameterState, index)
      : phase === "body" || (phase === "defaults" && index < progress);
    if (bindingNames.has(parameter.name) !== shouldBeBound) {
      errors.push("Runtime parameter bindings do not match prologue progress.");
    }
  });
}

/** Whether the prologue at `progress` has bound the supplied argument at `index`, whose binding then owns its value. */
function suppliedParameterBound(progress: Record<string, unknown>, index: number): boolean {
  return (
    progress.phase === "body" ||
    progress.phase === "defaults" ||
    (progress.phase === "supplied" &&
      typeof progress.parameterIndex === "number" &&
      index < progress.parameterIndex)
  );
}

function validateCallArguments(
  value: unknown,
  parameterState: unknown,
  definition: CompiledFunctionDefinition | undefined,
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
    // A malformed prologue state is reported on its own; the argument is then checked as if it were not bound yet.
    const bound = isPlainRecord(parameterState) && suppliedParameterBound(parameterState, index);
    if (argument.supplied && !bound) {
      if (!("value" in argument)) {
        errors.push("Supplied runtime argument is missing its value.");
      } else {
        const failure = validateCapturedSerializableValue(argument.value);
        if (failure !== null) errors.push(failure);
      }
    } else if ("value" in argument) {
      errors.push(
        argument.supplied
          ? "A bound runtime argument must not keep its value."
          : "Missing runtime argument must not contain a value.",
      );
    }
  });
}

function validateParameterState(
  value: unknown,
  definition: CompiledFunctionDefinition | undefined,
  errors: string[],
): void {
  if (
    !isPlainRecord(value) ||
    !isOneOf(value.phase, ["supplied", "defaults", "body"]) ||
    !nonNegativeSafeInteger(value.parameterIndex) ||
    (definition !== undefined && value.parameterIndex > definition.parameters.length) ||
    (value.phase === "body" &&
      definition !== undefined &&
      value.parameterIndex !== definition.parameters.length)
  ) {
    errors.push("Runtime parameter-prologue state is malformed.");
  }
}

function validateExactParameterPosition(
  value: unknown,
  definition: CompiledFunctionDefinition,
  instructionPosition: number,
  analysis: SnapshotValidationAnalysis,
  errors: string[],
): void {
  if (!isPlainRecord(value) || !nonNegativeSafeInteger(value.parameterIndex)) return;
  const expected = expectedParameterProgress(definition, instructionPosition, analysis);
  if (
    expected === null ||
    value.phase !== expected.phase ||
    value.parameterIndex !== expected.parameterIndex
  ) {
    errors.push("Runtime parameter progress does not match its exact instruction position.");
  }
}

function expectedParameterProgress(
  definition: CompiledFunctionDefinition,
  instructionPosition: number,
  analysis: SnapshotValidationAnalysis,
): RuntimeParameterStateSnapshot | null {
  const parameterCount = definition.parameters.length;
  if (
    instructionPosition >= definition.entryInstruction &&
    instructionPosition < definition.entryInstruction + parameterCount
  ) {
    return { phase: "supplied", parameterIndex: instructionPosition - definition.entryInstruction };
  }
  let cursor = definition.entryInstruction + parameterCount;
  if (instructionPosition === cursor) {
    return { phase: "supplied", parameterIndex: parameterCount };
  }
  cursor += 1;
  for (let parameterIndex = 0; parameterIndex < parameterCount; parameterIndex += 1) {
    const prepare = analysis.plan.instructions[cursor];
    if (prepare?.kind !== "prepareParameterDefault") return null;
    if (instructionPosition === cursor) {
      return { phase: "defaults", parameterIndex };
    }
    const bindIndex =
      analysis.defaultBindingPositions.get(`${definition.id}:${parameterIndex}`) ?? -1;
    if (instructionPosition > cursor && instructionPosition < prepare.target) {
      return {
        phase: "defaults",
        parameterIndex:
          bindIndex >= 0 && instructionPosition > bindIndex ? parameterIndex + 1 : parameterIndex,
      };
    }
    cursor = prepare.target;
  }
  if (instructionPosition === definition.bodyEntryInstruction - 1) {
    return { phase: "defaults", parameterIndex: parameterCount };
  }
  if (
    instructionPosition >= definition.bodyEntryInstruction &&
    instructionPosition < definition.endInstruction
  ) {
    return { phase: "body", parameterIndex: parameterCount };
  }
  return null;
}

function validateSuspendedContinuationTemporaries(
  callerTemporaries: unknown[],
  destinationTemporary: number | null,
  returnInstruction: number,
  callerPosition: number,
  contextLoops: readonly number[],
  analysis: SnapshotValidationAnalysis,
  continuationRequests: ContinuationRequests,
  errors: string[],
): void {
  const present = new Set(createTemporaryMap(callerTemporaries).keys());
  if (destinationTemporary !== null) present.add(destinationTemporary);
  const required = requiredContinuationTemporaries(
    analysis,
    returnInstruction,
    callerPosition,
    contextLoops,
    continuationRequests,
  );
  if ([...required].some((temporaryId) => !present.has(temporaryId))) {
    errors.push("Runtime caller temporaries cannot resume the suspended continuation.");
  }
}

/**
 * One snapshot validation's continuation liveness. Its continuations with the same loops share one graph, which each
 * query extends with the nodes it reaches; `required` holds what each continuation it asked about needs.
 */
export interface ContinuationRequests {
  readonly graphs: Map<string, ContinuationGraph>;
  readonly required: Map<string, ReadonlySet<number>>;
}

/** Analysed nodes, each with what it needs; closed under successors, so every result is final. */
type ContinuationGraph = Map<number, ReadonlySet<number>>;

/** Shared by every node that needs no temporary. */
const NOTHING_LIVE: ReadonlySet<number> = new Set<number>();

export function requiredContinuationTemporaries(
  analysis: SnapshotValidationAnalysis,
  startInstruction: number,
  callerPosition: number,
  contextLoops: readonly number[],
  continuationRequests: ContinuationRequests,
): ReadonlySet<number> {
  // A continuation by where it resumes and the loops of its context, outermost first.
  const kept = analysis.continuationRequirements.get(
    `${startInstruction}:${contextLoops.join(",")}`,
  );
  if (kept !== undefined) return kept;
  const activeLoops = analysableLoops(analysis, contextLoops, callerPosition);
  const loopsKey = activeLoops.join(",");
  const key = `${startInstruction}:${loopsKey}`;
  const known =
    analysis.continuationRequirements.get(key) ?? continuationRequests.required.get(key);
  if (known !== undefined) return known;
  let graph = continuationRequests.graphs.get(loopsKey);
  if (graph === undefined) {
    graph = new Map();
    continuationRequests.graphs.set(loopsKey, graph);
  }
  const required = continuationRequirement(analysis, startInstruction, activeLoops, graph);
  continuationRequests.required.set(key, required);
  return required;
}

/**
 * The context's loops as a continuation query uses them: a list that a session can have where its caller stands, as
 * loop validation requires. That is planned loops in nesting order whose header or body holds the position, including
 * every loop whose body holds it, so the plan's nesting bounds both the list and the contexts of one position. Any
 * other list fails loop validation; its query uses only its innermost planned loop, so that impossible contexts can
 * neither enlarge nor multiply the analysis.
 */
function analysableLoops(
  analysis: SnapshotValidationAnalysis,
  loopIds: readonly number[],
  position: number,
): readonly number[] {
  const listed = new Set<number>();
  let previousStart = -1;
  let possible = true;
  for (const loopId of loopIds) {
    const loop = analysis.loops.get(loopId);
    if (
      loop === undefined ||
      loop.start <= previousStart ||
      position < loop.continueStart ||
      position >= loop.target
    ) {
      possible = false;
      break;
    }
    previousStart = loop.start;
    listed.add(loopId);
  }
  if (possible) {
    for (const [loopId, loop] of analysis.loops) {
      if (position > loop.start && position < loop.target && !listed.has(loopId)) {
        possible = false;
        break;
      }
    }
  }
  if (possible) return loopIds;
  const innermost = loopIds.at(-1);
  return innermost !== undefined && analysis.loops.has(innermost) ? [innermost] : [];
}

/**
 * An accepted snapshot's continuations are ones its session can resume, with validated loops, so the plan keeps what
 * they need.
 */
export function keepContinuationRequirements(
  analysis: SnapshotValidationAnalysis,
  continuationRequests: ContinuationRequests,
): void {
  for (const [key, required] of continuationRequests.required) {
    analysis.continuationRequirements.set(key, required);
  }
}

/**
 * The temporaries that a continuation reads before setting them: backward liveness over the control flow that it can
 * reach from `startInstruction`, and nothing else of the plan. A node is an instruction together with how many of the
 * context's loops are still active there. Leaving the innermost of them, at its loop start's exit or by its `break`,
 * ends it; a loop start reads its expression unless its loop is the innermost one still active, which it continues.
 */
function continuationRequirement(
  analysis: SnapshotValidationAnalysis,
  startInstruction: number,
  activeLoops: readonly number[],
  graph: ContinuationGraph,
): ReadonlySet<number> {
  const { plan } = analysis;
  // A position outside the runnable plan has nothing live.
  if (plan.instructions[startInstruction] === undefined) return NOTHING_LIVE;
  const depths = activeLoops.length + 1;
  const startNode = startInstruction * depths + activeLoops.length;
  // The nodes that this continuation reaches and earlier ones of the validation did not, with their ways on.
  const ways = new Map<number, readonly (number | null)[]>();
  const pending = [startNode];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (graph.has(node) || ways.has(node)) continue;
    // An instruction outside the runnable plan has nothing live.
    if (plan.instructions[Math.floor(node / depths)] === undefined) {
      graph.set(node, NOTHING_LIVE);
      continue;
    }
    const successors = continuationSuccessors(analysis, node, activeLoops);
    ways.set(node, successors);
    for (const successor of successors) if (successor !== null) pending.push(successor);
  }
  if (ways.size === 0) return graph.get(startNode) ?? NOTHING_LIVE;
  recordValidationTestWork("continuationLivenessAnalyses");
  recordValidationTestWork("continuationLivenessNodes", ways.size);

  // The added nodes in plan order, then the earlier ones they lead to, whose needs are final.
  const added = Array.from(ways.keys()).sort((left, right) => left - right);
  const local = new Map<number, number>();
  added.forEach((node, index) => local.set(node, index));
  const known: [number, ReadonlySet<number>][] = [];
  const addedWays = added.map((node) =>
    ways.get(node)!.map((successor) => {
      if (successor === null) return { node: null, edge: null };
      let index = local.get(successor);
      if (index === undefined) {
        index = local.size;
        local.set(successor, index);
        known.push([index, graph.get(successor)!]);
      }
      return { node: index, edge: null };
    }),
  );
  const read = added.map((node) => {
    const instruction = plan.instructions[Math.floor(node / depths)]!;
    return requiredInstructionTemporaries(instruction, activeLoops[(node % depths) - 1] ?? null);
  });
  const killed = added.map((node) =>
    instructionKilledTemporaries(plan.instructions[Math.floor(node / depths)]!),
  );
  const needs = solveBackward<ReadonlySet<number>, null>(
    {
      nodeCount: local.size,
      successors: (index) => addedWays[index]!,
      join: setUnion,
      equals: sameSet,
      transfer: (index, _edge, after) => {
        const live = temporariesLiveBefore(read[index]!, killed[index]!, after ?? NOTHING_LIVE);
        return live.size === 0 ? null : live;
      },
    },
    known,
  );
  added.forEach((node, index) => graph.set(node, needs[index] ?? NOTHING_LIVE));
  return graph.get(startNode)!;
}

/**
 * The ways on from a node of a continuation's graph: for each way of its instruction that stays in the instruction's
 * region and on this path, the node with how many of the context's loops are still active after it, and `null` for
 * each other way, which leaves the graph.
 */
function continuationSuccessors(
  analysis: SnapshotValidationAnalysis,
  node: number,
  activeLoops: readonly number[],
): (number | null)[] {
  const { plan } = analysis;
  const depths = activeLoops.length + 1;
  const index = Math.floor(node / depths);
  const active = node % depths;
  const innermost = activeLoops[active - 1] ?? null;
  const instruction = plan.instructions[index]!;
  const regionEnd = analysis.regionEnds[index] ?? plan.instructions.length;
  const successors: (number | null)[] = [];
  for (const { edge, target } of analysis.controlFlow.successors(index)) {
    if (target === null || target >= regionEnd || !CONTINUATION_WAYS.has(edge.kind)) {
      successors.push(null);
      continue;
    }
    const leaves =
      (edge.kind === "exhausted" || edge.kind === "break") &&
      (instruction.kind === "loopStart" || instruction.kind === "loopControl") &&
      instruction.loopId === innermost;
    successors.push(target * depths + (leaves ? active - 1 : active));
  }
  return successors;
}

/**
 * The ways that a continuation follows. A goto, a transfer to a file, an end, an exit, or a return leaves this path with
 * no temporaries, so nothing it holds stays live; a call runs in a frame of its own and comes back at its `resume`. The
 * way past a parameter default for a supplied argument is not followed: a frame either supplies the argument or runs
 * the default, and following that way too would ask a frame that runs the default for a temporary that the default
 * sets itself. In a compiled plan both ways need the same.
 */
const CONTINUATION_WAYS: ReadonlySet<FlowEdge["kind"]> = new Set<FlowEdge["kind"]>([
  "next",
  "true",
  "false",
  "jump",
  "iterate",
  "exhausted",
  "continue",
  "break",
  "resume",
  "omitted",
]);

/**
 * The temporaries the next instruction reads must be present and those it writes absent. `readingTime` marks a say
 * that waits for its own reading time: it has run already, so its handle is present.
 */
export function validateCurrentTemporaryRequirements(
  temporaries: unknown,
  activeLoopId: number | null,
  nextInstruction: unknown,
  status: unknown,
  readingTime: boolean,
  plan: InstructionPlan | undefined,
  errors: string[],
): void {
  if (
    plan === undefined ||
    status === "halted" ||
    !Array.isArray(temporaries) ||
    !nonNegativeSafeInteger(nextInstruction)
  ) {
    return;
  }
  const instruction = plan.instructions[nextInstruction];
  if (instruction === undefined) return;
  const required = requiredInstructionTemporaries(instruction, activeLoopId);
  const present = new Set(
    temporaries
      .filter(isPlainRecord)
      .map((temporary) => temporary.id)
      .filter((id): id is number => nonNegativeSafeInteger(id)),
  );
  if ([...required].some((id) => !present.has(id))) {
    errors.push("Runtime state is missing a temporary required by the next instruction.");
  }
  if (
    instruction.kind === "interaction" &&
    instruction.destinationTemporary !== null &&
    present.has(instruction.destinationTemporary)
  ) {
    errors.push("Runtime interaction result destination is already occupied.");
  }
  if (instruction.kind === "callFunction" && present.has(instruction.destinationTemporary)) {
    errors.push("Runtime function result destination is already occupied.");
  }
  if (instruction.kind === "capture" && present.has(instruction.destinationTemporary)) {
    errors.push("Runtime capture result destination is already occupied.");
  }
  if (instruction.kind === "fileStore" && present.has(instruction.destinationTemporary)) {
    errors.push("Runtime file store result destination is already occupied.");
  }
  if (instruction.kind === "lock" && present.has(instruction.destinationTemporary)) {
    errors.push("Runtime lock result destination is already occupied.");
  }
  if (
    instruction.kind === "say" &&
    instruction.destinationTemporary !== undefined &&
    present.has(instruction.destinationTemporary) !== readingTime
  ) {
    errors.push(
      readingTime
        ? "Runtime say that waits for its reading time lacks its result."
        : "Runtime say result destination is already occupied.",
    );
  }
}

/** The loops of a context, outermost first: the loop frames just before `end` that the context owns. */
function contextLoopIds(
  loopFrames: readonly unknown[],
  end: number,
  owner: number | null | undefined,
): number[] {
  const loopIds: number[] = [];
  for (let index = Math.min(end, loopFrames.length) - 1; index >= 0; index -= 1) {
    const frame = loopFrames[index];
    if (
      !isPlainRecord(frame) ||
      !nonNegativeSafeInteger(frame.loopId) ||
      frame.callFrameId !== owner
    )
      break;
    loopIds.push(frame.loopId);
  }
  return loopIds.reverse();
}

/** The innermost loop of a context: the last loop frame, when the context owns it. */
export function activeLoopIdOf(
  loopFrames: unknown,
  owner: number | null | undefined,
): number | null {
  const active = Array.isArray(loopFrames) ? loopFrames.at(-1) : undefined;
  return isPlainRecord(active) &&
    nonNegativeSafeInteger(active.loopId) &&
    active.callFrameId === owner
    ? active.loopId
    : null;
}

/** The owner of the context above `level` call frames (all of them for the top): `null` for the base activation. */
export function callContextOwner(callFrames: unknown, level: number): number | null | undefined {
  if (!Array.isArray(callFrames)) return null;
  const below: unknown = callFrames[Math.min(level, callFrames.length) - 1];
  if (below === undefined) return null;
  return isPlainRecord(below) && nonNegativeSafeInteger(below.id) ? below.id : undefined;
}
