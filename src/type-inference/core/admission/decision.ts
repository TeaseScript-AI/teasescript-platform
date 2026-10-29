import type { PlaceId, SourceSite, TypeTerm } from "../../graph.js";
import type { Admission } from "../admission.js";
import { joinParts, joinSteps, keptParts, pathText, splitPath } from "../budget.js";
import { typeTags, writtenOf } from "../contract.js";
import { keptKey, keyOf, sortCost, type Definition, type Key } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import { marked } from "../guards.js";
import { ingressLeaves, writerKey, type Item, type ItemTag } from "../items.js";
import { addRest, aliasKeyAt, covers } from "./classes.js";
import { hostRead, takeable, wholeOf } from "./eligibility.js";
import { drive, inheritedAt, openAbove, optionalOf } from "./inherited.js";
import {
  admitsNumber,
  concrete,
  deciding,
  family,
  isExternal,
  offending,
  SCALAR,
} from "./kinds.js";
import { inheritance, landedBelow } from "./landings.js";
import type { Alias, Candidate, Decided, Decision, Inputs } from "./model.js";
import { permittedAt } from "./permitted.js";
import { inputsOf, scanAt } from "./scan.js";
import { compareKeys, stopsOf, writtenSource } from "./walk.js";

// The decision of one place at one path (§5), and its comparison under the member-answer oracle.

/**
 * S6-CARRIERS §4.1's member-answer oracle (the orchestrator's condition (a)), for the tests: while `withMemberOracle`
 * runs, every decided path compares each alias member's own answer with its class representative's, each with its own
 * guard applied (`marked` where a test of the read's path holds its node), and reports every difference and every
 * comparison made.
 */
let memberOracle: { readonly report: (difference: string | null) => void } | null = null;

export function withMemberOracle<T>(
  report: (difference: string | null) => void,
  callback: () => T,
): T {
  if (memberOracle !== null) throw new Error("The member-answer oracle is already active.");
  memberOracle = { report };
  try {
    return callback();
  } finally {
    memberOracle = null;
  }
}

/** An item as the oracle compares it: every field, its leaves by their ingresses. */
function itemText(item: Item, writer = true): string {
  const { ingress, ...rest } = item;
  return JSON.stringify({
    ...rest,
    writer: !writer || item.writer === null ? null : writerKey(item.writer),
    leaves: ingress === undefined ? [] : ingressLeaves(ingress).map(writerKey),
  });
}

/** A decision's fields where nothing is checked (`decided`). */
const NOTHING = {
  nullable: true,
  byWritten: false,
  permitsNull: false,
  decider: null,
  site: null,
  published: false,
  copied: null,
} as const;

/**
 * Under the member-answer oracle (`withMemberOracle`), after the decisions: every path copies land that `groups` left
 * out, compared as a decided one is, so the oracle covers each landed path as when every one was decided.
 */
export function compareLanded(admission: Admission): void {
  if (memberOracle === null) return;
  for (const place of inheritance(admission).into.keys())
    for (const text of landedBelow(admission, place, [])) {
      const path = splitPath(text);
      if (admission.attempted.has(keyOf(place, path))) continue;
      const inputs = inputsOf(admission, place, path);
      if (inputs !== null) compareMembers(admission, place, path, inputs.prefixes);
    }
}

/**
 * A decision that stopped at its demand allowance (S3 §5): what it had made of its key is taken back, so the key is
 * undecided, and its contract answers every read of it, or of a key below it, `unknown` with the reason `budget`
 * (`Contract.stop`).
 */
export function stopDecision(admission: Admission, root: PlaceId, path: readonly string[]): void {
  const key = keptKey(admission.work, root, path);
  admission.decided.delete(key);
  admission.nullable.delete(key);
  admission.permitsNull.delete(key);
  admission.inheritsWrittenKeys.delete(key);
  admission.unrestricted.delete(key);
  admission.deciderSites.delete(key);
  admission.pass.contract.stop(root, path);
}

/** Whether the decision of `place` at `path` or at a key above it stopped (`stopDecision`). */
export function decisionStopped(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
): boolean {
  return admission.pass.contract.stopped(place, path);
}

