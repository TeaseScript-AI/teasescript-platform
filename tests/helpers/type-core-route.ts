import type { InstructionPlan, TypePlan } from "../../src/plan/model.js";
import { run } from "../../src/runtime/engine.js";
import type { SerializableRuntimeValue } from "../../src/runtime/values/serializable-values.js";
import { createImmediatePacingRuntimeSnapshot } from "./immediate-pacing-runtime.js";
import { derivedText, type DerivedStore, type PredictedRun } from "./type-core-derived.js";

// The candidate route's plan and runs as the derived oracle compares them (S6-CARRIERS §5.2, TABLE r4.59).

/** A run of `plan` to its end with the host globals' values: its status, its failure and what it said, with offsets. */
export function runGlobals(
  plan: InstructionPlan,
  globals: Readonly<Record<string, SerializableRuntimeValue>>,
): PredictedRun {
  const result = run(plan, createImmediatePacingRuntimeSnapshot(plan, { globals }));
  const failure = result.events.find((event) => event.kind === "runtimeFailure");
  return {
    status: result.snapshot.status === "halted" ? "halted" : "failed",
    failure:
      failure?.kind === "runtimeFailure"
        ? `${failure.code}@${failure.span.start.offset}:${failure.span.end.offset}`
        : null,
    said: result.events.flatMap((event) =>
      event.kind === "say" ? [{ text: event.text, at: event.span.start.offset }] : [],
    ),
  };
}

/** A checked type in full, its unions' members sorted: the plan's side of `derivedText`. */
function planText(type: TypePlan | null): string {
  if (type === null) return "any";
  if (type.kind === "union") return type.members.map(planText).sort().join("|");
  if (type.kind === "list" || type.kind === "set" || type.kind === "dict")
    return `${type.kind}<${planText(type.element)}>`;
  if (type.kind === "object")
    return `{${type.properties.map(({ name, type: of }) => `${name}: ${planText(of)}`).join(", ")}}`;
  return type.kind;
}

/** A plan's checked stores as `derive` gives them: target, statement span, value span, whole type. */
export function plannedStores(plan: InstructionPlan): string[] {
  return plan.instructions.flatMap((instruction) =>
    (instruction.kind === "declareBinding" || instruction.kind === "assign") &&
    instruction.typeCheck !== undefined
      ? [
          `${instruction.kind === "declareBinding" ? instruction.name : instruction.target.kind === "identifier" ? instruction.target.name : "?"} ` +
            `${instruction.span.so}:${instruction.span.eo} ${instruction.value.span.so}:${instruction.value.span.eo} ` +
            planText(instruction.typeCheck.type),
        ]
      : [],
  );
}

export function derivedStores(stores: readonly DerivedStore[]): string[] {
  return stores.map(
    (store) =>
      `${store.target} ${store.so}:${store.eo} ${store.valueSo}:${store.valueEo} ${derivedText(store.type)}`,
  );
}

/** The host values a run's inputs take (§5.2's derived domain): a whole number, text, a truth value, a fraction, null. */
const DOMAIN: readonly SerializableRuntimeValue[] = [2, "text", true, 2.5, null];

/** Every assignment of the domain's values to the globals. */
export function assignments(
  globals: readonly string[],
): Readonly<Record<string, SerializableRuntimeValue>>[] {
  return globals.reduce<Record<string, SerializableRuntimeValue>[]>(
    (partial, name) =>
      partial.flatMap((assigned) => DOMAIN.map((value) => ({ ...assigned, [name]: value }))),
    [{}],
  );
}
