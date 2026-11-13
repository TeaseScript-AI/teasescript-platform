import type { PlaceId, SourceSite, TypeTerm } from "../../graph.js";
import type { Admission } from "../admission.js";
import { joinParts, joinSteps, keepText } from "../budget.js";
import { typeTags, writtenOf } from "../contract.js";
import { keyOf, keyPath, keyPlace, sortCost, type Definition, type Key } from "../definitions.js";
import {
  arrayRef,
  keyIdPath,
  keyStepsIn,
  restPart,
  restRef,
  restSteps,
  spanRef,
  stepsAfter,
  stepsArray,
  stepsFrom,
  stepsJoin,
  stepsRest,
  type PathRef,
  type Rest,
} from "../contract/key-ids.js";
import { withoutEmpty } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import type { Item, ItemTag } from "../items.js";
import { sharing } from "../sharing.js";
import { addRest } from "./classes.js";
import { eligibleOf } from "./eligibility.js";
import { holdsNothing, type PrefixHolders } from "./holders.js";
import { dictStepsRead, spellsValues } from "./structure.js";
import { deciding } from "./kinds.js";
import { dictList } from "../method-categories.js";
import { chooses, live, snapshotOf } from "./links.js";
import type {
  Candidate,
  DecidedAt,
  EvaluationKey,
  Inheriting,
  Inputs,
  Link,
  Stop,
  Stops,
  Via,
  ViaChain,
  View,
} from "./model.js";
import { joinedDomain, permittedAt } from "./permitted.js";
import { deciderRoot, literalRoute, transferredDecider, writtenDecider } from "./transfers.js";
import {
  bodyOfRead,
  cellOfBody,
  completeTerm,
  textDepth,
  viewDepths,
  type CellAnswer,
  type CellBatch,
  type CellSource,
} from "./literals/cell.js";
import { inheritedInto } from "../inherited/waiting.js";
import { readNow, type Reads } from "../inherited/reads.js";
import { compareKeys, expandRead, stopsOfRead, viaSignature, viewOfRead } from "./walk.js";

// A2's scan: the stores a path is decided from, and the earliest contribution in evaluation order that decides it.

/**
 * The stores a place's path is decided from (§5): its direct candidates (a store beside an unannotated parameter's
 * default none, F21) and the prefixes of the path whole stores or adds reach; `null` for a literal's own cell or
 * property, and where none reaches it.
 */
export function inputsOf(
  admission: Admission,
  root: PlaceId,
  path: readonly string[],
): Inputs | null {
  const { definitions, contract } = admission.pass;
  if (!decidesPaths(admission, root)) return null;
  const direct = (definitions.candidates.get(keyOf(root, path)) ?? []).filter(
    (candidate) => !admission.besideDefault(candidate.d),
  );
  // (G3 3b: the keys whole stores, adds or dead arguments reach along the path, shortest first, by one walk of its
  // steps down their trie: never a key made per prefix of the path)
  const prefixes: { readonly key: Key; readonly rest: PathRef }[] = [];
  for (const { key, depth } of admission.stored.along(root, path, false))
    prefixes.push({ key, rest: arrayRef(contract, path.slice(depth)) });
  const fresh = freshRead(admission, root, path, direct, prefixes);
  if (fresh !== null) return { direct, prefixes, fresh };
  return direct.length === 0 && prefixes.length === 0 ? null : { direct, prefixes };
}

/** `scanAt` of a path's inputs as `freshInputs` reads them. */
export function* freshScanAt(
  admission: Admission,
  inputs: Inputs,
  into: Key,
): ReturnType<typeof scanAt> {
  const read = yield* freshInputs(admission, inputs);
  return read === null
    ? null
    : yield* scanAt(admission, read.direct, read.prefixes, into, read.first);
}

/**
 * A path's inputs with its owner's kind read (`freshRead`): below a dict's list, the statement's own stores and those
 * reaching the path from the list's own level down, after the list's read, their first definition; `null` where no
 * statement changes the list in place (a copy's store landing here is its copy's, decided there). Else the inputs as
 * they were.
 */
export function* freshInputs(admission: Admission, inputs: Inputs): Reads<Inputs | null> {
  const { fresh } = inputs;
  if (fresh === undefined) return inputs;
  admission.pass.program.work.charge("indexSteps");
  const owner = withoutEmpty(
    yield* admission.runRead(() => admission.pass.contract.contractOf(fresh.owner)),
  );
  if (!owner.some((item) => item.tag === "dict"))
    return { direct: inputs.direct, prefixes: inputs.prefixes };
  if (fresh.read === null) return { direct: inputs.direct, prefixes: inputs.prefixes };
  return {
    direct: inputs.direct.filter((candidate) => candidate.d.place === fresh.place),
    prefixes: inputs.prefixes.slice(fresh.prefixes),
    first: fresh.read,
  };
}

/**
 * #2378 R34, R35: a dict's `values` or `keys` is a new list each time it is read (V30), so a statement that changes
 * it in place changes a list nobody holds, as its copy twin (`let t = d.values` before it, `t` in its place) changes
 * `t`. Below that list's own level a path is decided as the twin's: the receiver's read is the list's first
 * definition (an initializer, the twin's declaration), the statement's stores into the list follow it, and nothing the
 * dict holds or stores above the list is a prefix of it; the read carries what the dict holds there. `null` for a
 * path with no list step above its last step; `read` `null` where no store of the place changes the list through a
 * read of it.
 */
