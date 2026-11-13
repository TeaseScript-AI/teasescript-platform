// A written type's openness and the nearest written prefix of a path (#1450), each made once per type node: what
// the finishing read (`finishing.ts`) and its host frontier (`host-frontier.ts`) ask of a written type.

import type { TypeTerm } from "../../graph.js";
import type { WorkLedger } from "../budget.js";
import { termAt, typeTags } from "../contract.js";
import type { ItemTag } from "../items.js";

/** The part below a written part that admits every kind (`permittedAt`'s): every kind fits it too. */
const OPEN_PART: TypeTerm = { kind: "dynamic", why: "unwritten parts" };

/** A written type node's openness (#1450): whether it admits every kind, and whether it does at or anywhere below it. */
interface Openness {
  readonly open: boolean;
  readonly below: boolean;
}

const opennessByTerm = new WeakMap<TypeTerm, Openness>();

/** A written type node's parts one level down: a collection's element, an object's properties, a union's members. */
function partsOfTerm(term: TypeTerm): readonly TypeTerm[] {
  if (term.kind === "list" || term.kind === "set" || term.kind === "dict") return [term.element];
  if (term.kind === "object") return term.properties?.map((property) => property.type) ?? [];
  return term.kind === "union" ? term.members : [];
}

/**
 * A written type node's openness, made once per node from its parts' (#1487): `open` is admission's `unrestricted`
 * (`typeTags`' `unknown`: a part the core leaves open; a union's where one of its members is), `below` also where any
 * part is, or an `object`'s properties are unwritten. An explicit stack, parts first; each node charged once.
 */
export function openness(work: WorkLedger, term: TypeTerm): Openness {
  const known = opennessByTerm.get(term);
  if (known !== undefined) return known;
  const pending = [term];
  while (pending.length > 0) {
    const at = pending.at(-1)!;
    if (opennessByTerm.has(at)) {
      pending.pop();
      continue;
    }
    const parts = partsOfTerm(at);
    const unmade = parts.filter((part) => !opennessByTerm.has(part));
    if (unmade.length > 0) {
      for (const part of unmade) pending.push(part);
      continue;
    }
    pending.pop();
    work.charge("checks", 1 + parts.length);
    const below = parts.map((part) => opennessByTerm.get(part)!);
    // (a scalar restricts to its kind; a collection or an object restricts at its own level)
    const open =
      at.kind === "union"
        ? below.some((part) => part.open)
        : !["atom", "list", "set", "dict", "object"].includes(at.kind);
    opennessByTerm.set(at, {
      open,
      below:
        open ||
        (at.kind === "object" && at.properties === null) ||
        below.some((part) => part.below),
    });
  }
  return opennessByTerm.get(term)!;
}

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
