import { planNames, type PlanNames, type Variable } from "../../src/compiler/javascript/names.js";
import type { InstructionPlan } from "../../src/plan/model.js";
import type { InterpreterEvent } from "../../src/runtime/events.js";
import { createFreshRuntimeSession } from "../../src/runtime/session.js";
import { PlayHost } from "./generated-comparison/fixtures.js";
import {
  type HostOperation,
  Play,
  type PlayEnding,
  type PlayPolicy,
} from "./generated-comparison/play.js";

/*
 * `planNames` against today's engine: a session of the plan is played (the comparison's `Play`), and before every
 * instruction it runs, each name the instruction reads is looked up where execution stands (`RuntimeSession.scopeOf`,
 * the engine's own lookup). The engine's scope frames are labelled with the static variables as they are bound: after
 * each instruction, the variables `planNames` says it declares are looked up, and the scope the engine finds each in
 * gets that variable for that name; a media block's own handle as the block starts.
 *
 * At each read: the engine's `"global"` must be a global to `planNames`; a scope the engine finds must carry the label
 * of the very variable `planNames` names, and be labelled at all. A name the engine finds nowhere is either a file's
 * top-level variable not set yet, which `planNames` must name as that file's variable (a read on a way not taken, such
 * as `7 otherwise x`, or one that faults as ADR 0022 §3.4 says), or no variable at all (a host value not given, the
 * contextual `speaker`). The engine cannot tell those apart, so a global to `planNames` is checked against the plan
 * instead, at every read whether it runs or not: no global shares a name with a variable of the project (V30 §12 and
 * V30 §14), so a global that a `let`, loop, parameter or media block's handle names is wrong.
 *
 * One scope variable labelled with two static variables is a mismatch too, as is a static variable declared by two
 * instructions (two parameter bindings excepted), which would merge two variables the engine keeps apart without any
 * read telling them apart. Each mismatch names a defect of the analysis.
 */

export interface NameCheck {
  /** The names checked, counting each read at each executed instruction. */
  readonly reads: number;
  /** Reads the engine found in a scope frame. */
  readonly scoped: number;
  /** The functions and blocks the play entered, by plan ID, so a test can tell its case was reached. */
  readonly entered: ReadonlySet<number>;
  readonly mismatches: readonly string[];
  readonly ended: PlayEnding;
}

const FRESH = { seed: 1, wallClockMs: Date.UTC(2026, 0, 5, 9, 0, 0) };