/**
 * The complete type a store into `place` at `path` is checked against where a decision below the path stopped (S3 §5,
 * #1416), without new solving: the place's written type there (A1), else the written type a copy decides the path by,
 * whole below it (A4, this pass's decision: a pass in which a decision stops is restarted with it stopped, TABLE r4.180,
 * so that decision never read what the stop took back); `null` where neither decides the path.
 */
export function storeRequirement(
  admission: Admission,
  place: PlaceId,
  path: readonly string[],
): TypeTerm | null {
  const written = writtenOf(admission.pass.program.place(place).kind);
  const term = written === null ? null : permittedAt(written, path);
  if (term !== null) return term;
  return admission.decisions.get(keptKey(admission.work, place, path))?.copied ?? null;
}

/**
 * The decision of one place at one path (§5), or `null` where nothing is checked: no store reaches it, it lies below
 * a reference (F19a), a settled family needs no scan (A3), or nothing decides. The decision is recorded for the
 * boundary checks' `against` (C9). `lazily`: a path of a copy `groups` leaves to be decided where an answer asks for
 * it (`lazily`): recorded, its candidates owe nothing (`hotSets`) and are not taken.
 */
export function decide(
  admission: Admission,
  root: PlaceId,
  path: readonly string[],
  lazily = false,
): Decision | null {
  const { program, definitions, lists, contract } = admission.pass;
  const work = program.work;
  const key = keptKey(admission.work, root, path);
  admission.attempted.add(key);
  const inputs = inputsOf(admission, root, path);
  if (inputs === null) return null;
  const { direct, prefixes } = inputs;
  if (memberOracle !== null && !lazily) compareMembers(admission, root, path, prefixes);
  const found = decided(admission, root, path, inputs);
  if (found === null || found.tags === null) return null;
  const { nullable, byWritten, permitsNull, decider, transfer, published } = found;
  if (byWritten && !found.own) admission.inheritsWrittenKeys.add(key);
  else admission.inheritsWrittenKeys.delete(key);
  // an unrestricted written part, or a copy's, decides nothing: every kind fits there, no store owes it anything
  if (found.tags.includes("unknown")) {
    admission.unrestricted.add(key);
    work.charge("checksSkipped");
    return null;
  }
  const tags = found.tags;
  admission.decided.set(key, tags);
  admission.nullable.set(key, nullable);
  if (permitsNull) admission.permitsNull.add(key);
  else admission.permitsNull.delete(key);
  admission.deciderSites.set(key, found.site);
  if (lazily) return null;
  const offends = (items: readonly Item[]): boolean => offending(items, found);
  // A5: the direct stores, and the prefixes' whole stores whose source's contract at the path holds an offending kind
  const candidates = new Map<string, Candidate>();
  work.charge("checks", direct.length);
  for (const candidate of direct)
    if (candidate.d.how !== "argument" || transfer || lists.singleSite(candidate.d.fn))
      candidates.set(keptParts(admission.work, candidate.d.uid, candidate.at), candidate);
  if (transfer && path.length > 0)
    for (const d of [
      ...(definitions.byKey.get(keyOf(root, [])) ?? []),
      ...(definitions.deadArguments.get(keyOf(root, [])) ?? []),
    ])
      if (lists.live(d) && d.kind === "whole")
        candidates.set(keptParts(admission.work, d.uid, path), { d, at: path });
  for (const { key: prefix, rest } of prefixes) {
    const stored = contract.prefixStores(prefix);
    const take = (d: Definition): void => {
      const at = d.kind === "add" && d.how !== "elements" ? rest.slice(1) : rest;
      const members = admission.members.get(d);
      candidates.set(
        keptParts(admission.work, d.uid, at),
        members === undefined || !covers(admission, d, at) ? { d, at } : { d, at, members },
      );
      // (beside or above a literal's alias cell its members are their own candidates: their own terms stand there)
      if (members !== undefined && !covers(admission, d, at))
        for (const member of members)
          candidates.set(keptParts(admission.work, member.uid, at), { d: member, at });
    };
    const takeAll = (stores: ReadonlySet<Definition | null>): void => {
      const { wholes, adds } = takeable(admission, stores, byWritten);
      work.charge("checks", wholes.length);
      for (const d of wholes) take(d);
      if (rest[0] !== "element") return;
      work.charge("checks", adds.length);
      for (const d of adds) take(d);
    };
    for (const entry of stored.list) {
      work.charge("checks");
      if (offends(admission.run(contract.entryAt(entry, rest)))) takeAll(entry.ds);
    }
    for (const sub of contract.relevantSubs(stored, rest)) {
      work.charge("checks");
      if (offends(admission.run(contract.subAt(sub.key, rest)))) takeAll(sub.defs);
    }
    // A6: a rejected store is decided again in every pass, where it was rejected
    const retaken = admission.retaken.get(key) ?? [];
    work.charge("checks", retaken.length);
    for (const d of retaken)
      if (
        d.key === prefix &&
        (byWritten || !hostRead(admission, d.value)) &&
        (d.kind === "whole" || (d.kind === "add" && rest[0] === "element"))
      )
        take(d);
  }
  // (a member its class's candidate holds is checked there only, never as its own candidate too: an add is a direct
  // candidate at its element as well as its list's store, a return into a written result its root's at every path
  // (A9), a rejected member is retaken; each charged where it was taken, #1077)
  for (const [key, candidate] of candidates) {
    const representative = admission.representative.get(candidate.d);
    if (
      representative !== undefined &&
      candidates.get(joinParts(representative.uid, candidate.at))?.members !== undefined
    )
      candidates.delete(key);
  }
  const ordered = [...candidates.values()].sort(
    (a, b) => admission.sourceOrder(a.d) - admission.sourceOrder(b.d),
  );
  work.charge("checks", ordered.length + sortCost(ordered.length));
  contract.facts.decidedPaths += 1;
  return {
    root,
    path,
    // (a written path's label from its written type, final at every stop, TABLE r4.122)
    label: admission.pathLabel(
      root,
      path,
      byWritten ? writtenOf(admission.pass.program.place(root).kind) : null,
    ),
    tags,
    written: byWritten,
    own: found.own,
    nullable,
    decider,
    candidates: ordered,
    published,
  };
}