function freshRead(
  admission: Admission,
  root: PlaceId,
  path: readonly string[],
  direct: readonly Candidate[],
  prefixes: readonly { readonly key: Key; readonly rest: PathRef }[],
): NonNullable<Inputs["fresh"]> | null {
  const { program, definitions } = admission.pass;
  // (the innermost list by its spelling, its owner's kind read by `freshInputs`)
  let list = -1;
  for (let index = path.length - 2; index >= 0 && list < 0; index -= 1)
    if (dictList(path[index]!) !== undefined) list = index;
  if (list < 0) return null;
  const owner = keyOf(root, path.slice(0, list));
  // (the prefixes from the list's own level down: their rests no longer than the path below the list's step)
  let from = 0;
  while (from < prefixes.length && prefixes[from]!.rest.length > path.length - list - 1) from += 1;
  // (the read a store's target is a projection of: its `values` or `keys` occurrence; a store of the place's own,
  // never one a copy's alias lands here)
  const stores = [
    ...direct.map((candidate) => candidate.d),
    ...prefixes.slice(from).flatMap(({ key }) => definitions.byKey.get(key) ?? []),
  ];
  for (const d of stores)
    for (let into = d.place === root ? d.into : undefined; into !== undefined;) {
      const projection = program.projOf.get(into);
      if (projection === undefined) break;
      if (projection.step === path[list]) {
        const listPath = path.slice(0, list + 1);
        const read: Definition = {
          uid: -1 - into,
          kind: "whole",
          weak: false,
          key: keyOf(root, listPath),
          place: root,
          path: listPath,
          value: into,
          node: projection.node ?? d.node,
          how: "initializer",
          site: program.place(into).site ?? d.site,
          recv: null,
          prep: null,
        };
        return { owner, place: root, prefixes: from, read: { d: read, at: path.slice(list + 1) } };
      }
      into = projection.owner;
    }
  return { owner, place: root, prefixes: from, read: null };
}

/**
 * `inputsOf` for a decided path in its identity (G3 stage 1): a cursor's family holds no definition or candidate below
 * its place's own key (its shape requires it), so it has no direct store, and its one prefix with stores is that own
 * key, its rest the cursor's whole path as a span, asked of the trie as the path's walk asks it there.
 */
export function inputsAt(admission: Admission, at: DecidedAt): Inputs | null {
  if (at.key === undefined) return inputsOf(admission, at.root, at.path);
  if (!decidesPaths(admission, at.root)) return null;
  const prefixes: { readonly key: Key; readonly rest: PathRef }[] = [];
  for (const { key } of admission.stored.along(at.root, [], true))
    prefixes.push({ key, rest: spanRef(admission.pass.contract, keyIdPath(at.key)) });
  return prefixes.length === 0 ? null : { direct: [], prefixes };
}

/** Whether admission decides a place's paths: no literal's own cell or property. */
function decidesPaths(admission: Admission, root: PlaceId): boolean {
  const { program } = admission.pass;
  const place = program.place(root);
  return !(
    place.kind.kind === "cell" ||
    place.kind.kind === "property" ||
    program.cellOwner.has(root) ||
    program.hasOf.has(root)
  );
}

/**
 * A2, A4: the earliest contribution in source order that decides a path (`into`, the decision's own place and path),
 * with what it decides: a lazy merge of the direct stores and the prefixes' whole stores and adds, each read only as
 * far as the scan goes; `null` where none decides.
 */
