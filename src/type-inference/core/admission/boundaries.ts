import type { PlaceId, SourceSite } from "../../graph.js";
import type { Admission } from "../admission.js";
import type { CorePass } from "../answers.js";
import { joinSteps, keepText, keptParts } from "../budget.js";
import { termAt, writtenOf } from "../contract.js";
import { keptKey, type Definition } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import type { IngressNode, Item, ItemTag } from "../items.js";
import type { Obligation, RequiredKind } from "../result.js";
import { concrete, isExternal } from "./kinds.js";
import { f18Kinds, landingIndex, leafIngress, typedIngress } from "./landing-index.js";
import { elementsBelow } from "./structure.js";

// The boundary checks of external data (C9, F18), and the inventory of the derivations that create an obligation.

/**
 * S6-CARRIERS §3.4's resolution of a provenance node, once per node and pass: each leaf's ingress sends its store's
 * boundary, or its own read's check, once; the answer is whether some ingress below the node no walk reached, whose
 * consumer checks it (r4.10). A node on a cycle through a cell is answered again where it is met (its answer then
 * depends on where the cycle was entered).
 */
function resolve(admission: Admission, root: IngressNode): boolean {
  const known = admission.resolved.get(root);
  if (known !== undefined) return known;
  const { program } = admission.pass;
  const index = landingIndex(admission);
  const open = new Set<IngressNode>();
  const frames: {
    readonly node: IngressNode;
    readonly parts: readonly IngressNode[];
    next: number;
    unreached: boolean;
    cyclic: boolean;
  }[] = [];
  const enter = (node: IngressNode): void => {
    open.add(node);
    const parts =
      "parts" in node
        ? node.parts
        : !("ingress" in node) && node.contents !== null
          ? [node.contents]
          : [];
    frames.push({ node, parts, next: 0, unreached: false, cyclic: false });
  };
  enter(root);
  let answer = false;
  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    program.work.charge("checks");
    if (frame.next < frame.parts.length) {
      const part = frame.parts[frame.next++]!;
      const done = admission.resolved.get(part);
      if (done !== undefined) frame.unreached ||= done;
      else if (open.has(part)) frame.cyclic = true;
      else enter(part);
      continue;
    }
    frames.pop();
    open.delete(frame.node);
    if ("ingress" in frame.node) {
      let ingress = leafIngress(admission, frame.node.ingress);
      let found = ingress === null ? undefined : index.byIngress.get(ingress);
      // (a typed default's data is its call's, r4.63 (3): the call's landing checks it)
      const covered = found?.call !== undefined && found.stores.size === 0 && !found.own;
      if (covered) {
        ingress = found!.call!;
        found = index.byIngress.get(ingress);
      }
      if (found !== undefined && found.stores.size > 0)
        for (const d of found.stores) admission.boundaryAt(d);
      else if (found?.own === true) boundaryAtRead(admission, ingress!);
      else {
        // (a typed call no store brings is checked where it runs: its F18 check validates its default's data too)
        const call = covered ? program.opOf.get(ingress!) : undefined;
        frame.unreached =
          ingress !== null && (call === undefined || f18Admission(admission, call) === null);
      }
    }
    if (!frame.cyclic) admission.resolved.set(frame.node, frame.unreached);
    const parent = frames.at(-1);
    if (parent === undefined) answer = frame.unreached;
    else {
      parent.unreached ||= frame.unreached;
      parent.cyclic ||= frame.cyclic;
    }
  }
  return answer;
}

/** C9: the boundary check of an ingress store, once, against its destination's admitted type when it is published. */
export function boundaryAt(admission: Admission, d: Definition): void {
  admission.pending.set(d.uid, d);
}

/** C10, C9: host data in a fallback or a default is checked at its own read, against its own unknown contract. */
function boundaryAtRead(admission: Admission, value: PlaceId): void {
  if (admission.readSeen.has(value)) return;
  admission.readSeen.add(value);
  const operation = admission.pass.program.opOf.get(value);
  // (F18's own check is the boundary)
  if (operation !== undefined && f18Admission(admission, operation) !== null) return;
  const site = admission.pass.program.place(value).site;
  if (site === null) return;
  const label = admission.pass.program.textAt(site);
  admission.readChecks.push(
    boundaryCheck(
      site,
      label,
      ["unknown"],
      `validate external data entering ${label} against its own unknown contract`,
    ),
  );
  admission.readCheckKeys.push(value);
}

