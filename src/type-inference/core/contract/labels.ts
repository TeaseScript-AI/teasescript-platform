import type { PlaceId } from "../../graph.js";
import { keptText, pathText } from "../budget.js";
import type { Contract } from "../contract.js";
import { convert } from "./key-ids.js";

// G3 stage 1 (TABLE r4.196): a path's label as a recipe, made one step from its parent's, and its text made only where
// a diagnostic or a check shows it (`labelText`). A label no one shows costs its recipe and no text.

/**
 * A label's recipe: its place's label at the root, else its parent's recipe and one step as the label spells it (an
 * element step `element` or `entry`, spelled where the label is made, `Admission.labelOf`). One per spelling of a path
 * in a pass, made once from its parent's (`labelBelow`); its text is made once, where it is first shown (`labelText`).
 */
export interface Label {
  readonly parent: Label | null;
  readonly step: string;
  /** Its text once made (`labelText`), its place's label at the root, else `null`. */
  text: string | null;
  /** Its recipes one step below, by step, made as they are first asked. */
  below: Map<string, Label> | null;
}

/** A place's own label's recipe: the place's label, the same recipe each time in a pass. */
export function labelRoot(contract: Contract, place: PlaceId): Label {
  let root = contract.labelRoots.get(place);
  if (root === undefined) {
    const text = contract.pass.program.place(place).label;
    contract.labelRoots.set(place, (root = { parent: null, step: "", text, below: null }));
  }
  return root;
}

/** The recipe one `step` below `parent` (a step as the label spells it): made once, then the same recipe each time. */
export function labelBelow(parent: Label, step: string): Label {
  let found = parent.below?.get(step);
  if (found === undefined) {
    found = { parent, step, text: null, below: null };
    (parent.below ??= new Map()).set(step, found);
  }
  return found;
}

/**
 * A label's text, where a diagnostic or a check shows it: made once per recipe and kept, down from the nearest recipe
 * above it whose text is made, so a label makes no text of a prefix no one showed; charged as a key cursor's conversion
 * (`convert`: each recipe it visits and the text it keeps, `keyOfId`), a text made before only its visit.
 */
export function labelText(contract: Contract, label: Label): string {
  if (label.text !== null) {
    convert(contract, 1, 0, 0);
    return label.text;
  }
  const parts: string[] = [];
  let at = label;
  for (; at.text === null; at = at.parent!) parts.push(at.step);
  convert(contract, parts.length + 1, 0, 1);
  parts.push(at.text);
  parts.reverse();
  return (label.text = keptText(contract.work, parts));
}

/**
 * A label's text made plain and not kept here, charging nothing (`labelText`'s twin, as `pathText` is `keptText`'s):
 * for a caller that charges the text it keeps itself, the boundary check's (`publish`, TABLE r4.196: its legacy
 * billing stays).
 */
export function labelPlainText(label: Label): string {
  if (label.text !== null) return label.text;
  const parts: string[] = [];
  let at = label;
  for (; at.text === null; at = at.parent!) parts.push(at.step);
  parts.push(at.text);
  parts.reverse();
  return pathText(parts);
}
