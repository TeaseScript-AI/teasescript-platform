// The nearest written prefix of a path (#1450) and a written type's kinds, each made once per type node from its
// openness (`contract/terms.ts`): what the finishing read (`finishing.ts`) and its host frontier (`host-frontier.ts`)
// ask of a written type.

import type { TypeTerm } from "../../graph.js";
import type { WorkLedger } from "../budget.js";
import { termAt, typeTags } from "../contract.js";
import { openness } from "../contract/terms.js";
import type { ItemTag } from "../items.js";

/** The part below a written part that admits every kind (`permittedAt`'s): every kind fits it too. */
const OPEN_PART: TypeTerm = { kind: "dynamic", why: "unwritten parts" };

const prefixSteps = new WeakMap<TypeTerm, Map<string, TypeTerm | null>>();

/**
 * The nearest written prefix of a path (#1450): the written type's part at the path, or, below a part that admits every
 * kind (an unwritten element, an `object`'s properties, a union member's), the open part, as admission's `permittedAt`
 * reads it; `null` where the written type does not reach the path. Each step once per node, from the memoized openness.
 */
export function prefixAt(
  work: WorkLedger,
  term: TypeTerm,
  path: readonly string[],
): TypeTerm | null {
  let at: TypeTerm | null = term;
  for (const step of path) {
    if (at === null || openness(work, at).open) return at;
    at = prefixStep(work, at, step);
  }
  return at;
}

function prefixStep(work: WorkLedger, term: TypeTerm, step: string): TypeTerm | null {
  let steps = prefixSteps.get(term);
  if (steps === undefined) prefixSteps.set(term, (steps = new Map()));
  const known = steps.get(step);
  if (known !== undefined || steps.has(step)) return known ?? null;
  work.charge("checks");
  let below: TypeTerm | null;
  if (openness(work, term).open || (term.kind === "object" && term.properties === null))
    below = OPEN_PART;
  else if (term.kind === "union") {
    const parts = term.members.flatMap((member) => prefixStep(work, member, step) ?? []);
    below = parts.some((part) => openness(work, part).open)
      ? OPEN_PART
      : parts.length === 0
        ? null
        : parts.length === 1
          ? parts[0]!
          : { kind: "union", members: parts };
  } else below = termAt(term, [step]);
  steps.set(step, below);
  return below;
}

const tagsByTerm = new WeakMap<TypeTerm, readonly ItemTag[]>();

/** A written type's kinds (`typeTags`), made and charged once per type a read answers by. */
export function writtenTags(work: WorkLedger, term: TypeTerm): readonly ItemTag[] {
  let tags = tagsByTerm.get(term);
  if (tags === undefined) {
    tags = typeTags(term);
    work.charge("checks", tags.length);
    tagsByTerm.set(term, tags);
  }
  return tags;
}
