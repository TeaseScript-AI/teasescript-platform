import type { PlaceId, SourceSite } from "../../graph.js";
import type { Admission } from "../admission.js";
import { joinSteps, keepText, keptParts, keptSlice, type WorkLedger } from "../budget.js";
import type { ContractResult, LevelProof } from "../contract-descriptors.js";
import type { Definition } from "../definitions.js";
import type { Unsettled } from "./closure.js";
import { landingIndex } from "./landing-index.js";
import { elementsBelow } from "./structure.js";

/*
 * The receiving obligations of a settled pass (#1526 phase C step 1, Sol's round 1 D1): every check a
 * store owes its destination, found apart from the diagnostics the walk emitted, so a check whose warning a stop left
 * out (a stopped decision's own marks) or never made (a destination whose decision read a frozen key, the unmarked
 * function result `out = make(); out.nest.n = hostValue`) is still owed. A slot is stable across passes (its site, its
 * role and the store's normalized identity); each pass binds it to its destination's key, its receiving site and the
 * extent it requires (`Extent`), since a pass's store targets and rejections are its own (A6, #1275).
 */

/** What a receiving check requires at a path (D1): the whole contract, or the shape alone (suitability, presence). */
export type Extent = "shape" | "complete";

/**
 * Why a slot owes its check: a store's C1 check (a warning the walk made), a stopped decision's store obligation (the
 * marks the stop made, reason `budget`), or an ingress store's C9 boundary (the landing index, no diagnostic read).
 */
export type ReceivingRole = "store" | "stopped" | "ingress";

const ROLE_RANK: Readonly<Record<ReceivingRole, number>> = { store: 0, stopped: 1, ingress: 2 };

/** A receiving slot, stable across passes: its site, its role and the store's normalized identity. */
export interface ReceivingSlot {
  readonly site: SourceSite;
  readonly role: ReceivingRole;
  /** The store's form (its kind and how it stores) and, for an ingress, its receiving subpath below the store. */
  readonly store: string;
}

/** A slot bound in one pass: its destination, the path it receives at, the extent required there. */
export interface ReceivingObligation {
  readonly slot: ReceivingSlot;
  /** The pass (admission epoch) the binding is this one's: another pass binds the slot anew. */
  readonly epoch: number;
  readonly place: PlaceId;
  readonly path: readonly string[];
  readonly extent: Extent;
}

/** What the walk made that a slot is found from, beside admission's own state. */
export interface ReceivingSources {
  readonly epoch: number;
  /**
   * The sites of the store checks the walk owes (its store warnings, C1), each with whether a stop made it: a stopped
   * decision's stores among them, each by the mark the stop gave it (`Consumers.stoppedStores`).
   */
  readonly storeSites: readonly { readonly site: SourceSite; readonly stopped: boolean }[];
  /** The sites of the typed ingresses a stop left open (`Admission.ingressStores`, F18), which the capture takes too. */
  readonly ingressSites: readonly SourceSite[];
  /** A site's identity text. */
  readonly siteKey: (site: SourceSite) => string;
}

/**
 * A store's receiving check as D1's extent table reads it: the complete contract at the path it receives at, and the
 * shape of each level above it (the receiver is suitable and holds the step: `b.f = v` owes `b`'s shape and `b.f`'s
 * contract, never `b`'s other properties' contracts; `b = v` owes `b`'s whole contract; `b[0].f = v` the shapes of
 * `b` and its element and the element's `f`'s contract; host data inside a whole stored value the subpath it lands at).
 */
function extents(
  work: WorkLedger,
  slot: ReceivingSlot,
  epoch: number,
  place: PlaceId,
  path: readonly string[],
): ReceivingObligation[] {
  const out: ReceivingObligation[] = [];
  for (let length = 0; length < path.length; length += 1)
    out.push({ slot, epoch, place, path: keptSlice(work, path, 0, length), extent: "shape" });
  out.push({ slot, epoch, place, path, extent: "complete" });
  return out;
}

/** A store's form, the slot's normalized identity beside its site and role. */
const formOf = (d: Definition): string => `${d.kind}/${d.how ?? ""}`;

/**
 * The pass's receiving obligations, in the stable source order (site, role, extent, path), each slot once: the store
 * checks the walk owes and those a stop marked, a stopped decision's stores among them (by their stores' sites, each
 * store's destination its node's first live definition, as an answer reads one),
 * and every live store that brings external data (the landing index's stores, at the subpath its boundary stands at).
 * Every store and slot visited charged.
 */