/**
 * C9: an external item a consumer meets brings the boundary check of each ingress store it came in by, whichever
 * consumer asks first; host data that no ingress store brought is checked at the consumer (`here`) against `unknown`
 * (r4.10: the kinds the consumer needs are its own obligation).
 */
export function boundaryFor(admission: Admission, item: Item, here: Obligation | null): void {
  if (!isExternal(item)) return;
  // the landing index: an ingress's store's boundary, its own read's check, or the consumer's check (r4.10)
  const unreached = item.ingress !== undefined && resolve(admission, item.ingress);
  if (item.ingress !== undefined && item.loose !== true && !unreached) return;
  if (here === null) return;
  const at = keptParts(admission.work, here.target, `${here.site.file}:${here.site.start}`);
  if (admission.hostSeen.has(at)) return;
  admission.hostSeen.add(at);
  admission.readChecks.push({
    ...here,
    kind: "copy-type",
    against: ["unknown"],
    on: `validate external data ${here.target}`,
    boundary: true,
  });
  admission.readCheckKeys.push(at);
}

/**
 * Takes back the read checks from `length` on, with the keys they took and the ingress resolutions that made them, so
 * the walk that finishes their unit after a stop makes them again (D4 a′: the running unit's findings are taken back,
 * TABLE r4.54).
 */
export function takeBackReadChecks(admission: Admission, length: number): void {
  const taken = admission.readCheckKeys.splice(length);
  for (const key of taken)
    if (typeof key === "number") admission.readSeen.delete(key);
    else if (key !== null) admission.hostSeen.delete(key);
  admission.readChecks.length = length;
  // (an ingress resolved in the unit made its own read's check there: resolved again, its idempotent effects redone)
  if (taken.length > 0) admission.resolved.clear();
}

export function boundariesAt(
  admission: Admission,
  items: readonly Item[],
  here: Obligation | null,
): void {
  for (const item of items) admission.boundaryFor(item, here);
}

/** F18: a load or `fromJson` with an expected type that no store takes in is checked where it runs, against that type. */
function f18Admission(
  admission: Admission,
  c: CorePass["program"]["constraints"][number],
): { readonly label: string; readonly tags: readonly ItemTag[] } | null {
  if (!("result" in c) || !typedIngress(c)) return null;
  // (a typed ingress no store brings, an own read or unreached, is checked where it runs: §3.3, r4.57)
  const found = landingIndex(admission).byIngress.get(c.result);
  return found === undefined || found.stores.size === 0 ? f18Kinds(admission, c) : null;
}

/**
 * F18 (r4.57): the checks of loads and `fromJson` calls that no store brings in, where they run. `skip`, after a stop
 * before admission settled: a call whose records a mark stands for (inside a marked store's value), so the landing
 * index `publish` made there, of the stores into written places alone, answers for the rest (TABLE r4.138). Returns
 * the calls whose expected type a stop left open (`f18Open`), each with its label, for the consumers to mark: no
 * obligation is declined for a missing answer (TABLE r4.144).
 */
export function ingressStores(
  admission: Admission,
  skip?: (site: SourceSite) => boolean,
): readonly { readonly site: SourceSite; readonly label: string }[] {
  const open: { site: SourceSite; label: string }[] = [];
  for (const c of admission.pass.program.constraints) {
    if (skip !== undefined && "result" in c && typedIngress(c) && skip(c.site)) continue;
    const found = f18Admission(admission, c);
    if (found === null) {
      if ("result" in c && admission.f18Open.has(c.result))
        open.push({ site: c.site, label: `${c.kind === "load" ? "load" : "fromJson"}.result` });
      continue;
    }
    admission.readChecks.push(
      boundaryCheck(
        c.site,
        found.label,
        found.tags.map(requiredKind),
        `validate external data entering ${found.label} against ${found.tags.join("|")}`,
      ),
    );
    admission.readCheckKeys.push(null);
  }
  return open;
}

