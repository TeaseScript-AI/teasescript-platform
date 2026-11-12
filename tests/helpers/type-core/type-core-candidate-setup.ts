// The candidate route tests' shared setup (tests/type-core/candidate/): the candidate compile, its slice, its sited
// diagnostics and runs, both orders, the checks.

import assert from "node:assert/strict";

import { compileSourceWithBackend, type CompilationResult } from "../../../src/compiler.js";
import type { InstructionPlan, TypePlan } from "../../../src/plan/model.js";
import { run } from "../../../src/runtime/engine.js";
import { type SerializableRuntimeValue } from "../../../src/runtime/values/serializable-values.js";
import { CandidateOutsideSlice, CORE_BACKEND } from "../../../src/type-inference/core/backend.js";
import { withConsumerOrder } from "../../../src/type-inference/core/consumers.js";
import { withSolverSeam } from "../../../src/type-inference/core/solver.js";
import { createImmediatePacingRuntimeSnapshot } from "../immediate-pacing-runtime.js";

export const OPTIONS = { globals: ["hostValue"] };

export function candidate(source: string): CompilationResult {
  return compileSourceWithBackend(source, OPTIONS, CORE_BACKEND);
}

/** The result of `compile`, or `null` for a program outside the candidate's slice. */
export function insideSlice<T>(compile: () => T): T | null {
  try {
    return compile();
  } catch (error) {
    if (error instanceof CandidateOutsideSlice) return null;
    throw error;
  }
}

/** The diagnostics as these tests compare them: severity, code and start offset. */
export function sited(result: Pick<CompilationResult, "diagnostics">): string[] {
  return result.diagnostics.map(
    (diagnostic) => `${diagnostic.severity} ${diagnostic.code}@${diagnostic.span.start.offset}`,
  );
}

/** `run` in the source order and with the consumers' and the solver's orders reversed: the two results, equal. */
export function inBothOrders<T>(run: () => T): T {
  return inBothOrdersAs(run, (result) => result)[0];
}

/**
 * `inBothOrders` with the two results compared as `project` gives them: the forward result whole, and its projection.
 * A test that runs the forward plan compiles no third time: each run starts from a fresh snapshot.
 */
export function inBothOrdersAs<R, T>(run: () => R, project: (result: R) => T): readonly [R, T] {
  const forward = run();
  const projected = project(forward);
  const reversed = withSolverSeam({ reverseWorklist: true }, () =>
    withConsumerOrder(
      (list) => [...list].reverse(),
      () => project(run()),
    ),
  );
  assert.deepEqual(reversed, projected);
  return [forward, projected];
}

/** A run of `plan` to its end without reading pauses, with `hostValue`: its status, messages and failure. */
export function runWith(plan: InstructionPlan, hostValue: SerializableRuntimeValue) {
  const { said, ...ran } = runSited(plan, hostValue);
  return { ...ran, says: said.map(({ text }) => text) };
}

/** `runWith`'s run, each message with the offset its statement starts at: an effect's place in the source. */
function runSited(plan: InstructionPlan, hostValue: SerializableRuntimeValue) {
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals: { hostValue } }));
  const failure = result.events.find((event) => event.kind === "runtimeFailure");
  return {
    status: result.snapshot.status,
    said: result.events.flatMap((event) =>
      event.kind === "say" ? [{ text: event.text, at: event.span.start.offset }] : [],
    ),
    failure:
      failure?.kind === "runtimeFailure"
        ? `${failure.code}@${failure.span.start.offset}:${failure.span.end.offset}`
        : null,
  };
}

/**
 * The run oracle of an enforcement test: per host value its expected failure, `CODE@start:end`, or `null`.
 * A run without one says exactly `said` and halts at the end; a run with one ends failed with exactly it, nothing said
 * by a statement at or after the failing check's start.
 */
export function assertRuns(
  plan: InstructionPlan,
  name: string,
  said: readonly string[],
  runs: readonly (readonly [SerializableRuntimeValue, string | null])[],
): void {
  for (const [value, failure] of runs) {
    const ran = runSited(plan, value);
    const start = failure === null ? -1 : Number(/@(\d+):/.exec(failure)![1]);
    assert.deepEqual(
      {
        status: ran.status,
        failure: ran.failure,
        said: ran.said.flatMap(({ text, at }) => (at >= start ? [text] : [])),
      },
      {
        status: failure === null ? "halted" : "failed",
        failure,
        said: failure === null ? said : [],
      },
      `${name} with ${JSON.stringify(value)}`,
    );
  }
}

/** A plan's stores that check their value (`typeCheck`): per instruction, its file, span and checked type. */
export function typeChecks(
  plan: InstructionPlan,
): { readonly file: string; readonly so: number; readonly eo: number; readonly type: TypePlan }[] {
  const out: { file: string; so: number; eo: number; type: TypePlan }[] = [];
  for (const [index, instruction] of plan.instructions.entries())
    if (
      (instruction.kind === "declareBinding" || instruction.kind === "assign") &&
      instruction.typeCheck !== undefined
    )
      out.push({
        file:
          plan.files.find((file) => file.startInstruction <= index && index < file.endInstruction)
            ?.path ?? "",
        so: instruction.span.so,
        eo: instruction.span.eo,
        type: instruction.typeCheck.type,
      });
  return out;
}

/** A checked type in full, as these tests compare it: `integer`, `list<list<integer>>`, `{name: string}`, `a|b`. */
export function typeText(type: TypePlan | null): string {
  if (type === null) return "any";
  if (type.kind === "union") return type.members.map(typeText).join("|");
  if (type.kind === "list" || type.kind === "set" || type.kind === "dict")
    return `${type.kind}<${typeText(type.element)}>`;
  if (type.kind === "object")
    return `{${type.properties.map(({ name, type: of }) => `${name}: ${typeText(of)}`).join(", ")}}`;
  return type.kind;
}

/** A plan's checked stores, each as `start:end type`: the store that checks, and the whole type it checks. */
export function checksOf(plan: InstructionPlan): string[] {
  return typeChecks(plan).map(({ so, eo, type }) => `${so}:${eo} ${typeText(type)}`);
}
