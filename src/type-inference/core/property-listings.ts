// The property name search's tasks and listings: what a listing schedules and classifies, memoized per pass, and the
// test-only records and flat listings.

import type { PlaceId } from "../graph.js";
import type { CorePass } from "./answers.js";
import {
  isKeyId,
  keptKeyBelowIn,
  keptKeyWalk,
  stepsArray,
  type CanonicalKey,
} from "./contract/key-ids.js";
import {
  keepText,
  keptParts,
  keptSlice,
  keptSteps,
  type BudgetLimit,
  type WorkLedger,
} from "./budget.js";
import { type Contract } from "./contract.js";
import type { PrefixStores, SubLayer } from "./contract/model.js";
import { type Key } from "./definitions.js";
import { propertyName } from "./program.js";
import { Retained, retainedModule } from "./retained/retained.js";

/** A task of a property name search (`propertyNames`): a value at a path, a key, or a literal at a path. */
export type PropertyNamesTask =
  | { readonly value: PlaceId; readonly path: readonly string[] }
  | { readonly key: CanonicalKey }
  | { readonly literal: PlaceId; readonly path: readonly string[] };

/**
 * Test-only (`withNameRecords`): what the searches did, all of them together: the tasks they took up (a seen one too),
 * the prefixes they visited, the earlier tasks their pump checks walked and the longest such walk, the head steps those
 * checks compared, the longest path a task held, their path index's entries and longest chain, the tasks that pumped,
 * the keys below a key whose step they read, and the units of `checks` and of all counters the ledger counted
 * meanwhile, and of these the ones outside shared builds (`own`, what a demand's allowance measures); of the listings
 * (`listed`): the sources classified for their effective ones (their steps charged as the search's), the jumps taken to
 * find a stores object's single top, the effective sources scheduled, the listings that scheduled nothing, those that
 * scheduled every source, and of these the ones where a source could pump or an effective one was on the chain.
 */
export interface NameRecords {
  tasks: number;
  prefixes: number;
  ancestors: number;
  depth: number;
  heads: number;
  longest: number;
  entries: number;
  chain: number;
  pumped: number;
  below: number;
  checks: number;
  units: number;
  own: number;
  classified: number;
  jumps: number;
  replayed: number;
  skipped: number;
  flat: number;
  pumpable: number;
  cycled: number;
}

export let recording: NameRecords | null = null;

/** Test-only: `run`'s result and what the property-name searches inside it did (`NameRecords`). */
export function withNameRecords<T>(run: () => T): {
  readonly result: T;
  readonly records: Readonly<NameRecords>;
} {
  if (recording !== null) throw new Error("Name records are already being recorded.");
  const records: NameRecords = {
    tasks: 0,
    prefixes: 0,
    ancestors: 0,
    depth: 0,
    heads: 0,
    longest: 0,
    entries: 0,
    chain: 0,
    pumped: 0,
    below: 0,
    checks: 0,
    units: 0,
    own: 0,
    classified: 0,
    jumps: 0,
    replayed: 0,
    skipped: 0,
    flat: 0,
    pumpable: 0,
    cycled: 0,
  };
  recording = records;
  try {
    return { result: run(), records };
  } finally {
    recording = null;
  }
}

export let flatListings = false;

/** Test-only: `run` with every listing scheduling all its sources (`listed`'s fallback): the search without the records. */
export function withFlatListings<T>(run: () => T): T {
  const before = flatListings;
  flatListings = true;
  try {
    return run();
  } finally {
    flatListings = before;
  }
}

/**
 * The step of `below`, a key below the text key `key` (`definitions.keysBelow`), at `key`'s depth: read from the text
 * after `key`'s own, one charge, and the step alone kept, charged as kept text (#1493: no key's whole text is split to
 * read one of its steps).
 */
function keptStepBelow(work: WorkLedger, key: Key, below: Key): string {
  work.charge("checks");
  if (recording !== null) recording.below += 1;
  const start = key.endsWith("|") ? key.length : key.length + 1;
  const dot = below.indexOf(".", start);
  const end = dot < 0 ? below.length : dot;
  keepText(work, end - start);
  return below.slice(start, end);
}

/** A task's identity in a search, as it keeps it (`seen`). */
export function taskId(work: WorkLedger, task: PropertyNamesTask): string {
  return "key" in task
    ? keptParts(work, "k", task.key)
    : "literal" in task
      ? keptParts(work, `l${task.literal}`, task.path)
      : keptParts(work, `v${task.value}`, task.path);
}