/**
 * The kinds an ingress store's boundary check is against: the destination's admitted type; for an argument beside an
 * unannotated parameter's default, which that default's decision never constrains (F21, ADR 0021 1.5), the
 * argument's own kinds at the boundary's path (a record carrying the ingress its record, a typed ingress its expected
 * kinds, F18, with their `null`), none for external data alone (`unknown`: the runtime's validation of it).
 */
function againstOf(admission: Admission, d: Definition, path: readonly string[]): ItemTag[] {
  if (!admission.besideDefault(d)) {
    const tags = admission.admitted(d.place, path);
    // (after a stop, where admission retained nothing at the destination, the stored value's read below it as the
    // finishing read answers it: a finished source contract stands, a domain read as the value by this fixed need,
    // TABLE r4.126)
    const destination = admission.destPath(d);
    if (
      tags.length === 0 &&
      admission.pass.program.work.stopped !== null &&
      d.value !== undefined &&
      path.length >= destination.length
    ) {
      const read = admission.host.read?.(d.value, d.node, path.slice(destination.length)) ?? [];
      const kinds = [
        ...new Set(
          withoutEmpty(read)
            .filter((item) => concrete(item))
            .map((item) => item.tag),
        ),
      ];
      if (kinds.length > 0) return kinds;
    }
    // (an unrestricted destination, a copy's as the written part's, owes no boundary: every kind fits, V30 §13)
    return tags.includes("unknown") ? [] : tags;
  }
  const items = admission.valueAt(d, path);
  const tags: ItemTag[] = [
    ...new Set(items.filter((item) => concrete(item)).map((item) => item.tag)),
  ];
  return tags.length > 0 && items.some((item) => item.tag === "null") ? [...tags, "null"] : tags;
}

/**
 * C9, S6-CARRIERS §3.3, once every place is decided, from the landing index: one boundary per ingress store, at the
 * record level a whole record is stored at (the longest common prefix of its non-own ingress stops' boundary paths,
 * an `addAll`'s first element step dropped), against the admitted type there, at the span of its ingress stop of
 * least evaluation key; owed where a consumer met one of its ingresses' items, where a typed ingress lands where a
 * type is admitted (a parameter default too, r4.28; an argument or a return that carries a typed `load` or
 * `fromJson`, Sol M3 r8), or where one of its ingress stops stands where a type is admitted (the owner's F1).
 * `written`: only the stores whose destination has a written type (a stop before admission settled).
 */
export function publish(admission: Admission, written = false): void {
  const { definitions, lists, program } = admission.pass;
  const writtenAt = (d: Definition): boolean => {
    const type = writtenOf(program.place(d.place).kind);
    return type !== null && termAt(type, admission.destPath(d)) !== null;
  };
  // (`written`: only those stores' stops, so no walk of the rest after a stop; the index where it was made)
  const index = landingIndex(admission, written ? writtenAt : undefined);
  const stores = new Set(definitions.storeDefs);
  const elements = elementsBelow;
  for (const [d, stops] of index.byStore) {
    program.work.charge("checks");
    if (stops.length === 0) continue;
    // (`written`: a stop before admission settled reads no decision, so only a written destination's boundary forms;
    // any other ingress store is marked, TABLE r4.110 (3))
    if (written && !writtenAt(d)) continue;
    const destination = admission.destPath(d);
    // (a store or a parameter default of an ingress or carrying a typed one; an argument or a return carrying a typed
    // one)
    const typedIngress = stops.some((stop) => {
      const operation = program.opOf.get(stop.ingress);
      return operation !== undefined && f18Kinds(admission, operation) !== null;
    });
    const typed =
      d.kind === "whole" &&
      ((stores.has(d) || d.how === "parameter default"
        ? definitions.ingress.has(d.value!)
        : false) ||
        (typedIngress &&
          (stores.has(d) ||
            d.how === "parameter default" ||
            d.how === "argument" ||
            d.how === "return")));
    const owed =
      admission.pending.has(d.uid) ||
      (typed
        ? againstOf(admission, d, destination).length > 0
        : lists.live(d) &&
          stops.some(
            (stop) =>
              againstOf(admission, d, joinSteps(destination, elements(d, stop.path))).length > 0,
          ));
    if (!owed) continue;
    const record = elements(d, stops[0]!.recordPath);
    let common = record.length;
    for (const stop of stops) {
      const other = elements(d, stop.recordPath);
      let length = 0;
      while (length < common && length < other.length && other[length] === record[length])
        length += 1;
      common = length;
    }
    const path = joinSteps(destination, record.slice(0, common));
    const tags = againstOf(admission, d, path);
    const label = admission.pathLabel(
      d.place,
      path,
      written ? writtenOf(program.place(d.place).kind) : null,
    );
    const against: RequiredKind[] = tags.length > 0 ? tags.map(requiredKind) : ["unknown"];
    const key = keptKey(admission.work, d.place, path);
    const message = `validate external data entering ${label} against ${against.join("|")}`;
    // (the check keeps its label and its message, each about the path's text)
    keepText(admission.work, label.length);
    keepText(admission.work, message.length);
    const check = boundaryCheck(stops[0]!.site, label, against, message);
    const list = admission.boundaries.get(key);
    if (list === undefined) admission.boundaries.set(key, [check]);
    else list.push(check);
  }
}