export function* scanAt(
  admission: Admission,
  direct: readonly Candidate[],
  prefixes: readonly { readonly key: Key; readonly rest: PathRef }[],
  into: Key,
  first?: Inputs["first"],
): Inheriting<{
  readonly tags: ItemTag[];
  readonly nullable: boolean;
  readonly byWritten: boolean;
  /** The copied written type admits `null` at the path (`permitsNull`). */
  readonly permitsNull: boolean;
  /** The copied written type at the path, where a copy decides it (`inheritedAt`). */
  readonly copied: TypeTerm | null;
  /** Whether the copy reads its written type at its own level (`earliestDecider`'s `own`, #1901). */
  readonly own?: boolean;
  readonly decider: Definition;
  readonly site: SourceSite | null;
  /** #2289: the deciding strict cell holds an element that decides nothing and may hold host data. */
  readonly host?: true;
  /** #2289: a stop left a literal's element on the path undecided, so the path is: nothing else is set. */
  readonly stopped?: true;
} | null> {
  const { program, lists } = admission.pass;
  const work = program.work;
  const seen = new Map<string, Item[]>();
  // (a span's memo by its path's id, `(uid, span)`, never its text: G3 stage 1)
  function* evaluate(d: Definition, at: Rest): Reads<Item[]> {
    const memoKey = joinParts(d.uid, restPart(at));
    let items = seen.get(memoKey);
    if (items === undefined) {
      keepText(admission.work, memoKey.length);
      seen.set(memoKey, (items = yield* admission.valueAtRead(d, at)));
    }
    return items;
  }
  // A2: the earliest definite contribution in source order decides, a lazy merge of the direct stores and the
  // prefixes' whole stores and adds; A4: a copy of a written binding is decided by its type
  // (each list is in source order and read only as far as the scan goes: a prefix's stores are listed once per pass)
  const own = direct.filter(
    (candidate) =>
      ((candidate.d.how !== "argument" || lists.singleSite(candidate.d.fn)) &&
        candidate.d.kind !== "add") ||
      candidate.at.length === 0,
  );
  own.sort((a, b) => admission.sourceOrder(a.d) - admission.sourceOrder(b.d));
  work.charge("checks", direct.length + sortCost(own.length));
  const scans: {
    readonly ds: readonly Definition[];
    readonly at: (index: number) => Rest;
    /** #2065: its prefix's state until the prefix's index is made, which counts the stores read holding nothing. */
    readonly holders: PrefixHolders | null;
  }[] = [
    {
      ds: own.map((candidate) => candidate.d),
      at: (index) => stepsRest(own[index]!.at),
      holders: null,
    },
  ];
  // (#2378: a fresh list's read is its first definition, and no prefix of the dict's is one of it: `freshInputs`)
  if (first !== undefined) scans.push({ ds: [first.d], at: () => first.at, holders: null });
  // (a prefix's rest as its prefix reads it: an array where the path was one, a record's steps, a cursor's span else)
  const restOf = (rest: PathRef): Rest => (rest.kind === "span" ? rest : stepsRest(rest.steps()));
  for (const { key: prefix, rest } of prefixes) {
    const ds = yield* eligibleOf(admission, prefix, restOf(rest));
    const holders = admission.pass.receivingDomain.holders.get(prefix) ?? null;
    scans.push({ ds, at: () => restOf(rest), holders: holders?.whole === null ? holders : null });
  }
  for (const { key: prefix, rest } of prefixes)
    if (rest.length > 0 && rest.at(0) === "element") {
      const adds = yield* eligibleOf(admission, prefix, restOf(rest), true);
      scans.push({ ds: adds, at: (index) => addRest(adds[index]!, restOf(rest)), holders: null });
    }
  const positions = scans.map(() => 0);
  let sawNull = false;
  for (;;) {
    let best = -1;
    for (let index = 0; index < scans.length; index += 1)
      if (
        positions[index]! < scans[index]!.ds.length &&
        (best < 0 ||
          admission.sourceOrder(scans[index]!.ds[positions[index]!]!) <
            admission.sourceOrder(scans[best]!.ds[positions[best]!]!))
      )
        best = index;
    if (best < 0) break;
    const position = positions[best]!++;
    const d = scans[best]!.ds[position]!;
    const at = scans[best]!.at(position);
    work.charge("checks", scans.length);
    const first =
      d.value === undefined ? null : yield* earliestDecider(admission, d.value, d.node, at, into);
    if (first?.stopped === true) return stoppedScan(d);
    // (#2289: a literal's strict cell carries its complete type)
    const copied =
      first?.cell === undefined || first.term === null
        ? (first?.term ?? null)
        : yield* completeTerm(admission, first.cell, first.term);
    if (first?.cell !== undefined && copied === null) return stoppedScan(d);
    if (copied !== null) {
      // (its type stays strict, but a literal's `null` elements beside the copy make the place optional, ADR 0021
      // 1.3, A8; a list join's, a written operand's or an element's, make the joined list optional, ADR 0021 1.3, V30
      // §16, Codex r9's B1b on #1310)
      const copiedTags = typeTags(copied);
      const joinedNull =
        first!.joinedNull === true ||
        (first!.joined === true && (yield* evaluate(d, at)).some((item) => item.tag === "null"));
      return {
        tags: copiedTags.filter((tag) => tag !== "null"),
        nullable:
          sawNull ||
          copiedTags.includes("null") ||
          joinedNull ||
          (admission.pass.program.hasOf.has(d.value!) &&
            (yield* evaluate(d, at)).some((item) => item.tag === "null")),
        byWritten: true,
        permitsNull: copiedTags.includes("null") || joinedNull,
        copied,
        own: first!.own === true,
        decider: d,
        site: first?.site ?? d.site,
        ...(first!.host === true ? { host: true as const } : {}),
      };
    }
    // an unknown beside a kind does not decide, unless a literal's own element decides beside it; a null beside one
    // does (A8)
    const items = yield* evaluate(d, at);
    // (#2065: a store holding nothing at the path, which the prefix's index, once made, does not read)
    const holders = scans[best]!.holders;
    if (holders !== null && first === null && holdsNothing(items)) holders.wasted += 1;
    const definite =
      first === null && items.some((item) => item.tag === "unknown") ? [] : deciding(items);
    sawNull ||= items.some((item) => item.tag === "null");
    if (definite.length > 0)
      return {
        tags: [...new Set(definite.map((item) => item.tag))],
        nullable: true,
        byWritten: false,
        permitsNull: false,
        copied: null,
        decider: d,
        site: first?.site ?? d.site,
      };
  }
  return null;
}

/**
 * A2, A4, A8 (ADR 0021 1.1–1.3): the earliest contribution in evaluation order that decides a stored value's path: a
 * copy of a written binding (its written type at the rest of the path), or of a place that inherits one there, taken
 * into the decision of `into` (`inheritedInto`; `null` outside a place's decision), or a value whose items there are
 * of definite kinds; a `null` or an unknown decides nothing, and a value an unknown may stand beside (a read, a copy, a call)
 * neither, while a literal's other elements still may (A8: `[1, hostValue]`'s elements are whole numbers, Sol's
 * records for the owner's F1); a later copy never comes before an earlier definite element. The place's decision and
 * the literal's own elements (`literalElements`) both take it, so they cannot pick opposite deciders. A list join's
 * written operands count by `joinedDomain`, each whatever came before or after it: an open one leaves the path open,
 * and one holding `null` makes the copy's type optional (`joinedNull`). `null` where nothing on the path decides.
 * Where no written copy on the path asks a type, the value's carriers' transfers answer (`transferredDecider`), each
 * carrier once; else, outside every decision and into no decision's place, their written-decider summary
 * (`writtenDecider`); else its stops are scanned here.
 */
