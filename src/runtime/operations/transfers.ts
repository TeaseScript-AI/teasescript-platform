import type {
  EndInstruction,
  GotoInstruction,
  InstructionPlan,
  PlanComputedDestination,
  PlanDestination,
  PlanTransferDestination,
  PlanSourceLocation,
  SetFallbackInstruction,
  TransferInstruction,
} from "../../plan/model.js";
import { runsNothing } from "../activation-validation.js";
import { innermostFileCallIndex } from "../activations.js";
import { leaveScopes, sweepRetainedScopes } from "../captures.js";
import { RuntimeFault } from "../errors.js";
import { messageText } from "../text-length.js";
import type { Evaluator } from "../evaluator.js";
import { drawFromSessionGenerator, sampleIndex } from "../random-draws.js";
import type { TraceStore } from "../debug-trace.js";
import type { RandomControl } from "../random-control.js";
import { cloneTransferDestination } from "../state.js";
import { isScriptReference } from "../value-predicates.js";
import { describeValue } from "../value-types.js";
import type { InterpreterEvent } from "../events.js";
import type { RuntimeTimerSnapshot } from "../timers.js";
import type {
  RuntimeFileCallFrameSnapshot,
  RuntimeScopeFrameSnapshot,
  RuntimeSnapshot,
} from "../state.js";
import { assertCounterCanAdvance, assertEventSequenceCapacity, copySpan } from "./support.js";
import { stopTimerAction } from "./timer-lifecycle.js";
import {
  removePermanentButtons,
  type RuntimePermanentButtonSnapshot,
} from "../permanent-buttons.js";

/*
 * Transfers (ADR 0022 §5). Each entry into a file is an activation with its own top-level variables, in a root scope.
 * The current activation is the innermost one: the base activation, or the file called last. A transfer leaves the
 * functions, expiry or media blocks, loops, and blocks of the activation it continues in, so an action that a block
 * interrupted is abandoned rather than resumed. A non-persistent timer or permanent button belongs to the activation
 * that started or showed it and goes, with its queued blocks, when that activation is left: by a goto from it, by its
 * end, or when a block's goto abandons it. A call leaves nothing. Persistent timers and buttons and all media stay
 * (V30 §22, §27, §28). A root that leaves the stack stays retained while a block may still need it.
 */

/**
 * `goto label` continues the activation the code runs in: the current one, or one that called the current file, whose
 * later calls are then dropped. A block of a file the session has left brings that activation back in place of the
 * current one.
 */
export function executeGoto(
  instruction: GotoInstruction,
  snapshot: RuntimeSnapshot,
  rootId: number,
  events: InterpreterEvent[],
): void {
  const segment = activationIndex(snapshot, rootId);
  const retained =
    segment === undefined ? snapshot.retainedScopes.findIndex((root) => root.id === rootId) : -1;
  if (segment === undefined && retained < 0) {
    throw new Error("A goto runs in an activation that no longer exists.");
  }
  // The goto leaves its own activation and abandons those above it, or the current one for a left one.
  const left =
    segment !== undefined
      ? activationRootsFrom(snapshot, segment)
      : new Set([rootId, ...activationRootsFrom(snapshot, innermostFileCallIndex(snapshot))]);
  removeNonPersistentWork(snapshot, left, instruction.span, events);
  if (segment !== undefined) resetActivation(snapshot, segment);
  else replaceCurrentRoot(snapshot, snapshot.retainedScopes.splice(retained, 1)[0]!);
  snapshot.nextInstruction = instruction.target;
  sweepRetainedScopes(snapshot, true);
}

/** `goto` or `call` naming a file, or `call label`: a fresh activation of the destination's file. */
export function executeTransfer(
  plan: InstructionPlan,
  instruction: TransferInstruction,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
  events: InterpreterEvent[],
): void {
  assertCounterCanAdvance(snapshot.nextScopeId, "nextScopeId");
  if (instruction.mode === "call") {
    if (snapshot.callFrames.length >= snapshot.maxCallDepth) {
      throw new RuntimeFault(
        "TSR047",
        `Maximum TeaseScript call depth of ${snapshot.maxCallDepth} exceeded.`,
        copySpan(instruction.span),
      );
    }
    assertCounterCanAdvance(snapshot.nextCallFrameId, "nextCallFrameId");
  }
  const destination =
    "value" in instruction.destination
      ? resolveComputed(
          plan,
          instruction.destination,
          instruction.mode,
          evaluator,
          instruction.span,
        )
      : drawDestination(
          plan,
          snapshot,
          instruction.destination,
          evaluator.trace,
          evaluator.control,
        );
  const root = freshRoot(snapshot, destination);
  if (instruction.mode === "goto") {
    const left = activationRootsFrom(snapshot, innermostFileCallIndex(snapshot));
    removeNonPersistentWork(snapshot, left, instruction.span, events);
    replaceCurrentRoot(snapshot, root);
  } else {
    const call: RuntimeFileCallFrameSnapshot = {
      kind: "file",
      id: snapshot.nextCallFrameId,
      callSiteSpan: copySpan(instruction.span),
      returnInstruction: snapshot.nextInstruction + 1,
      callerTemporaries: snapshot.temporaries.map((temporary) => ({ ...temporary })),
      scopeBaseDepth: snapshot.frames.length,
      loopBaseDepth: snapshot.loopFrames.length,
    };
    snapshot.nextCallFrameId += 1;
    snapshot.callFrames.push(call);
    snapshot.frames.push(root);
    snapshot.temporaries.length = 0;
  }
  snapshot.nextInstruction = destination.target;
  sweepRetainedScopes(snapshot, true);
}