/** `names` is the analysis under test: `planNames(plan)`, unless a test checks the check with another. */
export function checkNamesAgainstEngine(
  plan: InstructionPlan,
  options: {
    readonly names?: PlanNames;
    readonly play?: PlayPolicy;
    readonly answers?: number;
  } = {},
): NameCheck {
  const names = options.names ?? planNames(plan);
  const session = createFreshRuntimeSession(plan, FRESH);
  const labels = new Map<string, number>();
  const mismatches: string[] = [];
  const entered = new Set<number>();
  let reads = 0;
  let scoped = 0;
  // A function's or block's entry, and a media block's own handle, by the entry instruction.
  const entries = new Map<number, number>();
  const selfHandles = new Map<number, Variable>();
  for (const definition of plan.functions) {
    entries.set(definition.entryInstruction, definition.id);
    const self = names.selfHandle(definition.id);
    if (self !== null) selfHandles.set(definition.entryInstruction, self);
  }
  const variableNames = new Set<string>();
  for (const instruction of plan.instructions) {
    if (instruction.kind === "declareBinding") variableNames.add(instruction.name);
    else if (instruction.kind === "loopStart" && instruction.loopKind === "for") {
      variableNames.add(instruction.variable);
      if (instruction.valueVariable !== undefined) variableNames.add(instruction.valueVariable);
    }
  }
  for (const definition of plan.functions) {
    for (const parameter of definition.parameters) variableNames.add(parameter.name);
    if (definition.selfHandle !== null) variableNames.add(definition.selfHandle);
  }
  for (let index = 0; index < plan.instructions.length; index += 1)
    for (const [name, target] of names.readsAt(index))
      if (target.kind === "global" && variableNames.has(name))
        mismatches.push(`instruction ${index}: '${name}' is a variable's name, not a global`);
  const label = (index: number, name: string, variable: number): void => {
    const scope = session.scopeOf(name);
    if (scope === "global") {
      mismatches.push(`instruction ${index}: '${name}' (v${variable}) is bound as a global`);
      return;
    }
    // A parameter left to its default, or a loop that ends, binds nothing.
    if (scope === null) return;
    const key = `${scope} ${name}`;
    const earlier = labels.get(key);
    if (earlier !== undefined && earlier !== variable)
      mismatches.push(
        `instruction ${index}: '${name}' of scope ${scope} is v${earlier} and v${variable}`,
      );
    labels.set(key, variable);
  };
  const instructionObserver = {
    before: (index: number): void => {
      const entry = entries.get(index);
      if (entry !== undefined) entered.add(entry);
      const self = selfHandles.get(index);
      if (self !== undefined) label(index, self.name, self.id);
      for (const [name, target] of names.readsAt(index)) {
        reads += 1;
        const scope = session.scopeOf(name);
        const expected = target.kind === "global" ? "a global" : `v${target.variable.id}`;
        if (scope === null) {
          if (target.kind === "variable" && target.variable.kind !== "root")
            mismatches.push(`instruction ${index}: '${name}' is unbound, not ${expected}`);
          continue;
        }
        if (scope === "global") {
          if (target.kind !== "global")
            mismatches.push(`instruction ${index}: '${name}' is a global, not ${expected}`);
          continue;
        }
        scoped += 1;
        const found = labels.get(`${scope} ${name}`);
        if (found === undefined)
          mismatches.push(
            `instruction ${index}: '${name}' is in unlabelled scope ${scope}, not ${expected}`,
          );
        else if (target.kind !== "variable" || target.variable.id !== found)
          mismatches.push(`instruction ${index}: '${name}' is v${found}, not ${expected}`);
      }
    },
    after: (index: number): void => {
      for (const variable of names.declaredAt(index)) label(index, variable.name, variable.id);
    },
  };
  // One variable per declaration: a parameter is bound where it is supplied or where its default is; any other
  // variable by one instruction, which may run many times.
  const declarers = new Map<Variable, number[]>();
  for (let index = 0; index < plan.instructions.length; index += 1)
    for (const variable of names.declaredAt(index)) {
      const list = declarers.get(variable) ?? [];
      list.push(index);
      declarers.set(variable, list);
    }
  for (const [variable, list] of declarers)
    if (list.length > (variable.kind === "parameter" ? 2 : 1))
      mismatches.push(
        `v${variable.id} '${variable.name}' is declared by instructions ${list.join(", ")}`,
      );
  const host = new PlayHost();
  const play = new Play(session, host, options.play ?? "first", {
    answers: options.answers ?? 50,
    sceneTimeMs: 6 * 60 * 60 * 1000,
  });
  let operation: HostOperation = { kind: "run" };
  for (;;) {
    const result = apply(operation);
    const next = play.next(operation, result.outcome, result.events);
    if (typeof next === "string") return { reads, scoped, entered, mismatches, ended: next };
    operation = next;
  }

  function apply(done: HostOperation): {
    readonly events: readonly InterpreterEvent[];
    readonly outcome: unknown;
  } {
    switch (done.kind) {
      case "run":
        return { events: session.run({ instructionObserver }).events, outcome: null };
      case "observeTime":
        return session.observeTime(done.nowMs, done.reports);
      case "completeAction":
        return session.completeAction(done.request, { capturedMedia: host.admission });
      case "updateInteraction":
        return session.updateInteraction(done.request);
      case "reportMediaLoad":
        return session.reportMediaLoad(done.mediaId, done.report);
      case "pressPermanentButton":
        return session.pressPermanentButton(done.buttonId);
    }
  }
}