export interface DeciderAnswer {
  readonly term: TypeTerm | null;
  readonly site: SourceSite | null;
  /** A deciding value's kinds there (`term` `null`). */
  readonly tags?: readonly ItemTag[];
  /** Whether a list join carries the deciding copy (`term`), and whether one of its written operands holds `null`. */
  readonly joined?: boolean;
  readonly joinedNull?: boolean;
  /** Whether the deciding copy (`term`) stands at the asked path's end: the path is the copy's own level (#1901). */
  readonly own?: boolean;
  /** #2289: a literal's strict cell decides (`term`), where it was asked (`completeTerm`). */
  readonly cell?: CellSource;
  /** #2289: that strict cell holds an element that decides nothing and may hold host data. */
  readonly host?: true;
  /** #2289: a stop left an element of a literal on the path undecided; nothing is set beside it. */
  readonly stopped?: true;
}

export function* earliestDecider(
  admission: Admission,
  value: PlaceId,
  node: FlowNode,
  path: Rest,
  into: Key | null,
): Inheriting<DeciderAnswer | null> {
  const { program, contract } = admission.pass;
  const asked = into === null ? path : yield* dictAsked(admission, into, path);
  // (a cursor's span read one step at a time and by its path's id, never made: G3 stage 1)
  const at = restRef(contract, asked);
  const task = yield* expandRead(admission, value, node, []);
  // #2289: where a literal stands on the path and a declared contribution (a written copy) in the value's region, the
  // literal's cell answers, one contribution, never a summary of its parts; with none declared every cell is inferred,
  // and the summaries' kinds are B1's (the decision takes the store's own kinds there, `scanAt`)
  const root = deciderRoot(admission, task, asked);
  const literal = yield* literalRoute(admission, root);
  if (!literal) {
    const written = { root: null, ids: null };
    const transferred = yield* transferredDecider(admission, task, asked, written, root);
    // #1444(b,c): outside every decision and into no decision's place, the groups' written-decider summary answers; a
    // decision's scan stays its stops', so each decision charges what it charged before
    if (transferred === undefined && into === null && admission.deciding === 0)
      return yield* writtenDecider(admission, task, asked, written);
    if (transferred !== undefined)
      return transferred === null
        ? null
        : {
            term: null,
            site: program.places[transferred.value]?.site ?? null,
            tags: transferred.tags,
          };
  }
  // (#2289: the value's view, each literal with a cell a link to its body, where the literal route answers)
  if (literal) {
    const view = yield* viewOfRead(admission, task);
    return yield* scanView(admission, view, at, asked, into, () => viewDepths(admission, view));
  }
  const raw = yield* stopsOfRead(admission, value, node);
  return yield* scanView(admission, raw, at, asked, into, () => stopDepths(admission, raw));
}

/**
 * #2378: a store's path into a decided key that reads a dict's values list below its own level, as the dict's elements:
 * the key's dict `values` steps read by their owners' contracts (`dictStepsRead`, as `sourceOfRead` reads a copy's
 * source) dropped from the path where it holds them, so a requirement on `d.values.element` is the one on `d`'s
 * elements, whatever reads it. The list itself, the key's last step, keeps its own level; a dict's `keys` hold text.
 */
function* dictAsked(admission: Admission, into: Key, path: Rest): Reads<Rest> {
  if (!spellsValues(admission, into)) return path;
  const steps = keyStepsIn(admission.pass.contract, into);
  const read = yield* dictStepsRead(admission, into);
  const rest = restSteps(path);
  const offset = steps.length - rest.length;
  const dropped = (read?.dropped ?? []).filter(
    (index) => index >= offset && index < steps.length - 1,
  );
  if (dropped.length === 0) return path;
  const kept: string[] = [];
  for (let index = 0; index < rest.length; index += 1)
    if (!dropped.includes(offset + index)) kept.push(rest.at(index)!);
  return kept;
}

/**
 * `earliestDecider`'s scan of one set of stops: a walk's own, or a view's (`View`, #2289: a value's, or an element's
 * in a literal's body), each link among them one contribution by its body's cell (`cellOfBody`).
 */
