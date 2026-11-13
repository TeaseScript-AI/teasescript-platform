import { captureOrReuseInstructionPlan } from "../../plan/capture.js";
import type { InstructionPlan } from "../../plan/model.js";
import { instructionBudget } from "../engine.js";
import type { InterpreterEvent } from "../events.js";
import { observeValidatedTime } from "../operations/observe-time.js";
import { createFreshRuntimeSnapshotWithValidatedPlan } from "../snapshot/snapshot-construction.js";
import {
  withFrozenTemporalCaptures,
  type FreshRuntimeOptions,
  type RuntimeSnapshot,
} from "../snapshot/state.js";
import { runNative } from "./execute/loop.js";
import { NativeMachine, newActivation } from "./execute/machine.js";
import { prepareNativeProgram, type NativeProgram } from "./prepare/program.js";
import { fromCanonical } from "./values/codec.js";
import type { NativeValue } from "./values/native-value.js";

/** What a drive or an observation of a native session did. */
export interface NativeSessionResult {
  readonly events: readonly InterpreterEvent[];
  readonly instructionsExecuted: number;
}

/**
 * A session the native engine runs, which tests and benchmarks drive beside today's `RuntimeSession`; no host or player
 * creates one. Its operations are those the native engine's slice needs: running, stepping to an event, observing time,
 * and reading its state's non-value parts. They take only validated input and return the engine's own objects, which a
 * caller must not change.
 */
export class NativeSession {
  readonly #program: NativeProgram;
  readonly #machine: NativeMachine;

  public constructor(plan: InstructionPlan, snapshot: RuntimeSnapshot) {
    this.#program = prepareNativeProgram(plan);
    const globals: Array<NativeValue | undefined> = [];
    for (let index = 0; index < this.#program.globals.size; index += 1) globals.push(undefined);
    for (const [name, index] of this.#program.globals.entries()) {
      const host = snapshot.globals.find((global) => global.name === name);
      if (host !== undefined) globals[index] = fromCanonical(host.value);
    }
    this.#machine = new NativeMachine(plan, snapshot, {}, newActivation([], null, 0, 0), globals, []);
  }

  public run(options: { readonly instructionBudget?: number } = {}): NativeSessionResult {
    return this.#drive(options, false);
  }

  public stepToEvent(options: { readonly instructionBudget?: number } = {}): NativeSessionResult {
    return this.#drive(options, true);
  }

  /** Observes scene time with today's `observeValidatedTime`, which settles due work such as a say's reading time. */
  public observeTime(nowMs: number): NativeSessionResult {
    const observed = observeValidatedTime(this.#machine.plan, this.#machine.snapshot, nowMs);
    return { events: observed.events, instructionsExecuted: 0 };
  }

  /** The session's state but its variables, temporaries and running loops and calls, which the machine holds. */
  public get state(): RuntimeSnapshot {
    return this.#machine.snapshot;
  }

  #drive(options: { readonly instructionBudget?: number }, untilEvent: boolean): NativeSessionResult {
    const machine = this.#machine;
    machine.events = [];
    const executed = runNative(machine, this.#program.steps, instructionBudget(options.instructionBudget), untilEvent);
    return { events: machine.events, instructionsExecuted: executed };
  }
}

/** A native session of a fresh start of `plan`, which is captured and validated as `createFreshRuntimeSession` does. */
export function createFreshNativeSession(plan: InstructionPlan, fresh: FreshRuntimeOptions = {}): NativeSession {
  const captured = captureOrReuseInstructionPlan(plan);
  if (!captured.validation.valid || captured.plan === null)
    throw new TypeError(captured.validation.errors[0]?.message ?? "Malformed instruction plan.");
  const snapshot = withFrozenTemporalCaptures(createFreshRuntimeSnapshotWithValidatedPlan(captured.plan, fresh));
  return new NativeSession(captured.plan, snapshot);
}