/**
 * `end` ends the current activation, also from one of its functions or blocks. It returns after the `call` of the file,
 * or without one continues at the fallback destination.
 */
export function executeEnd(
  plan: InstructionPlan,
  instruction: EndInstruction,
  snapshot: RuntimeSnapshot,
  events: InterpreterEvent[],
  trace: TraceStore | null,
  control: RandomControl | null,
): void {
  const index = innermostFileCallIndex(snapshot);
  if (index < 0 && snapshot.fallback === null) {
    throw new RuntimeFault(
      "TSR066",
      "This file ended, but no file called it, so there is nothing to return to. Use exit where the session should finish.",
      copySpan(instruction.span),
    );
  }
  if (index < 0) assertCounterCanAdvance(snapshot.nextScopeId, "nextScopeId");
  removeNonPersistentWork(snapshot, activationRootsFrom(snapshot, index), instruction.span, events);
  if (index < 0) {
    // A glob fallback draws its file each time it is used.
    const fallback = drawDestination(plan, snapshot, snapshot.fallback!, trace, control);
    replaceCurrentRoot(snapshot, freshRoot(snapshot, fallback));
    snapshot.nextInstruction = fallback.target;
  } else {
    const call = fileCall(snapshot, index);
    resetActivation(snapshot, index);
    snapshot.retainedScopes.push(snapshot.frames[call.scopeBaseDepth]!);
    snapshot.frames.length = call.scopeBaseDepth;
    snapshot.callFrames.length = index;
    for (const temporary of call.callerTemporaries) snapshot.temporaries.push({ ...temporary });
    snapshot.nextInstruction = call.returnInstruction;
  }
  sweepRetainedScopes(snapshot, true);
}

/**
 * `fallback target` and `fallback none`: the latest one executed wins. A computed target is resolved now, so the
 * fallback always names a file and its entry or label.
 */
export function executeSetFallback(
  plan: InstructionPlan,
  instruction: SetFallbackInstruction,
  snapshot: RuntimeSnapshot,
  evaluator: Evaluator,
): void {
  const destination = instruction.destination;
  snapshot.fallback =
    destination === null
      ? null
      : "value" in destination
        ? resolveComputed(plan, destination, "fallback", evaluator, instruction.span)
        : cloneTransferDestination(destination);
  snapshot.nextInstruction += 1;
}

/**
 * A computed target goes where its script reference names, checked against the plan each time it runs (ADR 0022
 * §2.4): the file must exist and have the label, and a `goto` or fallback needs a file that runs something.
 */
function resolveComputed(
  plan: InstructionPlan,
  destination: PlanComputedDestination,
  keyword: "goto" | "call" | "fallback",
  evaluator: Evaluator,
  span: PlanSourceLocation,
): PlanDestination {
  const value = evaluator.evaluate(destination.value);
  if (!isScriptReference(value)) {
    throw new RuntimeFault(
      "TSR058",
      `${keyword} needs a script reference here, made with script(...), but this is ${describeValue(value)}.`,
      copySpan(span),
    );
  }
  const { path, label } = value;
  const file = plan.files.findIndex((candidate) => candidate.path === path);
  const target =
    file < 0
      ? undefined
      : label === null
        ? plan.files[file]!.entryInstruction
        : plan.files[file]!.labels.find((candidate) => candidate.name === label)?.instruction;
  const problem =
    file < 0
      ? `This ${keyword} names the file '${messageText(path)}', but the project has no such file. Paths start at the package root, such as "rooms/hall.tease".`
      : target === undefined
        ? `This ${keyword} names label '${messageText(label!)}' of '${messageText(path)}', but that file has no such label.`
        : keyword !== "call" && runsNothing(plan, file)
          ? `'${messageText(path)}' holds declarations only and runs nothing, so going there would end nowhere. Call its functions instead.`
          : null;
  if (problem !== null) throw new RuntimeFault("TSR069", problem, copySpan(span));
  return { file, target: target! };
}

/**
 * A glob target picks one of its files with one draw from the session random generator, each time it runs. Its site is
 * the `goto`, `call`, or `end` that runs.
 */