export function* scanView(
  admission: Admission,
  stops: Pick<View, "written" | "values" | "literals"> & { readonly links?: View["links"] },
  at: PathRef,
  asked: Rest,
  into: Key | null,
  depthsOf: () => { readonly written: number; readonly values: number; readonly literals: number },
  /** The shallowest path any of the stops stands at: an element scope's own (#2289). */
  from = 0,
  /** The comparison evaluation a cell's scan belongs to (#2289), passed down to the cells it reads. */
  batch: CellBatch | null = null,
): Inheriting<DeciderAnswer | null> {
  const { program, values, contract } = admission.pass;
  const siteOf = (stop: Stop): SourceSite | null => program.places[stop.value]?.site ?? null;
  // the earliest copy whose written type reaches the rest of the path
  let copy: {
    readonly key: EvaluationKey;
    readonly term: TypeTerm;
    readonly site: SourceSite | null;
    readonly joined: boolean;
    readonly own: boolean;
    readonly cell?: CellSource;
    readonly host?: boolean;
  } | null = null;
  // (a list join's written operands by `joinedDomain`, each whatever came before or after it: an open one leaves the
  // value open there, one holding `null` makes it optional, Codex r9's B1 on #1310)
  let joinedNull = false;
  const self = admission;
  // (whether the last copy `termOf` answered reads its written type at its own level: a written copy's where no step of
  // the asked path is left below it, an inheriting copy's as the inheritance pass recorded it, `inheritedInto`'s `own`,
  // #1901)
  let ownLevel = false;
  function* termOf(stop: Stop, length: number): Inheriting<TypeTerm | null> {
    // (at the path's end itself a carried copy decides only where it surely is the value there: each literal it was
    // read out of has it alone, and each operation surely gives it)
    if (
      stop.deep &&
      length === at.length &&
      !(stop.single && (yield* selectsRead(self, stop, true)))
    )
      return null;
    const rest: Rest =
      at.kind === "span"
        ? at.from(length).after(stop.strip)
        : stepsAfter(stop.strip, stepsFrom(restSteps(asked), length));
    const inherited = { value: false };
    const term =
      stop.from === null
        ? permittedAt(stop.term!, rest)
        : yield* inheritedInto(self, stop.from, rest, into, inherited);
    ownLevel = stop.from === null ? rest.length === 0 : inherited.value;
    // (a written copy an operation carries decides only where the operation selects it: an operand it never gives is
    // no copy of the place, while a selected copy keeps its whole written type, A4)
    return term !== null && (stop.via === null || (yield* selectsRead(self, stop))) ? term : null;
  }
  // (G3 3b: no stop stands deeper than its value's own paths, `stopDepths`; a join's written calls stand among the
  // values)
  const depths = depthsOf();
  const deepest = Math.min(at.length, Math.max(depths.written, depths.values));
  for (let length = from; length <= deepest; length += 1) {
    program.work.charge("checks");
    // (a span's prefix text its record's, `textOf`; an array's made plain, as before)
    const prefix = at.text(length);
    const written = snapshots(admission, stops.written.get(prefix), false);
    // (and a call a join carries by its written result, as `joinElements` reads it: F20; since #2378 such a call is a
    // written stop too, `writtenSourceRead`, and this read answers alike)
    const calls = joinedOf(admission, snapshots(admission, stops.values.get(prefix), false));
    for (const stop of [...joinedOf(admission, written), ...calls]) {
      program.work.charge("checks");
      let term: TypeTerm | null;
      if (stop.term !== null || stop.from !== null) term = yield* termOf(stop, length);
      else {
        ownLevel = false;
        const key = contract.resultKey(stop.value);
        const result = key === null ? null : writtenOf(program.place(keyPlace(key)).kind);
        term =
          result === null || !(yield* selectsRead(admission, stop))
            ? null
            : permittedAt(
                result,
                stepsJoin(
                  joinSteps(keyPath(key!), stop.strip),
                  stepsFrom(restSteps(asked), length),
                ),
              );
      }
      if (term === null) continue;
      const domain = joinedDomain(typeTags(term));
      if (domain === "open") return { term, site: siteOf(stop) };
      joinedNull ||= typeTags(term).includes("null");
      if (domain === "kinds" && (copy === null || compareKeys(stop.key, copy.key) < 0))
        copy = { key: stop.key, term, site: siteOf(stop), joined: true, own: ownLevel };
    }
    for (const stop of written ?? []) {
      program.work.charge("checks");
      if (copy !== null && compareKeys(stop.key, copy.key) > 0) break;
      if (stop.via?.joined === true) continue;
      const term = yield* termOf(stop, length);
      if (term !== null)
        copy = { key: stop.key, term, site: siteOf(stop), joined: false, own: ownLevel };
    }
  }
  // #2289: each literal task on the path, in key order, by its cell's answer: a strict one as a written copy, an
  // inferred one as a value, a stopped one ending the scan where it comes first (#2289)
  const cellValues: {
    readonly key: EvaluationKey;
    readonly task: Link;
    readonly tags: readonly ItemTag[] | null;
    readonly site: SourceSite | null;
  }[] = [];
  for (const { link: t, length } of stops.links === undefined
    ? []
    : linksOn(admission, stops.links, at, from)) {
    const joined = t.via?.joined === true;
    if (!joined && copy !== null && compareKeys(t.key, copy.key) > 0) continue;
    // (a literal read whole is asked at a step below it: at its own path its own stop answers)
    if (t.strip.length === 0 && length === at.length) continue;
    const rel = stepsArray(stepsFrom(restSteps(asked), length));
    program.work.charge("checks", rel.length);
    const body = yield* bodyOfRead(admission, t.value, t.node, t.strip);
    const answer: CellAnswer = yield* cellOfBody(admission, body, rel, into, batch);
    if (answer.kind === "none") continue;
    if (answer.kind === "stopped") {
      cellValues.push({ key: t.key, task: t, tags: null, site: null });
      continue;
    }
    const term = answer.kind === "fit" ? answer.term : answer.earliest.term;
    if (term === null) {
      // (an inferred cell decides as a value: never under a typed default, nor at the path's end below an operation)
      if (t.via?.typed !== true && !(t.deep && length === at.length))
        cellValues.push({
          key: t.key,
          task: t,
          tags: answer.kind === "fit" ? answer.tags : answer.earliest.tags,
          // (the deciding element's own site, as its own reading gives it)
          site: answer.kind === "fit" ? answer.site : answer.earliest.site,
        });
      continue;
    }
    // (a strict cell as a written copy: selected by its operations, at the path's end below one only where surely)
    if (t.deep && length === at.length && !(t.single && (yield* taskSelected(admission, t, true))))
      continue;
    if (t.via !== null && !(yield* taskSelected(admission, t))) continue;
    const site = answer.kind === "fit" ? answer.site : answer.earliest.site;
    const own = answer.kind === "fit" ? answer.own : answer.earliest.own;
    if (joined) {
      const domain = joinedDomain(typeTags(term));
      if (domain === "open") return { term, site };
      joinedNull ||= typeTags(term).includes("null");
      if (domain !== "kinds") continue;
    }
    if (copy === null || compareKeys(t.key, copy.key) < 0)
      copy = {
        key: t.key,
        term,
        site,
        joined,
        own,
        ...(answer.kind === "fit" ? { cell: { body, rel, into }, host: answer.host } : {}),
      };
  }
  const copied = () => ({
    term: copy!.term,
    site: copy!.site,
    joined: copy!.joined,
    joinedNull,
    own: copy!.own,
    ...(copy!.cell === undefined ? {} : { cell: copy!.cell }),
    ...(copy!.host === true ? { host: true as const } : {}),
  });
  // the values in evaluation order, those standing above the path's end with its rest, the literals at its end
  const lists: { readonly list: readonly Stop[]; readonly length: number }[] = [];
  // (a value a projection selects stands for its parts below the path, never at it; of the values of one class the
  // first alone, the others answering as it does, Astra's review B2)
  for (let length = from; length <= Math.min(at.length, depths.values); length += 1) {
    const list = snapshots(
      admission,
      stops.values.get(at.text(length)),
      length === at.length,
      true,
    );
    if (list !== undefined) lists.push({ list, length });
  }
  const literals =
    at.length > depths.literals
      ? undefined
      : snapshots(admission, stops.literals.get(at.text(at.length)), true);
  if (literals !== undefined) lists.push({ list: literals, length: at.length });
  const positions = lists.map(() => 0);
  const throughs = new Map<string, WeakMap<ViaChain, boolean>>();
  let cellPosition = 0;
  for (;;) {
    let best = -1;
    for (let index = 0; index < lists.length; index += 1)
      if (
        positions[index]! < lists[index]!.list.length &&
        (best < 0 ||
          compareKeys(
            lists[index]!.list[positions[index]!]!.key,
            lists[best]!.list[positions[best]!]!.key,
          ) < 0)
      )
        best = index;
    const stopNext = best < 0 ? null : lists[best]!.list[positions[best]!]!;
    const cellNext = cellValues[cellPosition] ?? null;
    const next =
      cellNext !== null && (stopNext === null || compareKeys(cellNext.key, stopNext.key) < 0)
        ? cellNext
        : stopNext;
    // (a copy of a place that inherits a written type comes before that copy's own value, A4)
    if (next === null || (copy !== null && compareKeys(copy.key, next.key) <= 0))
      return copy === null ? null : copied();
    program.work.charge("checks", lists.length + (cellValues.length > 0 ? 1 : 0));
    if (next === cellNext) {
      cellPosition += 1;
      if (cellNext.tags === null) return { term: null, site: null, stopped: true };
      if (!(yield* chosen(admission, cellNext.task.via))) continue;
      const tags = cellNext.tags;
      const kinds = [...tags].sort().join(",");
      let holds = throughs.get(kinds);
      if (holds === undefined) throughs.set(kinds, (holds = new WeakMap()));
      if (yield* through(admission, cellNext.task.via, asked, tags, holds))
        return { term: null, site: cellNext.site, tags };
      continue;
    }
    const nextStop = stopNext!;
    positions[best]! += 1;
    // (a typed default's literal is the call's input, not the stored value's own element: where the default holds host
    // data it leaves the path open, and the call decides nothing there beside it, F18)
    if (nextStop.via?.typed === true) continue;
    const items = withoutEmpty(
      yield* admission.runRead(() =>
        values.valueItems(
          nextStop.value,
          nextStop.node,
          at.kind === "span"
            ? at.from(lists[best]!.length).after(nextStop.strip)
            : stepsAfter(nextStop.strip, stepsFrom(restSteps(asked), lists[best]!.length)),
        ),
      ),
    );
    const definite = items.some((item) => item.tag === "unknown") ? [] : deciding(items);
    // (an operand its operation does not give decides nothing, F17a, F17b)
    if (definite.length === 0 || !(yield* chosen(admission, nextStop.via))) continue;
    // (each chain's operations asked once per set of kinds at the path, whatever stops share them)
    const tags = definite.map((item) => item.tag);
    const kinds = [...tags].sort().join(",");
    let holds = throughs.get(kinds);
    if (holds === undefined) throughs.set(kinds, (holds = new WeakMap()));
    if (yield* through(admission, nextStop.via, asked, tags, holds))
      return { term: null, site: siteOf(nextStop), tags };
  }
}

