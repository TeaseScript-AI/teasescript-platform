import type { TypeTerm } from "../../graph.js";
import type { Admission } from "../admission.js";
import { keep } from "../budget.js";
import { termAt, typeTags } from "../contract.js";
import type { ItemTag } from "../items.js";

// What a written type permits at a path: its open steps, its levels, and the unrestricted parts below it.

/** The part below an unrestricted written part: every kind fits it. */
const OPEN: TypeTerm = { kind: "dynamic", why: "unwritten parts" };

/**
 * The written type a path stands under (V30 §13: `list`, `set`, `dict` and `object` stand for any list, set, dict or
 * object): its term, or below an unrestricted part (an unwritten element, an `object`'s properties, an optional's or a
 * union's member's too) a part whose every kind fits; `null` where the written type does not reach the path (the lead's
 * ruling on the merged S6's B2). One step at a time, so a path costs its length.
 */
export function permittedAt(term: TypeTerm, path: readonly string[]): TypeTerm | null {
  let at: TypeTerm | null = term;
  for (const step of path) {
    if (at === null || unrestricted(at)) return at;
    at = permittedStep(at, step);
  }
  return at;
}

/** One step of `permittedAt`: a union is unrestricted below where any of its members is, else read as `termAt` reads it. */
function permittedStep(term: TypeTerm, step: string): TypeTerm | null {
  if (term.kind === "union")
    return term.members.some((member) => {
      const below = permittedStep(member, step);
      return below !== null && unrestricted(below);
    })
      ? OPEN
      : termAt(term, [step]);
  if (unrestricted(term) || (term.kind === "object" && term.properties === null)) return OPEN;
  return termAt(term, [step]);
}

/** Whether a written part restricts nothing (`typeTags`' `unknown`: an unwritten element, a type the core leaves open). */
export function unrestricted(term: TypeTerm): boolean {
  return typeTags(term).includes("unknown");
}

/**
 * ADR 0021 1.3, V30 §13 and §16 (Astra r2's B1 on #1310): what a type an operand's elements have at a path brings into a
 * list join, whose joined list follows a literal's element rule: an unrestricted type (`list`'s elements) leaves the
 * joined list open there and below, whichever operand came first, so no conflict is proved from it; a type that holds
 * only `null` decides nothing, its `null` making the joined list optional; any other type decides by its kinds.
 * `joinElements` reads its operands by it, and a place holding a join is decided by it (`earliestDecider`).
 */
export function joinedDomain(tags: readonly ItemTag[]): "open" | "null" | "kinds" {
  if (tags.includes("unknown")) return "open";
  return tags.every((tag) => tag === "null") ? "null" : "kinds";
}

/**
 * A written type's element levels (A1, A4, A8): the type, its element type, that one's, as deep as the type goes, each
 * one step below the one before (`termAt`), once per type and pass: k copies of a type d levels deep read its levels
 * once, never once per copy and each level from the root (#1194).
 */
export function levelsOf(admission: Admission, term: TypeTerm): readonly TypeTerm[] {
  const known = admission.termLevels.get(term);
  if (known !== undefined) return known;
  const levels = [term];
  for (let at = termAt(term, ["element"]); at !== null; at = termAt(at, ["element"])) {
    admission.work.charge("indexSteps");
    levels.push(at);
  }
  keep(admission.work, levels.length);
  admission.termLevels.set(term, levels);
  return levels;
}
