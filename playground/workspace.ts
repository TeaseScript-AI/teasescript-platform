import {
  compileSource,
  createFreshRuntimeSnapshot,
  run,
  stepToEvent,
  type Diagnostic,
  type InstructionPlan,
  type InterpreterEvent,
  type RuntimeSnapshot,
} from "../src/index.js";

/** Limits keep the local automation surface useful without accepting unbounded work. */
export const MAX_WORKSPACE_SOURCE_BYTES = 64 * 1024;
export const MAX_WORKSPACE_INSTRUCTION_BUDGET = 10_000;

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
  const snapshot = createFreshRuntimeSnapshot(compilation.plan);
  return freezeResult({ diagnostics: diagnostics(compilation.diagnostics), plan: compilation.plan, snapshot, events: [], status: snapshot.status, instructionsExecuted: 0 });
}

export function executeWorkspaceSource(source: string, mode: "run" | "step" = "run"): WorkspaceResult {
  const compiled = compileWorkspaceSource(source);
  if (compiled.plan === null || compiled.snapshot === null) return compiled;
  const operation = mode === "run"
    ? run(compiled.plan, compiled.snapshot, {}, { instructionBudget: MAX_WORKSPACE_INSTRUCTION_BUDGET })
    : stepToEvent(compiled.plan, compiled.snapshot, {}, { instructionBudget: MAX_WORKSPACE_INSTRUCTION_BUDGET });
  return freezeResult({ diagnostics: compiled.diagnostics, plan: compiled.plan, snapshot: operation.snapshot, events: operation.events, status: operation.snapshot.status, instructionsExecuted: operation.instructionsExecuted });
}

export function executeWorkspaceSnapshot(plan: InstructionPlan, snapshot: RuntimeSnapshot, mode: "run" | "step"): WorkspaceResult {
  const operation = mode === "run"
    ? run(plan, snapshot, {}, { instructionBudget: MAX_WORKSPACE_INSTRUCTION_BUDGET })
    : stepToEvent(plan, snapshot, {}, { instructionBudget: MAX_WORKSPACE_INSTRUCTION_BUDGET });
  return freezeResult({ diagnostics: [], plan, snapshot: operation.snapshot, events: operation.events, status: operation.snapshot.status, instructionsExecuted: operation.instructionsExecuted });
}

export function assertWorkspaceSource(source: unknown): asserts source is string {
  if (typeof source !== "string") throw new TypeError("Workspace source must be UTF-8 text.");
  if (new TextEncoder().encode(source).byteLength > MAX_WORKSPACE_SOURCE_BYTES) {
    throw new RangeError(`Workspace source must not exceed ${MAX_WORKSPACE_SOURCE_BYTES} UTF-8 bytes.`);
  }
}

/** Decodes locally imported source without silently replacing malformed UTF-8 bytes. */
export function decodeWorkspaceSourceBytes(bytes: ArrayBuffer): string {
  if (bytes.byteLength > MAX_WORKSPACE_SOURCE_BYTES) {
    throw new RangeError(`Workspace source must not exceed ${MAX_WORKSPACE_SOURCE_BYTES} UTF-8 bytes.`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function diagnostics(values: readonly Diagnostic[]): readonly WorkspaceDiagnostic[] {
  return values.map((value) => Object.freeze({ code: value.code, message: value.message, line: value.span.start.line + 1, column: value.span.start.column + 1, length: value.span.end.offset - value.span.start.offset }));
}

function freezeResult(value: WorkspaceResult): WorkspaceResult {
  // Public runtime values are JSON-safe; clone so callers never receive mutable engine state.
  return Object.freeze(JSON.parse(JSON.stringify(value)) as WorkspaceResult);
}