/** A scan that met a stopped literal element (#2289: nothing decides, and the path is undecided. */
function stoppedScan(decider: Definition) {
  const tags: ItemTag[] = [];
  return {
    tags,
    nullable: false,
    byWritten: false,
    permitsNull: false,
    copied: null,
    decider,
    site: null,
    stopped: true as const,
  };
}

/**
 * #2289: the links of a view on the asked path's prefixes, in key order, with the path's length at each (the
 * literal's own path).
 */
function linksOn(
  admission: Admission,
  links: View["links"],
  at: PathRef,
  from = 0,
): { readonly link: Link; readonly length: number }[] {
  const { program } = admission.pass;
  if (links.size === 0) return [];
  const out: { readonly link: Link; readonly length: number }[] = [];
  for (let length = from; length <= at.length; length += 1) {
    program.work.charge("checks");
    for (const link of links.get(at.text(length)) ?? []) out.push({ link, length });
  }
  program.work.charge("checks", sortCost(out.length));
  return out.sort((a, b) => compareKeys(a.link.key, b.link.key));
}

/** Whether a literal task's operations select it (`selectsRead`), or `surely` do. */
function* taskSelected(admission: Admission, task: Link, surely = false): Reads<boolean> {
  return live(admission, task.value) && (yield* chosen(admission, task.via, surely));
}