/** A boundary check (C9): `copy-type` against the destination's own contract. */
function boundaryCheck(
  site: SourceSite,
  target: string,
  against: readonly RequiredKind[],
  on: string,
): Obligation {
  return {
    kind: "copy-type",
    target,
    against,
    on,
    site: { file: site.file, start: site.start, end: site.end },
    boundary: true,
  };
}

/**
 * Every derivation of admission's that creates an obligation, with its exits after a stop before admission settled
 * (TABLE r4.126, r4.138): where the fresh pass runs it (`freshStores`, or its walk, which finishes every
 * unit), what it publishes there, what it leaves undecided with a mark, and what it declines and why. A C1 obligation
 * comes from a decision (`decide`), which the consumers check. The lint check `check-obligation-inventory` reads the
 * syntax tree: every method here that creates one, and every `Admission` method a consumer method that creates one
 * calls, is an entry here or a read it lists with why (TABLE r4.143).
 *
 * @public (read by that check from the syntax tree, not imported)
 */
export const OBLIGATION_SITES = [
  {
    method: "decide",
    runs: "admittedStores",
    published: "C1 against a written type at a store's path (A1)",
    undecided: "a store into an inferred place, marked (storeMark)",
    declined: "an unrestricted destination; a multi-site argument decides nothing (F21)",
  },
  {
    method: "literalElements",
    runs: "literalElements",
    published:
      "a mixed element's TSV044 where its elements' own kinds decide it (ADR 0021 1.3, A8)",
    undecided:
      "a named element, one source identity's too (its test comes first): every definition holding its literal, or the literal, marked (markHolder)",
    declined:
      "elements of one source identity, in a settled pass; a literal landing in a written place, which C1 checks",
  },
  {
    method: "boundaryAtRead",
    runs: "the walk",
    published: "an own read's boundary (C9)",
    undecided: "none: ingress is structural (r4.113)",
    declined: "none",
  },
  {
    method: "boundaryFor",
    runs: "the walk",
    published: "an item's ingress boundary (C9)",
    undecided: "none: ingress is structural (r4.113)",
    declined: "an ingress the store owns (`ownIngress`)",
  },
  {
    method: "ingressStores",
    runs: "ingressStores",
    published:
      "a typed call's own boundary no store takes in, its type its syntax's or its default's (F18)",
    undecided:
      "a typed call whose default the finishing read leaves STOPPED: returned, the consumers mark it (ingressMark)",
    declined: "a typed call no type reaches: the runtime's validation alone",
  },
  {
    method: "publish",
    runs: "publish",
    published: "an ingress store's boundary against a written destination (C9, S6-CARRIERS §3.3)",
    undecided: "an ingress store into an inferred place, marked (storeMark)",
    declined: "an unrestricted destination (V30 §13)",
  },
] as const;

/** A required kind as an obligation names it. */
export function requiredKind(tag: ItemTag): RequiredKind {
  if (tag === "empty") throw new Error("The emptiness mark is no kind a check requires.");
  return tag;
}