/**
 * A source a listing schedules: its key at the listing's rest and that key task's identity, made by its classification
 * for the first visit that takes it up (`prepaid`).
 */
export interface Source {
  readonly key: CanonicalKey;
  readonly id: string;
  prepaid: boolean;
}

/**
 * The effective sources of listings along one chain of layers, in the order the search takes them up (`listed`), each
 * listing a prefix of them; what those sources add (`names`, and `ids`: theirs and those of the tasks they schedule) and
 * the sources classified (`classified`, by their keys in the layers), as the listing that may extend it in place
 * (`owner`) left them.
 */
interface Run {
  readonly sources: Source[];
  readonly names: Set<string>;
  readonly ids: Set<string>;
  readonly classified: Set<Key>;
  owner: Listing | null;
}

/** A listing's effective sources: the first `length` of a run. */
interface Listing {
  readonly run: Run;
  readonly length: number;
}

/** A scheduled source's listing run and its position there. */
export interface Placed {
  readonly run: Run;
  readonly at: number;
}

/** A task a key's step schedules, how many of its visit's last steps it keeps untouched, and its identity. */
interface Planned {
  readonly task: PropertyNamesTask;
  readonly untouched: number;
  readonly id: string;
}

/** A listing a key's step makes: a stored prefix's stores at the rest of the path below it. */
interface Made {
  readonly stores: PrefixStores;
  readonly rest: readonly string[];
}

/**
 * A key task's step as a listing's classification made it, once per pass, charged as the flat search charges the take-up
 * at that listing: its place and path (`keptKeyWalk`) and its names (`keyNames`), and its listings and tasks in their
 * order (`keyFollowers`) only where that take-up follows. Each part is taken once, by the first visit that takes the key
 * task up (its followers by the first that follows), in place of making it again, so the charge moves there.
 */
interface Contribution {
  readonly place: PlaceId;
  readonly path: readonly string[];
  readonly names: readonly string[];
  steps: readonly (Planned | Made)[] | null;
  walked: boolean;
  named: boolean;
  followed: boolean;
}

/** A layer's or stores object's listings by the steps of their rest. */
interface ByRest {
  listing: Listing | undefined;
  readonly next: Map<string, ByRest>;
}

/**
 * A pass's listings by layer or stores and rest, each stores object's single top (`singleTop`), and the key tasks'
 * contributions, until a stop.
 */
export interface ListingMemo {
  readonly stops: number;
  readonly stopped: BudgetLimit | null;
  readonly listings: Map<SubLayer | PrefixStores, ByRest>;
  readonly tops: Map<PrefixStores, SubLayer | null | undefined>;
  readonly contributions: Map<string, Contribution>;
}

/**
 * Where a listing classifies its sources: the search's tasks taken up so far, the flat search's pump check for a source
 * taken up below the listing visit, and the sources it classified there, by their keys in the layers, each with whether
 * its take-up there pumps (made for that take-up).
 */
export interface Take {
  readonly seen: ReadonlySet<string>;
  readonly pumps: (place: PlaceId, path: readonly string[], kept: number) => boolean;
  readonly classified: Map<Key, { readonly source: Source; readonly pumps: boolean | null }>;
}

const listingMemos = retainedModule<Contract, ListingMemo>(
  "property-names.listingMemos",
  "weakMap",
);

const NO_SOURCES: Listing = {
  run: {
    sources: [],
    names: Retained.set("property-names.NO_SOURCES.names"),
    ids: Retained.set("property-names.NO_SOURCES.ids"),
    classified: Retained.set("property-names.NO_SOURCES.classified"),
    owner: null,
  },
  length: 0,
};

/** The pass's listing memo, made anew once a decision or the work stopped since it was made. */
export function listingMemo(pass: CorePass): ListingMemo {
  const { contract } = pass;
  const work = pass.program.work;
  const known = listingMemos().get(contract);
  if (
    known !== undefined &&
    known.stops === contract.stoppedCount &&
    known.stopped === work.stopped
  )
    return known;
  const memo: ListingMemo = {
    stops: contract.stoppedCount,
    stopped: work.stopped,
    listings: Retained.map("ListingMemo.listings"),
    // (a stores object's single top reads the prefix index alone, which no stop changes: kept for the pass once found)
    tops: known?.tops ?? Retained.map("ListingMemo.tops"),
    contributions: Retained.map("ListingMemo.contributions"),
  };
  listingMemos().set(contract, memo);
  return memo;
}

