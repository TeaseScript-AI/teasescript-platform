import type { PlaceId } from "../graph.js";
import type { CorePass } from "./answers.js";
import {
  isKeyId,
  keyIdPath,
  keptKeyBelowIn,
  keptKeyWalk,
  someStep,
  stepsArray,
  stepsOfId,
  type CanonicalKey,
} from "./contract/key-ids.js";
import {
  keepText,
  keptArray,
  keptParts,
  keptSlice,
  keptSteps,
  type BudgetLimit,
  type WorkLedger,
} from "./budget.js";
import { carried, type Dispatch } from "./carriers.js";
import { heldReference, type Contract, type IndexNode } from "./contract.js";
import type { PrefixStores, SubLayer } from "./contract/model.js";
import { keptPath, recordPath, type Key } from "./definitions.js";
import { dictList } from "./method-categories.js";
import { propertyName } from "./program.js";
import type { Work } from "./solver.js";

/** A task of a property name search (`propertyNames`): a value at a path, a key, or a literal at a path. */
export type PropertyNamesTask =
  | { readonly value: PlaceId; readonly path: readonly string[] }
  | { readonly key: CanonicalKey }
  | { readonly literal: PlaceId; readonly path: readonly string[] };

/**
 * A task the search has taken up (`propertyNames`): its position on the search's chain and how many of its scheduling
 * task's last steps its own path keeps untouched, neither cut, changed nor read by the step between them (#1493's pump
 * bound).
 */
interface Visit {
  readonly at: PlaceId;
  /** Its identity (`taskId`). */
  readonly id: string;
  /** Its kind and place as one number. */
  readonly slot: number;
  readonly path: readonly string[];
  /** The effective sources it was scheduled among and its position there (`listed`), or `null`. */
  readonly listed: Placed | null;
  readonly kept: number;
  /** Its position on the chain, the search's first task's 0. */
  readonly depth: number;
  /** The least `kept` of the last 2, 4, 8, ... visits on the chain down to it, its own included (a sparse table). */
  readonly least: readonly number[];
  /**
   * Its own kind and place's nearest visit above it and the least `kept` on the way down since; the shortest path among
   * it and its place's visits above it.
   */
  readonly same: Visit | null;
  readonly keptSince: number;
  readonly shortestSame: number;
}

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

let recording: NameRecords | null = null;

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

let flatListings = false;

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

/**
 * What a search does at a key task other than its first (#1526 phase C step 4, `propertyNames`' `completed`): takes a
 * completed listing of that key whole (its names, its sources not followed), follows the key as any task, or defers it:
 * its names are another listing's to find, and this search's own names are then incomplete (its caller lists that key
 * first, and searches again).
 */
export type ListedKey = ReadonlySet<string> | "follow" | "defer";

/**
 * A task to take up, the visit that scheduled it, how many of that visit's last steps it keeps untouched, where it was
 * scheduled among a listing's effective sources (`listed`), and, where the listing's classification made them for this
 * take-up, its identity and whether it pumps (`Contribution`).
 */
interface Scheduled {
  readonly task: PropertyNamesTask;
  readonly from: Visit | null;
  readonly kept: number;
  readonly listed?: Placed;
  readonly id?: string;
  readonly pumps?: boolean;
}

