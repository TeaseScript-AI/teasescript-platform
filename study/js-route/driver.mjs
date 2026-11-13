// A session of an emitted program, driven as today's RuntimeSession is (research code of the JavaScript-route study).
// Stopping and continuing is way (1) of part C: every drive runs the program again from its start on a fresh state,
// with the same seed and clock, and applies at each wait the host's recorded observations of time; a wait that those
// observations settle is passed, the first one they do not settle ends the drive. Only events newer than those already
// given are given.
import { captureOrReuseInstructionPlan } from "../../dist/src/plan/capture.js";
import { instructionSourcePath } from "../../dist/src/plan/model.js";
import { failSnapshot, instructionFailure } from "../../dist/src/runtime/engine.js";
import { observeValidatedTime } from "../../dist/src/runtime/operations/observe-time.js";
import { createFreshRuntimeSnapshotWithValidatedPlan } from "../../dist/src/runtime/snapshot/snapshot-construction.js";
import { withFrozenTemporalCaptures } from "../../dist/src/runtime/snapshot/state.js";
import { emitProgram } from "./emit.mjs";
import { EXIT, Runtime, SUSPEND } from "./runtime.mjs";

const programs = new WeakMap();

/** The emitted program of a validated plan: its source, constants and the function that instantiates it. */
export function compileProgram(plan) {
  let program = programs.get(plan);
  if (program === undefined) {
    const emitted = emitProgram(plan);
    program = { ...emitted, instantiate: new Function("rt", "K", emitted.source) };
    programs.set(plan, program);
  }
  return program;
}

export class EmittedSession {
  #plan;
  #fresh;
  #program;
  /** For each wait the program reached, in order, the times the host observed while the session waited there. */
  #observed = [];
  #delivered = 0;
  #state;
  #waits = 0;
  #mode = "run";
  /** Instructions are not counted by generated code; drives report 0. */
  constructor(plan, fresh) {
    const captured = captureOrReuseInstructionPlan(plan);
    if (!captured.validation.valid || captured.plan === null) throw new TypeError("Malformed instruction plan.");
    this.#plan = captured.plan;
    this.#fresh = fresh;
    this.#program = compileProgram(this.#plan);
    this.#state = this.#freshState();
  }

  get state() {
    return this.#state;
  }

  run() {
    return this.#drive("run");
  }

  stepToEvent() {
    return this.#drive("run");
  }

  observeTime(nowMs) {
    if (this.#state.status !== "waiting") {
      // Not waiting: time is observed on the state as it is, as today's engine does between drives.
      const observed = observeValidatedTime(this.#plan, this.#state, nowMs);
      this.#delivered = this.#state.nextEventSequence;
      return { events: observed.events, instructionsExecuted: 0 };
    }
    const at = Math.max(0, this.#waits - 1);
    while (this.#observed.length <= at) this.#observed.push([]);
    this.#observed[at].push(nowMs);
    return this.#drive("observe");
  }

  /** Called by the program at the wait it reached: applies the observations recorded there; true when they settle it. */
  settle(rt) {
    const index = this.#waits;
    this.#waits += 1;
    const last = index >= this.#observed.length - 1;
    for (const nowMs of this.#observed[index] ?? []) {
      const observed = observeValidatedTime(this.#plan, rt.snapshot, nowMs);
      for (const event of observed.events) rt.events.push(event);
    }
    if (this.#mode === "observe" && last) return false;
    return rt.snapshot.status !== "waiting";
  }

  #freshState() {
    return withFrozenTemporalCaptures(createFreshRuntimeSnapshotWithValidatedPlan(this.#plan, this.#fresh));
  }

  #drive(mode) {
    if (this.#state.status === "halted" || this.#state.status === "failed") return { events: [], instructionsExecuted: 0 };
    this.#mode = mode;
    this.#waits = 0;
    const snapshot = this.#freshState();
    const rt = new Runtime(this.#plan, snapshot, this);
    const main = this.#program.instantiate(rt, this.#program.constants);
    snapshot.status = "running";
    try {
      main();
    } catch (error) {
      if (error !== SUSPEND && error !== EXIT) {
        const failure = instructionFailure(error, this.#plan.instructions[0].span);
        if (failure === null) throw error;
        failSnapshot(rt.snapshot, failure.toInfo(), instructionSourcePath(this.#plan, 0), rt.events);
      }
    }
    this.#state = rt.snapshot;
    const events = rt.events.filter((event) => event.sequence >= this.#delivered);
    this.#delivered = rt.snapshot.nextEventSequence;
    return { events, instructionsExecuted: 0 };
  }
}

export function createEmittedSession(plan, fresh = {}) {
  return new EmittedSession(plan, fresh);
}