/**
 * A place's decision at a path as `decide` takes it (§5), unrecorded and without its candidates: `null` where no store
 * reaches the path; `tags` `null` where nothing is checked, with `unknown` where an unrestricted part decides nothing.
 * Once per key and pass, so the paths `groups` tests (`hotAt`) and their decisions share it.
 */
export function decided(
  admission: Admission,
  root: PlaceId,
  path: readonly string[],
  inputs = inputsOf(admission, root, path),
): Decided | null {
  const key = keptKey(admission.work, root, path);
  const known = admission.decisions.get(key);
  if (known !== undefined) return known;
  const found = inputs === null ? null : decision(admission, root, path, key, inputs);
  admission.decisions.set(key, found);
  return found;
}

function decision(
  admission: Admission,
  root: PlaceId,
  path: readonly string[],
  key: Key,
  inputs: Inputs,
): Decided {
  const { program, lists, contract } = admission.pass;
  const work = program.work;
  const place = program.place(root);
  const { direct, prefixes } = inputs;
  const written = writtenOf(place.kind);
  const term = written === null ? null : permittedAt(written, path);
  const none = { key, own: term !== null, transfer: false, tags: null } as const;
  // A9, C7: every argument and return into a written parameter or result is a candidate
  const transfer =
    term !== null && (place.kind.kind === "parameter" || place.kind.kind === "result");
  // F19a: below a reference nothing is admitted
  if (path.length > 0 && admission.run(contract.refReceiver(key))) {
    work.charge("checksSkipped");
    return { ...NOTHING, ...none };
  }
  // below an unrestricted part of a written type a copy decides above the path every kind fits, whatever decides the
  // path itself, as below the place's own (`openAbove`)
  if (term === null && openAbove(admission, root, path))
    return { ...NOTHING, ...none, tags: ["unknown"], byWritten: true };
  if (path.length > 0 && term === null) {
    // A3: a settled family needs no scan, where no store on the path was rejected
    const clean = isClean(admission, root, path);
    const kinds = clean ? withoutEmpty(admission.run(contract.contractOf(key))) : [];
    if (
      clean &&
      kinds.every((item) => item.tag !== "unknown") &&
      family(kinds.map((item) => item.tag))
    ) {
      work.charge("checksSkipped");
      return { ...NOTHING, ...none };
    }
  }
  const writtenTags = term === null ? null : typeTags(term);
  let nullable = writtenTags === null ? true : writtenTags.includes("null");
  let tags: ItemTag[] | null =
    writtenTags === null ? null : writtenTags.filter((tag) => tag !== "null");
  let byWritten = writtenTags !== null;
  let permitsNull = false;
  let decider: Definition | null = null;
  let deciderSite: SourceSite | null = null;
  let published = false;
  let copied: TypeTerm | null = null;
  // an inferred root whose every store's contract is plain scalar kinds of one family accepts every store
  if (tags === null && path.length === 0 && !admission.a4Keys.has(keyOf(root, []))) {
    let plain = true;
    const all: ItemTag[] = [];
    for (const { d, at } of direct) {
      work.charge("checks");
      // a multi-site argument decides nothing (F21); a single-site one is the parameter's start value
      if (d.how === "argument" && !lists.singleSite(d.fn)) continue;
      const kinds = at.length === 0 ? admission.quietKinds(d.value) : null;
      if (kinds === null || !kinds.every((tag) => SCALAR.has(tag) || tag === "null")) {
        plain = false;
        break;
      }
      all.push(...kinds);
    }
    if (plain && family(all)) {
      work.charge("checksSkipped");
      return { ...NOTHING, ...none };
    }
  }
  // A2: a path whose contract holds no kind (an unknown, a null) has no definite contribution to decide it, and no
  // store needs a scan (the contract holds every live store's kinds); a copy of a written binding on the path still
  // decides (A4), and a store rejected there is decided again (A6)
  if (
    tags === null &&
    isClean(admission, root, path) &&
    !withoutEmpty(admission.run(contract.contractOf(key))).some((item) => concrete(item))
  ) {
    work.charge("checksSkipped");
    return { ...NOTHING, ...none };
  }
  if (tags === null) {
    const found = drive(admission, scanAt(admission, direct, prefixes, key));
    if (found !== null) {
      ({ tags, nullable, byWritten, permitsNull, decider, site: deciderSite } = found);
      copied = optionalOf(found.copied, found.nullable);
    } else {
      // C9 r4.12, r4.50 (1): where no contribution decides, but the contract holds kinds beside external data, those
      // kinds are the type the place is published with, so external data a store brings into it owes its check
      // there, named as well as inline (`published`)
      const kinds = withoutEmpty(admission.run(contract.contractOf(key)));
      if (kinds.some((item) => concrete(item)) && kinds.some(isExternal)) {
        tags = [...new Set(kinds.filter((item) => concrete(item)).map((item) => item.tag))];
        deciderSite = concreteSite(admission, direct, prefixes);
        published = true;
      }
    }
  }
  if (tags === null) return { ...NOTHING, ...none };
  // the decided family (ADR 1.2): an integer decider with a number admitted at the path decides numbers (r4.28); a
  // number possible solely through external data admits nothing (r4.36)
  if (
    !tags.includes("unknown") &&
    !byWritten &&
    tags.includes("integer") &&
    withoutEmpty(admission.run(contract.contractOf(key))).some(admitsNumber)
  )
    tags = [...new Set(tags.map((tag) => (tag === "integer" ? "number" : tag)))];
  return {
    key,
    own: writtenTags !== null,
    transfer,
    tags,
    nullable,
    byWritten,
    permitsNull,
    decider,
    site: deciderSite,
    published,
    copied,
  };
}