/** A task's identity in a search, as it keeps it (`seen`). */
function taskId(work: WorkLedger, task: PropertyNamesTask): string {
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
interface Source {
  readonly key: CanonicalKey;
  readonly id: string;
  prepaid: boolean;
}

/** A key's place (`keyPlace`'s), read from its leading digits without making a text. */
function placeOfKey(key: CanonicalKey): PlaceId {
  let place = 0;
  for (let at = 0; at < key.length; at += 1) {
    const digit = key.charCodeAt(at) - 48;
    if (digit < 0 || digit > 9) break;
    place = place * 10 + digit;
  }
  return place;
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
interface Placed {
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
interface ListingMemo {
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
interface Take {
  readonly seen: ReadonlySet<string>;
  readonly pumps: (place: PlaceId, path: readonly string[], kept: number) => boolean;
  readonly classified: Map<Key, { readonly source: Source; readonly pumps: boolean | null }>;
}

const listingMemos = new WeakMap<Contract, ListingMemo>();

const NO_SOURCES: Listing = {
  run: { sources: [], names: new Set(), ids: new Set(), classified: new Set(), owner: null },
  length: 0,
};

/** The pass's listing memo, made anew once a decision or the work stopped since it was made. */
function listingMemo(pass: CorePass): ListingMemo {
  const { contract } = pass;
  const work = pass.program.work;
  const known = listingMemos.get(contract);
  if (
    known !== undefined &&
    known.stops === contract.stoppedCount &&
    known.stopped === work.stopped
  )
    return known;
  const memo: ListingMemo = {
    stops: contract.stoppedCount,
    stopped: work.stopped,
    listings: new Map(),
    // (a stores object's single top reads the prefix index alone, which no stop changes: kept for the pass once found)
    tops: known?.tops ?? new Map(),
    contributions: new Map(),
  };
  listingMemos.set(contract, memo);
  return memo;
}

/** A key task's names (S3 §1): the steps of the keys below it, each read charged (`keptStepBelow`). */
function keyNames(pass: CorePass, key: CanonicalKey, name: (name: string) => void): void {
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
function keyFollowers(
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
    memo.listings.set(of, (at = { listing: undefined, next: new Map() }));
  }
  for (const step of rest) {
    let next: ByRest | undefined = at.next.get(step);
    if (next === undefined) {
      if (!make) return undefined;
      at.next.set(step, (next = { listing: undefined, next: new Map() }));
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
  byRest(memo, of, rest, true)!.listing = listing;
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
    contribution = {
      place: walk.place,
      path: stepsArray(walk.path),
      names,
      steps: null,
      walked: true,
      named: true,
      followed: false,
    };
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
  return { key, id: taskId(pass.program.work, { key }), prepaid: true };
}

/** A listing made from all of its sources in `subSources`' order: each classified, the last first. */
function wholeListing(
  pass: CorePass,
  memo: ListingMemo,
  subs: readonly Key[],
  rest: readonly string[],
  take: Take,
): Listing {
  const run: Run = {
    sources: [],
    names: new Set(),
    ids: new Set(),
    classified: new Set(),
    owner: null,
  };
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
function listingOf(
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

/**
 * The names of a value's known properties (S3 §1): those the keys below its sources store, and those the objects of
 * its literals and of the values its collections' adds insert have at its path. One worklist of sources, each once: a value read further at a path is followed
 * through its projections and the operations that pass a value on (the value side's transfers) to a copied key, a
 * call's result key or a literal; a key to its prefixes' stores and their sources' own stores; a literal to the
 * reads and calls standing at its path or above it. Each task it schedules, each prefix it visits and each key below a
 * key whose step it reads is charged, and every key, path, step and identity it keeps, through the kept helpers: no
 * key's text is split uncharged to read its steps (`keptStepBelow`, `keptPath`).
 *
 * #1493, the pump bound: each task has the task that scheduled it (`from`) and records how many of that one's last steps
 * its path keeps untouched (`kept`): a key's step at a stored prefix keeps the rest below it (an add's one step less), a
 * literal's at a depth the rest below that depth, a carrier's all but the two steps it reads, and a record path the
 * steps it leaves unchanged. A task pumps an earlier one on its chain where both are of one kind and place, its path is
 * longer, and it starts with that one's head: that one's path without the last steps no task between them touched (the
 * least `kept` on the way). Its own names are taken; its sources are not followed. Since every step reads and cuts a
 * bounded front of its path and pushes a bounded head, a chain of tasks that never ends holds such a pair, and from it
 * the same steps repeat forever, each turn longer (a feedback copy `w = r.z`: `w|`, `w|z`, `w|z.z`, ...); a search that
 * ends without the bound meets none, so its names are as before, whatever the answer at a key is, stopped or not. The
 * check walks only the new task's own kind and place's visits above it, one charge per visit, until none with a shorter
 * path is left, and compares heads only with those, one charge per step of the head. The worklist is a stack, so a
 * task's chain is the current depth-first path, its scheduling visit last (checked at each task taken up): the search
 * keeps that path, each kind and place's positions on it, and on each visit the least `kept` of the last 2, 4, 8, ...
 * visits down to it, so a visit finds its place's nearest visit above it and the least `kept` since in two reads. Each
 * visit is added once, removed at most once and makes at most ⌈log₂ D⌉ such entries on a chain of D visits, each
 * charged. The check's total: at most the new tasks times (2 + ⌈log₂ D⌉), plus their place's earlier tasks walked, plus
 * head steps each no longer than the earlier task's path.
 *
 * #1610, the listings: a stored prefix lists its sources' own stores (`subSources`, every layer below it), and in a chain
 * of copies each source's own prefix lists those below it again, so a stack of k copies cost its i-th decided object i
 * sources and each of those its own again (k³ over the stack). The rule, stated here alone, in three conditions:
 * (i) a listing schedules only its effective sources: those `subSources` lists that, taken up in the search's order (the
 * last first), add a name of their keys below, a task, or a listing that no source before them did; any other source is
 * a no-op there on the flat listing, its names already present and everything it schedules taken up by an earlier
 * sibling, whose subtree ends first. A source scheduled among a run's effective sources whose own listing is a prefix of
 * that run, no longer than its position there, schedules nothing: those sources were taken up before it. (ii) Where an
 * effective source could pump (a visit of its place's key on the chain has a path shorter than the rest, the pump
 * check's own entry) or is on the chain, the listing schedules every source, as before. (iii) A layer's or stores
 * object's effective sources at a rest are made from the definitions and the prefix index, a layer's from its parent's
 * (`layerListing`), each source as the flat search takes it up below the listing visit (`classify`): one this search
 * took up already, or whose take-up there pumps, is kept as effective with its followers unmade, so the names the
 * listings give are one whichever question makes them; they are forgotten once a decision or the work stopped
 * (`listingMemo`). In a demand's work, charges move, never add: a classification charges each source as the flat search
 * charges its take-up at that listing (its key and identity, its walk, its pump check and names, and its listings and
 * tasks only where it follows), and the visit that takes it up there, or the first later, takes those parts in place of
 * making them again (`Contribution`); an effective source is charged as a scheduled task. The analysis alone carries
 * one charge more: a stores object's single top, a charge per jump, a shared build no demand's allowance counts
 * (`singleTop`); a completed one is kept for the pass, and a walk the work stop interrupts may be walked again as
 * finishing work. A decided object's names then cost its own prefixes' stores and its effective sources: for a stack
 * of diamonds, one.
 */
export function propertyNames(
  pass: CorePass,
  run: <T>(work: Work<T>) => T,
  start: PropertyNamesTask,
  /** Each object of a literal the value holds, with its names in the literal's order (a first property's question). */
  objects?: (literal: PlaceId, names: ReadonlySet<string>) => void,
  /**
   * #1526 phase C step 4: at each key task but the first, a completed listing of that key to take, or whether to follow
   * or defer it (`ListedKey`); without it every key is followed. A key's listing holds every name its tasks reach, so
   * taking it gives the names following it would (the pump bound cuts only a chain that never ends).
   */
  completed?: (key: CanonicalKey) => ListedKey,
): ReadonlySet<string> {
  const { program, contract } = pass;
  const work = program.work;
  const names = new Set<string>();
  const pending: Scheduled[] = [{ task: start, from: null, kept: 0 }];
  const seen = new Set<string>();
  // (the current depth-first path, the search's first visit first, and each kind and place's positions on it)
  const chain: Visit[] = [];
  const positions = new Map<number, number[]>();
  /** The least `kept` of the visits at positions `low` to `high` on the chain, from two of their sparse entries. */
  const leastKept = (low: number, high: number): number => {
    const level = 31 - Math.clz32(high - low + 1);
    const at = (position: number): number =>
      level === 0 ? chain[position]!.kept : chain[position]!.least[level - 1]!;
    return Math.min(at(high), at(low + 2 ** level - 1));
  };
  // (the identities of the visits on the chain)
  const onChain = new Set<string>();
  const checksBefore = recording === null ? 0 : (work.counts().get("checks") ?? 0);
  const unitsBefore = recording === null ? 0 : work.total + work.finishing;
  const ownBefore = recording === null ? 0 : work.own;
  // (the pass's listings, none where every listing schedules all its sources)
  const listings = (): ListingMemo | null => (flatListings ? null : listingMemo(pass));
  /**
   * A stored prefix's listing of its sources at a rest, by the rule above (#1610): nothing for a source's listing that is
   * a prefix of the run it was scheduled from, no longer than its position there; else the effective sources where none
   * can pump and none is on the chain; else every source. A source the listing classified here is taken up with the
   * identity and the pump check its classification made for that take-up.
   */
  const listed = (stores: PrefixStores, rest: readonly string[], visit: Visit): void => {
    const memo = listings();
    const take: Take = {
      seen,
      pumps: (place, path, kept) => {
        const { same, keptSince } = placeAbove(place * 3, chain.length, kept);
        return pumps(path, same, keptSince);
      },
      classified: new Map(),
    };
    if (memo !== null) {
      const listing = listingOf(pass, memo, stores, rest, take);
      const placed = visit.listed;
      if (
        placed !== null &&
        (listing.length === 0 || listing.run === placed.run) &&
        listing.length <= placed.at
      ) {
        if (recording !== null) recording.skipped += 1;
        return;
      }
      const { sources } = listing.run;
      const told = new Map<string, boolean | null>();
      for (const { source, pumps: verdict } of take.classified.values())
        told.set(source.id, verdict);
      let safe = true;
      for (let at = 0; safe && at < listing.length; at += 1) {
        const source = sources[at]!;
        const verdict = told.get(source.id);
        if (onChain.has(source.id)) {
          safe = false;
          if (recording !== null) recording.cycled += 1;
        } else if (verdict === true || (verdict === undefined && mayPump(source, rest))) {
          safe = false;
          if (recording !== null) recording.pumpable += 1;
        }
      }
      if (safe) {
        // (pushed the last first, so the search takes them up in the run's order)
        for (let at = listing.length - 1; at >= 0; at -= 1) {
          const source = sources[at]!;
          const verdict = told.get(source.id);
          pending.push({
            task: { key: source.key },
            from: visit,
            kept: rest.length,
            listed: { run: listing.run, at },
            ...(source.prepaid ? { id: source.id } : {}),
            ...(verdict === true || verdict === false ? { pumps: verdict } : {}),
          });
          source.prepaid = false;
        }
        if (recording !== null) recording.replayed += listing.length;
        return;
      }
    }
    if (recording !== null) recording.flat += 1;
    for (const sub of contract.subSources(stores)) {
      const made = take.classified.get(sub);
      if (made === undefined)
        pending.push({
          task: { key: keptKeyBelowIn(contract, sub, rest) },
          from: visit,
          kept: rest.length,
        });
      else {
        pending.push({
          task: { key: made.source.key },
          from: visit,
          kept: rest.length,
          ...(made.source.prepaid ? { id: made.source.id } : {}),
          ...(made.pumps === null ? {} : { pumps: made.pumps }),
        });
        made.source.prepaid = false;
      }
    }
  };
  /**
   * Whether an effective source a listing did not classify here could pump below the listing visit: the pump check's own
   * entry, its place's shortest visit on the chain shorter than its path.
   */
  const mayPump = (source: Source, rest: readonly string[]): boolean => {
    const own = positions.get(placeOfKey(source.key) * 3);
    return (
      own !== undefined && own.length > 0 && chain[own[own.length - 1]!]!.shortestSame < rest.length
    );
  };
  /**
   * A task's kind and place's nearest visit above a visit of it at `position` on the chain, and the least `kept` on the
   * way down since (the pump check's view of it, `pumps`).
   */
  const placeAbove = (
    slot: number,
    position: number,
    kept: number,
  ): { readonly same: Visit | null; readonly keptSince: number } => {
    const own = positions.get(slot);
    const nearest = own === undefined || own.length === 0 ? null : own[own.length - 1]!;
    return {
      same: nearest === null ? null : chain[nearest]!,
      keptSince:
        nearest === null
          ? Number.POSITIVE_INFINITY
          : nearest + 1 === position
            ? kept
            : Math.min(kept, leastKept(nearest + 1, position - 1)),
    };
  };
  const dispatch: Dispatch = {
    kinds: (of) => new Set(run(contract.contractOfValue(of)).map((item) => item.tag)),
    reference: (receiver) => heldReference(run(contract.valueReceiver(receiver))),
    joined: (operand) => pass.lists.joined(operand),
  };
  /**
   * Whether a visit at `path` pumps one before it (its kind and place's nearest visit above it, `same`, and the least
   * `kept` since, `placeAbove`): the same kind and place, a longer path, that one's head before its untouched tail. Only
   * its place's visits above it are walked, through `same`, until none with a shorter path is left. The flat search's
   * one check, at a visit and at a listing's classification of a source taken up below it.
   */
  const pumps = (path: readonly string[], same: Visit | null, keptSince: number): boolean => {
    let tail = keptSince;
    let depth = 0;
    for (let above = same; above !== null && above.shortestSame < path.length; above = above.same) {
      work.charge("checks");
      if (recording !== null) {
        recording.ancestors += 1;
        recording.depth = Math.max(recording.depth, (depth += 1));
      }
      if (path.length > above.path.length) {
        const head = above.path.length - Math.min(tail, above.path.length);
        work.charge("checks", head);
        if (recording !== null) recording.heads += head;
        let alike = true;
        for (let index = 0; index < head && alike; index += 1)
          alike = path[index] === above.path[index];
        if (alike) return true;
      }
      tail = Math.min(tail, above.keptSince);
    }
    return false;
  };
  /** A path's record steps (`recordPath`), and how many of its last steps they keep unchanged. */
  const recorded = (
    path: readonly string[],
  ): { readonly path: readonly string[]; readonly kept: number } => {
    const record = recordPath(path);
    if (record === path) return { path, kept: path.length };
    let kept = 0;
    while (kept < path.length && path[path.length - 1 - kept] === record[record.length - 1 - kept])
      kept += 1;
    return { path: record, kept };
  };
  while (pending.length > 0) {
    const { task, from, kept, listed: placed, id: made, pumps: told } = pending.pop()!;
    const id = made ?? taskId(work, task);
    // (each task it schedules, a seen one too, whose identity it made)
    work.charge("checks");
    if (recording !== null) recording.tasks += 1;
    if (seen.has(id)) continue;
    seen.add(id);
    if ("key" in task && from !== null && completed !== undefined) {
      const known = completed(task.key);
      if (known !== "follow") {
        if (known !== "defer") {
          // (each name taken, charged: the listing's output)
          work.charge("checks", known.size);
          for (const name of known) names.add(name);
        }
        continue;
      }
    }
    // (a key's path and place through its walk, `keptKeyWalk`: a text's kept, a cursor's steps through the charged
    // boundary and copied out once, G3 stage 1)
    // (or the parts of its step a listing's classification made, each taken once in place of its own: `Contribution`)
    const prepaid = "key" in task ? (listings()?.contributions.get(id) ?? null) : null;
    const walked = prepaid?.walked === true;
    if (walked) prepaid!.walked = false;
    const walk = "key" in task && !walked ? keptKeyWalk(contract, task.key) : null;
    const taken: readonly string[] = walked
      ? prepaid!.path
      : "key" in task
        ? stepsArray(walk!.path)
        : task.path;
    const at = walked
      ? prepaid!.place
      : "key" in task
        ? walk!.place
        : "literal" in task
          ? task.literal
          : task.value;
    const slot = at * 3 + ("key" in task ? 0 : "literal" in task ? 2 : 1);
    // (the chain back to the scheduling visit, each visit below it removed once, charged)
    // EVIDENCE: invariant: the worklist is a stack, so the visit that scheduled a task is on the current path.
    if (from === null ? chain.length > 0 : chain[from.depth] !== from)
      throw new Error(
        "A property-name task's scheduling visit is not on the search's current path.",
      );
    const position = from === null ? 0 : from.depth + 1;
    while (chain.length > position) {
      const left = chain.pop()!;
      positions.get(left.slot)!.pop();
      onChain.delete(left.id);
      work.charge("checks");
      if (recording !== null) recording.entries += 1;
    }
    const { same, keptSince } = placeAbove(slot, position, kept);
    // (the visit added, charged, with its sparse entries: the least `kept` of the last 2, 4, 8, ... visits, each charged)
    const least: number[] = [];
    for (let level = 1; 2 ** level <= position + 1; level += 1) {
      const below = chain[position - 2 ** (level - 1)]!;
      least.push(
        Math.min(
          level === 1 ? kept : least[level - 2]!,
          level === 1 ? below.kept : below.least[level - 2]!,
        ),
      );
    }
    work.charge("checks", 1 + least.length);
    if (recording !== null) recording.entries += 1 + least.length;
    const visit: Visit = {
      at,
      id,
      slot,
      path: taken,
      listed: placed ?? null,
      kept,
      depth: position,
      least,
      same,
      keptSince,
      shortestSame: Math.min(taken.length, same?.shortestSame ?? taken.length),
    };
    chain.push(visit);
    onChain.add(id);
    let own = positions.get(slot);
    if (own === undefined) positions.set(slot, (own = []));
    own.push(position);
    if (recording !== null) recording.chain = Math.max(recording.chain, chain.length);
    if (recording !== null) recording.longest = Math.max(recording.longest, visit.path.length);
    // (a pumped task's own names are taken, its sources not followed; the check made for it by a listing's classification
    // below the same visit, where it made one)
    const follows = !(told ?? pumps(visit.path, visit.same, visit.keptSince));
    if (!follows && recording !== null) recording.pumped += 1;
    const schedule = (next: PropertyNamesTask, untouched: number): void => {
      if (follows) pending.push({ task: next, from: visit, kept: Math.max(0, untouched) });
    };
    if ("value" in task) {
      const { path } = task;
      const at = task.value;
      const source = contract.copiedKey(at) ?? contract.resultKey(at);
      // through a dict's `values` the projections are followed (a dict's values are its elements)
      // (a choice's selected value is read as its record's `value` or `text`, as the literal's records say: V30 §19)
      // (a cursor's path holds no dict's list where it holds no built-in member: the arena's, G3 stage 1)
      if (
        source !== null &&
        !(isKeyId(source)
          ? contract.pathMembers[keyIdPath(source)] !== 0 &&
            someStep(stepsOfId(contract, source), (step) => dictList(step) !== undefined)
          : keptPath(work, source).some((step) => dictList(step) !== undefined))
      ) {
        const record = recorded(path);
        schedule({ key: keptKeyBelowIn(contract, source, record.path) }, record.kept);
        continue;
      }
      if (program.hasOf.has(at)) {
        const record = recorded(path);
        schedule({ literal: at, path: keptArray(work, record.path) }, record.kept);
        continue;
      }
      // the carrier table's operands, after the value side's decisions (`carriers.ts`: F12, F27, F17b, C10, F10, F7,
      // a list's `+`, V30 §19's choice; nothing through an operation that keeps its own value, F19a)
      // (a carrier reads its path's first two steps at most, and keeps the rest)
      if (follows)
        for (const [operand, rest] of carried(program, at, path, dispatch))
          schedule({ value: operand, path: keptArray(work, rest) }, path.length - 2);
      continue;
    }
    if ("literal" in task) {
      // (the literal's index node at each prefix of the path, until one it holds none at)
      const nodes: IndexNode[] = [contract.literalIndex(task.literal).root];
      for (const step of task.path) {
        const below = nodes.at(-1)!.children.get(step);
        if (below === undefined) break;
        nodes.push(below);
      }
      for (const object of nodes.length > task.path.length
        ? (nodes.at(-1)!.objects?.list ?? [])
        : []) {
        objects?.(task.literal, object.names);
        for (const name of object.names) names.add(propertyName(name));
      }
      // the reads and calls standing at the path or above it, followed at the rest of the path (`standsAlong`)
      if (follows)
        for (const kind of ["reads", "others"] as const)
          for (const { depth, entries } of contract.standsAlong(task.literal, task.path, kind))
            for (const entry of entries)
              schedule(
                { value: entry.value, path: keptSlice(work, task.path, depth) },
                task.path.length - depth,
              );
      continue;
    }
    // (its names, and where it follows its listings and tasks: a part a listing's classification made is taken once in
    // place of its own)
    if (prepaid?.named === true) {
      prepaid.named = false;
      for (const found of prepaid.names) names.add(found);
    } else keyNames(pass, task.key, (found) => names.add(found));
    if (!follows) continue;
    if (prepaid?.followed === true && prepaid.steps !== null) {
      prepaid.followed = false;
      for (const step of prepaid.steps)
        if ("id" in step)
          pending.push({
            task: step.task,
            from: visit,
            kept: Math.max(0, step.untouched),
            id: step.id,
          });
        else listed(step.stores, step.rest, visit);
    } else
      keyFollowers(pass, visit.at, visit.path, {
        listing: (stores, rest) => listed(stores, rest, visit),
        task: schedule,
      });
  }
  if (recording !== null) {
    recording.checks += (work.counts().get("checks") ?? 0) - checksBefore;
    recording.units += work.total + work.finishing - unitsBefore;
    recording.own += work.own - ownBefore;
  }
  return names;
}
