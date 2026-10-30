import type { PlaceId } from "../../graph.js";
import { keptText, pathText, type WorkCounter, type WorkLedger } from "../budget.js";
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
  recorded?.records.push({ kind: "recipe", made: root === undefined });
  if (root === undefined) {
    const text = contract.pass.program.place(place).label;
    contract.labelRoots.set(place, (root = { parent: null, step: "", text, below: null }));
  }
  return root;
}

/** The recipe one `step` below `parent` (a step as the label spells it): made once, then the same recipe each time. */
export function labelBelow(parent: Label, step: string): Label {
  let found = parent.below?.get(step);
  recorded?.records.push({ kind: "recipe", made: found === undefined });
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
  if (recorded === null) return shown(contract, label);
  const before = mark(contract.work);
  const made = label.text === null;
  const text = shown(contract, label);
  const pass = passOf(contract);
  recorded.records.push({ kind: "text", pass, text, made, ...since(contract.work, before) });
  return text;
}

function shown(contract: Contract, label: Label): string {
  if (label.text !== null) {
    convert(contract, 1, 0, 0);
    return label.text;
  }
  const parts = partsOf(label);
  convert(contract, parts.length, 0, 1);
  return (label.text = keptText(contract.work, parts));
}

/**
 * A label's text made plain and not kept here, charging nothing (`labelText`'s twin, as `pathText` is `keptText`'s):
 * for a caller that charges the text it keeps itself, the boundary check's (`publish`, TABLE r4.196: its legacy
 * billing stays).
 */
export function labelPlainText(label: Label): string {
  const made = label.text === null;
  const text = made ? pathText(partsOf(label)) : label.text!;
  recorded?.records.push({ kind: "text", pass: null, text, made, counters: {}, apart: {} });
  return text;
}

/** A label's parts, from the nearest recipe at or above it whose text is made down to its own step. */
function partsOf(label: Label): string[] {
  const parts: string[] = [];
  let at = label;
  for (; at.text === null; at = at.parent!) parts.push(at.step);
  parts.push(at.text);
  return parts.reverse();
}

/**
 * What `withLabelRecords` hears: a recipe asked (`made` where new), and a text shown in a pass, numbered in the order the
 * recording first met it (`made` where its text was made there, not found), with the units it charged by counter,
 * against the allowance or apart from it (after a stop, `apart`); a plain text (`labelPlainText`) with no pass, charging
 * nothing.
 */
export type LabelRecord =
  | { readonly kind: "recipe"; readonly made: boolean }
  | {
      readonly kind: "text";
      readonly pass: number | null;
      readonly text: string;
      readonly made: boolean;
      readonly counters: Readonly<Partial<Record<WorkCounter, number>>>;
      readonly apart: Readonly<Partial<Record<WorkCounter, number>>>;
    };

let recorded: {
  readonly records: LabelRecord[];
  readonly passes: WeakMap<Contract, number>;
  next: number;
} | null = null;

/** The recording's number of a pass, by its contract. */
function passOf(contract: Contract): number {
  const { passes } = recorded!;
  let pass = passes.get(contract);
  if (pass === undefined) passes.set(contract, (pass = recorded!.next++));
  return pass;
}

/** Test and evidence only: `run`, with every recipe asked and every text shown inside it recorded (`LabelRecord`). */
export function withLabelRecords<T>(run: () => T): {
  readonly result: T;
  readonly records: readonly LabelRecord[];
} {
  if (recorded !== null) throw new Error("Label records are already being recorded.");
  const records: LabelRecord[] = [];
  recorded = { records, passes: new WeakMap(), next: 0 };
  try {
    return { result: run(), records };
  } finally {
    recorded = null;
  }
}

type Mark = readonly [ReadonlyMap<WorkCounter, number>, ReadonlyMap<WorkCounter, number>];

function mark(work: WorkLedger): Mark {
  return [work.counts(), work.apartCounts()];
}

/** The units charged since `before`, by counter, counted against the allowance and apart. */
function since(
  work: WorkLedger,
  before: Mark,
): Pick<Extract<LabelRecord, { kind: "text" }>, "counters" | "apart"> {
  const [counters, apart]: Partial<Record<WorkCounter, number>>[] = [{}, {}];
  for (const [index, now] of [work.counts(), work.apartCounts()].entries())
    for (const [counter, units] of now) {
      const spent = units - (before[index]!.get(counter) ?? 0);
      if (spent !== 0) [counters, apart][index]![counter] = spent;
    }
  return { counters: counters!, apart: apart! };
}