/** A key task's names (S3 §1): the steps of the keys below it, each read charged (`keptStepBelow`). */
export function keyNames(pass: CorePass, key: CanonicalKey, name: (name: string) => void): void {
  const work = pass.program.work;
  for (const below of isKeyId(key) ? [] : pass.definitions.keysBelow(key)) {
    const step = keptStepBelow(work, key, below);
    if (step !== "element") name(propertyName(step));
  }
}

/**
 * A key task's step as it follows (S3 §1): at each stored key along its path (`definitions.stored`: any other prefix's
 * frame holds no definition and its stores are empty), the prefix's listing of its sources and its stores' tasks, in the
 * order the search schedules them. One step of the trie each, charged, the stored key's own text, and the rest of the
 * path below it kept and charged; no prefix key or path half is rebuilt.
 */
export function keyFollowers(
  pass: CorePass,
  place: PlaceId,
  path: readonly string[],
  next: {
    readonly listing: (stores: PrefixStores, rest: readonly string[]) => void;
    readonly task: (task: PropertyNamesTask, untouched: number) => void;
  },
): void {
  const { contract, definitions } = pass;
  const work = pass.program.work;
  for (const { key: prefix, depth } of definitions.stored.along(place, path, true)) {
    work.charge("checks");
    if (recording !== null) recording.prefixes += 1;
    const rest = keptSlice(work, path, depth);
    const stores = contract.prefixStores(prefix);
    // the sources' own stores below their roots
    next.listing(stores, rest);
    for (const entry of stores.list) {
      const at = keptSteps(work, entry.at ?? [], rest);
      if (entry.key !== undefined)
        next.task({ key: keptKeyBelowIn(contract, entry.key, at) }, rest.length);
      else if (entry.value !== undefined) next.task({ value: entry.value, path: at }, rest.length);
      // an added value stands at the collection's element, an `addAll`'s at its own (as `entryAt` reads it), never
      // at the collection itself
      else if (entry.elem !== undefined && rest[0] === "element")
        next.task(
          {
            value: entry.elem,
            path: keptSteps(work, entry.at ?? [], keptSlice(work, path, depth + 1)),
          },
          rest.length - 1,
        );
    }
  }
}

/** A key task's followers as a contribution keeps them, each task's identity made as the search makes it. */
function followersOf(pass: CorePass, place: PlaceId, path: readonly string[]): (Planned | Made)[] {
  const work = pass.program.work;
  const steps: (Planned | Made)[] = [];
  keyFollowers(pass, place, path, {
    listing: (stores, rest) => steps.push({ stores, rest }),
    task: (task, untouched) => steps.push({ task, untouched, id: taskId(work, task) }),
  });
  return steps;
}

/** The layers a stores object lists its sources from (`subSources`' order): the one it inherits, then those it joins. */
function topsOf(stores: PrefixStores): SubLayer[] {
  const tops = stores.subs === null ? [] : [stores.subs];
  for (const joined of stores.also) tops.push(joined.layer);
  return tops;
}

/** Whether `other` is `layer` or on its parent chain, by its jumps, one charge per jump. */
function onParentChain(work: WorkLedger, layer: SubLayer, other: SubLayer): boolean {
  if (other.depth > layer.depth) return false;
  let at = layer;
  while (at.depth > other.depth) {
    work.charge("checks");
    if (recording !== null) recording.jumps += 1;
    let level = 0;
    while (at.jumps[level + 1] !== undefined && at.jumps[level + 1]!.depth >= other.depth)
      level += 1;
    at = at.jumps[level]!;
  }
  return at === other;
}

/**
 * The layer a stores object's sources come from as one, once per pass: its first top, every other top on that one's
 * parent chain (so `subSources` lists them within it); `undefined` where none is, `null` where it lists none. A shared
 * build (`WorkLedger.shared`): its jumps count to the analysis, to no demand's allowance, as the search that asked first
 * did not make them its own work. Only a completed walk is kept: one the work stop interrupts is walked again, its jumps
 * then finishing work.
 */