/** The member-answer oracle at a decided path (`withMemberOracle`): every class at each prefix, at its rest. */
function compareMembers(
  admission: Admission,
  root: PlaceId,
  path: readonly string[],
  prefixes: readonly { readonly key: Key; readonly rest: readonly string[] }[],
): void {
  const { guards } = admission.pass;
  const report = memberOracle!.report;
  // (a member read through a chain of copies, or its class's, carries its own links' writers, provenance and not the
  // answer: that pair's answers are compared with them set aside, the published records' writers guarded apart)
  // (and its admission: the written type A4 decides it by at the path, TABLE r4.72)
  const answer = (
    d: Definition,
    rest: readonly string[],
    writers: boolean,
  ): { readonly guard: boolean; readonly domain: string; readonly items: readonly string[] } => {
    const alias = admission.aliases.get(d)!;
    const key = aliasKeyAt(alias, rest);
    return {
      guard: key !== null && guards.narrowed(key, alias.read),
      domain: JSON.stringify(
        key === null ? null : writtenDomainAt(admission, alias, rest.slice(alias.at.length)),
      ),
      items: admission
        .valueAt(d, rest)
        .map((item) => itemText(item, writers))
        .sort(),
    };
  };
  const marks = (d: Definition, rest: readonly string[], writers: boolean): string[] =>
    marked(admission.valueAt(d, rest))
      .map((item) => itemText(item, writers))
      .sort();
  // (a prefix's whole stores' classes and, below an element step, its adds', §4.5)
  for (const { key: prefix, rest: below } of prefixes)
    for (const add of below[0] === "element" ? [false, true] : [false])
      for (const representative of wholeOf(admission, prefix, add)) {
        const members = admission.members.get(representative);
        const rest = add ? addRest(representative, below) : below;
        if (members === undefined || !covers(admission, representative, rest)) continue;
        for (const member of members) {
          const writers =
            admission.aliases.get(representative)!.chained !== true &&
            admission.aliases.get(member)!.chained !== true;
          const theirs = answer(representative, rest, writers);
          const own = answer(member, rest, writers);
          // (each with its own guard: a guarded one's answer is the other's marked)
          const expected =
            own.guard === theirs.guard || !own.guard
              ? theirs.items
              : marks(representative, rest, writers);
          const actual =
            own.guard !== theirs.guard && theirs.guard ? marks(member, rest, writers) : own.items;
          report(
            own.domain === theirs.domain && JSON.stringify(expected) === JSON.stringify(actual)
              ? null
              : `${keyOf(root, path)}: the member at ${member.site.start} answers ${JSON.stringify(actual)} ` +
                  `(written ${own.domain}) at ${pathText(rest)}, its class at ${representative.site.start} ` +
                  `${JSON.stringify(expected)} (written ${theirs.domain})`,
          );
        }
      }
}

