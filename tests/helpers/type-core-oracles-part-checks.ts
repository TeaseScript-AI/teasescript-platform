// A stopped plan's part checks against the natural plan's (#1682).
import type { InstructionPlan, PartCheckPlan, PartStep, TypePlan } from "../../src/plan/model.js";
import { planSiteKey } from "./site-keys.js";

/**
 * The type a store's whole check checks at `path` below it, as `reaches` in `runtime-plan.ts` reads it: a property's
 * type where an object lists it, a collection's element type, through a union's members at any depth that can hold the
 * step (one member's type, else their union); `null` where the check reaches nothing there (an object without the
 * property, a collection with open elements, no member that holds the step).
 */
function projectedType(type: TypePlan, path: readonly PartStep[]): TypePlan | null {
  // (a union's members, a nested union's at any depth, as `reaches` walks them)
  const members = (t: TypePlan): TypePlan[] =>
    t.kind === "union" ? t.members.flatMap(members) : [t];
  let at: readonly TypePlan[] = [type];
  for (const step of path) {
    const next: TypePlan[] = [];
    for (const each of at.flatMap(members))
      if ("property" in step) {
        if (each.kind !== "object") continue;
        const found = each.properties.find((property) => property.name === step.property);
        if (found === undefined) return null;
        next.push(found.type);
      } else if (each.kind === "list" || each.kind === "set" || each.kind === "dict") {
        if (each.element === null) return null;
        next.push(each.element);
      }
    if (next.length === 0) return null;
    at = next;
  }
  return at.length === 1 ? at[0]! : { kind: "union", members: at };
}

/**
 * Whether a check against `wide` accepts every value one against `narrow` does (a type plan's own rules: an object checks
 * only the properties it lists, a collection with open elements accepts any, a union any member's values).
 */
function accepts(wide: TypePlan, narrow: TypePlan): boolean {
  if (JSON.stringify(wide) === JSON.stringify(narrow)) return true;
  if (narrow.kind === "union") return narrow.members.every((member) => accepts(wide, member));
  if (wide.kind === "union") return wide.members.some((member) => accepts(member, narrow));
  if (wide.kind !== narrow.kind) return false;
  if (wide.kind === "object" && narrow.kind === "object")
    return wide.properties.every((property) => {
      const other = narrow.properties.find((candidate) => candidate.name === property.name);
      return other !== undefined && accepts(property.type, other.type);
    });
  if ("element" in wide && "element" in narrow)
    return (
      wide.element === null || (narrow.element !== null && accepts(wide.element, narrow.element))
    );
  return false;
}

/**
 * The invariant of a stopped plan's part checks (#1682, the lead's ruling on HEAD 0): each stopped store's parts are a
 * subsequence of the natural store's (path, type and place equal), except a part whose path the natural store's whole
 * check covers with that same projected type (`projectedType`), or one the part accepts all of (the part is then fewer);
 * never a part the natural plan neither has nor covers, never one narrower than what covers it. `problems`: each a line
 * naming the store (`kind@file:so:eo`, its site the compiler's, `planSiteKey`: a store's offsets are its file's,
 * Astra r1's B1 on #1690) and the part; `covered`: each covered part with `=` (the projected type itself) or
 * `wider`.
 */
export function partProblems(
  natural: InstructionPlan,
  stopped: InstructionPlan,
): { readonly problems: string[]; readonly covered: string[] } {
  type Store = { readonly parts: readonly PartCheckPlan[]; readonly whole: TypePlan | null };
  const stores = (plan: InstructionPlan): Map<string, Store> => {
    const out = new Map<string, Store>();
    plan.instructions.forEach((instruction, index) => {
      if (instruction.kind !== "declareBinding" && instruction.kind !== "assign") return;
      const at = `${instruction.kind}@${planSiteKey(plan, index)}`;
      if (out.has(at)) throw new Error(`Two stores of one plan at ${at}.`);
      out.set(at, {
        parts: instruction.partChecks ?? [],
        whole: instruction.typeCheck?.type ?? null,
      });
    });
    return out;
  };
  const text = (part: PartCheckPlan): string => JSON.stringify([part.path, part.type, part.place]);
  const naturals = stores(natural);
  const problems: string[] = [];
  const covered: string[] = [];
  for (const [at, { parts }] of stores(stopped)) {
    if (parts.length === 0) continue;
    const own = naturals.get(at);
    if (own === undefined) {
      problems.push(`${at}: no such store in the natural plan`);
      continue;
    }
    const expected = own.parts.map(text);
    let cursor = 0;
    for (const part of parts) {
      const found = expected.indexOf(text(part), cursor);
      if (found >= 0) {
        cursor = found + 1;
        continue;
      }
      const projected = own.whole === null ? null : projectedType(own.whole, part.path);
      if (projected !== null && accepts(part.type, projected)) {
        covered.push(
          `${at}: ${text(part)} ${JSON.stringify(part.type) === JSON.stringify(projected) ? "=" : "wider"}`,
        );
        continue;
      }
      problems.push(
        `${at}: ${text(part)} ${
          expected.includes(text(part))
            ? "out of the natural order"
            : projected === null
              ? "neither a natural part nor covered by the natural whole check"
              : `stricter than the natural whole check's ${JSON.stringify(projected)} there`
        }`,
      );
    }
  }
  return { problems, covered };
}