function singleTop(
  work: WorkLedger,
  memo: ListingMemo,
  stores: PrefixStores,
): SubLayer | null | undefined {
  if (memo.tops.has(stores)) return memo.tops.get(stores);
  const tops = topsOf(stores);
  const top = work.shared(() =>
    tops.length === 0
      ? null
      : tops.every((each) => onParentChain(work, tops[0]!, each))
        ? tops[0]
        : undefined,
  );
  memo.tops.set(stores, top);
  return top;
}

/** The entry of `of`'s listings at a rest, made the first time `make` is given. */
function byRest(
  memo: ListingMemo,
  of: SubLayer | PrefixStores,
  rest: readonly string[],
  make: boolean,
): ByRest | undefined {
  let at = memo.listings.get(of);
  if (at === undefined) {
    if (!make) return undefined;
    memo.listings.set(
      of,
      (at = Retained.record<ByRest>("ListingMemo.byRest", {
        listing: undefined,
        next: Retained.map("ListingMemo.next"),
      })),
    );
  }
  for (const step of rest) {
    let next: ByRest | undefined = at.next.get(step);
    if (next === undefined) {
      if (!make) return undefined;
      at.next.set(
        step,
        (next = Retained.record<ByRest>("ListingMemo.byRest", {
          listing: undefined,
          next: Retained.map("ListingMemo.next"),
        })),
      );
    }
    at = next;
  }
  return at;
}

/** A listing already made at a rest, or `undefined`; nothing is made. */
function knownListing(
  pass: CorePass,
  memo: ListingMemo,
  stores: PrefixStores,
  rest: readonly string[],
): Listing | undefined {
  const top = singleTop(pass.program.work, memo, stores);
  if (top === null) return NO_SOURCES;
  return byRest(memo, top ?? stores, rest, false)?.listing;
}

function remember(
  memo: ListingMemo,
  of: SubLayer | PrefixStores,
  rest: readonly string[],
  listing: Listing,
): Listing {
  const at = byRest(memo, of, rest, true)!;
  at.listing = listing;
  return listing;
}

/**
 * Classifies a source as the next one taken up in a run (`listed`), as the flat search would take it up below the
 * listing visit (`take`): no source where an earlier one scheduled it; an effective one, its parts not made, where this
 * search took it up already; else its walk, its pump check and its names made, and its followers where it follows; an
 * effective one where it pumps (what it would follow elsewhere is not made), else effective where it adds a name or a
 * task the sources before it did not, or makes a listing that is no prefix of the run before it.
 */
function classify(
  pass: CorePass,
  memo: ListingMemo,
  run: Run,
  sub: Key,
  rest: readonly string[],
  take: Take,
): void {
  if (recording !== null) recording.classified += 1;
  run.classified.add(sub);
  const source = sourceAt(pass, sub, rest);
  // (taken up before it: a task an earlier source scheduled)
  if (run.ids.has(source.id)) {
    take.classified.set(sub, { source, pumps: null });
    return;
  }
  if (take.seen.has(source.id)) {
    take.classified.set(sub, { source, pumps: null });
    run.sources.push(source);
    run.ids.add(source.id);
    return;
  }
  let contribution = memo.contributions.get(source.id);
  if (contribution === undefined) {
    // (a key's path and place through its walk, as the search takes them: `keptKeyWalk`)
    const walk = keptKeyWalk(pass.contract, source.key);
    const names: string[] = [];
    keyNames(pass, source.key, (found) => names.push(found));
    contribution = Retained.record<Contribution>("ListingMemo.contribution", {
      place: walk.place,
      path: stepsArray(walk.path),
      names,
      steps: null,
      walked: true,
      named: true,
      followed: false,
    });
    memo.contributions.set(source.id, contribution);
  }
  const pumps = take.pumps(contribution.place, contribution.path, rest.length);
  take.classified.set(sub, { source, pumps });
  if (contribution.steps === null && !pumps) {
    contribution.steps = followersOf(pass, contribution.place, contribution.path);
    contribution.followed = true;
  }
  const { names, steps } = contribution;
  const adds = (step: Planned | Made): boolean => {
    if ("id" in step) return !run.ids.has(step.id);
    const listing = knownListing(pass, memo, step.stores, step.rest);
    return (
      listing === undefined ||
      (listing.length > 0 && listing.run !== run) ||
      listing.length > run.sources.length
    );
  };
  if (steps !== null && names.every((found) => run.names.has(found)) && !steps.some(adds)) return;
  run.sources.push(source);
  run.ids.add(source.id);
  for (const found of names) run.names.add(found);
  for (const step of steps ?? []) if ("id" in step) run.ids.add(step.id);
}

