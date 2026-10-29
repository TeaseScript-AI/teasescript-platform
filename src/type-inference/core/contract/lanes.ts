import type { PlaceId } from "../../graph.js";
import { joinParts, type WorkCounter, type WorkLedger } from "../budget.js";
import type { Contract } from "../contract.js";
import { keyOf } from "../definitions.js";
import { marksNothing } from "./marks.js";
import type { WrapperHop } from "./model.js";
import { writtenOf } from "./terms.js";

// G3 stage 1 (TABLE r4.196): a binding's wrapper shape, the frozen structural part of `wrapperHop`, and the lane the keys
// of each `(binding, first step)` family take from it.

/** The representation a family's keys take in a pass: cursors (`key-ids.ts`) or their text. */
export type KeyLane = "cursor" | "text";

/** Who asked a wrapper shape: `wrapperHop`'s live answer, or a key's lane (`keyLane`). */
export type ShapeAsker = "hop" | "lane";

/**
 * A wrapper shape or a key lane asked, with what the question cost (criterion 2 of r4.196's early selector): its pass
 * (in the order the recording first saw it), binding and first step; for a shape its asker, answer (`stopped` where the
 * ledger stopped it), whether its memo answered, and the units it charged by counter, as the demand's own work, a shared
 * build's or work counted apart; for a lane its lane, whether its family was frozen already or was being built, which
 * leaves it text for the pass. Each with the demand whose run asked (`Solver.reading`).
 */
export type KeyRecord =
  | {
      readonly kind: "shape";
      readonly pass: number;
      readonly binding: PlaceId;
      readonly step: string;
      readonly asker: ShapeAsker;
      readonly outcome: "wrapper" | "none" | "stopped";
      readonly hit: boolean;
      readonly owner: string | null;
      readonly counters: Readonly<Partial<Record<WorkCounter, number>>>;
      readonly own: number;
      readonly shared: number;
      readonly apart: number;
    }
  | {
      readonly kind: "lane";
      readonly pass: number;
      readonly binding: PlaceId;
      readonly step: string;
      readonly lane: KeyLane;
      readonly hit: boolean;
      readonly building: boolean;
      readonly owner: string | null;
    };

let recording: {
  readonly records: KeyRecord[];
  readonly passes: WeakMap<Contract, number>;
  next: number;
} | null = null;

/** Test and evidence only: `run`, with every wrapper shape and key lane asked inside it recorded (`KeyRecord`). */
export function withKeyRecords<T>(run: () => T): {
  readonly result: T;
  readonly records: readonly KeyRecord[];
} {
  if (recording !== null) throw new Error("Key records are already being recorded.");
  const records: KeyRecord[] = [];
  recording = { records, passes: new WeakMap(), next: 0 };
  try {
    return { result: run(), records };
  } finally {
    recording = null;
  }
}

/** The recording's number of a pass, by its contract. */
function passOf(contract: Contract): number {
  const { passes } = recording!;
  let pass = passes.get(contract);
  if (pass === undefined) passes.set(contract, (pass = recording!.next++));
  return pass;
}

/** The ledger as it stands, to tell a question's units (`KeyRecord`). */
interface LedgerMark {
  readonly sharing: boolean;
  readonly counts: ReadonlyMap<WorkCounter, number>;
  readonly apartCounts: ReadonlyMap<WorkCounter, number>;
  readonly total: number;
  readonly own: number;
  readonly finishing: number;
}

function ledgerMark(work: WorkLedger): LedgerMark {
  return {
    sharing: work.sharing,
    counts: work.counts(),
    apartCounts: work.apartCounts(),
    total: work.total,
    own: work.own,
    finishing: work.finishing,
  };
}

/**
 * The units charged since `before`, by counter and by how the ledger counted them: inside a `shared` build already
 * running at `before`, all shared, though the ledger books them so only when that build ends.
 */
function chargedSince(
  work: WorkLedger,
  before: LedgerMark,
): Pick<Extract<KeyRecord, { kind: "shape" }>, "counters" | "own" | "shared" | "apart"> {
  const counters: Partial<Record<WorkCounter, number>> = {};
  for (const [now, then] of [
    [work.counts(), before.counts],
    [work.apartCounts(), before.apartCounts],
  ] as const)
    for (const [counter, units] of now) {
      const spent = units - (then.get(counter) ?? 0);
      if (spent > 0) counters[counter] = (counters[counter] ?? 0) + spent;
    }
  const own = before.sharing ? 0 : work.own - before.own;
  return {
    counters,
    own,
    shared: work.total - before.total - own,
    apart: work.finishing - before.finishing,
  };
}

/**
 * The binding's wrapper at `step` (`wrapperHop`), or `null`, from the facts of the program and the pass's live stores
 * alone, never its stops or the occurrence that asks: so one answer per binding and step for the pass, found once (its
 * memo key's text charged first) by whichever asker comes first.
 */
