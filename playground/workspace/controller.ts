import {
  compileSource,
  type Diagnostic,
  type InstructionPlan,
  type InterpreterEvent,
  type RuntimeSnapshot,
} from "../../src/index.js";
import { runValidatedState, stepValidatedStateToEvent } from "../../src/runtime/engine.js";
import { observeTime } from "../../src/runtime/operations/observe-time.js";
import type {
  ActionCompletionOutcome,
  TimeObservationOutcome,
} from "../../src/runtime/operations/model.js";
import {
  createCheckpoint,
  deserializeCheckpoint,
  restoreCheckpoint,
  serializeCheckpoint,
  type RuntimeCheckpoint,
} from "../../src/runtime/checkpoint.js";
import type {
  RuntimeChatPacingGateActionSnapshot,
  RuntimeInteractionActionSnapshot,
} from "../../src/runtime/actions/model.js";
import {
  cloneCapturedRuntimeSnapshot,
  createFreshRuntimeSnapshotWithValidatedPlan,
} from "../../src/runtime/state.js";
import {
  activePlayerRuntimeInteraction,
  activePlayerRuntimePacingGate,
  completePlayerRuntimeAction,
} from "../../player/runtime-adapter.js";

export interface WorkspaceDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly line: number;
  readonly column: number;
  readonly length: number;
}

export interface WorkspaceResult {
  readonly diagnostics: readonly WorkspaceDiagnostic[];
  readonly plan: InstructionPlan | null;
  readonly snapshot: RuntimeSnapshot | null;
  readonly events: readonly InterpreterEvent[];
  readonly status: RuntimeSnapshot["status"] | "compileError";
  readonly instructionsExecuted: number;
}

export interface WorkspacePlayerPresentation {
  readonly activeInteraction: RuntimeInteractionActionSnapshot | null;
  readonly pacingGate: RuntimeChatPacingGateActionSnapshot | null;
}

export type WorkspaceControlOutcome =
  | ActionCompletionOutcome
  | TimeObservationOutcome
  | { readonly kind: "localRejection"; readonly message: string };

export interface WorkspaceControlResult<T = WorkspaceControlOutcome> {
  readonly snapshot: RuntimeSnapshot;
  readonly events: readonly InterpreterEvent[];
  readonly outcome: T;
  readonly presentation: WorkspacePlayerPresentation;
}

export type WorkspaceRenderedChoiceSelection =
  | { readonly kind: "label"; readonly value: string | number }
  | { readonly kind: "text"; readonly value: string };

export function inspectWorkspacePlayerPresentation(
  snapshot: RuntimeSnapshot,
): WorkspacePlayerPresentation {
  const activeInteraction =
    snapshot.foregroundAction?.kind === "interaction" ? snapshot.foregroundAction : null;
  const foregroundPacing =
    snapshot.foregroundAction?.kind === "chatPacingGate" ? snapshot.foregroundAction : null;
  const backgroundPacing =
    snapshot.backgroundActions.find((action) => action.kind === "chatPacingGate") ?? null;
  return freezeDeep({
    activeInteraction: activeInteraction === null ? null : cloneForPresentation(activeInteraction),
    pacingGate:
      foregroundPacing === null
        ? backgroundPacing === null
          ? null
          : cloneForPresentation(backgroundPacing)
        : cloneForPresentation(foregroundPacing),
  });
}

export function submitWorkspaceComposer(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  submittedText: string,
): WorkspaceControlResult {
  const action = activeInteraction(snapshot, "text", "number", "choice");
  if (action === null)
    return localRejection(snapshot, "No active text, number, or choice interaction.");
  const payload = { kind: "submittedText", submittedText };
  return completeWorkspaceAction(plan, snapshot, action, payload);
}

export function activateWorkspaceButton(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): WorkspaceControlResult {
  const action = activeInteraction(snapshot, "button");
  if (action === null) return localRejection(snapshot, "No active button interaction.");
  return completeWorkspaceAction(plan, snapshot, action, { kind: "activate" });
}

export function selectWorkspaceChoice(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  selection: WorkspaceRenderedChoiceSelection,
): WorkspaceControlResult {
  const action = activeInteraction(snapshot, "choice");
  if (action === null) return localRejection(snapshot, "No active choice interaction.");
  const payload =
    selection.kind === "label"
      ? { kind: "selectedLabel", selectedLabel: selection.value }
      : { kind: "selectedText", selectedText: selection.value };
  return completeWorkspaceAction(plan, snapshot, action, payload);
}

export function skipWorkspacePacing(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): WorkspaceControlResult {
  const action = pacingAction(snapshot);
  if (action === null) return localRejection(snapshot, "No active pacing gate.");
  return completeWorkspaceAction(plan, snapshot, action, { kind: "skip" });
}

export function observeWorkspaceTime(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  currentSessionTimeMs: number,
): WorkspaceControlResult {
  const operation = observeTime(plan, snapshot, currentSessionTimeMs);
  return controlResult(operation.snapshot, operation.events, operation.outcome);
}

export function serializeWorkspaceCheckpoint(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
): WorkspaceControlResult<{
  readonly kind: "serialized";
  readonly json: string;
  readonly checkpoint: RuntimeCheckpoint;
}> {
  const checkpoint = createCheckpoint(plan, snapshot);
  const json = serializeCheckpoint(checkpoint);
  return controlResult(snapshot, [], { kind: "serialized", json, checkpoint });
}