/**
 * The site of the earliest contribution of definite kinds at a path no contribution decides (`decide`'s fallback):
 * per store in source order, the first value standing at the path whose own items there are definite kinds (a
 * literal's element, an operand), else the store's own site; `null` without a store.
 */
function concreteSite(
  admission: Admission,
  direct: readonly Candidate[],
  prefixes: readonly { readonly key: Key; readonly rest: readonly string[] }[],
): SourceSite | null {
  const { program, values } = admission.pass;
  const tried = [
    ...direct.map(({ d, at }) => ({ d, at })),
    ...prefixes.flatMap(({ key, rest }) =>
      wholeOf(admission, key, false).map((d) => ({ d, at: rest })),
    ),
  ].sort((a, b) => admission.sourceOrder(a.d) - admission.sourceOrder(b.d));
  program.work.charge("checks", tried.length + sortCost(tried.length));
  const first = tried[0];
  for (const { d, at } of tried) {
    if (d.value === undefined) continue;
    const stops = stopsOf(admission, d.value, d.node);
    const here = [
      ...(stops.written.get(pathText(at)) ?? []),
      ...(stops.values.get(pathText(at)) ?? []),
      ...(stops.literals.get(pathText(at)) ?? []),
    ].sort((x, y) => compareKeys(x.key, y.key));
    program.work.charge("checks", here.length + sortCost(here.length));
    for (const stop of here)
      if (
        deciding(withoutEmpty(admission.run(values.valueItems(stop.value, stop.node, stop.strip))))
          .length > 0
      )
        return program.places[stop.value]?.site ?? d.site;
  }
  return first === undefined ? null : first.d.site;
}

/**
 * Whether no store on the path or a prefix of it was rejected (A6) or copies a written binding (A4): G3 3b, by one walk
 * of the path down those keys' trie (`Admission.dirty`), never a key made per prefix.
 */
function isClean(admission: Admission, root: PlaceId, path: readonly string[]): boolean {
  return admission.dirty.along(root, path, true).length === 0;
}

/** The written type an alias's read copies at `rest` below its path (`writtenDomainKey`), `null` where none. */
function writtenDomainAt(
  admission: Admission,
  alias: Alias,
  rest: readonly string[],
): TypeTerm | null {
  const written = writtenSource(admission, alias.value, []);
  if (written === null) return null;
  const path = joinSteps(written.strip, rest);
  return written.from === null
    ? permittedAt(written.term!, path)
    : inheritedAt(admission, written.from, path);
}
