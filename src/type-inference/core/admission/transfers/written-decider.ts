// The written decider: the candidates a written type's paths summarize, decided over the regions a group reads.

import type { PlaceId, SourceSite, TypeTerm } from "../../../graph.js";
import type { Admission } from "../../admission.js";
import { restRef, restSteps, stepsAfter, type Rest } from "../../contract/key-ids.js";
import { keep, keptParts } from "../../budget.js";
import { typeTags, writtenOf } from "../../contract.js";
import { keyPath, keyPlace } from "../../definitions.js";
import type { ItemTag } from "../../items.js";
import { sharing } from "../../sharing.js";
import { live, snapshotOf } from "../links.js";
import type { Expansion, Inheriting } from "../model.js";
import { joinedDomain, permittedAt } from "../permitted.js";
import { inheritedInto } from "../../inherited/waiting.js";
import {
  type Entry,
  type RegionPath,
  type DeciderGroup,
  type DeciderCaches,
  type DecidingValue,
  groupOf,
  regionOf,
  distinctAt,
  holdsWritten,
  asksType,
  decides,
  EMPTY,
  narrowed,
  maskName,
  restAfter,
  forEachPathRead,
  type WrittenCandidate,
  type WrittenSummary,
} from "./regions.js";
import { rootMember } from "./transferred-decider.js";

/**
 * A region path's written copies as the decider's scan reads them (`earliestDecider`'s `snapshots`): of one member's
 * copies there that read one snapshot at one strip and lanes, the first (a member's copies share its chain of
 * operations, `viaSignature`); once per path.
 */
function writtenAt(admission: Admission, path: RegionPath): readonly Entry[] {
  if (path.representatives !== null) return path.representatives;
  if (!sharing() || path.written.length < 2) return (path.representatives = path.written);
  const seen = new Set<string>();
  const out: Entry[] = [];
  for (const entry of path.written) {
    admission.pass.program.work.charge("checks");
    const read = snapshotOf(admission, entry.task.value);
    if (read !== null) {
      const inherited = entry.call !== true && entry.task.inherits !== null;
      const strip = inherited ? entry.task.inherits!.strip : entry.task.stop!.strip;
      const name = keptParts(
        admission.work,
        entry.member,
        strip,
        entry.deep,
        entry.single,
        read,
        inherited,
      );
      if (seen.has(name)) continue;
      seen.add(name);
    }
    out.push(entry);
  }
  keep(admission.work, 1 + out.length);
  return (path.representatives = out);
}

/**
 * The maps the written-decider summary reads and keeps its answers in: the pass's own while no stop forgot an answer
 * since admission began (each made from the solver's current answers), else maps of its own made since the last
 * `Solver.forget`, the only place a finished answer changes within a pass. A forget replaces them whole, so no answer
 * made before it is read after it; the pass's own maps are never written then.
 */
function summaryCaches(admission: Admission): DeciderCaches {
  const forgets = admission.pass.solver.forgets;
  const known = admission.summary;
  if (known !== null && known.forgets === forgets) return known.caches;
  const own = admission.deciderCaches;
  const caches: DeciderCaches =
    forgets === admission.forgetsAtStart
      ? {
          deciders: own.deciders,
          linkTests: own.linkTests,
          linkKinds: own.linkKinds,
          summaries: new WeakMap(),
        }
      : {
          deciders: new Map(),
          linkTests: new Map(),
          linkKinds: new Map(),
          summaries: new WeakMap(),
        };
  admission.summary = { forgets, caches };
  admission.summaryEpochs += 1;
  return caches;
}

/**
 * #1444(b,c): `earliestDecider`'s answer where a written copy on the path asks a type (`transferredDecider` answered
 * `undefined`), asked outside every decision and into no decision's place (`literalElements`, `joinElements`), from its
 * groups' regions instead of a walk of its stops: each group's answer at a rest of the path once per masks and linked
 * members, its written copies and values in its region's rank order, each operand group's answer taken at its rank
 * (a nest's levels each answered once, never each level's whole walk again). The same answer as the scan: an open list
 * join's operand first, else the earlier of the earliest written copy (`copy`) and the earliest deciding value.
 * A decision's own scan stays the stops' (`earliestDecider`), so each decision charges what it charged before.
 */