/** A source of a listing at a rest: its key there and that key's identity, charged as the search charges them. */
function sourceAt(pass: CorePass, sub: Key, rest: readonly string[]): Source {
  const key = keptKeyBelowIn(pass.contract, sub, rest);
  return Retained.record<Source>("Listing.source", {
    key,
    id: taskId(pass.program.work, { key }),
    prepaid: true,
  });
}

/** A listing made from all of its sources in `subSources`' order: each classified, the last first. */
function wholeListing(
  pass: CorePass,
  memo: ListingMemo,
  subs: readonly Key[],
  rest: readonly string[],
  take: Take,
): Listing {
  const run = Retained.record<Run>("Listing.run", {
    sources: Retained.array("Listing.run.sources"),
    names: Retained.set("Listing.run.names"),
    ids: Retained.set("Listing.run.ids"),
    classified: Retained.set("Listing.run.classified"),
    owner: null,
  });
  for (let at = subs.length - 1; at >= 0; at -= 1) classify(pass, memo, run, subs[at]!, rest, take);
  const listing = { run, length: run.sources.length };
  run.owner = listing;
  return listing;
}

/** A layer's listing alone (`subSources` of stores holding it only), made whole. */
function layerWhole(
  pass: CorePass,
  memo: ListingMemo,
  layer: SubLayer,
  rest: readonly string[],
  take: Take,
): Listing {
  const alone: PrefixStores = {
    list: [],
    subs: layer,
    other: false,
    inheritedBy: new Set(),
    also: [],
    cut: false,
  };
  return wholeListing(pass, memo, pass.contract.subSources(alone), rest, take);
}

/**
 * A layer's listing at a rest, composed from its parent's: `subSources` lists a layer's own sources, then its parent's
 * listing, so the search takes up the parent's first and the layer's own after them, the last first. The run of the
 * parent's listing is extended in place where that listing was the run's last and the layer lists none of its sources
 * (else `subSources` would list such a source among the layer's own); a layer with joins, or one whose parent's run went
 * on without it, is made whole. Made from the nearest layer with a listing up, on one loop.
 */
function layerListing(
  pass: CorePass,
  memo: ListingMemo,
  layer: SubLayer,
  rest: readonly string[],
  take: Take,
): Listing {
  const chain: SubLayer[] = [];
  let below: Listing | undefined;
  for (let at: SubLayer | null = layer; below === undefined;) {
    if (at === null) {
      below = NO_SOURCES;
      break;
    }
    below = byRest(memo, at, rest, false)?.listing;
    if (below === undefined && at.joins.length > 0)
      below = remember(memo, at, rest, layerWhole(pass, memo, at, rest, take));
    if (below === undefined) {
      chain.push(at);
      at = at.parent;
    }
  }
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const at = chain[index]!;
    const { run } = below;
    // (its own sources in `subSources`' order, each once)
    const own = new Set<Key>();
    for (const [, listed] of at.own) for (const sub of listed) own.add(sub);
    if (
      below === NO_SOURCES ||
      run.owner !== below ||
      run.sources.length !== below.length ||
      [...own].some((sub) => run.classified.has(sub))
    ) {
      below = remember(memo, at, rest, layerWhole(pass, memo, at, rest, take));
      continue;
    }
    const subs = [...own];
    for (let next = subs.length - 1; next >= 0; next -= 1)
      classify(pass, memo, run, subs[next]!, rest, take);
    const listing = { run, length: run.sources.length };
    run.owner = listing;
    below = remember(memo, at, rest, listing);
  }
  return below;
}

/** A stores object's listing at a rest: its single top's (`singleTop`), else made whole from `subSources`. */
export function listingOf(
  pass: CorePass,
  memo: ListingMemo,
  stores: PrefixStores,
  rest: readonly string[],
  take: Take,
): Listing {
  const top = singleTop(pass.program.work, memo, stores);
  if (top === null) return NO_SOURCES;
  if (top !== undefined) return layerListing(pass, memo, top, rest, take);
  return (
    byRest(memo, stores, rest, false)?.listing ??
    remember(
      memo,
      stores,
      rest,
      wholeListing(pass, memo, pass.contract.subSources(stores), rest, take),
    )
  );
}