function drawDestination(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  destination: PlanTransferDestination,
  trace: TraceStore | null,
  control: RandomControl | null,
): PlanDestination {
  if (!("pick" in destination)) return destination;
  const count = destination.pick.length;
  const drawId = snapshot.rng.state;
  let index = drawFromSessionGenerator(snapshot.rng, trace, "glob", null, count, null, (draw) =>
    sampleIndex(draw, count),
  );
  if (control !== null) {
    const instruction = snapshot.nextInstruction;
    const resolved = control.resolve(
      instruction,
      plan.instructions[instruction]!.span,
      "glob",
      drawId,
      { kind: "index", index },
      () => ({
        kind: "candidates",
        candidates: destination.pick.map((candidate) => plan.files[candidate.file]!.path),
      }),
    );
    if (resolved.kind !== "index") throw new Error("A glob resolved to another kind of outcome.");
    index = resolved.index;
  }
  const picked = destination.pick[index]!;
  trace?.randomResult(plan.files[picked.file]!.path);
  return picked;
}

/** The index of the file call whose activation has this root, -1 for the base activation, or none when left. */
function activationIndex(snapshot: RuntimeSnapshot, rootId: number): number | undefined {
  for (let index = snapshot.callFrames.length - 1; index >= 0; index -= 1) {
    const frame = snapshot.callFrames[index]!;
    if (frame.kind === "file" && snapshot.frames[frame.scopeBaseDepth]!.id === rootId) return index;
  }
  return snapshot.frames[0]!.id === rootId ? -1 : undefined;
}

/** Leaves everything above an activation's root: later calls, functions, blocks, loops, and temporaries. */
function resetActivation(snapshot: RuntimeSnapshot, index: number): void {
  const call = index < 0 ? undefined : fileCall(snapshot, index);
  const rootDepth = call?.scopeBaseDepth ?? 0;
  for (let depth = rootDepth + 1; depth < snapshot.frames.length; depth += 1) {
    const frame = snapshot.frames[depth]!;
    if (frame.file !== null) snapshot.retainedScopes.push(frame);
  }
  // A block, loop, or function scope stays while a resource or queued block shares its variables.
  leaveScopes(snapshot, rootDepth + 1);
  snapshot.callFrames.length = index + 1;
  snapshot.loopFrames.length = call?.loopBaseDepth ?? 0;
  snapshot.temporaries.length = 0;
}

function fileCall(snapshot: RuntimeSnapshot, index: number): RuntimeFileCallFrameSnapshot {
  const call = snapshot.callFrames[index];
  if (call?.kind !== "file") throw new Error("An activation's file call is missing.");
  return call;
}

/** Replaces the current activation by another: a fresh one, or one the session left that a block brings back. */
function replaceCurrentRoot(snapshot: RuntimeSnapshot, root: RuntimeScopeFrameSnapshot): void {
  const index = innermostFileCallIndex(snapshot);
  resetActivation(snapshot, index);
  const rootDepth = snapshot.frames.length - 1;
  snapshot.retainedScopes.push(snapshot.frames[rootDepth]!);
  snapshot.frames[rootDepth] = root;
}

function freshRoot(
  snapshot: RuntimeSnapshot,
  destination: PlanDestination,
): RuntimeScopeFrameSnapshot {
  const root = {
    id: snapshot.nextScopeId,
    file: destination.file,
    entry: destination.target,
    bindings: [],
  };
  snapshot.nextScopeId += 1;
  return root;
}

/** The roots of an activation, by its file call's index or -1 for the base one, and of every activation above it. */
function activationRootsFrom(snapshot: RuntimeSnapshot, index: number): Set<number> {
  const roots = new Set<number>();
  if (index < 0) roots.add(snapshot.frames[0]!.id);
  for (let position = Math.max(index, 0); position < snapshot.callFrames.length; position += 1) {
    const frame = snapshot.callFrames[position]!;
    if (frame.kind === "file") roots.add(snapshot.frames[frame.scopeBaseDepth]!.id);
  }
  return roots;
}

/**
 * Stops the non-persistent timers and removes the non-persistent permanent buttons of the activations a transfer
 * leaves, with their queued blocks.
 */
function removeNonPersistentWork(
  snapshot: RuntimeSnapshot,
  left: ReadonlySet<number>,
  span: PlanSourceLocation,
  events: InterpreterEvent[],
): void {
  const leaves = (owned: RuntimeTimerSnapshot | RuntimePermanentButtonSnapshot): boolean =>
    !owned.persist && left.has(owned.rootScopeId);
  const stopping = snapshot.backgroundActions.filter(
    (action) => action.kind === "timer" && leaves(action.timer),
  );
  const removing = snapshot.backgroundActions.filter(
    (action) => action.kind === "permanentButton" && leaves(action.button),
  );
  // Every settlement must fit before any of them happens.
  assertEventSequenceCapacity(snapshot, stopping.length + removing.length, span);
  for (const action of stopping) {
    if (action.kind === "timer") stopTimerAction(snapshot, action, span, events);
  }
  // A finished timer may still have queued blocks; they belong to the activation the transfer leaves.
  const dropped = new Set(snapshot.settledTimers.filter(leaves).map((timer) => timer.timerId));
  for (let index = snapshot.pendingTimerHandlers.length - 1; index >= 0; index -= 1) {
    const invocation = snapshot.pendingTimerHandlers[index]!;
    if ("timerId" in invocation && dropped.has(invocation.timerId)) {
      snapshot.pendingTimerHandlers.splice(index, 1);
    }
  }
  removePermanentButtons(snapshot, (action) => leaves(action.button), span, events);
}
