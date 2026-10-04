import { compileChild, runCompileTask, type CompileTask } from "./compiler/continuation.js";
import type { TypePlan, TypePropertyPlan } from "./plan/model.js";
import { members, type StaticType } from "./static-types.js";

/**
 * The runtime check for a place of `type`, or `null` when the compiler knows nothing about the place that the runtime
 * could check. Unknown and still undecided parts are left out (ADR 0021 rule 1.7). Types can be as deep as the
 * literals they come from, so the conversion uses compile-time continuations instead of native recursion.
 */
export function typePlan(type: StaticType): TypePlan | null {
  return runCompileTask(typePlanTask(type));
}

function* typePlanTask(type: StaticType): CompileTask<TypePlan | null> {
  const parts = members(type);
  if (parts.length > 1) {
    const plans: TypePlan[] = [];
    for (const part of parts) {
      const plan = yield* compileChild(typePlanTask(part));
      // A member that accepts every value makes the whole union accept it.
      if (plan === null) return null;
      plans.push(plan);
    }
    return { kind: "union", members: plans };
  }
  const value = parts[0]!;
  switch (value.kind) {
    case "unknown":
    case "open":
    case "never":
    // `members` never gives a union as a member.
    case "union":
      return null;
    case "scalar":
      return { kind: value.name };
    case "list":
    case "set":
      return { kind: value.kind, element: yield* compileChild(typePlanTask(value.element)) };
    case "object": {
      const properties: TypePropertyPlan[] = [];
      for (const [name, property] of value.properties ?? []) {
        const plan = yield* compileChild(typePlanTask(property));
        if (plan !== null) properties.push({ name, type: plan });
      }
      return { kind: "object", properties };
    }
    default:
      return { kind: value.kind };
  }
}