export function restoreWorkspaceCheckpoint(
  value: unknown,
): WorkspaceControlResult<{
  readonly kind: "restored";
  readonly plan: InstructionPlan;
  readonly checkpoint: RuntimeCheckpoint;
}> {
  const checkpoint =
    typeof value === "string" ? deserializeCheckpoint(value) : restoreCheckpoint(value);
  return controlResult(checkpoint.snapshot, [], {
    kind: "restored",
    plan: checkpoint.plan,
    checkpoint,
  });
}

export function compileWorkspaceSource(source: string): WorkspaceResult {
  assertWorkspaceSource(source);
  const compilation = compileSource(source);
  if (compilation.plan === null) {
    return freezeResult({
      diagnostics: diagnostics(compilation.diagnostics),
      plan: null,
      snapshot: null,
      events: [],
      status: "compileError",
      instructionsExecuted: 0,
    });
  }
  const snapshot = createFreshRuntimeSnapshotWithValidatedPlan(compilation.plan);
  return freezeResult({
    diagnostics: diagnostics(compilation.diagnostics),
    plan: compilation.plan,
    snapshot,
    events: [],
    status: snapshot.status,
    instructionsExecuted: 0,
  });
}

export function executeWorkspaceSource(
  source: string,
  mode: "run" | "step" = "run",
): WorkspaceResult {
  const compiled = compileWorkspaceSource(source);
  if (compiled.plan === null || compiled.snapshot === null) return compiled;
  const operation =
    mode === "run"
      ? runValidatedState(compiled.plan, compiled.snapshot)
      : stepValidatedStateToEvent(compiled.plan, compiled.snapshot);
  return freezeResult({
    diagnostics: compiled.diagnostics,
    plan: compiled.plan,
    snapshot: operation.snapshot,
    events: operation.events,
    status: operation.snapshot.status,
    instructionsExecuted: operation.instructionsExecuted,
  });
}

export function executeValidatedWorkspaceSnapshot(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  mode: "run" | "step",
): WorkspaceResult {
  const workingSnapshot = cloneCapturedRuntimeSnapshot(snapshot);
  const operation =
    mode === "run"
      ? runValidatedState(plan, workingSnapshot)
      : stepValidatedStateToEvent(plan, workingSnapshot);
  return freezeResult({
    diagnostics: [],
    plan,
    snapshot: operation.snapshot,
    events: operation.events,
    status: operation.snapshot.status,
    instructionsExecuted: operation.instructionsExecuted,
  });
}

function assertWorkspaceSource(source: unknown): asserts source is string {
  if (typeof source !== "string") throw new TypeError("Workspace source must be UTF-8 text.");
}

/** Decodes locally imported source without silently replacing malformed UTF-8 bytes. */
export function decodeWorkspaceSourceBytes(bytes: ArrayBuffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function diagnostics(values: readonly Diagnostic[]): readonly WorkspaceDiagnostic[] {
  return values.map((value) =>
    Object.freeze({
      code: value.code,
      message: value.message,
      line: value.span.start.line + 1,
      column: value.span.start.column + 1,
      length: value.span.end.offset - value.span.start.offset,
    }),
  );
}

function freezeResult(value: WorkspaceResult): WorkspaceResult {
  // Compiler and runtime operations already return caller-owned data; the
  // workspace retains no engine state that needs another whole-result copy.
  return Object.freeze(value);
}

function controlResult<T>(
  snapshot: RuntimeSnapshot,
  events: readonly InterpreterEvent[],
  outcome: T,
): WorkspaceControlResult<T> {
  return Object.freeze({
    snapshot,
    events: Object.freeze([...events]),
    outcome,
    presentation: inspectWorkspacePlayerPresentation(snapshot),
  });
}

function localRejection(
  snapshot: RuntimeSnapshot,
  message: string,
): WorkspaceControlResult<{ readonly kind: "localRejection"; readonly message: string }> {
  return controlResult(cloneCapturedRuntimeSnapshot(snapshot), [], {
    kind: "localRejection",
    message,
  });
}

function completeWorkspaceAction(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  action: RuntimeInteractionActionSnapshot | RuntimeChatPacingGateActionSnapshot,
  payload: Record<string, unknown>,
): WorkspaceControlResult {
  const operation = completePlayerRuntimeAction(plan, snapshot, action, payload);
  return controlResult(operation.snapshot, operation.events, operation.outcome);
}

function activeInteraction(
  snapshot: RuntimeSnapshot,
  ...kinds: RuntimeInteractionActionSnapshot["interactionKind"][]
): RuntimeInteractionActionSnapshot | null {
  const action = activePlayerRuntimeInteraction(snapshot);
  return action?.kind === "interaction" && kinds.includes(action.interactionKind) ? action : null;
}

function pacingAction(snapshot: RuntimeSnapshot): RuntimeChatPacingGateActionSnapshot | null {
  return activePlayerRuntimePacingGate(snapshot);
}

function cloneForPresentation<T extends object>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    // EVIDENCE: the input array is rebuilt recursively with the same element shape before it is frozen.
    return freezeDeep(value.map((item) => cloneForPresentation(item))) as T;
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = item !== null && typeof item === "object" ? cloneForPresentation(item) : item;
  }
  // EVIDENCE: every own field was copied recursively from the validated plain engine presentation object.
  return freezeDeep(copy) as T;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    // EVIDENCE: the object check above makes Object.values safe for recursive freezing.
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
