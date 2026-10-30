import type { PlaceId, SourceSite, TypeTerm } from "../../graph.js";
import type { Admission } from "../admission.js";
import { joinParts, joinSteps, keepText, pathText } from "../budget.js";
import { typeTags, writtenOf } from "../contract.js";
import { keyOf, keyPath, keyPlace, sortCost, type Definition, type Key } from "../definitions.js";
import {
  arrayRef,
  keyIdPath,
  restPart,
  restRef,
  restSteps,
  spanRef,
  type PathRef,
  type Rest,
} from "../contract/key-ids.js";
import { withoutEmpty } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import type { Item, ItemTag } from "../items.js";
import { sharing } from "../sharing.js";
import { addRest } from "./classes.js";
import { eligibleOf } from "./eligibility.js";
import { deciding } from "./kinds.js";
import { chooses, live, snapshotOf } from "./links.js";
import type {
  Candidate,
  DecidedAt,
  EvaluationKey,
  Inheriting,
  Inputs,
  Stop,
  Stops,
  Via,
  ViaChain,
} from "./model.js";
import { joinedDomain, permittedAt } from "./permitted.js";
import { transferredDecider } from "./transfers.js";
import { inheritedInto } from "./waiting.js";
import { compareKeys, expand, stopsOf, viaSignature } from "./walk.js";

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
  const { program, definitions, contract } = admission.pass;
  if (!decidesPaths(admission, root)) return null;
  const direct = (definitions.candidates.get(keyOf(root, path)) ?? []).filter(
    (candidate) => !admission.besideDefault(candidate.d),
  );
  // (G3 3b: the keys whole stores, adds or dead arguments reach along the path, shortest first, by one walk of its
  // steps down their trie: never a key made per prefix of the path)
  const prefixes: { readonly key: Key; readonly rest: PathRef }[] = [];
  for (const { key, depth } of admission.stored.along(root, path, false))
    prefixes.push({ key, rest: arrayRef(contract, path.slice(depth)) });
  void program;
  return direct.length === 0 && prefixes.length === 0 ? null : { direct, prefixes };
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
): Inheriting<{
  readonly tags: ItemTag[];
  readonly nullable: boolean;
  readonly byWritten: boolean;
  /** The copied written type admits `null` at the path (`permitsNull`). */
  readonly permitsNull: boolean;
  /** The copied written type at the path, where a copy decides it (`inheritedAt`). */
  readonly copied: TypeTerm | null;
  readonly decider: Definition;
  readonly site: SourceSite | null;
} | null> {
  const { program, lists } = admission.pass;
  const work = program.work;
  const seen = new Map<string, Item[]>();
  // (a span's memo by its path's id, `(uid, span)`, never its text: G3 stage 1)
  const evaluate = (d: Definition, at: Rest): Item[] => {
    const memoKey = joinParts(d.uid, restPart(at));
    let items = seen.get(memoKey);
    if (items === undefined) {
      keepText(admission.work, memoKey.length);
      seen.set(memoKey, (items = admission.valueAt(d, at)));
    }
    return items;
  };
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
  const scans: { readonly ds: readonly Definition[]; readonly at: (index: number) => Rest }[] = [
    { ds: own.map((candidate) => candidate.d), at: (index) => own[index]!.at },
  ];
  // (a prefix's rest as its prefix reads it: an array where the path was one, a cursor's span else)
  const restOf = (rest: PathRef): Rest => (rest.kind === "span" ? rest : rest.steps());
  for (const { key: prefix, rest } of prefixes)
    scans.push({ ds: eligibleOf(admission, prefix, restOf(rest)), at: () => restOf(rest) });
  for (const { key: prefix, rest } of prefixes)
    if (rest.length > 0 && rest.at(0) === "element") {
      const adds = eligibleOf(admission, prefix, restOf(rest), true);
      scans.push({ ds: adds, at: (index) => addRest(adds[index]!, restOf(rest)) });
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
    const copied = first?.term ?? null;
    if (copied !== null) {
      // (its type stays strict, but a literal's `null` elements beside the copy make the place optional, ADR 0021
      // 1.3, A8; a list join's, a written operand's or an element's, make the joined list optional, ADR 0021 1.3, V30
      // §16, Codex r9's B1b on #1310)
      const copiedTags = typeTags(copied);
      const joinedNull =
        first!.joinedNull === true ||
        (first!.joined === true && evaluate(d, at).some((item) => item.tag === "null"));
      return {
        tags: copiedTags.filter((tag) => tag !== "null"),
        nullable:
          sawNull ||
          copiedTags.includes("null") ||
          joinedNull ||
          (admission.pass.program.hasOf.has(d.value!) &&
            evaluate(d, at).some((item) => item.tag === "null")),
        byWritten: true,
        permitsNull: copiedTags.includes("null") || joinedNull,
        copied,
        decider: d,
        site: first?.site ?? d.site,
      };
    }
    // an unknown beside a kind does not decide, unless a literal's own element decides beside it; a null beside one
    // does (A8)
    const items = evaluate(d, at);
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
 * carrier once; else its stops are scanned here.
 */
export function* earliestDecider(
  admission: Admission,
  value: PlaceId,
  node: FlowNode,
  asked: Rest,
  into: Key | null,
): Inheriting<{
  readonly term: TypeTerm | null;
  readonly site: SourceSite | null;
  /** A deciding value's kinds there (`term` `null`). */
  readonly tags?: readonly ItemTag[];
  /** Whether a list join carries the deciding copy (`term`), and whether one of its written operands holds `null`. */
  readonly joined?: boolean;
  readonly joinedNull?: boolean;
} | null> {
  const { program, values, contract } = admission.pass;
  // (a cursor's span read one step at a time and by its path's id, never made: G3 stage 1)
  const at = restRef(contract, asked);
  const transferred = transferredDecider(admission, expand(admission, value, node, []), asked);
  if (transferred !== undefined)
    return transferred === null
      ? null
      : {
          term: null,
          site: program.places[transferred.value]?.site ?? null,
          tags: transferred.tags,
        };
  const stops = stopsOf(admission, value, node);
  const siteOf = (stop: Stop): SourceSite | null => program.places[stop.value]?.site ?? null;
  // the earliest copy whose written type reaches the rest of the path
  let copy: { readonly key: EvaluationKey; readonly term: TypeTerm; readonly stop: Stop } | null =
    null;
  // (a list join's written operands by `joinedDomain`, each whatever came before or after it: an open one leaves the
  // value open there, one holding `null` makes it optional, Codex r9's B1 on #1310)
  let joinedNull = false;
  const self = admission;
  function* termOf(stop: Stop, length: number): Inheriting<TypeTerm | null> {
    // (at the path's end itself a carried copy decides only where it surely is the value there: each literal it was
    // read out of has it alone, and each operation surely gives it)
    if (stop.deep && length === at.length && !(stop.single && selects(self, stop, true)))
      return null;
    const rest: Rest =
      at.kind === "span"
        ? at.from(length).after(stop.strip)
        : joinSteps(stop.strip, restSteps(asked).slice(length));
    const term =
      stop.from === null
        ? permittedAt(stop.term!, rest)
        : yield* inheritedInto(self, stop.from, rest, into);
    // (a written copy an operation carries decides only where the operation selects it: an operand it never gives is
    // no copy of the place, while a selected copy keeps its whole written type, A4)
    return term !== null && (stop.via === null || selects(self, stop)) ? term : null;
  }
  // (G3 3b: no stop stands deeper than its value's own paths, `stopDepths`; a join's written calls stand among the
  // values)
  const depths = stopDepths(admission, stops);
  const deepest = Math.min(at.length, Math.max(depths.written, depths.values));
  for (let length = 0; length <= deepest; length += 1) {
    program.work.charge("checks");
    const prefix =
      at.kind === "span" ? at.text(length) : pathText(restSteps(asked).slice(0, length));
    const written = snapshots(admission, stops.written.get(prefix), false);
    // (and a call a join carries by its written result, as `joinElements` reads it: F20)
    const calls = joinedOf(admission, snapshots(admission, stops.values.get(prefix), false));
    for (const stop of [...joinedOf(admission, written), ...calls]) {
      program.work.charge("checks");
      let term: TypeTerm | null;
      if (stop.term !== null || stop.from !== null) term = yield* termOf(stop, length);
      else {
        const key = contract.resultKey(stop.value);
        const result = key === null ? null : writtenOf(program.place(keyPlace(key)).kind);
        term =
          result === null || !selects(admission, stop)
            ? null
            : permittedAt(
                result,
                joinSteps(keyPath(key!), stop.strip, restSteps(asked).slice(length)),
              );
      }
      if (term === null) continue;
      const domain = joinedDomain(typeTags(term));
      if (domain === "open") return { term, site: siteOf(stop) };
      joinedNull ||= typeTags(term).includes("null");
      if (domain === "kinds" && (copy === null || compareKeys(stop.key, copy.key) < 0))
        copy = { key: stop.key, term, stop };
    }
    for (const stop of written ?? []) {
      program.work.charge("checks");
      if (copy !== null && compareKeys(stop.key, copy.key) > 0) break;
      if (stop.via?.joined === true) continue;
      const term = yield* termOf(stop, length);
      if (term !== null) copy = { key: stop.key, term, stop };
    }
  }
  const copied = () => ({
    term: copy!.term,
    site: siteOf(copy!.stop),
    joined: copy!.stop.via?.joined === true,
    joinedNull,
  });
  // the values in evaluation order, those standing above the path's end with its rest, the literals at its end
  const lists: { readonly list: readonly Stop[]; readonly length: number }[] = [];
  // (a value a projection selects stands for its parts below the path, never at it; of the values of one class the
  // first alone, the others answering as it does, Astra's review B2)
  for (let length = 0; length <= Math.min(at.length, depths.values); length += 1) {
    const list = snapshots(
      admission,
      stops.values.get(
        at.kind === "span" ? at.text(length) : pathText(restSteps(asked).slice(0, length)),
      ),
      length === at.length,
      true,
    );
    if (list !== undefined) lists.push({ list, length });
  }
  const literals =
    at.length > depths.literals
      ? undefined
      : snapshots(
          admission,
          stops.literals.get(at.kind === "span" ? at.text(at.length) : pathText(restSteps(asked))),
          true,
        );
  if (literals !== undefined) lists.push({ list: literals, length: at.length });
  const positions = lists.map(() => 0);
  const throughs = new Map<string, WeakMap<ViaChain, boolean>>();
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
    const next = best < 0 ? null : lists[best]!.list[positions[best]!]!;
    // (a copy of a place that inherits a written type comes before that copy's own value, A4)
    if (next === null || (copy !== null && compareKeys(copy.key, next.key) <= 0))
      return copy === null ? null : copied();
    program.work.charge("checks", lists.length);
    positions[best]! += 1;
    // (a typed default's literal is the call's input, not the stored value's own element: where the default holds host
    // data it leaves the path open, and the call decides nothing there beside it, F18, TABLE r4.66 (3))
    if (next.via?.typed === true) continue;
    const items = withoutEmpty(
      admission.run(
        values.valueItems(
          next.value,
          next.node,
          at.kind === "span"
            ? at.from(lists[best]!.length).after(next.strip)
            : joinSteps(next.strip, restSteps(asked).slice(lists[best]!.length)),
        ),
      ),
    );
    const definite = items.some((item) => item.tag === "unknown") ? [] : deciding(items);
    // (an operand its operation does not give decides nothing, F17a, F17b)
    if (definite.length === 0 || !chosen(admission, next.via)) continue;
    // (each chain's operations asked once per set of kinds at the path, whatever stops share them)
    const tags = definite.map((item) => item.tag);
    const kinds = [...tags].sort().join(",");
    let holds = throughs.get(kinds);
    if (holds === undefined) throughs.set(kinds, (holds = new WeakMap()));
    if (through(admission, next.via, asked, tags, holds))
      return { term: null, site: siteOf(next), tags };
  }
}

/** The depth of a path text (`pathText`): its steps' count, none for the empty path. */
function textDepth(text: string): number {
  if (text === "") return 0;
  let depth = 1;
  for (let at = text.indexOf("."); at >= 0; at = text.indexOf(".", at + 1)) depth += 1;
  return depth;
}

/** The deepest path a walk's stops stand at, per kind of stop, once per walk (`earliestDecider`'s loops). */
function stopDepths(
  admission: Admission,
  stops: Stops,
): { readonly written: number; readonly values: number; readonly literals: number } {
  let known = admission.stopDepths.get(stops);
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
    admission.stopDepths.set(stops, known);
  }
  return known;
}

