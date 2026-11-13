// A session of an emitted program, driven as today's RuntimeSession is (research code of the JavaScript-route study).
// Stopping and continuing is way (1) of part C: every drive runs the program again from its start on a fresh state,
// with the same seed and clock, and applies at each wait the host's recorded observations of time; a wait that those
// observations settle is passed, the first one they do not settle ends the drive. Only events newer than those already
// given are given.
import { captureOrReuseInstructionPlan } from "../../dist/src/plan/capture.js";
import { instructionSourcePath } from "../../dist/src/plan/model.js";
import { failSnapshot, instructionFailure } from "../../dist/src/runtime/engine.js";
import { observeValidatedTime } from "../../dist/src/runtime/operations/observe-time.js";
import { completeValidatedAction } from "../../dist/src/runtime/operations/complete-action.js";
import { createFreshRuntimeSnapshotWithValidatedPlan } from "../../dist/src/runtime/snapshot/snapshot-construction.js";
import { withFrozenTemporalCaptures } from "../../dist/src/runtime/snapshot/state.js";
import { emitProgram } from "./emit.mjs";
import { EXIT, Runtime, SUSPEND } from "./runtime.mjs";
import { fromCanonical, toCanonical } from "../../dist/src/runtime/native/values/codec.js";

const programs = new Map();

