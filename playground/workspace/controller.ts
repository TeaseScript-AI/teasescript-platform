import {
  compileSource,
  type Diagnostic,
  type InstructionPlan,
  type InterpreterEvent,
  type RuntimeSnapshot,
} from "../../src/index.js";
import {
  runValidatedState,
  stepValidatedStateToEvent,
} from "../../src/runtime/engine.js";
import {
  cloneCapturedRuntimeSnapshot,
  createFreshRuntimeSnapshotWithValidatedPlan,
} from "../../src/runtime/state.js";

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

export function compileWorkspaceSource(source: string): WorkspaceResult {
  assertWorkspaceSource(source);
  const compilation = compileSource(source);
  if (compilation.plan === null) {
    return freezeResult({ diagnostics: diagnostics(compilation.diagnostics), plan: null, snapshot: null, events: [], status: "compileError", instructionsExecuted: 0 });
  }
  const snapshot = createFreshRuntimeSnapshotWithValidatedPlan(compilation.plan);
  return freezeResult({ diagnostics: diagnostics(compilation.diagnostics), plan: compilation.plan, snapshot, events: [], status: snapshot.status, instructionsExecuted: 0 });
}

export function executeWorkspaceSource(source: string, mode: "run" | "step" = "run"): WorkspaceResult {
  const compiled = compileWorkspaceSource(source);
  if (compiled.plan === null || compiled.snapshot === null) return compiled;
  const operation = mode === "run"
    ? runValidatedState(compiled.plan, compiled.snapshot)
    : stepValidatedStateToEvent(compiled.plan, compiled.snapshot);
  return freezeResult({ diagnostics: compiled.diagnostics, plan: compiled.plan, snapshot: operation.snapshot, events: operation.events, status: operation.snapshot.status, instructionsExecuted: operation.instructionsExecuted });
}

export function executeValidatedWorkspaceSnapshot(
  plan: InstructionPlan,
  snapshot: RuntimeSnapshot,
  mode: "run" | "step",
): WorkspaceResult {
  const workingSnapshot = cloneCapturedRuntimeSnapshot(snapshot);
  const operation = mode === "run"
    ? runValidatedState(plan, workingSnapshot)
    : stepValidatedStateToEvent(plan, workingSnapshot);
  return freezeResult({ diagnostics: [], plan, snapshot: operation.snapshot, events: operation.events, status: operation.snapshot.status, instructionsExecuted: operation.instructionsExecuted });
}

export function assertWorkspaceSource(source: unknown): asserts source is string {
  if (typeof source !== "string") throw new TypeError("Workspace source must be UTF-8 text.");
}

/** Decodes locally imported source without silently replacing malformed UTF-8 bytes. */
export function decodeWorkspaceSourceBytes(bytes: ArrayBuffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function diagnostics(values: readonly Diagnostic[]): readonly WorkspaceDiagnostic[] {
  return values.map((value) => Object.freeze({ code: value.code, message: value.message, line: value.span.start.line + 1, column: value.span.start.column + 1, length: value.span.end.offset - value.span.start.offset }));
}

function freezeResult(value: WorkspaceResult): WorkspaceResult {
  // Compiler and runtime operations already return caller-owned data; the
  // workspace retains no engine state that needs another whole-result copy.
  return Object.freeze(value);
}