export function* writtenDecider(
  admission: Admission,
  task: Expansion,
  asked: Rest,
  found: { readonly root: DeciderGroup | null; readonly ids: ((rest: number) => number) | null },
): Inheriting<{
  readonly term: TypeTerm | null;
  readonly site: SourceSite | null;
  readonly tags?: readonly ItemTag[];
  readonly joined?: boolean;
  readonly joinedNull?: boolean;
  readonly own?: boolean;
} | null> {
  const caches = summaryCaches(admission);
  const { program, contract } = admission.pass;
  const work = program.work;
  const at = restRef(contract, asked);
  const ids = found.ids!;
  const root =
    caches.deciders === admission.deciders
      ? found.root!
      : groupOf(admission, [rootMember(task)], caches);
  type Kind = "written" | "value" | "bound";
  interface Frame {
    readonly group: DeciderGroup;
    readonly rest: number;
    readonly masks: readonly (ReadonlySet<ItemTag> | null)[];
    readonly linked: readonly boolean[];
    /** Its answer's name in its group's (`DeciderCaches.summaries`), `null` for the root's, which is not kept. */
    readonly name: string | null;
    entries: { readonly entry: Entry; readonly length: number; readonly kind: Kind }[] | null;
    next: number;
    copy: WrittenCandidate | null;
    first: DecidingValue | null;
    open: WrittenCandidate | null;
    copyRank: number;
    firstRank: number;
    openRank: number;
    copyFirst: boolean;
    joinedNull: boolean;
    waiting: { readonly rank: number; readonly length: number } | null;
  }
  const frame = (
    group: DeciderGroup,
    rest: number,
    masks: readonly (ReadonlySet<ItemTag> | null)[],
    linked: readonly boolean[],
    name: string | null,
  ): Frame => ({
    group,
    rest,
    masks,
    linked,
    name,
    entries: null,
    next: 0,
    copy: null,
    first: null,
    open: null,
    copyRank: Infinity,
    firstRank: Infinity,
    openRank: Infinity,
    copyFirst: false,
    joinedNull: false,
    waiting: null,
  });
  // (an earlier open join wins: the shallower, at one depth a written operand before a call, then the earlier rank)
  const earlierOpen = (a: WrittenCandidate, rank: number, f: Frame): boolean =>
    f.open === null ||
    a.depth < f.open.depth ||
    (a.depth === f.open.depth &&
      (Number(a.call) < Number(f.open.call) || (a.call === f.open.call && rank < f.openRank)));
  const merge = (f: Frame, s: WrittenSummary, rank: number, length: number): void => {
    if (s.copy !== null && rank < f.copyRank) {
      f.copy = { ...s.copy, depth: length + s.copy.depth };
      f.copyRank = rank;
    }
    if (s.first !== null && rank < f.firstRank) {
      f.first = s.first;
      f.firstRank = rank;
    }
    if (s.open !== null) {
      const open = { ...s.open, depth: length + s.open.depth };
      if (earlierOpen(open, rank, f)) {
        f.open = open;
        f.openRank = rank;
      }
    }
    f.joinedNull ||= s.joinedNull;
    if (f.copyRank !== f.firstRank) f.copyFirst = f.copyRank < f.firstRank;
    else if (rank === f.copyRank) f.copyFirst = s.copyFirst;
  };
  const stack: Frame[] = [
    frame(
      root,
      0,
      root.members.map(() => null),
      root.members.map(() => false),
      null,
    ),
  ];
  let answer: WrittenSummary | null = null;
  while (stack.length > 0) {
    const f = stack.at(-1)!;
    if (answer !== null) {
      merge(f, answer, f.waiting!.rank, f.waiting!.length);
      f.waiting = null;
      answer = null;
    }
    if (f.entries === null) {
      admission.summaryStates += 1;
      const entries: { entry: Entry; length: number; kind: Kind }[] = [];
      yield* forEachPathRead(
        yield* regionOf(admission, f.group, caches),
        at,
        f.rest,
        function* (path, length) {
          if (path === null) return;
          for (const entry of writtenAt(admission, path))
            entries.push({ entry, length, kind: "written" });
          const end = f.rest + length === at.length;
          for (const entry of distinctAt(admission, path, end))
            if (!end || entry.bound === null)
              entries.push({ entry, length, kind: entry.bound === null ? "value" : "bound" });
          // (at the path's end an operand group of operands below operations decides no value, but its written copies
          // still may: it is entered for them)
          if (end)
            for (const entry of distinctAt(admission, path, false))
              if (
                entry.bound !== null &&
                (entry.bound.group.members.some((member) => !member.deep) ||
                  (yield* holdsWritten(admission, entry.bound.group, caches)))
              )
                entries.push({ entry, length, kind: "bound" });
          if (end)
            for (const entry of path.literals) entries.push({ entry, length, kind: "value" });
        },
      );
      f.entries = entries;
    }
    if (f.next >= f.entries.length) {
      const done: WrittenSummary = {
        copy: f.copy,
        first: f.first,
        copyFirst: f.copyFirst,
        open: f.open,
        joinedNull: f.joinedNull,
      };
      if (f.name !== null) {
        let byName = caches.summaries.get(f.group);
        if (byName === undefined) caches.summaries.set(f.group, (byName = new Map()));
        byName.set(f.name, done);
        keep(
          work,
          1 + Number(f.copy !== null) + Number(f.first !== null) + Number(f.open !== null),
        );
      }
      stack.pop();
      answer = done;
      continue;
    }
    const { entry, length, kind } = f.entries[f.next++]!;
    const rest = f.rest + length;
    const member = f.group.members[entry.member]!;
    work.charge("checks");
    if (kind === "bound") {
      const { group: inner, from, through } = entry.bound!;
      const values =
        (rest !== at.length || inner.members.some((each) => !each.deep)) &&
        entry.rank <= Math.min(f.copyRank, f.firstRank);
      // (each member's mask in turn, as a map makes them)
      const masks: (ReadonlySet<ItemTag> | null)[] = [];
      for (const [index, each] of inner.members.entries())
        masks.push(
          values
            ? yield* narrowed(
                admission,
                f.masks[from[index]!]!,
                each,
                through[index]!,
                at,
                rest,
                ids(rest),
                caches,
              )
            : EMPTY,
        );
      const linked = inner.members.map(
        (_, index) => f.linked[from[index]!]! || through[index] !== null,
      );
      const name = keptParts(
        work,
        ids(rest),
        ...masks.map((mask, index) => `${maskName(mask)}${linked[index] ? "'" : ""}`),
      );
      const known = caches.summaries.get(inner)?.get(name);
      if (known !== undefined) {
        merge(f, known, entry.rank, length);
        continue;
      }
      f.waiting = { rank: entry.rank, length };
      stack.push(frame(inner, rest, masks, linked, name));
      continue;
    }
    if (kind === "value") {
      if (entry.rank > Math.min(f.copyRank, f.firstRank)) continue;
      const tags = yield* decides(admission, member, entry, at, rest, f.masks[entry.member]!);
      if (tags !== null)
        merge(
          f,
          {
            copy: null,
            first: { value: entry.task.value, tags },
            copyFirst: false,
            open: null,
            joinedNull: false,
          },
          entry.rank,
          length,
        );
      continue;
    }
    // (a written copy after the earliest one decides nothing, but a list join's may still leave the path open)
    if (!member.joined && entry.rank > f.copyRank) continue;
    if (!asksType(admission, f.group, entry, rest === at.length)) continue;
    let term: TypeTerm | null;
    // (whether the copy reads its written type at its own level: a written copy's where no step of the asked path is
    // left below it, an inheriting copy's as the inheritance pass recorded it (`inheritedInto`'s `own`); a call's
    // result never is a copy read as an occurrence, #1901)
    let own = false;
    if (entry.call === true) {
      const key = contract.resultKey(entry.task.value);
      const result = key === null ? null : writtenOf(program.place(keyPlace(key)).kind);
      term =
        result === null || !member.chosen || !live(admission, entry.task.value)
          ? null
          : permittedAt(
              result,
              stepsAfter(keyPath(key!), restSteps(restAfter(entry.task.stop!.strip, at, rest))),
            );
    } else if (entry.task.inherits !== null) {
      const below = restAfter(entry.task.inherits.strip, at, rest);
      const inherited = { value: false };
      term = yield* inheritedInto(admission, entry.task.inherits.from, below, null, inherited);
      own = inherited.value;
    } else {
      const below = restAfter(entry.task.stop!.strip, at, rest);
      own = below.length === 0;
      term = permittedAt(entry.task.stop!.term!, below);
    }
    // (a copy reached through operations decides only where they select it, A4)
    if (
      term !== null &&
      entry.call !== true &&
      f.linked[entry.member]! &&
      !(member.chosen && live(admission, entry.task.value))
    )
      term = null;
    if (term === null) continue;
    const candidate: WrittenCandidate = {
      term,
      value: entry.task.value,
      joined: member.joined,
      call: entry.call === true,
      depth: 0,
      own,
    };
    const domain = member.joined ? joinedDomain(typeTags(term)) : "kinds";
    merge(
      f,
      {
        copy: domain === "kinds" ? candidate : null,
        first: null,
        copyFirst: true,
        open: domain === "open" ? candidate : null,
        joinedNull: member.joined && typeTags(term).includes("null"),
      },
      entry.rank,
      length,
    );
  }
  const s = answer!;
  const siteOf = (value: PlaceId): SourceSite | null => program.places[value]?.site ?? null;
  if (s.open !== null) return { term: s.open.term, site: siteOf(s.open.value) };
  if (s.copy !== null && s.copyFirst)
    return {
      term: s.copy.term,
      site: siteOf(s.copy.value),
      joined: s.copy.joined,
      joinedNull: s.joinedNull,
      own: s.copy.own,
    };
  return s.first === null ? null : { term: null, site: siteOf(s.first.value), tags: s.first.tags };
}
