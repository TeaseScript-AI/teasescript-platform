import type { PlaceId, SourceSite } from "../../graph.js";
import { joinSteps } from "../budget.js";
import type { Consumers } from "../consumers.js";
import { termAt, writtenOf } from "../contract.js";
import { keyOf, type Definition } from "../definitions.js";
import { STOPPED } from "../items.js";
import { pathPhrase } from "../messages.js";
import { Laminar } from "../narrowing.js";
import { siteKey } from "../program.js";
import { targetName } from "../result.js";
import { mixed } from "./mixed.js";
import { admittedStores } from "./stores.js";
import { placeText, storeRoot, storeSteps, storeWarning } from "./warnings.js";

// The fresh pass (TABLE r4.138): the stores' obligations where admission had not settled, and the marks it leaves.

/**
 * The stores' obligations in the finishing path where admission had not settled (TABLE r4.110 (3)), reading no
 * decision (A6: a later pass may admit a store this one rejected, so its decisions may be narrower than the settled
 * ones). It runs every derivation of admission's that creates an obligation (`OBLIGATION_SITES`, with each one's
 * exits: TABLE r4.126, r4.138), as admission runs it, reading what the stop retained as every consumer does (one
 * derivation): C1 against a written type at a store's path (`admittedStores`); ADR 0021 1.3's mixed literal elements
 * (`literalElements`), a literal whose element needs a decision marked through its holders or itself (`markHolder`);
 * F18's typed calls no store takes in (`ingressStores`); the ingress stores' boundaries against written types
 * (`publish`); the walk, which finishes every unit, the read boundaries. Every store and transfer into an inferred
 * place is marked at its site, its type undecided (r4.100); a mark stands for its records within its value (r4.111).
 * No syntax decision is made here (TABLE r4.135): admission decides an inferred place from its contract, which a fresh
 * pass has not solved, so only a settled stop's finishing read asks the stores' syntax, after the decision admission
 * retained.
 */
export function freshStores(walk: Consumers): void {
  const { program, definitions } = walk.pass;
  // (every store and transfer, an argument to a parameter several calls reach and one beside a default among them,
  // which `Admission.stores` leaves out of its decisions but whose obligations it owes: r4.138)
  for (const d of [...definitions.storeDefs, ...definitions.transferDefs]) {
    program.work.charge("checks");
    if (d.value === undefined || (d.kind !== "whole" && d.kind !== "add")) continue;
    const written = writtenOf(program.place(d.place).kind);
    const path = d.kind === "add" ? joinSteps(d.path, ["element"]) : d.path;
    if (written !== null && termAt(written, path) !== null) continue;
    storeMark(walk, d, path);
  }
  // (ranked as admission's own stages, C1 before the mixed elements; run after them, so C1 reads the elements they
  // keep, as unstopped admission's passes converge on: A6)
  walk.rule = 3;
  walk.admission.literalElements(
    walk.order,
    (site, found) => mixed(walk, site, found),
    (cell) => markHolder(walk, cell),
  );
  walk.rule = 1;
  admittedStores(walk, true);
  // (the publication first: its landing index, of the stores into written places alone, is the one F18's asks)
  walk.admission.publish(true);
  walk.rule = 2;
  const open = walk.admission.ingressStores((site) => inMarkedValue(walk, site));
  for (const { site, label } of open) ingressMark(walk, site, label);
  walk.rule = 1;
  walk.published = true;
}

/**
 * Whether a literal's element stands (A6, ADR 0021 1.3): no pass's admission rejected it, nor this fresh pass's mixed
 * elements whole, as the unstopped values read it.
 */
export function stands(walk: Consumers, d: Definition): boolean {
  if (!walk.pass.lists.live(d)) return false;
  return !(
    walk.finishing &&
    !walk.settled &&
    (walk.admission.newlyRejected.get(d.uid)?.has(keyOf(d.place, [])) ?? false)
  );
}

/** A store into a place the fresh pass leaves undecided: marked at its site, its type undecided (r4.100), once. */
function storeMark(walk: Consumers, d: Definition, path: readonly string[]): void {
  if (walk.marked.has(d.uid)) return;
  walk.marked.add(d.uid);
  const { program } = walk.pass;
  storeWarning(
    walk,
    d.site,
    targetName(program.place(d.place).label, path),
    STOPPED[0]!,
    ["unknown"],
    {
      rule: "store",
      into: placeText(walk, d.place, path),
      type: ["unknown"],
      written: false,
      decider: null,
      brought: null,
      root: storeRoot(walk, d.place),
      steps: storeSteps(walk, d.place, path),
    },
    [],
  );
}