/**
 * A list of a walk's stops as the decider reads it, once per list: each snapshot once (TABLE §8: one key read here,
 * r4.68 (1)), so of the reads of one key through one chain of operations at one strip that read the same only the
 * first is read, the later ones holding what it holds (k reads of one host global, decided at k paths: Codex r23 F1);
 * so too k calls of one function (r4.15, Codex r24 F2's neighbours); `shallow` leaves out the values a projection
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
 * that read the same (`Contract.readSnapshot`), and of k calls of one function (as in the literal index, r4.15), the
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
function through(
  admission: Admission,
  via: ViaChain | null,
  at: Rest,
  definite: readonly ItemTag[],
  holds: WeakMap<ViaChain, boolean>,
): boolean {
  const ref = restRef(admission.pass.contract, at);
  return perLink(admission, holds, via, true, (level) => {
    const carried = withoutEmpty(
      admission.run(
        admission.pass.values.valueItems(
          level.value,
          level.node,
          ref.kind === "span"
            ? ref.from(level.path.length).after(level.strip)
            : joinSteps(level.strip, restSteps(at).slice(level.path.length)),
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
  const open: ViaChain[] = [];
  let at = via;
  for (; at !== null && !memo.has(at); at = at.outer) open.push(at);
  let answer = at === null ? every : memo.get(at)!;
  for (let index = open.length - 1; index >= 0; index -= 1) {
    admission.pass.program.work.charge("checks");
    if (answer === every) answer = test(open[index]!.level);
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
  return live(admission, stop.value) && chosen(admission, stop.via, surely);
}

/**
 * Whether each operation of a chain gives the operand the walk took (`selects`'s rule), or `surely` gives it: a `get`
 * its receiver's element where its default is dead and its default where that is the only value, `otherwise` its
 * operand where that is never null and its fallback where the operand is only null; no other carrier surely.
 */
function chosen(admission: Admission, via: ViaChain | null, surely = false): boolean {
  return perLink(admission, admission.chosenLinks[surely ? 1 : 0]!, via, true, (level) =>
    chooses(admission, level, surely),
  );
}
