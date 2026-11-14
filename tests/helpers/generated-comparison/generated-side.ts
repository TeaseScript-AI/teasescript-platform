import type { InstructionPlan } from "../../../src/plan/model.js";
import type { InterpreterEvent } from "../../../src/runtime/events.js";
import type { ActionCompletionOptions } from "../../../src/runtime/operations/complete-action.js";
import type { RuntimeSession, RuntimeSessionOptions } from "../../../src/runtime/session.js";
import type { FreshRuntimeOptions } from "../../../src/runtime/snapshot/state.js";
import type { SideRecord } from "./record.js";

/** The stage's output as this comparison takes it: an ES module's text and its table. */
export interface GeneratedProgramText {
  readonly module: string;
  readonly table: unknown;
}

/** A media progress report as `observeTime` takes it. */
export interface MediaProgressReport {
  readonly mediaId: number;
  readonly segment: number;
  readonly progressMs: number;
}

/** What an operation gave: its events and semantic outcome (`null` for `run`). */
export interface OperationResult<Event = unknown> {
  readonly events: readonly Event[];
  readonly outcome: unknown;
}

/**
 * One side of a comparison: the session operations a play uses, and the state after them in today's snapshot shape.
 * Today's engine is one side (`todaySide`); generated code is the other, through an adapter over its module.
 */
export interface ComparedSession<Event = unknown> {
  run(): OperationResult<Event>;
  observeTime(nowMs: number, reports: readonly MediaProgressReport[]): OperationResult<Event>;
  completeAction(request: unknown, options: ActionCompletionOptions): OperationResult<Event>;
  updateInteraction(request: unknown): OperationResult<Event>;
  reportMediaLoad(mediaId: number, report: unknown): OperationResult<Event>;
  pressPermanentButton(buttonId: number): OperationResult<Event>;
  state(): Pick<SideRecord, "snapshot" | "interrupt">;
}

/** Today's engine as a side of a comparison. */
export function todaySide(session: RuntimeSession): ComparedSession<InterpreterEvent> {
  return {
    run: () => ({ events: session.run().events, outcome: null }),
    observeTime: (nowMs, reports) => session.observeTime(nowMs, reports),
    completeAction: (request, options) => session.completeAction(request, options),
    updateInteraction: (request) => session.updateInteraction(request),
    reportMediaLoad: (mediaId, report) => session.reportMediaLoad(mediaId, report),
    pressPermanentButton: (buttonId) => session.pressPermanentButton(buttonId),
    state: () => {
      const view = session.view();
      return {
        snapshot: session.exportSnapshot(),
        interrupt: { action: view.suspendedAction, atMs: view.suspendedAtMs },
      };
    },
  };
}

/**
 * The generated side for a program the stage gave. No runtime entries for generated code exist, so this side is
 * unavailable: it rejects every program, and the default generator refuses every plan before reaching it.
 */
export function generatedSide(
  _program: GeneratedProgramText,
  _plan: InstructionPlan,
  _fresh: FreshRuntimeOptions,
  _options: RuntimeSessionOptions,
): Promise<ComparedSession> {
  return Promise.reject(new Error("Generated code has no runtime entries to run on."));
}