/** The deepest path a walk's stops stand at, per kind of stop, once per walk (`earliestDecider`'s loops). */
function stopDepths(
  admission: Admission,
  stops: Stops,
): { readonly written: number; readonly values: number; readonly literals: number } {
  let known = admission.pass.receivingDomain.stopDepths.get(stops);
  if (known === undefined) {
    const deepest = (map: ReadonlyMap<string, readonly Stop[]>): number => {
      let depth = 0;
      for (const text of map.keys()) {
        admission.pass.program.work.charge("checks");
        depth = Math.max(depth, textDepth(text));
      }
      return depth;
    };
    known = {
      written: deepest(stops.written),
      values: deepest(stops.values),
      literals: deepest(stops.literals),
    };
    admission.pass.receivingDomain.stopDepths.set(stops, known);
  }
  return known;
}

/**
 * A list of a walk's stops as the decider reads it, once per list: each snapshot once (one key read here),
 * so of the reads of one key through one chain of operations at one strip that read the same only the
 * first is read, the later ones holding what it holds (k reads of one host global, decided at k paths: Codex r23 F1);
 * so too k calls of one function (Codex r24 F2's neighbours); `shallow` leaves out the values a projection
 * selects, `classes` all but the first of a class (`classFirsts`).
 */
function snapshots(
  admission: Admission,
  list: readonly Stop[] | undefined,
  shallow: boolean,
  classes = false,
): readonly Stop[] | undefined {
  if (list === undefined) return undefined;
  let memo = admission.snapshotLists.get(list);
  if (memo === undefined) admission.snapshotLists.set(list, (memo = []));
  const slot = (shallow ? 1 : 0) + (classes ? 2 : 0);
  const known = memo[slot];
  if (known !== undefined) return known;
  let out: readonly Stop[];
  if (classes) out = classFirsts(admission, snapshots(admission, list, shallow)!);
  else {
    out = distinctStops(admission, shallow ? list.filter((stop) => !stop.deep) : list);
    admission.pass.program.work.charge("checks", list.length);
  }
  memo[slot] = out;
  return out;
}

/** Of a snapshot of a walk's stops, those a list join carries (`ViaChain.joined`), once per snapshot. */
function joinedOf(admission: Admission, list: readonly Stop[] | undefined): readonly Stop[] {
  if (list === undefined) return [];
  let out = admission.joinedLists.get(list);
  if (out === undefined) {
    admission.pass.program.work.charge("checks", list.length);
    admission.joinedLists.set(list, (out = list.filter((stop) => stop.via?.joined === true)));
  }
  return out;
}

/**
 * Of a decider's values (`earliestDecider`), the first of each value-side class (`Contract.boundClass`) at one node,
 * strip and chain of operations: the values of one class answer alike at every path but for their roles' writers and
 * the leaves or operands they name (C9, F16), none of which decides, so a later one decides as the first does and is
 * never read where the first decides nothing (k loads of one default before a literal's object, decided at its k
 * properties, Astra's review B2; k bindings of them, #1313). Each value of no class as itself.
 */
function classFirsts(admission: Admission, list: readonly Stop[]): readonly Stop[] {
  if (!sharing() || list.length < 2) return list;
  const { program, contract } = admission.pass;
  const seen = new Set<string>();
  const out: Stop[] = [];
  for (const stop of list) {
    program.work.charge("checks");
    const cls = contract.boundClass(stop.value, true).cls;
    if (cls !== null) {
      const key = joinParts(
        cls,
        stop.node.id,
        viaClasses(admission, stop.via),
        stop.strip,
        stop.deep,
        stop.single,
      );
      if (seen.has(key)) continue;
      keepText(admission.work, key.length);
      seen.add(key);
    }
    out.push(stop);
  }
  return out;
}

/**
 * Stops with each snapshot once, in their order: of the reads of one key through one chain of operations at one strip
 * that read the same (`Contract.readSnapshot`), and of k calls of one function (as in the literal index), the
 * first; any other stop as itself.
 */
export function distinctStops(admission: Admission, list: readonly Stop[]): Stop[] {
  if (!sharing()) return [...list];
  const { program } = admission.pass;
  const seen = new Set<string>();
  const out: Stop[] = [];
  for (const stop of list) {
    program.work.charge("checks");
    const read = snapshotOf(admission, stop.value);
    if (read !== null) {
      const snapshot = joinParts(
        viaSignature(admission, stop.via),
        stop.strip,
        stop.deep,
        stop.single,
        read,
      );
      if (seen.has(snapshot)) continue;
      keepText(admission.work, snapshot.length);
      seen.add(snapshot);
    }
    out.push(stop);
  }
  return out;
}