export function receivingObligations(
  admission: Admission,
  sources: ReceivingSources,
): ReceivingObligation[] {
  const { epoch, siteKey } = sources;
  const { definitions, lists, program } = admission.pass;
  const work = program.work;
  const found: ReceivingObligation[] = [];
  const add = (slot: ReceivingSlot, place: PlaceId, path: readonly string[]): void => {
    work.charge("checks", path.length + 1);
    keepText(work, slot.store.length);
    found.push(...extents(work, slot, epoch, place, path));
  };
  // (a store's destination: its node's first live definition, else its first, as `Answers.at` reads one; an argument's
  // and a return's, transfers, return with functions to the slice's syntax, which has none)
  const destinations = new Map<unknown, Definition>();
  const bySite = new Map<string, Definition[]>();
  for (const d of definitions.storeDefs) {
    work.charge("checks");
    if (!destinations.has(d.node) && lists.live(d)) destinations.set(d.node, d);
    const at = siteKey(d.site);
    const list = bySite.get(at);
    if (list === undefined) bySite.set(at, [d]);
    else list.push(d);
  }
  for (const d of definitions.storeDefs) if (!destinations.has(d.node)) destinations.set(d.node, d);
  const atSite = (site: SourceSite, role: ReceivingRole): void => {
    const made = new Set<Definition>();
    for (const d of bySite.get(siteKey(site)) ?? []) {
      const destination = destinations.get(d.node)!;
      if (made.has(destination)) continue;
      made.add(destination);
      add(
        { site, role, store: formOf(destination) },
        destination.place,
        admission.destPath(destination),
      );
    }
  };
  for (const { site, stopped } of sources.storeSites) atSite(site, stopped ? "stopped" : "store");
  for (const site of sources.ingressSites) atSite(site, "store");
  // (C9 from the landing index alone: a store whose value brings external data owes its check at the subpath its
  // ingress stops land at, their common prefix below the destination, whatever the walk's warnings say)
  for (const [d, stops] of landingIndex(admission).byStore) {
    work.charge("checks");
    if (stops.length === 0 || !lists.live(d)) continue;
    const record = elementsBelow(d, stops[0]!.path);
    let common = record.length;
    for (const stop of stops) {
      const other = elementsBelow(d, stop.path);
      let length = 0;
      while (length < common && length < other.length && other[length] === record[length])
        length += 1;
      common = length;
    }
    work.charge("checks", stops.length);
    const below = keptSlice(work, record, 0, common);
    add(
      { site: d.site, role: "ingress", store: keptParts(work, formOf(d), below) },
      d.place,
      joinSteps(admission.destPath(d), below),
    );
  }
  // (each slot's binding once: the same site, role, path and extent found twice is one)
  const unique = new Map<string, ReceivingObligation>();
  for (const obligation of found) {
    const { slot } = obligation;
    const text = keptParts(
      work,
      siteKey(slot.site),
      slot.role,
      slot.store,
      obligation.place,
      obligation.path,
      obligation.extent,
    );
    if (!unique.has(text)) unique.set(text, obligation);
  }
  const ordered = [...unique.values()].sort(compareObligations);
  work.charge("checks", ordered.length);
  return ordered;
}

/** The stable source order of obligations: their sites, roles, extents (a shape before a contract), places, paths. */
function compareObligations(a: ReceivingObligation, b: ReceivingObligation): number {
  const sa = a.slot.site;
  const sb = b.slot.site;
  return (
    sa.file - sb.file ||
    sa.start - sb.start ||
    sa.end - sb.end ||
    ROLE_RANK[a.slot.role] - ROLE_RANK[b.slot.role] ||
    (a.extent === b.extent ? 0 : a.extent === "shape" ? -1 : 1) ||
    a.place - b.place ||
    comparePaths(a.path, b.path)
  );
}

function comparePaths(a: readonly string[], b: readonly string[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1)
    if (a[index] !== b[index]) return a[index]! < b[index]! ? -1 : 1;
  return a.length - b.length;
}

/** A distinct requirement of a pass's obligations: a place's path, the extent that dominates there, its sites. */
export interface ReceivingRequirement {
  readonly place: PlaceId;
  readonly path: readonly string[];
  extent: Extent;
  readonly sites: Set<SourceSite>;
}

/**
 * The distinct requirements of a pass's obligations, by place and path, each with the extent that dominates there (a
 * complete contract includes the shape), in the order first required: what the capture extracts, each once; a repeated
 * one attaches its site and solves nothing again.
 */
export function receivingRequirements(
  work: WorkLedger,
  obligations: readonly ReceivingObligation[],
): ReceivingRequirement[] {
  const byPath = new Map<string, ReceivingRequirement>();
  for (const obligation of obligations) {
    const text = keptParts(work, obligation.place, obligation.path);
    const known = byPath.get(text);
    if (known === undefined)
      byPath.set(text, {
        place: obligation.place,
        path: obligation.path,
        extent: obligation.extent,
        sites: new Set([obligation.slot.site]),
      });
    else {
      if (obligation.extent === "complete") known.extent = "complete";
      known.sites.add(obligation.slot.site);
    }
  }
  return [...byPath.values()];
}

/**
 * A shape's result: its level proved (written, decided, or proved open), or lost where its proof is unfinished, or where
 * a completion decision it read cut it (`cause`).
 */
export interface ShapeResult {
  readonly shape: true;
  readonly state: "complete" | "open" | "lost";
  readonly by: LevelProof["by"];
  readonly tags: readonly string[];
  readonly cause?: Unsettled;
}

/** An obligation's result: a complete extent's contract (`ContractResult`), or a shape's. */
export type ReceivingResult = ContractResult | ShapeResult;

/** A shape's result from its level's proof: lost where the proof is unfinished, open where nothing constrains it. */
export function shapeOf(proof: LevelProof): ShapeResult {
  const state = proof.unfinished
    ? "lost"
    : proof.by === "undecided" || proof.tags.includes("unknown")
      ? "open"
      : "complete";
  return { shape: true, state, by: proof.by, tags: [...proof.tags] };
}

/**
 * A requirement lost, nothing of it kept: a completion decision its proof read would reject a store or retarget a
 * selecting store (`Unsettled`). No stop cuts the completion, which runs after everything that can stop (`receive`).
 */
export function lostBy(requirement: ReceivingRequirement, cause: Unsettled): ReceivingResult {
  if (requirement.extent === "shape")
    return { shape: true, state: "lost", by: "undecided", tags: [], cause };
  return {
    state: "lost",
    required: [{ place: requirement.place, path: requirement.path }],
    cause,
    partial: null,
  };
}