export function wrapperShape(
  contract: Contract,
  binding: PlaceId,
  step: string,
  asker: ShapeAsker,
): WrapperHop | null {
  const memoKey = joinParts(binding, step);
  const known = contract.hops.get(memoKey);
  if (known !== undefined) {
    if (recording !== null)
      recording.records.push({
        kind: "shape",
        pass: passOf(contract),
        binding,
        step,
        asker,
        outcome: known === null ? "none" : "wrapper",
        hit: true,
        owner: contract.pass.solver.reading,
        counters: {},
        own: 0,
        shared: 0,
        apart: 0,
      });
    return known;
  }
  const before = recording === null ? null : ledgerMark(contract.work);
  let hop: WrapperHop | null | undefined;
  try {
    contract.keepText(memoKey.length);
    contract.shaping.add(memoKey);
    hop = shapeOf(contract, binding, step);
    contract.hops.set(memoKey, hop);
    return hop;
  } finally {
    contract.shaping.delete(memoKey);
    if (before !== null && recording !== null)
      recording.records.push({
        kind: "shape",
        pass: passOf(contract),
        binding,
        step,
        asker,
        outcome: hop === undefined ? "stopped" : hop === null ? "none" : "wrapper",
        hit: false,
        owner: contract.pass.solver.reading,
        ...chargedSince(contract.work, before),
      });
  }
}

/** `wrapperShape`'s finding: the conditions of `wrapperHop` on the binding, its declaration and its literal. */
function shapeOf(contract: Contract, binding: PlaceId, step: string): WrapperHop | null {
  const { program, definitions, lists, guards } = contract.pass;
  program.work.charge("invSteps");
  const place = program.places[binding];
  if (
    place === undefined ||
    place.kind.kind !== "binding" ||
    writtenOf(place.kind) !== null ||
    program.isHost(binding) ||
    program.speakerPlaces.has(binding)
  )
    return null;
  const root = keyOf(binding, []);
  const defs = definitions.byKey.get(root) ?? [];
  const d = defs[0];
  if (
    defs.length !== 1 ||
    d === undefined ||
    d.how !== "initializer" ||
    d.kind !== "whole" ||
    d.weak ||
    d.value === undefined ||
    d.orig !== undefined ||
    d.loop !== undefined ||
    !lists.live(d) ||
    !program.live(d.node) ||
    program.inBlockCode(d.node) ||
    !program.hasOf.has(d.value) ||
    definitions.keysBelow(root).length > 0 ||
    definitions.loopAdds.has(root) ||
    definitions.ownedAway(root) ||
    !guards.untested(binding)
  )
    return null;
  // its declaration's entry, alone and marking nothing, at its root
  const stores = contract.prefixStores(root);
  const entry = stores.list[0];
  if (
    stores.list.length !== 1 ||
    entry === undefined ||
    entry.value !== d.value ||
    entry.at !== undefined ||
    entry.key !== undefined ||
    entry.elem !== undefined ||
    entry.unk !== undefined ||
    entry.guarded ||
    entry.ingress !== undefined ||
    !marksNothing(contract, entry.holder) ||
    stores.subs !== null ||
    stores.also.length > 0 ||
    stores.other ||
    stores.cut
  )
    return null;
  const read = contract.literalHop(d.value, step);
  if (read === null) return null;
  contract.keep(3);
  return {
    decl: d,
    literal: d.value,
    read: read.read,
    node: read.node ?? d.node,
    writer: definitions.writerOf(d),
  };
}

/**
 * The lane of the keys of `place` (a binding, or a read of one: its binding's) whose first step is `firstStep`, frozen
 * at the family's first question for the pass (TABLE r4.196): cursors where the step passes the binding's wrapper
 * (`wrapperShape`), text where it does not; text for the pass, too, where the question comes while the shape is being
 * found or the identity layer or the marks are being built (`building`), whose unfinished state a shape found then
 * would read, never promoted later. A key with no first step keeps its text, and the live conditions of `wrapperHop`
 * (an ingress, a stop) decide answers, never a lane. A fresh pass (A6, a stopped set, the finishing) asks afresh.
 */
export function keyLane(contract: Contract, place: PlaceId, firstStep: string | null): KeyLane {
  if (firstStep === null) return "text";
  const binding = contract.pass.program.occurrenceOf.get(place) ?? place;
  let byStep = contract.lanes.get(binding);
  const frozen = byStep?.get(firstStep);
  if (frozen !== undefined) {
    if (recording !== null) noteLane(contract, binding, firstStep, frozen, true, false);
    return frozen;
  }
  const memoKey = joinParts(binding, firstStep);
  const known = contract.hops.get(memoKey);
  const building = known === undefined && (contract.building > 0 || contract.shaping.has(memoKey));
  const shape = building ? null : (known ?? wrapperShape(contract, binding, firstStep, "lane"));
  // (a question while the shape was being found froze the family first: its lane stands)
  const meanwhile = contract.lanes.get(binding)?.get(firstStep);
  if (meanwhile !== undefined) {
    if (recording !== null) noteLane(contract, binding, firstStep, meanwhile, true, false);
    return meanwhile;
  }
  const lane: KeyLane = shape === null ? "text" : "cursor";
  contract.keep(1);
  byStep ??= contract.lanes.get(binding);
  if (byStep === undefined) contract.lanes.set(binding, (byStep = new Map()));
  byStep.set(firstStep, lane);
  if (recording !== null) noteLane(contract, binding, firstStep, lane, false, building);
  return lane;
}

function noteLane(
  contract: Contract,
  binding: PlaceId,
  step: string,
  lane: KeyLane,
  hit: boolean,
  building: boolean,
): void {
  recording!.records.push({
    kind: "lane",
    pass: passOf(contract),
    binding,
    step,
    lane,
    hit,
    building,
    owner: contract.pass.solver.reading,
  });
}