/**
 * A chain of operations by its values' classes (`classFirsts`): each level's value-side class (`Contract.classOf`),
 * else its value, with its role, node, strip and path's length, all a decider asks of it (`chosen`, `through`), so k
 * loads of one class, each the operation the walk reaches its default through, have one name. Once per chain, named
 * as `viaSignature` names it.
 */
function viaClasses(admission: Admission, via: ViaChain | null): string {
  const unnamed: ViaChain[] = [];
  let at = via;
  for (; at !== null && !admission.viaClassNames.has(at); at = at.outer) unnamed.push(at);
  let name = at === null ? "" : admission.viaClassNames.get(at)!;
  for (let index = unnamed.length - 1; index >= 0; index -= 1) {
    const { level } = unnamed[index]!;
    admission.pass.program.work.charge("checks");
    const cls = admission.pass.contract.classOf(level.value, true);
    const parts = joinParts(
      name,
      cls === null ? "v" : "c",
      cls ?? level.value,
      level.role,
      level.node.id,
      level.strip,
      level.path.length,
    );
    let known = admission.viaClassParts.get(parts);
    if (known === undefined) {
      keepText(admission.work, parts.length);
      admission.viaClassParts.set(parts, (known = `${admission.viaClassParts.size}`));
    }
    admission.viaClassNames.set(unnamed[index]!, (name = known));
  }
  return name;
}

/**
 * Whether a decider reached through operations decides at `at`: each of them, outermost to innermost, holds its kinds
 * definitely in its own value there; per link in `holds` (one decision's, for these kinds).
 */
function* through(
  admission: Admission,
  via: ViaChain | null,
  at: Rest,
  definite: readonly ItemTag[],
  holds: WeakMap<ViaChain, boolean>,
): Reads<boolean> {
  const ref = restRef(admission.pass.contract, at);
  return yield* perLinkRead(admission, holds, via, true, function* (level) {
    const carried = withoutEmpty(
      yield* admission.runRead(() =>
        admission.pass.values.valueItems(
          level.value,
          level.node,
          ref.kind === "span"
            ? ref.from(level.path.length).after(level.strip)
            : stepsAfter(level.strip, stepsFrom(restSteps(at), level.path.length)),
        ),
      ),
    );
    return definite.every((tag) => carried.some((own) => own.tag === tag && own.cert === "def"));
  });
}

/**
 * A chain's answer kept per link in `memo` (#1230): `every` operation passes `test`, else some does, each link's
 * answer from the chain outside it and its own operation, asked outermost first and only where the answer outside it
 * leaves it open, as `every` and `some` ask them; each link once, so the chains of a walk's k stops cost their links
 * once, never a chain per stop.
 */
export function perLink(
  admission: Admission,
  memo: WeakMap<ViaChain, boolean>,
  via: ViaChain | null,
  every: boolean,
  test: (level: Via) => boolean,
): boolean {
  return readNow(
    perLinkRead(admission, memo, via, every, function* (level) {
      return test(level);
    }),
  );
}

/** `perLink` of a test that makes reads (`Read`), each link's test asked as `perLink` asks it (#1072 A2). */
function* perLinkRead(
  admission: Admission,
  memo: WeakMap<ViaChain, boolean>,
  via: ViaChain | null,
  every: boolean,
  test: (level: Via) => Reads<boolean>,
): Reads<boolean> {
  const open: ViaChain[] = [];
  let at = via;
  for (; at !== null && !memo.has(at); at = at.outer) open.push(at);
  let answer = at === null ? every : memo.get(at)!;
  for (let index = open.length - 1; index >= 0; index -= 1) {
    admission.pass.program.work.charge("checks");
    if (answer === every) answer = yield* test(open[index]!.level);
    memo.set(open[index]!, answer);
  }
  return answer;
}

/**
 * Whether a written copy reached through operations is selected: its own read runs, and each operation gives the
 * operand the walk took to it, by the operation's rule, never by what the copy's items say of their writers (a written
 * parameter's have none): a `get` its receiver's element unless the graph's literal proof leaves only its default, and
 * its default only where that is reached (F17b); `otherwise` its own operand only where that may be a value, and its
 * fallback only where the operand may be null (F17a); the other carriers give every operand that runs.
 */
export function selects(admission: Admission, stop: Stop, surely = false): boolean {
  return readNow(selectsRead(admission, stop, surely));
}

/** `selects` as reads (#1072 A2). */
function* selectsRead(admission: Admission, stop: Stop, surely = false): Reads<boolean> {
  return live(admission, stop.value) && (yield* chosen(admission, stop.via, surely));
}

/**
 * Whether each operation of a chain gives the operand the walk took (`selects`'s rule), or `surely` gives it: a `get`
 * its receiver's element where its default is dead and its default where that is the only value, `otherwise` its
 * operand where that is never null and its fallback where the operand is only null; no other carrier surely.
 */
function* chosen(admission: Admission, via: ViaChain | null, surely = false): Reads<boolean> {
  return yield* perLinkRead(admission, admission.chosenLinks[surely ? 1 : 0]!, via, true, (level) =>
    chooses(admission, level, surely),
  );
}