/**
 * Whether a site lies inside the value of a store or transfer the fresh pass marked (`storeMark`): one laminar list of
 * their values' spans per file, made once, and a walk up from the innermost span holding the site's start.
 */
function inMarkedValue(walk: Consumers, site: SourceSite): boolean {
  const { program, definitions } = walk.pass;
  const work = program.work;
  if (walk.markedSpans === null) {
    const byFile = new Map<number, { start: number; end: number; item: null }[]>();
    for (const d of [...definitions.storeDefs, ...definitions.transferDefs]) {
      work.charge("checks");
      if (!walk.marked.has(d.uid) || d.value === undefined) continue;
      const at = program.places[d.value]?.site ?? null;
      if (at === null) continue;
      const spans = byFile.get(at.file);
      const span = { start: at.start, end: at.end, item: null };
      if (spans === undefined) byFile.set(at.file, [span]);
      else spans.push(span);
    }
    walk.markedSpans = new Map();
    for (const [file, spans] of byFile) walk.markedSpans.set(file, new Laminar(work, spans));
  }
  const spans = walk.markedSpans.get(site.file);
  if (spans === undefined) return false;
  for (let index = spans.innermostIndex(site.start); index >= 0;) {
    work.charge("checks");
    if (spans.ends[index]! >= site.end) return true;
    index = spans.parents[index]!;
  }
  return false;
}

/**
 * A literal whose element needs a decision admission did not make (`Admission.literalElements`, before admission
 * settled): each definition of the outermost literal holding it marked (`storeMark`: a store, an add, an argument
 * whether one call or several reaches its parameter, a return), standing for its records within its value, the mixed
 * elements' among them (TABLE r4.126); a literal no definition holds (a consumer's own, `say [count, "bad"]`, or a
 * receiver's) marked itself, standing for its records within it (r4.138).
 */
function markHolder(walk: Consumers, cell: PlaceId): void {
  const { program, definitions } = walk.pass;
  if (walk.heldIn === null) {
    walk.heldIn = new Map();
    for (const [at, list] of definitions.cellDefs)
      for (const d of list) {
        program.work.charge("checks");
        if (d.value !== undefined) walk.heldIn.set(d.value, at);
      }
    walk.storesOf = new Map();
    for (const d of [...definitions.storeDefs, ...definitions.transferDefs]) {
      program.work.charge("checks");
      if (d.value === undefined) continue;
      const list = walk.storesOf.get(d.value);
      if (list === undefined) walk.storesOf.set(d.value, [d]);
      else list.push(d);
    }
  }
  let literal = program.cellOwner.get(cell)?.owner;
  for (let up = literal; up !== undefined;) {
    program.work.charge("checks");
    literal = up;
    const holder = walk.heldIn.get(up);
    up = holder === undefined ? undefined : program.cellOwner.get(holder)?.owner;
  }
  if (literal === undefined) return;
  const holders = walk.storesOf?.get(literal) ?? [];
  for (const d of holders)
    storeMark(walk, d, d.kind === "add" ? joinSteps(d.path, ["element"]) : d.path);
  if (holders.length === 0) literalMark(walk, literal);
}

/** A literal no definition holds, marked at its own site, its type undecided (r4.100, r4.138), once. */
function literalMark(walk: Consumers, literal: PlaceId): void {
  const { program } = walk.pass;
  const site = program.places[literal]?.site ?? null;
  if (site === null || walk.markedLiterals.has(literal)) return;
  walk.markedLiterals.add(literal);
  storeWarning(
    walk,
    site,
    program.place(literal).label,
    STOPPED[0]!,
    ["unknown"],
    {
      rule: "store",
      into: placeText(walk, literal, []),
      type: ["unknown"],
      written: false,
      decider: null,
      brought: null,
      root: null,
      steps: [],
    },
    [],
  );
}

/**
 * A typed call no store takes in whose expected type the finishing read leaves open after a stop (`Admission.ingressStores`
 * returns it): marked at its site, its type undecided, standing for its boundary (r4.100, r4.144), once.
 */
export function ingressMark(walk: Consumers, site: SourceSite, label: string): void {
  const key = siteKey(site);
  if (walk.markedIngress.has(key)) return;
  walk.markedIngress.add(key);
  storeWarning(
    walk,
    site,
    label,
    STOPPED[0]!,
    ["unknown"],
    {
      rule: "store",
      into: pathPhrase({ code: label }, []),
      type: ["unknown"],
      written: false,
      decider: null,
      brought: null,
      root: null,
      steps: [],
    },
    [],
  );
}