/** The emitted program of a validated plan: its source, constants and the function that instantiates it. */
export function compileProgram(plan, resumable = false, runawayCheck = false) {
  const key = `${resumable}/${runawayCheck}`;
  if (!programs.has(key)) programs.set(key, new WeakMap());
  const cache = programs.get(key);
  let program = cache.get(plan);
  if (program === undefined) {
    const emitted = emitProgram(plan, { resumable, runawayCheck });
    program = { ...emitted, instantiate: new Function("rt", "K", emitted.source) };
    cache.set(plan, program);
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
  constructor(plan, fresh, { runawayCheck = false } = {}) {
    const captured = captureOrReuseInstructionPlan(plan);
    if (!captured.validation.valid || captured.plan === null) throw new TypeError("Malformed instruction plan.");
    this.#plan = captured.plan;
    this.#fresh = fresh;
    this.#program = compileProgram(this.#plan, false, runawayCheck);
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
    return this.#record({ kind: "time", nowMs });
  }

  /** Completes the action the session waits on (an answer, a click), recorded at the wait it answers. */
  completeAction(request) {
    if (this.#state.status !== "waiting") return { events: [], instructionsExecuted: 0 };
    return this.#record({ kind: "complete", request });
  }

  #record(operation) {
    const at = Math.max(0, this.#waits - 1);
    while (this.#observed.length <= at) this.#observed.push([]);
    this.#observed[at].push(operation);
    return this.#drive("observe");
  }

  /** Called by the program at the wait it reached: applies the observations recorded there; true when they settle it. */
  settle(rt) {
    const index = this.#waits;
    this.#waits += 1;
    const last = index >= this.#observed.length - 1;
    for (const operation of this.#observed[index] ?? []) {
      const done =
        operation.kind === "time"
          ? observeValidatedTime(this.#plan, rt.snapshot, operation.nowMs)
          : completeValidatedAction(this.#plan, rt.snapshot, operation.request);
      for (const event of done.events) rt.events.push(event);
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
    rt.fileEntries = this.#program.fileEntries;
    const main = this.#program.instantiate(rt, this.#program.constants);
    snapshot.status = "running";
    try {
      main();
    } catch (error) {
      if (error !== SUSPEND && error !== EXIT) {
        const failure = instructionFailure(error, this.#plan.instructions[0].span);
        if (failure === null) throw error;
        failSnapshot(rt.snapshot, failure.toInfo(), instructionSourcePath(this.#plan, this.#plan.files[rt.file ?? 0].startInstruction), rt.events);
      }
    }
    this.#state = rt.snapshot;
    this.bridged = rt.bridged;
    this.bridgedInstructions = rt.bridgedInstructions;
    const events = rt.events.filter((event) => event.sequence >= this.#delivered);
    this.#delivered = rt.snapshot.nextEventSequence;
    return { events, instructionsExecuted: 0 };
  }
}

export function createEmittedSession(plan, fresh = {}, options = {}) {
  return new EmittedSession(plan, fresh, options);
}

/** A value of a saved frame as JSON: a native value's canonical form, and `undefined` (not set yet) marked. */
function saveValue(value) {
  return value === undefined ? { $unset: 1 } : toCanonical(value);
}
function loadValue(value) {
  return value !== null && typeof value === "object" && value.$unset === 1 ? undefined : fromCanonical(value);
}

/**
 * Part C way (2): a session whose program saves at each wait, as JSON text, the session's state but its values (today's
 * snapshot shape), the globals and the frames of the functions that wait; between drives the save is all it keeps, so
 * every drive continues from a reload of it. Host operations apply to the saved state.
 */
export class ResumableSession {
  #plan;
  #program;
  /** The save: JSON text, or null before the first wait. */
  save = null;
  #state;
  constructor(plan, fresh) {
    const captured = captureOrReuseInstructionPlan(plan);
    if (!captured.validation.valid || captured.plan === null) throw new TypeError("Malformed instruction plan.");
    this.#plan = captured.plan;
    this.#program = compileProgram(this.#plan, true);
    this.#state = withFrozenTemporalCaptures(createFreshRuntimeSnapshotWithValidatedPlan(this.#plan, fresh));
  }
  get state() {
    return this.#state;
  }
  run() {
    return this.#drive();
  }
  stepToEvent() {
    return this.#drive();
  }
  observeTime(nowMs) {
    return this.#host((snapshot) => observeValidatedTime(this.#plan, snapshot, nowMs));
  }
  completeAction(request) {
    return this.#host((snapshot) => completeValidatedAction(this.#plan, snapshot, request));
  }
  #host(apply) {
    if (this.save === null) {
      const done = apply(this.#state);
      return { events: done.events, instructionsExecuted: 0 };
    }
    const saved = JSON.parse(this.save);
    const done = apply(saved.snapshot);
    this.save = JSON.stringify(saved);
    this.#state = saved.snapshot;
    return { events: done.events, instructionsExecuted: 0 };
  }
  #drive() {
    const status = this.#state.status;
    if (status === "halted" || status === "failed" || status === "waiting") return { events: [], instructionsExecuted: 0 };
    const saved = this.save === null ? null : JSON.parse(this.save);
    const snapshot = saved === null ? this.#state : saved.snapshot;
    const rt = new Runtime(this.#plan, snapshot, this);
    rt.fileEntries = this.#program.fileEntries;
    if (saved !== null) {
      rt.globals.push(...saved.globals.map(loadValue));
      rt.resumeFrames = saved.frames.map((frame) => ({ ...frame, v: frame.v.map(loadValue) }));
      rt.resuming = rt.resumeFrames.length > 0;
    }
    const main = this.#program.instantiate(rt, this.#program.constants);
    snapshot.status = "running";
    this.save = null;
    try {
      main();
    } catch (error) {
      if (error === SUSPEND) {
        // Innermost first as they were pushed; a resume gives them back outermost first.
        const frames = rt.frames.reverse().map((frame) => ({ ...frame, v: frame.v.map(saveValue) }));
        this.save = JSON.stringify({ snapshot: rt.snapshot, globals: rt.globals.map(saveValue), frames });
        this.saveBytes = this.save.length;
      } else if (error !== EXIT) {
        const failure = instructionFailure(error, this.#plan.instructions[0].span);
        if (failure === null) throw error;
        failSnapshot(rt.snapshot, failure.toInfo(), instructionSourcePath(this.#plan, this.#plan.files[rt.file ?? 0].startInstruction), rt.events);
      }
    }
    this.#state = rt.snapshot;
    this.bridged = rt.bridged;
    this.bridgedInstructions = rt.bridgedInstructions;
    return { events: rt.events, instructionsExecuted: 0 };
  }
}

export function createResumableSession(plan, fresh = {}) {
  return new ResumableSession(plan, fresh);
}
