// A literal's stores at a step, and where an error inside one sits.
import type { PlaceId, SourceSite } from "../../../graph.js";
import type { Admission } from "../../admission.js";
import type { Steps } from "../../contract/key-ids.js";
import { type Definition, sortCost } from "../../definitions.js";
import type { FlowNode } from "../../flow-graph.js";
import type { Item } from "../../items.js";

/**
 * A literal value's stores at one step, in evaluation order: a property's one store, a collection's every element, a
 * dict's values among them (its `element`, as its type has them). Every walk of a literal's children asks here with its
 * path's own step, so the step that reaches a child is read in this one place.
 */
export function literalChildren(admission: Admission, value: PlaceId, step: string): Definition[] {
  const { program, definitions } = admission.pass;
  const out: Definition[] = [];
  for (const has of program.hasOf.get(value) ?? []) {
    const term = admission.termAt(has.type, step);
    if (term?.kind === "ref")
      for (const d of definitions.cellDefs.get(term.place) ?? []) out.push(d);
  }
  program.work.charge("checks", sortCost(out.length));
  return out.sort(
    (a, b) =>
      (program.places[a.value!]?.site?.start ?? 0) - (program.places[b.value!]?.site?.start ?? 0),
  );
}

/**
 * an error for a contribution inside literals sits at the innermost offending expression: the stored value
 * walked along the path through record fields, collection elements and dict values, in evaluation order, to the first
 * value at the path's end whose own items offend.
 */
export function offendingAt(
  admission: Admission,
  d: Definition,
  at: Steps,
  leaf: (items: readonly Item[]) => boolean,
): Definition | null {
  const pending: [PlaceId, FlowNode, number][] = [[d.value!, d.node, 0]];
  while (pending.length > 0) {
    const [value, node, index] = pending.pop()!;
    const children = admission.literalChildren(value, at.at(index)!);
    if (index + 1 === at.length) {
      for (const child of children) {
        admission.pass.program.work.charge("checks");
        if (leaf(admission.items(child.value!, child.node ?? node, []))) return child;
      }
    } else
      for (let position = children.length - 1; position >= 0; position -= 1)
        pending.push([children[position]!.value!, children[position]!.node ?? node, index + 1]);
  }
  return null;
}

/** The site of an error for a store's contribution: the innermost offending expression inside literals, else the store's. */
export function siteAt(
  admission: Admission,
  d: Definition,
  at: Steps,
  leaf: (items: readonly Item[]) => boolean,
): SourceSite {
  const found = at.length > 0 && d.kind === "whole" ? admission.offendingAt(d, at, leaf) : null;
  return found === null ? d.site : (admission.pass.program.place(found.value!).site ?? d.site);
}

/** A literal value's stores at one step: a property's one store, a collection's every element. */
export function storesAt(
  admission: Admission,
  value: PlaceId,
  step: string,
): readonly Definition[] {
  const { program, definitions } = admission.pass;
  for (const has of program.hasOf.get(value) ?? []) {
    const at = admission.termAt(has.type, step);
    if (at?.kind === "ref") return definitions.cellDefs.get(at.place) ?? [];
  }
  return [];
}
