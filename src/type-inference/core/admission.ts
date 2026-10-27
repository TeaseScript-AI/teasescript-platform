import { unwrap } from "../../expression-children.js";
import type { PlaceId, SourceSite, TypeTerm } from "../graph.js";
import type { CorePass } from "./answers.js";
import {
  joinParts,
  joinSteps,
  keepText,
  keptParts,
  keptSplit,
  keptSlice,
  keptSteps,
  keptText,
  pathText,
  splitPath,
  stepText,
  type WorkLedger,
} from "./budget.js";
import { carried, keepsOwn, operandsOf, type CarrierRole, type Dispatch } from "./carriers.js";
import { defaultOf, heldReference, termAt, typeTags, writtenOf } from "./contract.js";
import {
  keptKey,
  keptKeyBelow,
  keptPath,
  keptPathText,
  keptPrefixes,
  keyBelow,
  keyOf,
  keyPath,
  keyPlace,
  prefixesOf,
  recordKey,
  SELECTED_TEXT,
  SELECTED_VALUE,
  sortCost,
  type Definition,
  type Key,
} from "./definitions.js";
import { withoutEmpty } from "./exact-path.js";
import type { Callable, FlowNode } from "./flow-graph.js";
import { marked } from "./guards.js";
import {
  ingressLeaves,
  REASON,
  writerKey,
  type IngressNode,
  type Item,
  type ItemTag,
  type Writer,
} from "./items.js";
import { conversionCategory, dictList, measuresLength } from "./method-categories.js";
import { propertyStep, stepName } from "./program.js";
import { elementStep, type Obligation, type RequiredKind } from "./result.js";
import { sharing } from "./sharing.js";
import type { Work } from "./solver.js";
import { getProof } from "./values.js";

/*
 * Admission (checkpoint 9, TABLE §5) and the boundary checks of external data (C9). A place's type is decided once,
 * in source order, at a destination store, from the value that store transfers at its own node (§3): a written type
 * decides (A1, A9); a copy of a written binding is decided by its type (A4); otherwise the earliest definite
 * contribution in source order (A2), where a settled family needs no scan (A3); the candidates a decided type is checked
 * against are the direct stores and the whole stores of a prefix whose source holds an offending kind (A5). A definite
 * contribution that does not fit is an error at the store, which is rejected: its rejection takes effect in the next
 * pass, and the passes repeat until the rejected set is stable (A6, `analyseCore`). The consumers check each candidate
 * against the decided type (C1); here: the decision, the rejections, a literal's elements of one type (A8, ADR 1.3) and
 * where each boundary check of external data stands (C9: one per ingress store at its ingress expression, against the
 * destination's own admitted type; host data no store brought is checked at the consumer that reads it).
 */

/** The plain scalar kinds: an inferred root whose every store is of one family of them asks nothing. */
const SCALAR: ReadonlySet<ItemTag> = new Set(["integer", "number", "string", "boolean"]);
const NUMERIC: ReadonlySet<ItemTag> = new Set(["integer", "number"]);

/** The kinds that fit a destination of kind `ref` (C1, ADR 1.2): a whole number a number; an unknown anything. */
export function fits(tag: ItemTag, ref: ItemTag, written: boolean): boolean {
  return (
    tag === ref ||
    (tag === "integer" && ref === "number") ||
    (!written && tag === "number" && ref === "integer") ||
    tag === "unknown" ||
    // (an unrestricted destination, a written `list`'s element: every kind fits, V30 §13)
    ref === "unknown"
  );
}

/** A copy of a place that may inherit a written type (`#inheriting`): where it lands, and the path into the place. */
interface InheritedCopy {
  readonly place: PlaceId;
  readonly path: readonly string[];
  readonly from: PlaceId;
  readonly strip: readonly string[];
}

/**
 * A4 through copies' landings (`groups`, r4.75 (1)): where copies of written types land in each place, and the copies of
 * inheriting places each place takes; a place's landed paths are its own, its copies' own paths and below them its
 * copies' sources' landed paths below their strips, asked of those sources, never made per copy (TABLE r4.80). A cycle
 * of copies has its members' landed paths made once, as the landing within it brings them.
 */
interface Inheritance {
  /** Per place, the paths copies of written types land at in it (their elements too), with each type at the path. */
  readonly seeds: ReadonlyMap<PlaceId, ReadonlyMap<string, ReadonlySet<TypeTerm>>>;
  /** Per place, the copies of inheriting places that land in it, each distinct one once. */
  readonly into: ReadonlyMap<PlaceId, readonly InheritedCopy[]>;
  /** Per place, the paths its copies land at (their own paths), each once (`#landed`). */
  readonly owned: ReadonlyMap<PlaceId, ReadonlySet<string>>;
  /** The places in a cycle of copies, by cycle (`cyclesOf`). */
  readonly cycleOf: ReadonlyMap<PlaceId, number>;
  /** Per member of a cycle of copies, its landed paths. */
  readonly cycles: ReadonlyMap<PlaceId, ReadonlySet<string>>;
  /**
   * Per member of a cycle of whole copies with no written type of its own that whole copies of one place outside it
   * feed, that place: the member lands that place's paths and its own root, asked of it (`#copiesOf`).
   */
  readonly fed: ReadonlyMap<PlaceId, PlaceId>;
  /** The places copies join, each one's sources' before its own (`cyclesOf`). */
  readonly order: readonly (readonly PlaceId[])[];
}

/**
 * The copies a place answers through (`#passThrough`): each place whose only store at its root is one whole copy of an
 * unwritten inheriting place, by that place (its parent), with the keys below its root it stores at, which stop it
 * answering as its parent there; each tree of them in depth-first order (entry and last entry below), and per key the
 * places storing at it (`Storing`).
 */
interface CopyForest {
  readonly parent: ReadonlyMap<PlaceId, PlaceId>;
  readonly stores: ReadonlyMap<PlaceId, ReadonlySet<string>>;
  readonly top: ReadonlyMap<PlaceId, PlaceId>;
  readonly depth: ReadonlyMap<PlaceId, number>;
  readonly entry: ReadonlyMap<PlaceId, number>;
  readonly exit: ReadonlyMap<PlaceId, number>;
  readonly storing: ReadonlyMap<string, Storing>;
  /** Per key, the places storing at it or below it (`#landedBelow`). */
  readonly beneath: ReadonlyMap<string, Storing>;
}

/**
 * A place's contents beside its landings (`#looseOf`): the paths of its own stores' literals and other values, each with
 * what lies below it for the latter, and its copies' sources' such contents, each where the copy lands it.
 */
interface Loose {
  readonly points: readonly (readonly string[])[];
  readonly below: readonly (readonly string[])[];
  readonly from: readonly { readonly copy: InheritedCopy; readonly loose: Loose }[];
}

const NO_LOOSE: Loose = { points: [], below: [], from: [] };

/**
 * A place's own contributions besides its copies of inheriting places (`#ownStructure`): its literals' and constants'
 * paths, other values' paths with what lies below them, and its reads of other places' keys (a copy of a place that
 * inherits nothing, a call's result) with where each stands.
 */
interface OwnStructure {
  readonly points: readonly (readonly string[])[];
  readonly below: readonly (readonly string[])[];
  readonly reads: readonly { readonly at: readonly string[]; readonly source: Key }[];
}

/**
 * What a place holds at and below a path (`#identity`, TABLE r4.86 (2)): the place and path whose landings and contents
 * these are, beside the own contributions of the places stepped through on the way (`locals`, at rests below the path).
 */
interface Identity {
  readonly root: PlaceId;
  readonly strip: readonly string[];
  readonly locals: Locals | null;
}

/** One stepped-through place's own contributions below the asked path, then the rest of the way's (`Identity`). */
interface Locals {
  /** Literals and constants: another kind may stand there. */
  readonly points: readonly (readonly string[])[];
  /** Any other value, and what lies below it. */
  readonly below: readonly (readonly string[])[];
  readonly next: Locals | null;
}

/** A place's copies of one identity at one path, with the locals of their ways (`#meeting`). */
interface Group {
  readonly root: PlaceId;
  readonly strip: readonly string[];
  readonly path: readonly string[];
  readonly locals: Set<Locals>;
}

/** A place's read of another place's key, by what that key holds (`#meeting`). */
interface Held {
  readonly root: PlaceId;
  readonly strip: readonly string[];
  readonly at: readonly string[];
  readonly locals: Locals | null;
}

/** A configuration of a place's groups in `#meeting`'s order: a node of their prefix trie. */
interface Configuration {
  readonly id: number;
  readonly next: Map<string, Configuration>;
  /** What its last group adds to the meeting of the groups before it (`#joined`). */
  readonly added: readonly (readonly string[])[];
  /** Per read identity and path, what the read meets of these groups (`#readMeets`). */
  readonly reads: Map<string, readonly (readonly string[])[]>;
}

/** The groups of one `#meeting` call: those it listed, by their landings and contents, and those it asks. */
interface Running {
  readonly lands: Map<string, { readonly path: readonly string[]; readonly groups: Group[] }>;
  /** The listed landings' texts by every prefix's text. */
  readonly under: Map<string, string[]>;
  /** The listed groups' contents beside their landings: points, and prefixes they may hold anything below. */
  readonly points: Map<string, Group[]>;
  readonly below: Map<string, Group[]>;
  /** The groups asked: the widest, and those a known configuration served (a prefix of the call's order). */
  readonly served: Group[];
  readonly loose: ReadonlyMap<PlaceId, Loose>;
  /** Per path the call tested its groups at (`#tested`), what it has accounted there. */
  readonly accounts: Map<string, Account>;
}

/**
 * What `#tested` has accounted at one path: the listed landers and holders taken so far (by their lists' lengths), the
 * terms and contents found, by what they admit, and whether they may not meet.
 */
interface Account {
  landers: number;
  points: number;
  readonly below: number[];
  readonly contented: Set<Group>;
  readonly terms: Map<string, TypeTerm | null>;
  readonly contents: Map<string, readonly Item[]>;
  met: boolean;
}

/** A root's contents beside its landings below a strip, as rests from it (`#flatLoose`). */
interface FlatLoose {
  readonly points: (readonly string[])[];
  readonly below: (readonly string[])[];
  readonly pointTexts: Set<string>;
  readonly belowTexts: Set<string>;
}

/** A locals chain's paths where a configuration's groups land, kept only where a node adds one (`#localsMeet`). */
interface LocalsMet {
  readonly paths: readonly (readonly string[])[];
  readonly next: LocalsMet | null;
}

const NO_LOCALS_MET: LocalsMet = { paths: [], next: null };

/** Places of a copy forest by entry, with the greatest last entry below over each range (a max segment tree). */
interface Storing {
  readonly places: readonly PlaceId[];
  readonly entries: readonly number[];
  readonly exits: readonly number[];
}

/**
 * The last index at or before `last` whose value is at least `least`, in a max segment tree over `size` leaves (`tree`,
 * leaves from `size`), or -1.
 */
function lastAtLeast(tree: readonly number[], size: number, last: number, least: number): number {
  // (the leaves at or before `last`, right to left, each subtree skipped whole where its greatest is too small)
  let node = size + last;
  if (tree[node]! >= least) return last;
  // climb while the node is a left child or its left sibling holds none, then take that sibling's last one
  while (node > 1 && (node % 2 === 0 || tree[node - 1]! < least)) node >>= 1;
  if (node <= 1) return -1;
  node -= 1;
  while (node < size) node = tree[2 * node + 1]! >= least ? 2 * node + 1 : 2 * node;
  return node - size;
}

/** Whether `path` starts with `prefix` (or is it). */
function isPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  return prefix.length <= path.length && prefix.every((step, index) => path[index] === step);
}

/**
 * The cycles of places a graph of copies holds (Tarjan's strongly connected components, with an explicit stack): each
 * place in one, a place copied into itself too, by the cycle's number; and every component of the graph, each place's
 * sources' before its own.
 */
function cyclesOf(
  edges: ReadonlyMap<PlaceId, readonly InheritedCopy[]>,
  work: { charge(counter: "indexSteps", units?: number): void },
): { readonly cycleOf: Map<PlaceId, number>; readonly order: readonly (readonly PlaceId[])[] } {
  const out = new Map<PlaceId, number>();
  // (Tarjan's components come a place's copies' first)
  const components: PlaceId[][] = [];
  const order = new Map<PlaceId, number>();
  const low = new Map<PlaceId, number>();
  const stack: PlaceId[] = [];
  const onStack = new Set<PlaceId>();
  // (each place's copies' places, once: Sol's round 4 B2)
  const adjacency = new Map<PlaceId, readonly PlaceId[]>();
  for (const [place, copies] of edges) {
    work.charge("indexSteps", copies.length);
    adjacency.set(
      place,
      copies.map((copy) => copy.place),
    );
  }
  const next = (place: PlaceId): readonly PlaceId[] => adjacency.get(place) ?? [];
  const enter = (place: PlaceId): void => {
    low.set(place, order.size);
    order.set(place, order.size);
    stack.push(place);
    onStack.add(place);
  };
  for (const start of edges.keys()) {
    if (order.has(start)) continue;
    enter(start);
    const frames: { readonly place: PlaceId; at: number }[] = [{ place: start, at: 0 }];
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const targets = next(frame.place);
      work.charge("indexSteps");
      if (frame.at < targets.length) {
        const target = targets[frame.at]!;
        frame.at += 1;
        if (!order.has(target)) {
          enter(target);
          frames.push({ place: target, at: 0 });
        } else if (onStack.has(target))
          low.set(frame.place, Math.min(low.get(frame.place)!, order.get(target)!));
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined)
        low.set(parent.place, Math.min(low.get(parent.place)!, low.get(frame.place)!));
      if (low.get(frame.place) !== order.get(frame.place)) continue;
      const members: PlaceId[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        members.push(member);
        if (member === frame.place) break;
      }
      work.charge("indexSteps", targets.length);
      if (members.length > 1 || targets.includes(frame.place))
        for (const member of members) out.set(member, frame.place);
      components.push(members);
    }
  }
  return { cycleOf: out, order: components.reverse() };
}

/**
 * A computation that may need an unwritten place's inherited type at a path first (`#inheritedAt`): it yields that place
 * and path's key and is resumed with the type, so a scan that waits on another stops where it stands and goes on from
 * there, never taken again from its start.
 */
type Inheriting<T> = Generator<Key, T, TypeTerm | null>;

/** `#inheritedAt`'s scan of one place and path, suspended while the key it waits on resolves. */
interface Waiting {
  readonly key: Key;
  readonly steps: Inheriting<{
    readonly copied: TypeTerm | null;
    readonly nullable: boolean;
  } | null> | null;
  /** Its cycle of decisions when it stopped (`#cycleOf`): a scan whose cycle grew meanwhile is taken again. */
  cycle: string;
}

/**
 * A copied written type as a place's own decision admits it: with its `null` where the decision is nullable beside the
 * copy (S6-CARRIERS §4.2: a `null` before the written decider, a literal's `null` element), so a copy of the place keeps
 * that too (Astra's F2 on #1049).
 */
function optionalOf(term: TypeTerm | null, nullable: boolean): TypeTerm | null {
  if (term === null || !nullable || typeTags(term).includes("null")) return term;
  return { kind: "union", members: [term, { kind: "atom", name: "null" }] };
}

/** The part below an unrestricted written part: every kind fits it. */
const OPEN: TypeTerm = { kind: "dynamic", why: "unwritten parts" };

/**
 * The written type a path stands under (V30 §13: `list`, `set`, `dict` and `object` stand for any list, set, dict or
 * object): its term, or below an unrestricted part (an unwritten element, an `object`'s properties, an optional's or a
 * union's member's too) a part whose every kind fits; `null` where the written type does not reach the path (the lead's
 * ruling on the merged S6's B2). One step at a time, so a path costs its length.
 */
function permittedAt(term: TypeTerm, path: readonly string[]): TypeTerm | null {
  let at: TypeTerm | null = term;
  for (const step of path) {
    if (at === null || unrestricted(at)) return at;
    at = permittedStep(at, step);
  }
  return at;
}

/** One step of `permittedAt`: a union is unrestricted below where any of its members is, else read as `termAt` reads it. */
function permittedStep(term: TypeTerm, step: string): TypeTerm | null {
  if (term.kind === "union")
    return term.members.some((member) => {
      const below = permittedStep(member, step);
      return below !== null && unrestricted(below);
    })
      ? OPEN
      : termAt(term, [step]);
  if (unrestricted(term) || (term.kind === "object" && term.properties === null)) return OPEN;
  return termAt(term, [step]);
}

/** Whether a written part restricts nothing (`typeTags`' `unknown`: an unwritten element, a type the core leaves open). */
function unrestricted(term: TypeTerm): boolean {
  return typeTags(term).includes("unknown");
}

export const concrete = (item: Item): boolean =>
  item.tag !== "null" && item.tag !== "unknown" && item.tag !== "empty";
export const isOpaque = (item: Item): boolean =>
  item.tag === "unknown" && (item.reasons & (REASON.opaque | REASON.missing | REASON.budget)) !== 0;
export const isExternal = (item: Item): boolean =>
  item.tag === "unknown" && (item.reasons & REASON.external) !== 0;
/** A value a store contributes to a place: an opaque or external unknown, never a source's missing field. */
export const contributes = (item: Item): boolean =>
  (isOpaque(item) || isExternal(item)) && item.reasons !== REASON.missing;
/** The items that decide (A2): definite, of a kind. */
export const deciding = (items: readonly Item[]): Item[] =>
  items.filter((item) => item.cert === "def" && concrete(item));

/** One family (A3): one kind, or whole numbers with numbers, with or without `null`. */
function family(tags: readonly ItemTag[]): boolean {
  const kinds = tags.filter((tag) => tag !== "null");
  return kinds.length > 0 && (new Set(kinds).size === 1 || kinds.every((tag) => NUMERIC.has(tag)));
}

/** A number the place admits: one an internal contribution gives, never one possible solely through external data. */
const admitsNumber = (item: Item): boolean => item.tag === "number" && item.extOnly !== true;

/**
 * An evaluation key (S6-CARRIERS §2): from the stored value down to a stop, each carrier's operand position (its own
 * contribution after all of them, `OWN`) and each literal cell's source position. Keys compare lexicographically, a
 * shorter key before the keys it prefixes.
 */
type EvaluationKey = readonly number[];

/** A carrier's own contribution's position: after every operand it carries (A4: a selected copy precedes it). */
const OWN = Number.MAX_SAFE_INTEGER;

/** The order of two evaluation keys: negative where `a` is evaluated first. */
function compareKeys(a: EvaluationKey, b: EvaluationKey): number {
  for (let index = 0; index < a.length && index < b.length; index += 1)
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  return a.length - b.length;
}

/** The roles of a typed ingress's default (F18). */
const TYPED_ROLES: ReadonlySet<CarrierRole> = new Set([
  "load default/default",
  "parse default/default",
]);

/** The roles whose operation reads a member of its receiver, the member read C1 sits at (TABLE r4.60). */
const RECEIVER_ROLES: ReadonlySet<CarrierRole> = new Set([
  "get/receiver",
  "copy/receiver",
  "removal/receiver",
]);

/** The roles of operations that combine or remove, whose operand brought the kind (TABLE r4.63 (2)). */
const COMBINING_ROLES: ReadonlySet<CarrierRole> = new Set([
  "concatenation/operand",
  "removal/receiver",
]);

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

/**
 * For the tests: while `withoutChains` runs, no chain of copies is resolved (§4.1), so a class is a read's own; the
 * published records, their F28 writers included, are the same either way (the oracle sets a link's writer aside).
 */
let chainsOff = false;

export function withoutChains<T>(callback: () => T): T {
  const before = chainsOff;
  chainsOff = true;
  try {
    return callback();
  } finally {
    chainsOff = before;
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

/** The kinds whose length is built in (F14): a text's, a collection's. */
const MEASURED: ReadonlySet<ItemTag> = new Set(["string", "list", "set", "dict"]);

/** The roles whose operand is its operation's own read (C10: an ingress there is checked at its read). */
const OWN_ROLES: ReadonlySet<CarrierRole> = new Set([
  "otherwise/fallback",
  "get/default",
  "load default/default",
  "parse default/default",
]);

/**
 * A whole store's alias (S6-CARRIERS §4.1): the stable source path its value reads at `at` below it (the value itself,
 * or a literal's one read cell) and the node it is read at, its own guard's key and node whatever its class.
 */
interface Alias {
  readonly source: Key;
  readonly read: FlowNode;
  readonly at: readonly string[];
  /** The read itself: the copy whose binding's written type, A4's, its class keeps (TABLE r4.72, Astra r5 B1). */
  readonly value: PlaceId;
  /** Whether its class is its read's chain's end (§4.1's chains): its items keep their own link's writer. */
  chained?: true;
}

/** A chain of clean copies' end (`#chainEnd`): the read it stands for and that read's path as written. */
interface ChainEnd {
  readonly source: Key;
  readonly read: FlowNode;
  readonly written: string;
}

/** The path below an add's added value for a path below its list (an `addAll`'s value stands for the list's elements). */
function addRest(d: Definition, rest: readonly string[]): readonly string[] {
  return d.how === "elements" ? rest : rest.slice(1);
}

/** The key an alias's read stands for at `rest` below its store; `null` beside or above its cell, where no read is. */
function aliasKeyAt(alias: Alias, rest: readonly string[]): Key | null {
  if (rest.length < alias.at.length || alias.at.some((step, index) => rest[index] !== step))
    return null;
  return keyBelow(alias.source, rest.slice(alias.at.length));
}

/**
 * An ingress stop of a landing's walk (S6-CARRIERS §3.1): the ingress it is or reads through projections, its store,
 * its contribution path and its boundary path (the contribution path up to the first object property step), its
 * evaluation key, the ingress's own span, and whether it is the ingress whole.
 */
interface IngressStop {
  readonly ingress: PlaceId;
  readonly d: Definition;
  readonly path: readonly string[];
  readonly recordPath: readonly string[];
  readonly key: EvaluationKey;
  /** The ingress's own expression, C9's site (r4.29). */
  readonly site: SourceSite;
  /** The stop's own expression (§3.4): the ingress itself where it is whole, a member read of it else. */
  readonly reads: SourceSite;
  /** C1's site for it (`#contributionSite`): the stop's own expression, or what a receiver's operation reads of it. */
  readonly contribution: SourceSite;
  readonly whole: boolean;
}

/**
 * The landing index (S6-CARRIERS §3.2), once per pass: per store, its non-own ingress stops in evaluation order; per
 * ingress, the stores that bring it and whether it is an own read. An ingress neither brought nor own is unreached.
 */
interface LandingIndex {
  readonly byStore: ReadonlyMap<Definition, readonly IngressStop[]>;
  readonly byIngress: ReadonlyMap<PlaceId, Landing>;
}

/** Where an ingress lands: the stores that bring it, whether it is an own read, the typed call whose default it is. */
interface Landing {
  readonly stores: Set<Definition>;
  own: boolean;
  /** A typed `load` or `fromJson` of an inferred place whose default holds the ingress (TABLE r4.63 (3)). */
  call?: PlaceId;
}

/** A contribution of a stored value at one path (`#stopsOf`): its evaluation key, value and node, its written type. */
interface Stop {
  readonly key: EvaluationKey;
  readonly value: PlaceId;
  readonly node: FlowNode;
  /** The path below the stored value it stands at. */
  readonly path: readonly string[];
  /** A copy of a written binding's written type, else `null`. */
  readonly term: TypeTerm | null;
  /**
   * A copy of an unwritten place that may inherit a written type (`#inheriting`): that place, its type at each path the
   * one its own decision copies there (`#inheritedAt`); else `null`.
   */
  readonly from: PlaceId | null;
  /** The path into the value its contribution stands at (a projection's step into its owner, F12). */
  readonly strip: readonly string[];
  /**
   * A value a projection selects: it stands for its fields and elements below the path, while at the path itself the
   * projection's own value, the union of what it may select, contributes (A2: an unknown beside a kind decides nothing).
   */
  readonly deep: boolean;
  /** Whether each literal it was read out of has it alone at the step (`[typed][0]`, never `[typed, 2][0]`). */
  readonly single: boolean;
  /**
   * The operations it was reached through, the outermost first (`get` with its default, a copy of the elements, a
   * list's `+`, ...): its contribution decides only where each of them holds its kinds definitely (F7, F10, F17b).
   */
  readonly via: readonly Via[];
}

/**
 * An operation a decider was reached through: its value, node, position and the path into it, and the operand the walk
 * took (`Stop.via`).
 */
interface Via {
  readonly value: PlaceId;
  readonly node: FlowNode;
  readonly path: readonly string[];
  readonly strip: readonly string[];
  readonly operand: PlaceId;
  /** The operand's role for the carrier (`carriers.ts`), part of a via's signature. */
  readonly role: CarrierRole;
}

/** A stored value's contributions by path (`#stopsOf`): written copies, other whole values, and literals. */
interface Stops {
  readonly written: Map<string, Stop[]>;
  readonly values: Map<string, Stop[]>;
  readonly literals: Map<string, Stop[]>;
}

/** A store's stops at one key (`#keyStops`): the selected ones in evaluation order, its sitings and named data. */
interface KeyStops {
  readonly selected: readonly Stop[];
  /** The selected ones, each snapshot once (`#distinct`). */
  readonly distinct: () => readonly Stop[];
  readonly sitings: () => readonly Siting[];
  /** Of the sitings, the named data's (`ingress` null, no member of host data). */
  readonly namedSitings: () => readonly Siting[];
  readonly named: () => readonly Stop[];
}

/** A store's landing stops by ingress (`#storeIngresses`): held whole, brought as members, each one's first stop. */
interface StoreIngresses {
  readonly inline: ReadonlySet<PlaceId>;
  readonly members: ReadonlySet<PlaceId>;
  /** The index of an ingress's first stop in the store's list (`LandingIndex.byStore`). */
  readonly first: ReadonlyMap<PlaceId, number>;
}

/** A contribution C1 may be sited at (`ingressSiteOf`): the ingress it reads, or `null` for named data sited by itself. */
interface Siting {
  readonly stop: Stop;
  readonly ingress: PlaceId | null;
  /** A member of host data the store reads (r4.60): its own place's C1, no named data's. */
  readonly host?: true;
}

/** The values at one depth of a stored value's path, and the first of them no literal of it holds (`wholeBelow`). */
interface Level {
  readonly values: readonly PlaceId[];
  readonly whole: PlaceId | null;
}

/**
 * The known structure of a stored value or a source key (F2): the paths below it its literals and the stores below the
 * key give, and the source keys copied or called below it, each where it stands; below a source key, its elements only
 * (`#depthOf`).
 */
interface Structure {
  readonly paths: readonly (readonly string[])[];
  readonly sources: readonly { readonly below: readonly string[]; readonly key: Key }[];
}

/** A candidate of a decided type: a store and the path below its destination it reaches the place at. */
export interface Candidate {
  readonly d: Definition;
  readonly at: readonly string[];
  /** The later stores of `d`'s alias class (`#aliasKey`): checked only where `d` owes something (§8, S6-CARRIERS §4.1). */
  readonly members?: readonly Definition[];
}

/** What decides a place (§5): the kinds, by a written type, a written copy's (A4) or the first definite store's. */
export interface Decision {
  readonly root: PlaceId;
  readonly path: readonly string[];
  readonly label: string;
  readonly tags: readonly ItemTag[];
  /** By a written type, at the place or of a copied binding (A4): no number of an integer fits there. */
  readonly written: boolean;
  /** Whether the place's own written type decides (A1), and whether it is a parameter's or a result's (A9, C7). */
  readonly own: boolean;
  readonly nullable: boolean;
  /** The store that decided (A2, A4), `null` for a written type. */
  readonly decider: Definition | null;
  /** The candidates in source order (A5). */
  readonly candidates: readonly Candidate[];
  /**
   * Decided by no contribution, the contract's kinds it is published with (C9 r4.12) beside external data: only the
   * external data another store brought owes its check at each candidate (r4.50 (1)); data a store brings inline has
   * its boundary, an opaque value C5's obligation at its access (A7).
   */
  readonly published: boolean;
}

/** A path's stores: the direct ones and the prefixes whole stores or adds reach (`#inputs`). */
type Inputs = {
  readonly direct: readonly Candidate[];
  readonly prefixes: readonly { readonly key: Key; readonly rest: readonly string[] }[];
};

/** A decision before it is recorded and its candidates taken (`#decided`). */
interface Decided {
  readonly key: Key;
  /** The decided kinds; `null` where nothing is checked; with `unknown` where an unrestricted part decides nothing. */
  readonly tags: readonly ItemTag[] | null;
  readonly nullable: boolean;
  readonly byWritten: boolean;
  /** Whether the place's own written type decides (A1). */
  readonly own: boolean;
  /** A written parameter's or result's (A9, C7). */
  readonly transfer: boolean;
  readonly permitsNull: boolean;
  readonly decider: Definition | null;
  readonly site: SourceSite | null;
  readonly published: boolean;
}

/** A decision's fields where nothing is checked (`#decided`). */
const NOTHING = {
  nullable: true,
  byWritten: false,
  permitsNull: false,
  decider: null,
  site: null,
  published: false,
} as const;

/** Whether items hold one a decision does not admit (A5: an offending kind; a `null` where none is admitted). */
function offending(items: readonly Item[], decision: Decided): boolean {
  const tags = decision.tags ?? [];
  return items.some((item) =>
    item.tag === "null"
      ? !decision.nullable
      : item.tag === "unknown"
        ? contributes(item)
        : item.tag !== "empty" && !tags.some((tag) => fits(item.tag, tag, decision.byWritten)),
  );
}

/**
 * Whether contents may meet a written type at a path whatever stands first there (`#meeting`): each item fits it (a
 * `null` where it admits one, an unknown no external or opaque data), and where the contents' definite kinds decide
 * first (A2), each kind the type admits fits each of them; a written type unrestricted there admits everything, none
 * (`null`) nothing known.
 */
function compatible(items: readonly Item[], term: TypeTerm | null): boolean {
  if (term === null) return false;
  const tags = typeTags(term);
  if (tags.includes("unknown")) return true;
  const kinds = tags.filter((tag) => tag !== "null");
  const decides = new Set<ItemTag>();
  for (const item of items) {
    if (item.tag === "null") {
      if (!tags.includes("null")) return false;
    } else if (item.tag === "unknown") {
      if (contributes(item)) return false;
    } else if (item.tag !== "empty") {
      if (!kinds.some((kind) => fits(item.tag, kind, true))) return false;
      if (item.cert === "def") decides.add(item.tag);
    }
  }
  for (const kind of kinds) for (const tag of decides) if (!fits(kind, tag, false)) return false;
  return true;
}

/** What admission asks of the consumers it runs beside: their solver runs, with each read's accounting. */
export interface AdmissionHost {
  run<T>(work: Work<T>): T;
}

export class Admission {
  /** The decider's kinds per key (§5). */
  readonly decided = new Map<Key, readonly ItemTag[]>();
  /** The stores rejected in this pass, by their definitions' order, with the places and paths they are rejected at (A6). */
  readonly newlyRejected = new Map<number, Set<Key>>();
  /** The boundary checks of the ingress stores, by the key each enters (C9), published after the consumers ran. */
  readonly boundaries = new Map<Key, Obligation[]>();
  /** The boundary checks no store into a place owes: host data read where it is consumed, an ingress read (C9, F18). */
  readonly readChecks: Obligation[] = [];
  readonly #rejectedKeys = new Set<Key>();
  /** The previous pass's rejected stores by the place and path each was rejected at (A6). */
  readonly #retaken = new Map<Key, Definition[]>();
  readonly #a4Keys = new Set<Key>();
  /** The parameters with a default (ADR 0021 1.5). */
  readonly #defaulted = new Set<PlaceId>();
  readonly #a4Copies: {
    readonly place: PlaceId;
    readonly path: readonly string[];
    readonly term: TypeTerm;
  }[] = [];
  /** Whether each decision admits `null` (a copy of a written type without one does not, A4). */
  readonly #nullable = new Map<Key, boolean>();
  /**
   * The decisions a copy of a written type with `null` made: they admit it whatever the stored kinds hold (A4, F17b; ADR
   * 0021 1.3: the kinds present never narrow a written domain, the lead's ruling on external round 7 B1).
   */
  readonly #permitsNull = new Set<Key>();
  /** The paths a copy of a written type decides, not the place's own (A4 through copies, r4.75 (1)). */
  readonly #inheritsWritten = new Set<Key>();
  /** The paths a written type, or a copy of one, leaves unrestricted (`permittedAt`): no decision, every kind fits. */
  readonly #unrestricted = new Set<Key>();
  /** The site of the contribution each decision took (S3 §1's admitted answer), `null` for a written type. */
  readonly #deciderSites = new Map<Key, SourceSite | null>();
  readonly #copies = new Map<
    PlaceId,
    readonly {
      readonly path: readonly string[];
      readonly binding: PlaceId;
      readonly strip: readonly string[];
    }[]
  >();
  /** The copies of places that may inherit a written type (`#inheriting`), where they land. */
  readonly #a4Inherits: InheritedCopy[] = [];
  /** A4 through copies (`#copyGraph`): the unwritten places a copy of a written binding reaches, copy by copy. */
  readonly #inheriting = new Set<PlaceId>();
  /** Per unwritten place and path, the written type its own decision copies there (`#inheritedAt`), or none. */
  readonly #inherited = new Map<Key, TypeTerm | null>();
  /** The places and paths whose decisions wait on each other through copies, by cycle (`#cut`): a union-find. */
  readonly #cycles = new Map<Key, Key>();
  /** Each cycle's size, by its root (`#cycleOf`). */
  readonly #cycleSizes = new Map<Key, number>();
  /**
   * The deepest path a written type can reach through copies (`#inheritedAt`): the written copies' landing paths with
   * their types' element levels, and every copy of an inheriting place's own landing path beside them.
   */
  #reach = 0;
  #resolving = false;
  readonly #whole = new Map<string, Definition[]>();
  readonly #fields = new WeakMap<TypeTerm, Map<string, TypeTerm>>();
  readonly #stops = new Map<PlaceId, Stops>();
  /**
   * A representative store's later equivalent ones (`#grouped`), each recorded once per pass with its representative
   * (`#representative`), and the bindings defined by one whole store.
   */
  readonly #members = new Map<Definition, Definition[]>();
  /** An alias's source path and the node it is read at (`#aliasKey`). */
  readonly #aliases = new Map<Definition, Alias>();
  /** Per read (its source and node), its chain's end (`#chainEnd`), `null` where it is its own. */
  readonly #chains = new Map<string, ChainEnd | null>();
  /** Per class (its representative), its eligible member at each tested key of its demanded paths (§4.3). */
  readonly #eligible = new Map<Definition, Map<string, Definition | null>>();
  /** Per key with stores, the rests below it of the paths the pass decides (`groups()`), once. */
  #demands: Map<Key, (readonly string[])[]> | null = null;
  readonly #representative = new Map<Definition, Definition>();
  /** The expected types of typed ingresses by identity, for `#conflictClass`. */
  readonly #termIds = new Map<TypeTerm, string>();
  /** The own structure of each stored value (`v`) and source key (`k`), and each source key's element depth, F2. */
  readonly #structures = new Map<string, Structure>();
  readonly #depths = new Map<Key, number>();
  #keyBound: number | null = null;
  #below: Map<Key, (readonly string[])[]> | null = null;
  readonly #takeables = new WeakMap<
    ReadonlySet<Definition | null>,
    { readonly wholes: readonly Definition[]; readonly adds: readonly Definition[] }[]
  >();
  /** `wholeBelow`'s values per stored value and path prefix. */
  readonly #levels = new Map<string, Level>();
  readonly #pending = new Map<number, Definition>();
  readonly #readSeen = new Set<PlaceId>();
  readonly #hostSeen = new Set<string>();
  /** Per provenance node, the ingresses its leaves name, and whether one of them no walk reached (`#resolve`). */
  readonly #nodeIngresses = new Map<IngressNode, ReadonlySet<PlaceId>>();
  /** Per store, the ingresses that reach its value through an operation's own read (`#ownLeaves`). */
  readonly #ownReads = new Map<string, ReadonlySet<PlaceId>>();
  /** Per store and path, the ingresses of named data it brings beside its inline data (`#namedBeside`). */
  readonly #beside = new Map<string, ReadonlySet<PlaceId>>();
  /** Per store and key, its stops there (`#keyStops`). */
  readonly #keyed = new Map<string, KeyStops>();
  /**
   * Per store and provenance node (`#perNode`): `ownReadItem`'s answer, whether an item carries an own read's data
   * (`ingressSiteOf`), `ownIngress`'s whole test, `#firstStop`.
   */
  readonly #ownItems = new Map<number, Map<IngressNode, boolean>>();
  readonly #someOwn = new Map<number, Map<IngressNode, boolean>>();
  readonly #wholeItems = new Map<number, Map<IngressNode, boolean>>();
  readonly #firstStops = new Map<number, Map<IngressNode, IngressStop | null>>();
  /** Per chain of a walk's operations, its signature (`#viaSignature`). */
  readonly #viaSignatures = new WeakMap<readonly Via[], string>();
  /** Per store, its landing stops by ingress (`#storeIngresses`). */
  readonly #byIngress = new Map<number, StoreIngresses>();
  /** Per list of a walk's stops, the decider's snapshots of it, all and the unselected ones (`#snapshots`). */
  readonly #snapshotLists = new WeakMap<readonly Stop[], (readonly Stop[] | undefined)[]>();
  readonly #resolved = new Map<IngressNode, boolean>();
  readonly #f18 = new Map<
    PlaceId,
    { readonly label: string; readonly tags: readonly ItemTag[] } | null
  >();
  #groups: { readonly root: PlaceId; readonly path: readonly string[] }[] | null = null;
  /** A4 through copies' landings (`#inheritance`), and per place and path whether its copies land it (`#landed`). */
  #inherits: Inheritance | null = null;
  readonly #landedPaths = new Map<string, boolean>();
  /** Per place copies land in, the landed paths whose contents may not fit (`#hotSets`). */
  #hots: ReadonlyMap<PlaceId, readonly (readonly string[])[]> | null = null;
  /** The copies places answer through (`#passThrough`), once per pass. */
  #forest: CopyForest | null = null;
  /** Per class, its eligible member per tested key asked while the groups are made (`#eligibleAt`). */
  readonly #eligibleWhileGrouping = new Map<Definition, Map<string, Definition | null>>();
  /** The prefix trie of the configurations of places' groups (`#meeting`), and its nodes' count. */
  readonly #configurations: Configuration = { id: 0, next: new Map(), added: [], reads: new Map() };
  #configurationCount = 1;
  /** Per locals node, per configuration and place path, its chain's paths there (`#localsMeet`). */
  readonly #localsMet = new Map<Locals, Map<string, LocalsMet>>();
  /** Per root and strip, its contents beside its landings (`#flatLoose`). */
  readonly #flatLooses = new Map<string, FlatLoose>();
  /** Per place and path, what it holds there (`#identity`); per place, its own contributions (`#ownStructure`). */
  readonly #identities = new Map<string, Identity>();
  readonly #owns = new Map<PlaceId, OwnStructure | null>();
  readonly #opaque = new Map<PlaceId, ReadonlySet<string>>();
  #cycleMembers: Map<number, PlaceId[]> | null = null;
  readonly #forwards = new Map<
    PlaceId,
    { readonly root: PlaceId; readonly strip: readonly string[] }
  >();
  /** Per place, its seeds' paths at or below each prefix (`#seedsUnder`), and its stores taken again (`#retakenOf`). */
  readonly #seedIndex = new Map<PlaceId, Map<string, string[]>>();
  #retakenByPlace: Map<PlaceId, (readonly string[])[]> | null = null;
  /** Per place, a bound on the paths copies land in it (`#meeting` lists all but the largest group's). */
  readonly #bounds = new Map<PlaceId, number>();
  /** Per key, its decision before it is recorded (`#decided`); the keys `decide` took (`#lazily`). */
  readonly #decisions = new Map<Key, Decided | null>();
  readonly #attempted = new Set<Key>();
  #landings: LandingIndex | null = null;

  public constructor(
    readonly pass: CorePass,
    readonly host: AdmissionHost,
    /**
     * The stores rejected by the previous pass, each with the places and paths it was rejected at, and those a rejection
     * cycle changes (A6).
     */
    readonly rejected: ReadonlyMap<number, ReadonlySet<Key>>,
    readonly cycling: ReadonlySet<number>,
  ) {
    const { definitions, program } = pass;
    for (const list of definitions.byKey.values()) {
      program.work.charge("indexSteps", list.length);
      for (const d of list) {
        const keys = rejected.get(d.uid);
        if (keys === undefined) continue;
        this.#rejectedKeys.add(d.key);
        for (const key of keys) {
          const retaken = this.#retaken.get(key);
          if (retaken === undefined) this.#retaken.set(key, [d]);
          else retaken.push(d);
        }
      }
    }
    for (const d of definitions.transferDefs)
      if (d.how === "parameter default") this.#defaulted.add(d.place);
    // A4: the copies of written bindings the stores, adds, returns, parameter defaults and single-site arguments bring
    // (a multi-site argument decides nothing, F21), where they land; and the copies of the unwritten places that may
    // inherit a written type through them, at any chain length (r4.75 (1)), each decided by the type that place's own
    // decision copies at the path (`#inheritedAt`)
    this.#copyGraph();
    for (const d of [...definitions.storeDefs, ...definitions.transferDefs])
      if (
        (d.kind === "whole" || d.kind === "add") &&
        d.value !== undefined &&
        (d.how !== "argument" || pass.lists.singleSite(d.fn)) &&
        !this.#besideDefault(d)
      ) {
        // (one landing path and key per copied path, its copies' shared one, charged before it is made)
        const landed = new Map<readonly string[], readonly string[]>();
        for (const { path, binding, strip } of this.#copySources(d.value)) {
          const written = writtenOf(program.place(binding).kind);
          const term = written === null ? null : permittedAt(written, strip);
          if (term === null && (written !== null || !this.#inheriting.has(binding))) continue;
          let at = landed.get(path);
          if (at === undefined) {
            at = keptSteps(
              this.#work,
              d.path,
              d.kind === "add" && d.how !== "elements" ? ["element"] : [],
              path,
            );
            landed.set(path, at);
            this.#a4Keys.add(keptKey(this.#work, d.place, at));
          }
          if (term !== null) this.#a4Copies.push({ place: d.place, path: at, term });
          else this.#a4Inherits.push({ place: d.place, path: at, from: binding, strip });
        }
      }
    for (const { path, term } of this.#a4Copies) {
      let depth = path.length;
      for (let step = ["element"]; termAt(term, step) !== null; step = joinSteps(step, ["element"]))
        depth = path.length + step.length;
      this.#reach = Math.max(this.#reach, depth);
    }
    for (const { path } of this.#a4Inherits) this.#reach += path.length;
  }

  /**
   * A4 through copies (ADR 0021 1.3: a copy of a binding with a written type keeps that type, so a copy of that copy does
   * too; r4.75 (1)), from every definition's stores: the unwritten places a copy of a written binding lands in, then
   * those a copy of such a place lands in, at any path (`#inheriting`). Only their copies carry an inherited type.
   */
  #copyGraph(): void {
    const { program, definitions } = this.pass;
    const work = program.work;
    const targets = new Set(program.occurrenceOf.values());
    const edges = new Map<PlaceId, PlaceId[]>();
    const seeds: PlaceId[] = [];
    for (const list of definitions.byKey.values())
      for (const d of list) {
        work.charge("indexSteps");
        if (d.value === undefined) continue;
        if (!targets.has(d.place) || writtenOf(program.place(d.place).kind) !== null) continue;
        for (const { binding } of this.#copySources(d.value)) {
          work.charge("indexSteps");
          if (writtenOf(program.place(binding).kind) !== null) seeds.push(d.place);
          else {
            const out = edges.get(binding);
            if (out === undefined) edges.set(binding, [d.place]);
            else out.push(d.place);
          }
        }
      }
    const queue = [...new Set(seeds)];
    for (const place of queue) this.#inheriting.add(place);
    for (let index = 0; index < queue.length; index += 1)
      for (const next of edges.get(queue[index]!) ?? []) {
        work.charge("indexSteps");
        if (this.#inheriting.has(next)) continue;
        this.#inheriting.add(next);
        queue.push(next);
      }
  }

  /**
   * A4 through copies (ADR 0021 1.3; r4.75 (1), (1a)): the written type an unwritten place's own decision copies at a
   * path, through whatever copy of a written binding it comes (a chain of copies, a projection, a selected carrier, a
   * literal, a parameter's default), at every collection level: `#scan`'s copied type, with the place's own `null`
   * where its decision is nullable beside the copy (`optionalOf`), `null` where a value decides the path or nothing does. A copy of the place carries that type there. Once per place and path, iteratively: a scan
   * that needs another place's type first is suspended where it stands (`Inheriting`) and goes on from there once that
   * type is known, so a chain of copies never deepens the native stack and a scanned prefix is never scanned again for a
   * sibling resolved later (the owner's reviewer's F1 on #1049, TABLE r4.80). A scan that needs the very place and path
   * whose own scan is waiting closes a cycle of copies: those waiting from there on are joined (`#cycles`), and a copy
   * between two of them carries no written type (`#cut`): a cycle of copies decides nothing written, whichever of its
   * places is asked first. A scan whose own cycle grew while it waited is taken again from its start, since the cut may
   * now drop a copy it already read; nothing else changes what it read. A place at another path is no cycle (`a.q = a`:
   * `a.q.p` needs `a.p`). Past the deepest path a written type reaches (`#reach`) a place inherits only what its path's
   * prefix there leaves below it (an unrestricted part), so a copy nesting a place in itself never deepens without end.
   */
  #inheritedAt(place: PlaceId, path: readonly string[]): TypeTerm | null {
    if (path.length > this.#reach) {
      const above = this.#inheritedAt(place, path.slice(0, this.#reach));
      return above === null ? null : permittedAt(above, path.slice(this.#reach));
    }
    const key = keyOf(place, path);
    const known = this.#inherited.get(key);
    if (known !== undefined) return known;
    // (a resolution resolves every key its scans wait on itself, so none starts inside another)
    if (this.#resolving)
      throw new Error(`The inherited type of '${key}' was asked while resolving.`);
    this.#resolving = true;
    try {
      const scan = (next: Key): Waiting => {
        const [place, path] = [keyPlace(next), keyPath(next)];
        // (a place that answers through a copy above it asks that copy's place, nothing scanned)
        const through = this.#passThrough(place, path);
        if (through !== place)
          return {
            key: next,
            steps: this.#answerOf(keptKey(this.#work, through, path)),
            cycle: "",
          };
        const inputs = this.#inputs(place, path);
        return {
          key: next,
          steps: inputs === null ? null : this.#scan(inputs.direct, inputs.prefixes, next),
          cycle: "",
        };
      };
      const pending: Waiting[] = [scan(key)];
      // (the positions of the waiting scans, and the last cycle closed)
      const waiting = new Map<Key, number>([[key, 0]]);
      let closed = "";
      // (the type the top scan waited on, given to it as it goes on)
      let given: TypeTerm | null = null;
      // the top scan's type is taken, the scan below it goes on, or is taken again where its cycle grew meanwhile
      const resolved = (term: TypeTerm | null): void => {
        const done = pending.pop()!;
        keepText(this.#work, done.key.length);
        this.#inherited.set(done.key, term);
        waiting.delete(done.key);
        const below = pending.at(-1);
        if (below !== undefined && below.cycle !== this.#cycleOf(below.key))
          pending[pending.length - 1] = scan(below.key);
        given = term;
      };
      while (pending.length > 0) {
        const top = pending.at(-1)!;
        // (a key no store reaches finds nothing)
        const step =
          top.steps === null ? { done: true as const, value: null } : top.steps.next(given);
        given = null;
        if (step.done === true) {
          resolved(step.value === null ? null : optionalOf(step.value.copied, step.value.nullable));
          continue;
        }
        const needed = step.value;
        const from = waiting.get(needed);
        if (from !== undefined) {
          const cycle = joinParts(top.key, needed);
          // (a scan that asks again across the cycle just closed inherits nothing: it never waits on itself twice)
          if (cycle === closed) {
            resolved(null);
            continue;
          }
          closed = cycle;
          for (let index = from; index < pending.length; index += 1)
            this.#join(pending[index]!.key, needed);
          // (its cycle grew: taken again, as every scan it joined is when it goes on)
          pending[pending.length - 1] = scan(top.key);
          continue;
        }
        top.cycle = this.#cycleOf(top.key);
        waiting.set(needed, pending.length);
        pending.push(scan(needed));
      }
    } finally {
      this.#resolving = false;
    }
    return this.#inherited.get(key)!;
  }

  /**
   * What `from` inherits at `path` (`#inheritedAt`) as a scan asks it: known, or the key it waits on yielded, past the
   * deepest path a written type reaches its path's prefix there.
   */
  *#inheritedSteps(from: PlaceId, path: readonly string[]): Inheriting<TypeTerm | null> {
    if (path.length > this.#reach) {
      const above = yield* this.#inheritedSteps(from, path.slice(0, this.#reach));
      return above === null ? null : permittedAt(above, path.slice(this.#reach));
    }
    const key = keyOf(from, path);
    const known = this.#inherited.get(key);
    return known !== undefined ? known : yield key;
  }

  /**
   * The written type a copy of `from` at `path` carries into the decision of `into`: what `from` inherits there
   * (`#inheritedAt`), none where the two wait on each other through copies (`#cut`).
   */
  *#inheritedInto(
    from: PlaceId,
    path: readonly string[],
    into: Key | null,
  ): Inheriting<TypeTerm | null> {
    // (past the deepest path a written type reaches, the place's path there is what it waits on, `#inheritedAt`)
    const source = keyOf(from, path.length > this.#reach ? path.slice(0, this.#reach) : path);
    if (into !== null && this.#cut(into, source)) return null;
    const term = yield* this.#inheritedSteps(from, path);
    return into !== null && this.#cut(into, source) ? null : term;
  }

  /** A computation run outside a resolution: each inherited type it waits on resolved by `#inheritedAt` first. */
  #drive<T>(steps: Inheriting<T>): T {
    let given: TypeTerm | null = null;
    for (;;) {
      const step = steps.next(given);
      if (step.done === true) return step.value;
      given = this.#inheritedAt(keyPlace(step.value), keyPath(step.value));
    }
  }

  /** Another key's inherited type as a scan's answer (`#inheritedAt`'s `#passThrough`): known, or waited on. */
  *#answerOf(
    key: Key,
  ): Inheriting<{ readonly copied: TypeTerm | null; readonly nullable: boolean } | null> {
    const known = this.#inherited.get(key);
    const term = known !== undefined ? known : yield key;
    return term === null ? null : { copied: term, nullable: false };
  }

  /**
   * The place whose inherited type a place's is at a path (`#inheritedAt`, r4.75 (1)): a place whose only store on the
   * path is one whole copy of an unwritten inheriting place, outside every cycle of copies, inherits there what that
   * place does (its scan finds the copy, whose type is that place's, and nothing beside it); so a chain of such copies
   * answers as its nearest member with a store on the path, or its top. Each copy storing its own field asks that member
   * directly, never every copy above it (the reviewer's control of a copy's own contribution, TABLE r4.80).
   */
  #passThrough(place: PlaceId, path: readonly string[]): PlaceId {
    const forest = this.#copyForest();
    if (!forest.parent.has(place)) return place;
    const own = forest.stores.get(place);
    const lists: (Storing | undefined)[] = [];
    for (let length = 1; length <= path.length; length += 1) {
      this.pass.program.work.charge("indexSteps");
      const text = keptText(this.#work, path.slice(0, length));
      if (own?.has(text) === true) return place;
      lists.push(forest.storing.get(text));
    }
    return this.#nearest(place, lists);
  }

  /**
   * The place whose landed paths at or below `prefix` a place's are, besides its own root (`#landedBelow`): a place
   * that answers through its parent lands nothing of its own but below its keys, so a chain of them lands what its
   * nearest member storing at, above or below the prefix lands, or its top.
   */
  #landsThrough(place: PlaceId, prefix: readonly string[]): PlaceId {
    const forest = this.#copyForest();
    if (!forest.parent.has(place)) return place;
    const own = forest.stores.get(place);
    const lists: (Storing | undefined)[] = [];
    for (let length = 1; length <= prefix.length; length += 1) {
      this.pass.program.work.charge("indexSteps");
      const text = keptText(this.#work, prefix.slice(0, length));
      if (own?.has(text) === true) return place;
      lists.push(forest.storing.get(text));
    }
    for (const text of own ?? []) {
      this.pass.program.work.charge("indexSteps");
      if (isPrefix(prefix, splitPath(text))) return place;
    }
    lists.push(forest.beneath.get(keptText(this.#work, prefix)));
    return this.#nearest(place, lists);
  }

  /** The deepest place above `place` in its copy tree among the lists' places (`Storing`), else its tree's top. */
  #nearest(place: PlaceId, lists: readonly (Storing | undefined)[]): PlaceId {
    const forest = this.#copyForest();
    const work = this.pass.program.work;
    let found = forest.top.get(place)!;
    const entry = forest.entry.get(place)!;
    for (const storing of lists) {
      if (storing === undefined) continue;
      work.charge("indexSteps", Math.ceil(Math.log2(storing.places.length + 1)) + 1);
      // (the last place entered at or before it whose subtree holds it: entries sorted, last entries in a tree)
      let low = 0;
      let high = storing.entries.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (storing.entries[middle]! <= entry) low = middle + 1;
        else high = middle;
      }
      if (low === 0) continue;
      const index = lastAtLeast(storing.exits, storing.exits.length >> 1, low - 1, entry);
      if (index < 0) continue;
      const at = storing.places[index]!;
      if (at !== place && forest.depth.get(at)! > forest.depth.get(found)!) found = at;
    }
    return found;
  }

  /** The copies places answer through (`CopyForest`), once per pass. */
  #copyForest(): CopyForest {
    if (this.#forest !== null) return this.#forest;
    const { program, definitions, lists } = this.pass;
    const work = program.work;
    const { cycleOf } = this.#inheritance();
    // each place's keys with stores or candidates below its root
    const keys = new Map<PlaceId, Set<string>>();
    for (const map of [definitions.byKey, definitions.candidates] as const)
      for (const key of map.keys()) {
        work.charge("indexSteps");
        const path = keyPath(key);
        if (path.length === 0) continue;
        let own = keys.get(keyPlace(key));
        if (own === undefined) keys.set(keyPlace(key), (own = new Set()));
        own.add(keptText(this.#work, path));
      }
    const parent = new Map<PlaceId, PlaceId>();
    const children = new Map<PlaceId, PlaceId[]>();
    for (const place of this.#inheriting) {
      work.charge("indexSteps");
      if (cycleOf.has(place) || writtenOf(program.place(place).kind) !== null) continue;
      const stores = definitions.byKey.get(keyOf(place, [])) ?? [];
      const d = stores.length === 1 ? stores[0]! : null;
      const source =
        d !== null &&
        d.kind === "whole" &&
        d.value !== undefined &&
        d.how !== "argument" &&
        d.how !== "parameter default" &&
        lists.live(d)
          ? program.occurrenceOf.get(d.value)
          : undefined;
      if (
        source === undefined ||
        !this.#inheriting.has(source) ||
        writtenOf(program.place(source).kind) !== null
      )
        continue;
      parent.set(place, source);
      const list = children.get(source);
      if (list === undefined) children.set(source, [place]);
      else list.push(place);
    }
    const top = new Map<PlaceId, PlaceId>();
    const depth = new Map<PlaceId, number>();
    const entry = new Map<PlaceId, number>();
    const exit = new Map<PlaceId, number>();
    let clock = 0;
    for (const start of children.keys()) {
      if (parent.has(start)) continue;
      const frames: { readonly place: PlaceId; next: number }[] = [{ place: start, next: 0 }];
      top.set(start, start);
      depth.set(start, 0);
      entry.set(start, clock++);
      while (frames.length > 0) {
        const frame = frames.at(-1)!;
        const below = children.get(frame.place) ?? [];
        work.charge("indexSteps");
        if (frame.next < below.length) {
          const child = below[frame.next++]!;
          top.set(child, start);
          depth.set(child, depth.get(frame.place)! + 1);
          entry.set(child, clock++);
          frames.push({ place: child, next: 0 });
          continue;
        }
        exit.set(frame.place, clock - 1);
        frames.pop();
      }
    }
    const stores = new Map<PlaceId, Set<string>>();
    // (per key, the places storing at it; and at it or below it, each key's prefixes, the root's too, once per place)
    const at = new Map<string, PlaceId[]>();
    const below = new Map<string, PlaceId[]>();
    const put = (map: Map<string, PlaceId[]>, text: string, place: PlaceId): void => {
      work.charge("indexSteps");
      const list = map.get(text);
      if (list === undefined) map.set(text, [place]);
      else if (list.at(-1) !== place) list.push(place);
    };
    for (const place of entry.keys()) {
      const own = keys.get(place);
      if (own === undefined) continue;
      stores.set(place, own);
      const prefixes = new Set<string>([""]);
      for (const text of own) {
        put(at, text, place);
        const steps = splitPath(text);
        for (let length = 1; length <= steps.length; length += 1)
          prefixes.add(keptText(this.#work, steps.slice(0, length)));
      }
      for (const text of prefixes) put(below, text, place);
    }
    // (each list by entry, the last entries below its places the leaves of a max segment tree)
    const index = (map: Map<string, PlaceId[]>): Map<string, Storing> => {
      const out = new Map<string, Storing>();
      for (const [text, places] of map) {
        work.charge("indexSteps", places.length + sortCost(places.length));
        places.sort((a, b) => entry.get(a)! - entry.get(b)!);
        let size = 1;
        while (size < places.length) size <<= 1;
        const exits = Array<number>(2 * size).fill(-1);
        places.forEach((place, position) => (exits[size + position] = exit.get(place)!));
        for (let node = size - 1; node >= 1; node -= 1)
          exits[node] = Math.max(exits[2 * node]!, exits[2 * node + 1]!);
        out.set(text, { places, entries: places.map((place) => entry.get(place)!), exits });
      }
      return out;
    };
    this.#forest = {
      parent,
      stores,
      top,
      depth,
      entry,
      exit,
      storing: index(at),
      beneath: index(below),
    };
    return this.#forest;
  }

  /** Whether two decisions wait on each other through copies (`#cycles`). */
  #cut(a: Key, b: Key): boolean {
    return this.#cycles.has(a) && this.#cycles.has(b) && this.#root(a) === this.#root(b);
  }

  /** A decision's cycle as it stands (`#cycles`): its root and size, empty outside every cycle. */
  #cycleOf(key: Key): string {
    if (!this.#cycles.has(key)) return "";
    const root = this.#root(key);
    return `${this.#cycleSizes.get(root)!}:${root}`;
  }

  #root(key: Key): Key {
    let root = key;
    while (this.#cycles.get(root) !== root) root = this.#cycles.get(root)!;
    for (let at = key; at !== root;) {
      const parent = this.#cycles.get(at)!;
      this.#cycles.set(at, root);
      at = parent;
    }
    return root;
  }

  #join(a: Key, b: Key): void {
    for (const key of [a, b])
      if (!this.#cycles.has(key)) {
        this.#cycles.set(key, key);
        this.#cycleSizes.set(key, 1);
      }
    const x = this.#root(a);
    const y = this.#root(b);
    if (x === y) return;
    this.#cycles.set(x, y);
    this.#cycleSizes.set(y, this.#cycleSizes.get(y)! + this.#cycleSizes.get(x)!);
    this.#cycleSizes.delete(x);
  }

  /** The analysis's ledger, which the paths and keys built here are charged to (`keptKey`, `keptText`). */
  get #work(): WorkLedger {
    return this.pass.program.work;
  }

  #run<T>(work: Work<T>): T {
    return this.host.run(work);
  }

  /**
   * A6: a definite contribution that does not fit at a place's path is rejected, a return against its own result's
   * decision too (F23), so it leaves the result's contract (an argument stays: the parameter is its callee's); in the
   * next pass it is decided again there.
   */
  /** The rejections made in this pass, counted (C1 asks whether a candidate left one). */
  public rejections = 0;

  public reject(d: Definition, root: PlaceId, path: readonly string[]): void {
    this.rejections += 1;
    if (d.how === "argument") return;
    let keys = this.newlyRejected.get(d.uid);
    if (keys === undefined) this.newlyRejected.set(d.uid, (keys = new Set()));
    keys.add(keptKey(this.#work, root, path));
  }

  /**
   * ADR 0021 1.6: source order, in which a declaration's start value comes before every other store into its place; a
   * single-site parameter's is its argument (F21).
   */
  public sourceOrder(d: Definition): number {
    return d.how === "initializer" || (d.how === "argument" && this.pass.lists.singleSite(d.fn))
      ? -1
      : d.site.file * 1e9 + d.site.start;
  }

  /**
   * F21, ADR 0021 1.5: an argument for an unannotated parameter with a default. Each call types such a parameter from
   * its argument, and the default is the parameter's start value, checked once at the function against the body: the
   * argument decides nothing and is no candidate, so the two never constrain each other. Without a default a single-site
   * argument is the start value (F21); a written parameter checks every argument (A9, C7).
   */
  #besideDefault(d: Definition): boolean {
    return (
      d.how === "argument" &&
      this.#defaulted.has(d.place) &&
      writtenOf(this.pass.program.place(d.place).kind) === null
    );
  }

  /** A store's value at the path below its destination, by §3 at its node. */
  public valueAt(d: Definition, at: readonly string[]): Item[] {
    this.pass.program.work.charge("checks");
    if (d.kind === "const") return at.length === 0 ? [...(d.items ?? [])] : [];
    return withoutEmpty(this.#run(this.pass.values.valueItems(d.value!, d.node, at)));
  }

  /** A place's path in the contract's vocabulary: an element step below a dict is its `entry`. */
  public pathLabel(place: PlaceId, path: readonly string[]): string {
    const { program, contract } = this.pass;
    let label = program.place(place).label;
    path.forEach((step, index) => {
      if (step !== "element") label = stepText(label, step);
      else {
        const kinds = withoutEmpty(
          this.#run(contract.contractOf(keyOf(place, path.slice(0, index)))),
        );
        label = stepText(label, elementStep(kinds.map((item) => item.tag)));
      }
    });
    return label;
  }

  // ------------------------------------------------------------------------------------------- the decision

  /** Every place and path admission decides: the keys with definitions, below them a literal's structure, written elements. */
  public groups(): readonly { readonly root: PlaceId; readonly path: readonly string[] }[] {
    if (this.#groups !== null) return this.#groups;
    const { program, definitions, lists } = this.pass;
    const work = program.work;
    const tracked = new Set<Key>([...definitions.byKey.keys(), ...definitions.candidates.keys()]);
    for (const c of program.constraints)
      if (c.kind === "project") {
        const target = program.targetRoot(c.into);
        if (!program.cellOwner.has(target.root) && !program.hasOf.has(target.root))
          tracked.add(keptKey(this.#work, target.root, target.path));
      }
    for (const [, binding] of program.occurrenceOf) tracked.add(keptKey(this.#work, binding, []));
    // the stores, adds, returns, parameter defaults and single-site arguments into each key (a multi-site argument
    // decides nothing, F21)
    const reaching = [...definitions.storeDefs, ...definitions.transferDefs].filter(
      (d) =>
        (d.kind === "whole" || d.kind === "add") &&
        (d.how !== "argument" || lists.singleSite(d.fn)) &&
        !this.#besideDefault(d),
    );
    const stores = new Map<Key, number>();
    for (const d of reaching)
      for (const key of [d.key, ...keptPrefixes(this.#work, d.key)]) {
        work.charge("indexSteps");
        stores.set(key, (stores.get(key) ?? 0) + 1);
      }
    // a stored value's structure where another store or add reaches the place or below it: its literals', and below a
    // copy or a call its source's elements (F2), the deepest once per path it lands at (its prefixes follow below)
    const deepest = new Map<Key, number>();
    for (const d of reaching)
      if ((stores.get(d.key) ?? 0) > 1) {
        const base = joinSteps(d.path, d.kind === "add" && d.how !== "elements" ? ["element"] : []);
        const structure = this.#valueStructure(d.value!);
        for (const path of structure.paths)
          tracked.add(keptKey(this.#work, d.place, joinSteps(base, path)));
        for (const { below, key } of structure.sources) {
          work.charge("indexSteps");
          const landing = keptKey(this.#work, d.place, joinSteps(base, below));
          const depth = this.#depthOf(key);
          if (depth <= (deepest.get(landing) ?? 0)) continue;
          deepest.set(landing, depth);
          tracked.add(
            keptKey(
              this.#work,
              d.place,
              joinSteps(base, below, Array<string>(depth).fill("element")),
            ),
          );
        }
      }
    // a literal holding a named value (a copy, a call, what an operation carries of either) decides the paths its own
    // structure gives with its store, read or not, so the named value's uncertain contents meet C1 there (the owner's
    // F1, round 10 B1)
    for (const d of reaching)
      if ((stores.get(d.key) ?? 0) === 1) {
        const structure = this.#valueStructure(d.value!);
        if (structure.sources.length === 0) continue;
        const base = joinSteps(d.path, d.kind === "add" && d.how !== "elements" ? ["element"] : []);
        for (const path of structure.paths) {
          work.charge("indexSteps");
          tracked.add(keptKey(this.#work, d.place, joinSteps(base, path)));
        }
      }
    // C9: where each ingress store's external data stands below its destination, decided with the store whether a
    // consumer reads the place or not (the owner's F1): its landings' contribution paths (§3.2)
    for (const [d, stops] of this.#landingIndex().byStore)
      for (const stop of stops) {
        work.charge("indexSteps");
        const below = elementsBelow(d, stop.path);
        if (below.length > 0)
          tracked.add(keptKey(this.#work, d.place, joinSteps(this.#destPath(d), below)));
      }
    for (const key of [...tracked])
      for (const prefix of keptPrefixes(this.#work, key)) {
        work.charge("indexSteps");
        tracked.add(prefix);
      }
    work.charge(
      "checks",
      tracked.size +
        program.places.length +
        program.constraints.length +
        definitions.storeDefs.length,
    );
    const roots = new Map<PlaceId, Set<string>>();
    for (const key of tracked) {
      let paths = roots.get(keyPlace(key));
      if (paths === undefined) roots.set(keyPlace(key), (paths = new Set()));
      paths.add(keptPathText(this.#work, key));
    }
    // A1, A8: a written collection's elements at every depth
    for (const place of program.places) {
      const written = writtenOf(place.kind);
      const paths = roots.get(place.id);
      if (written === null || paths === undefined) continue;
      for (
        let path = ["element"];
        termAt(written, path) !== null;
        path = joinSteps(path, ["element"])
      )
        paths.add(keptText(this.#work, path));
    }
    const at = (place: PlaceId): Set<string> => {
      let paths = roots.get(place);
      if (paths === undefined) roots.set(place, (paths = new Set()));
      return paths;
    };
    // A4: a copied written type's paths, where the copy lands and below (A8: its elements)
    const { seeds, into, order } = this.#inheritance();
    for (const [place, paths] of seeds) {
      const own = at(place);
      for (const text of paths.keys()) own.add(text);
    }
    // A4 through copies (r4.75 (1)): a copy of a place that may inherit a written type lands at its own path; below it,
    // where copies of written types land in that place, it is decided with the copy only where the place's contents may
    // not fit (`#hotSets`: a store's host data or other kinds, two copies of different sources meeting, a store taken again),
    // and where an answer asks otherwise (`#lazily`), so a copy costs its own divergences, never its source's every
    // path (the owner's reviewer's F1 on #1049, TABLE r4.80; r4.51)
    const hots = this.#hotSets();
    for (const component of order)
      for (const place of component) {
        const copies = into.get(place);
        if (copies === undefined) continue;
        const own = at(place);
        for (const { path } of copies) {
          work.charge("indexSteps");
          own.add(keptText(this.#work, path));
        }
        for (const path of hots.get(place) ?? []) {
          work.charge("indexSteps");
          own.add(keptText(this.#work, path));
        }
      }
    const groups: { readonly root: PlaceId; readonly path: readonly string[] }[] = [];
    for (const [root, paths] of roots)
      for (const path of paths) groups.push({ root, path: keptSplit(this.#work, path) });
    this.#groups = groups;
    return groups;
  }

  /** A4 through copies' landings (`Inheritance`), once per pass. */
  #inheritance(): Inheritance {
    if (this.#inherits !== null) return this.#inherits;
    const work = this.pass.program.work;
    const seeds = new Map<PlaceId, Map<string, Set<TypeTerm>>>();
    // (once per landing path and written type: k copies of one binding into one literal are one)
    const copied = new Map<Key, Set<TypeTerm>>();
    for (const { place, path, term } of this.#a4Copies) {
      const key = keptKey(this.#work, place, path);
      let terms = copied.get(key);
      if (terms === undefined) copied.set(key, (terms = new Set()));
      work.charge("indexSteps");
      if (terms.has(term)) continue;
      terms.add(term);
      let paths = seeds.get(place);
      if (paths === undefined) seeds.set(place, (paths = new Map()));
      // (each element level with the written type there)
      let step: readonly string[] = [];
      for (let level: TypeTerm | null = term; level !== null; level = termAt(term, step)) {
        work.charge("indexSteps");
        const text = keptText(this.#work, joinSteps(path, step));
        let levels = paths.get(text);
        if (levels === undefined) paths.set(text, (levels = new Set()));
        levels.add(level);
        step = joinSteps(step, ["element"]);
      }
    }
    const into = new Map<PlaceId, InheritedCopy[]>();
    const owned = new Map<PlaceId, Set<string>>();
    const bySource = new Map<PlaceId, InheritedCopy[]>();
    const distinct = new Set<string>();
    for (const copy of this.#a4Inherits) {
      const list = bySource.get(copy.from);
      if (list === undefined) bySource.set(copy.from, [copy]);
      else list.push(copy);
      work.charge("indexSteps");
      const id = keptParts(this.#work, copy.place, copy.path, copy.from, copy.strip);
      if (distinct.has(id)) continue;
      distinct.add(id);
      const own = into.get(copy.place);
      if (own === undefined) into.set(copy.place, [copy]);
      else own.push(copy);
      let paths = owned.get(copy.place);
      if (paths === undefined) owned.set(copy.place, (paths = new Set()));
      paths.add(keptText(this.#work, copy.path));
    }
    const { cycleOf, order } = cyclesOf(bySource, work);
    const cycles = new Map<PlaceId, Set<string>>();
    const fed = new Map<PlaceId, PlaceId>();
    this.#inherits = { seeds, into, owned, cycleOf, cycles, fed, order };
    // a cycle's landed paths, sources before it: a copy from outside it brings its own path and every path landed below
    // its strip, as base; within it a copy brings its source's base paths only, kept base by a whole copy alone, so no
    // path grows by going round (Sol's round 4 B1)
    for (const component of order) {
      const cycle = cycleOf.get(component[0]!);
      if (cycle === undefined) continue;
      const brings = (copy: InheritedCopy, land: (path: readonly string[]) => void): void => {
        land(copy.path);
        for (const text of this.#landedBelow(copy.from, copy.strip)) {
          const steps = splitPath(text);
          if (steps.length > copy.strip.length)
            land(keptSteps(this.#work, copy.path, steps.slice(copy.strip.length)));
        }
      };
      // (a cycle of whole copies: each member's base paths reach every other's whole, so its members land one set, their
      // own, their copies' from outside, and the root each whole copy lands)
      // (fed by whole copies of one place outside it, nothing written of its own: that place's landings, asked of it,
      // Sol's review r2's independent cycles)
      if (this.#wholeCycle(component) && component.every((member) => !seeds.has(member))) {
        const feeding = new Set<PlaceId>();
        let whole = true;
        for (const member of component)
          for (const copy of into.get(member) ?? []) {
            work.charge("indexSteps");
            if (cycleOf.get(copy.from) === cycle) continue;
            feeding.add(copy.from);
            whole &&= copy.path.length === 0 && copy.strip.length === 0;
          }
        if (whole && feeding.size === 1) {
          const source = [...feeding][0]!;
          for (const member of component) fed.set(member, source);
          continue;
        }
      }
      if (this.#wholeCycle(component)) {
        const shared = new Set<string>([""]);
        const land = (path: readonly string[]): void => {
          work.charge("indexSteps");
          shared.add(keptText(this.#work, path));
        };
        for (const member of component) {
          for (const text of seeds.get(member)?.keys() ?? []) land(splitPath(text));
          for (const copy of into.get(member) ?? [])
            if (cycleOf.get(copy.from) !== cycle) brings(copy, land);
        }
        for (const member of component) cycles.set(member, shared);
        continue;
      }
      const all = new Map<PlaceId, Set<string>>();
      // (each member's base paths in the order they came, so a copy reads only those it has not read)
      const base = new Map<PlaceId, { readonly paths: Set<string>; readonly list: string[] }>();
      for (const member of component) {
        const own = [...(seeds.get(member)?.keys() ?? [])];
        all.set(member, new Set(own));
        base.set(member, { paths: new Set(own), list: own });
      }
      // a path landed in a member, kept base by a copy that keeps it; whether its base grew
      const land = (member: PlaceId, path: readonly string[], keeps: boolean): boolean => {
        work.charge("indexSteps");
        const text = keptText(this.#work, path);
        all.get(member)!.add(text);
        const kept = base.get(member)!;
        if (!keeps || kept.paths.has(text)) return false;
        kept.paths.add(text);
        kept.list.push(text);
        return true;
      };
      const outgoing = new Map<PlaceId, InheritedCopy[]>();
      for (const member of component)
        for (const copy of into.get(member) ?? []) {
          if (cycleOf.get(copy.from) !== cycle) {
            brings(copy, (path) => land(member, path, true));
            continue;
          }
          const list = outgoing.get(copy.from);
          if (list === undefined) outgoing.set(copy.from, [copy]);
          else list.push(copy);
        }
      // (a member taken again only where its base paths grew; each copy reads its source's from where it stopped)
      const read = new Map<InheritedCopy, number>();
      const queue = [...component];
      const queued = new Set(queue);
      for (let index = 0; index < queue.length; index += 1) {
        const from = queue[index]!;
        queued.delete(from);
        for (const copy of outgoing.get(from) ?? []) {
          const keeps = copy.path.length === 0 && copy.strip.length === 0;
          let grew = land(copy.place, copy.path, keeps);
          const list = base.get(from)!.list;
          for (let at = read.get(copy) ?? 0; at < list.length; at += 1) {
            const steps = splitPath(list[at]!);
            if (steps.length > copy.strip.length && isPrefix(copy.strip, steps))
              grew =
                land(
                  copy.place,
                  keptSteps(this.#work, copy.path, steps.slice(copy.strip.length)),
                  keeps,
                ) || grew;
          }
          read.set(copy, list.length);
          if (grew && !queued.has(copy.place)) {
            queued.add(copy.place);
            queue.push(copy.place);
          }
        }
      }
      for (const member of component) cycles.set(member, all.get(member)!);
    }
    return this.#inherits;
  }

  /** Whether a cycle of copies holds only whole copies within it (no step added or taken), its members' one landing. */
  #wholeCycle(component: readonly PlaceId[]): boolean {
    const { into, cycleOf } = this.#inheritance();
    const work = this.pass.program.work;
    const cycle = cycleOf.get(component[0]!);
    return component.every((member) =>
      (into.get(member) ?? []).every((copy) => {
        work.charge("indexSteps");
        return (
          cycleOf.get(copy.from) !== cycle || (copy.path.length === 0 && copy.strip.length === 0)
        );
      }),
    );
  }

  /**
   * The copies a place lands through (`#landed`, `#landedBelow`): its own, or, for a member of a cycle a place outside it
   * feeds (`Inheritance.fed`), one whole copy of that place.
   */
  #copiesOf(place: PlaceId): readonly InheritedCopy[] {
    const { into, fed } = this.#inheritance();
    const source = fed.get(place);
    return source === undefined
      ? (into.get(place) ?? [])
      : [{ place, path: [], from: source, strip: [] }];
  }

  /**
   * Whether copies land a path in a place (`Inheritance`): its own landings, else its copies' sources' landings below
   * their strips, on an explicit stack, each place and path asked once.
   */
  #landed(place: PlaceId, path: readonly string[]): boolean {
    const { seeds, owned, cycleOf, cycles, fed } = this.#inheritance();
    const work = this.pass.program.work;
    const memo = this.#landedPaths;
    const frames: {
      readonly key: string;
      readonly place: PlaceId;
      readonly path: readonly string[];
      next: number;
    }[] = [];
    // a place and path's answer where its own landings give it, else its frame, its copies' sources asked one by one;
    // a place that answers through its parent answers as the copy it answers through (`#passThrough`)
    const open = (place: PlaceId, steps: readonly string[]): boolean | null => {
      const at = steps.length === 0 ? place : this.#passThrough(place, steps);
      const key = keptParts(this.#work, at, steps);
      const known = memo.get(key);
      if (known !== undefined) return known;
      work.charge("indexSteps");
      const text = pathText(steps);
      const found =
        cycleOf.has(at) && !fed.has(at)
          ? cycles.get(at)!.has(text)
          : seeds.get(at)?.has(text) === true ||
            owned.get(at)?.has(text) === true ||
            (fed.has(at) && steps.length === 0) ||
            null;
      if (found !== null) memo.set(key, found);
      else frames.push({ key, place: at, path: steps, next: 0 });
      return found;
    };
    const first = open(place, path);
    if (first !== null) return first;
    const key = frames[0]!.key;
    let answer: boolean | null = null;
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      if (answer === true) {
        memo.set(frame.key, true);
        frames.pop();
        continue;
      }
      const copies = this.#copiesOf(frame.place);
      if (frame.next >= copies.length) {
        memo.set(frame.key, false);
        frames.pop();
        answer = false;
        continue;
      }
      const copy = copies[frame.next++]!;
      work.charge("indexSteps");
      answer =
        copy.path.length < frame.path.length && isPrefix(copy.path, frame.path)
          ? open(copy.from, keptSteps(this.#work, copy.strip, frame.path.slice(copy.path.length)))
          : false;
    }
    return memo.get(key)!;
  }

  /**
   * The paths copies land in a place at or below `prefix` (`Inheritance`), each once: its own landings and, through each
   * copy, its source's at or below the copy's strip, written where the copy lands them; on an explicit stack, each
   * source, prefix and way of writing its paths once.
   */
  #landedBelow(place: PlaceId, prefix: readonly string[]): string[] {
    const { cycleOf, cycles, fed } = this.#inheritance();
    const work = this.pass.program.work;
    const out = new Set<string>();
    const seen = new Set<string>();
    // a task: a place, the prefix its paths are taken at or below, and how its path is written in the place asked:
    // its first `drop` steps replaced by `prepend`
    const tasks: {
      readonly place: PlaceId;
      readonly below: readonly string[];
      readonly drop: number;
      readonly prepend: readonly string[];
    }[] = [{ place, below: prefix, drop: 0, prepend: [] }];
    while (tasks.length > 0) {
      const task = tasks.pop()!;
      const id = keptParts(this.#work, task.place, task.below, task.drop, task.prepend);
      if (seen.has(id)) continue;
      seen.add(id);
      const emit = (path: readonly string[]): void => {
        work.charge("indexSteps");
        if (isPrefix(task.below, path))
          out.add(keptText(this.#work, joinSteps(task.prepend, path.slice(task.drop))));
      };
      // (a place that lands through its parent lands its root and what the copy it lands through does, `#landsThrough`)
      const through = this.#landsThrough(task.place, task.below);
      if (through !== task.place) {
        emit([]);
        tasks.push({ ...task, place: through });
        continue;
      }
      if (cycleOf.has(task.place) && !fed.has(task.place)) {
        for (const text of cycles.get(task.place)!) emit(splitPath(text));
        continue;
      }
      for (const text of this.#seedsUnder(task.place, task.below)) emit(splitPath(text));
      for (const copy of this.#copiesOf(task.place)) {
        emit(copy.path);
        // (the source's paths at or below the strip, those the prefix asks for)
        const below = isPrefix(copy.path, task.below)
          ? keptSteps(this.#work, copy.strip, task.below.slice(copy.path.length))
          : isPrefix(task.below, copy.path)
            ? copy.strip
            : null;
        if (below === null) continue;
        tasks.push(
          task.drop <= copy.path.length
            ? {
                place: copy.from,
                below,
                drop: copy.strip.length,
                prepend: keptSteps(this.#work, task.prepend, copy.path.slice(task.drop)),
              }
            : {
                place: copy.from,
                below,
                drop: copy.strip.length + task.drop - copy.path.length,
                prepend: task.prepend,
              },
        );
      }
    }
    return [...out];
  }

  /**
   * Per place copies land in, the landed paths a copy decides with its store (`groups`): those where the place's
   * contents may hold a kind its decision there does not admit (`#hotAt`), among its candidates: where its written types
   * land (a written binding's own host data, which each copy carries on: C9 r4.50 (1)), its own stores' host data,
   * other values and literals (`#ownStructure`), the hot paths of the sources it copies where it lands them, and where
   * two of its copies or written types meet (`#meeting`); and each store taken again (A6). Elsewhere a copy's
   * contents fit what its source's decision admits, so its decision there owes nothing; a copy that only copies one
   * source, whole, stands for that source's (TABLE r4.80). Sources first; a cycle's members test every landed path.
   */
  #hotSets(): ReadonlyMap<PlaceId, readonly (readonly string[])[]> {
    if (this.#hots !== null) return this.#hots;
    const { seeds, into, cycleOf, cycles, fed, order } = this.#inheritance();
    const work = this.pass.program.work;
    const hots = new Map<PlaceId, readonly (readonly string[])[]>();
    // (the source a copy that only copies one source whole stands for, and a bound on each place's landed paths)
    const origins = new Map<PlaceId, PlaceId>();
    // (each place's contents beside its landings, and a bound on its landed paths)
    const loose = new Map<PlaceId, Loose>();
    const bound = (place: PlaceId): number => this.#bounds.get(place) ?? 0;
    const retaken = new Map<PlaceId, (readonly string[])[]>();
    for (const key of this.#retaken.keys()) {
      work.charge("indexSteps");
      const list = retaken.get(keyPlace(key));
      if (list === undefined) retaken.set(keyPlace(key), [keptPath(this.#work, key)]);
      else list.push(keptPath(this.#work, key));
    }
    for (const component of order) {
      if (cycleOf.has(component[0]!)) {
        const cycle = cycleOf.get(component[0]!);
        // (a cycle's contents, its members' and those its copies from outside bring, flow round it: one for all its
        // members, everything below each where its copies add or take steps, Sol's review r2 B1)
        const owns = component.map((member) => this.#ownStructure(member));
        const outside = component.flatMap((member) =>
          (into.get(member) ?? []).filter((copy) => {
            work.charge("indexSteps");
            return cycleOf.get(copy.from) !== cycle;
          }),
        );
        const contents = this.#looseOf(owns, outside, loose, !this.#wholeCycle(component));
        if (this.#wholeCycle(component)) {
          // a cycle of whole copies holds what all its members' stores and its copies from outside bring, at its one
          // landing: its candidates the members', and a path hot where any member's contents may not fit there
          // (its landing: one set, or the place outside it that feeds it, asked)
          const shared = cycles.get(component[0]!);
          const feeder = fed.get(component[0]!);
          const lands = (path: readonly string[]): boolean =>
            shared === undefined ? this.#landed(component[0]!, path) : shared.has(pathText(path));
          const candidates = new Map<string, readonly string[]>();
          const put = (path: readonly string[]): void => {
            work.charge("indexSteps");
            candidates.set(keptText(this.#work, path), path);
          };
          const types = new Map<string, Set<TypeTerm>>();
          const classes = new Map<string, InheritedCopy>();
          for (const [index, member] of component.entries()) {
            work.charge("indexSteps");
            for (const [text, levels] of seeds.get(member) ?? []) {
              put(keptSplit(this.#work, text));
              let found = types.get(text);
              if (found === undefined) types.set(text, (found = new Set()));
              for (const level of levels) found.add(level);
            }
            const own = owns[index]!;
            for (const path of own?.points ?? []) if (lands(path)) put(path);
            // (its other values and its reads, everything landed below each)
            for (const prefixes of [own?.below ?? [], (own?.reads ?? []).map(({ at }) => at)])
              for (const prefix of prefixes)
                for (const text of this.#landedBelow(member, prefix))
                  put(keptSplit(this.#work, text));
            for (const copy of into.get(member) ?? []) {
              if (cycleOf.get(copy.from) === cycle) continue;
              const origin = origins.get(copy.from) ?? copy.from;
              const id = keptParts(this.#work, origin, copy.path, copy.strip);
              if (!classes.has(id))
                classes.set(id, origin === copy.from ? copy : { ...copy, from: origin });
            }
          }
          for (const copy of classes.values())
            for (const path of hots.get(copy.from) ?? []) {
              work.charge("indexSteps");
              if (isPrefix(copy.strip, path))
                put(keptSteps(this.#work, copy.path, path.slice(copy.strip.length)));
            }
          // (two written types at one path of the cycle's landing: each of its paths tested)
          if (
            shared !== undefined &&
            ([...types.values()].some((levels) => levels.size > 1) || classes.size > 1)
          )
            for (const text of shared) put(keptSplit(this.#work, text));
          const hot: (readonly string[])[] = [];
          for (const path of candidates.values())
            if (component.some((member) => this.#hotAt(member, path))) hot.push(path);
          for (const member of component)
            for (const path of retaken.get(member) ?? []) if (lands(path)) hot.push(path);
          for (const member of component) {
            hots.set(member, hot);
            origins.set(member, member);
            this.#bounds.set(member, shared === undefined ? bound(feeder!) : shared.size);
            loose.set(member, contents);
          }
          continue;
        }
        // (a cycle whose copies add or take steps: every landed path of each member tested, and each store taken
        // again kept, Sol's review r1 B4)
        for (const member of component) {
          const hot: (readonly string[])[] = [];
          for (const text of cycles.get(member)!) {
            const path = keptSplit(this.#work, text);
            if (this.#hotAt(member, path)) hot.push(path);
          }
          for (const path of retaken.get(member) ?? [])
            if (cycles.get(member)!.has(pathText(path))) hot.push(path);
          hots.set(member, hot);
          origins.set(member, member);
          this.#bounds.set(member, cycles.get(member)!.size);
          loose.set(member, contents);
        }
        continue;
      }
      const place = component[0]!;
      const copies = into.get(place) ?? [];
      // its copies, a copy of a place standing for one source by that source
      const classes = new Map<string, InheritedCopy>();
      let landing = seeds.get(place)?.size ?? 0;
      for (const copy of copies) {
        work.charge("indexSteps");
        const origin = origins.get(copy.from) ?? copy.from;
        const id = keptParts(this.#work, origin, copy.path, copy.strip);
        if (!classes.has(id))
          classes.set(id, origin === copy.from ? copy : { ...copy, from: origin });
        landing = Math.min(Number.MAX_SAFE_INTEGER, landing + 1 + bound(copy.from));
      }
      this.#bounds.set(place, landing);
      const own = this.#ownStructure(place);
      loose.set(place, this.#looseOf([own], copies, loose));
      const only = classes.size === 1 ? [...classes.values()][0]! : null;
      if (
        only !== null &&
        own === null &&
        !seeds.has(place) &&
        !retaken.has(place) &&
        only.path.length === 0 &&
        only.strip.length === 0
      ) {
        origins.set(place, only.from);
        hots.set(place, hots.get(only.from) ?? []);
        continue;
      }
      const candidates = new Map<string, readonly string[]>();
      const put = (path: readonly string[]): void => {
        work.charge("indexSteps");
        candidates.set(keptText(this.#work, path), path);
      };
      for (const copy of copies)
        for (const path of hots.get(copy.from) ?? []) {
          work.charge("indexSteps");
          if (isPrefix(copy.strip, path))
            put(keptSteps(this.#work, copy.path, path.slice(copy.strip.length)));
        }
      for (const text of seeds.get(place)?.keys() ?? []) put(keptSplit(this.#work, text));
      for (const path of own?.points ?? []) if (this.#landed(place, path)) put(path);
      for (const prefix of own?.below ?? [])
        for (const text of this.#landedBelow(place, prefix)) put(keptSplit(this.#work, text));
      for (const path of this.#meeting(copies, own?.reads ?? [], loose)) put(path);
      const hot: (readonly string[])[] = [];
      for (const path of candidates.values()) if (this.#hotAt(place, path)) hot.push(path);
      for (const path of retaken.get(place) ?? []) if (this.#landed(place, path)) hot.push(path);
      hots.set(place, hot);
    }
    this.#hots = hots;
    return hots;
  }

  /**
   * A place's own contributions besides its copies of inheriting places (`#hotSets`, `OwnStructure`): each store's
   * literals and constants at their paths (another kind may stand there), its reads of other places' keys and calls'
   * results with where they stand (`#meeting` tests them, once per configuration), and any other value at its path with
   * what lies below it (host data through an operation: anything); a written binding's copy stands where it lands
   * (`#hotSets`). `null` where there is none.
   */
  #ownStructure(place: PlaceId): OwnStructure | null {
    const known = this.#owns.get(place);
    if (known !== undefined) return known;
    const { definitions } = this.pass;
    const work = this.pass.program.work;
    const copies = new Set<string>();
    for (const copy of this.#inheritance().into.get(place) ?? [])
      copies.add(keptParts(this.#work, copy.path, copy.from, copy.strip));
    const points: (readonly string[])[] = [];
    const below: (readonly string[])[] = [];
    const reads: { readonly at: readonly string[]; readonly source: Key }[] = [];
    const root = keyOf(place, []);
    for (const key of [root, ...definitions.keysBelow(root)])
      for (const d of definitions.byKey.get(key) ?? []) {
        work.charge("indexSteps");
        if (d.kind === "const") points.push(d.path);
        if ((d.kind !== "whole" && d.kind !== "add") || d.value === undefined) continue;
        const base =
          d.kind === "add" && d.how !== "elements"
            ? keptSteps(this.#work, d.path, ["element"])
            : d.path;
        const stops = this.#stopsOf(d.value, d.node);
        // (a copy the place's copies list stands for its source's contents, its value with it)
        const copying = new Set<string>();
        for (const list of stops.written.values())
          for (const stop of list) {
            work.charge("indexSteps");
            if (stop.from === null) continue;
            const at = keptSteps(this.#work, base, stop.path);
            if (copies.has(keptParts(this.#work, at, stop.from, stop.strip)))
              copying.add(keptParts(this.#work, stop.path, stop.value));
            else below.push(at);
          }
        for (const list of stops.values.values())
          for (const stop of list) {
            work.charge("indexSteps");
            if (copying.has(keptParts(this.#work, stop.path, stop.value))) continue;
            const at = keptSteps(this.#work, base, stop.path);
            const source = stop.deep ? null : this.#sourceOf(stop.value);
            const kinds = this.#quietKinds(stop.value);
            if (source !== null)
              reads.push({ at, source: keptKeyBelow(this.#work, source, stop.strip) });
            else if (
              kinds !== null &&
              kinds.every((tag) => SCALAR.has(tag) || tag === "null") &&
              stop.strip.length === 0
            )
              points.push(at);
            else below.push(at);
          }
        for (const list of stops.literals.values())
          for (const stop of list) {
            work.charge("indexSteps");
            points.push(keptSteps(this.#work, base, stop.path));
          }
      }
    const found =
      points.length === 0 && below.length === 0 && reads.length === 0
        ? null
        : { points, below, reads };
    this.#owns.set(place, found);
    return found;
  }

  /**
   * Where a place's copies of different identities (`#identity`: what they land and hold, whichever place they come
   * from), or its reads, may meet a written type another of its copies lands (`#hotSets`, TABLE r4.86 (2)). Its groups
   * in a canonical order (widest first, then by identity) walk the configurations (`Configuration`): what each group
   * adds to the groups before it is found once for every place holding that prefix (`#joined`), whatever else the place
   * holds; each read once per configuration (`#readMeets`); each way's locals once per configuration (`#localsMeet`).
   * Groups no configuration serves are listed once per call (`Running`); the others are asked.
   */
  #meeting(
    copies: readonly InheritedCopy[],
    reads: OwnStructure["reads"],
    loose: ReadonlyMap<PlaceId, Loose>,
  ): readonly (readonly string[])[] {
    const work = this.pass.program.work;
    const groups = new Map<string, Group>();
    for (const copy of copies) {
      work.charge("indexSteps");
      const { root, strip, locals } = this.#identity(copy.from, copy.strip);
      const id = keptParts(this.#work, root, strip, copy.path);
      let group = groups.get(id);
      if (group === undefined)
        groups.set(id, (group = { root, strip, path: copy.path, locals: new Set() }));
      if (locals !== null) group.locals.add(locals);
    }
    if (groups.size === 0 || (groups.size === 1 && reads.length === 0)) return [];
    const bound = (group: Group): number => this.#bounds.get(group.root) ?? 0;
    const ordered = [...groups].sort(
      ([a, left], [b, right]) => bound(right) - bound(left) || (a < b ? -1 : a > b ? 1 : 0),
    );
    work.charge("indexSteps", ordered.length + sortCost(ordered.length));
    const run: Running = {
      lands: new Map(),
      under: new Map(),
      points: new Map(),
      below: new Map(),
      served: [],
      loose,
      accounts: new Map(),
    };
    const out = new Map<string, readonly string[]>();
    const put = (list: readonly (readonly string[])[]): void => {
      for (const path of list) {
        work.charge("indexSteps");
        out.set(keptText(this.#work, path), path);
      }
    };
    let node = this.#configurations;
    let first = true;
    for (const [id, group] of ordered) {
      let next = node.next.get(id);
      if (next === undefined) {
        const added = first ? [] : this.#joined(group, run, loose);
        if (first) run.served.push(group);
        next = { id: this.#configurationCount++, next: new Map(), added, reads: new Map() };
        node.next.set(id, next);
      } else run.served.push(group);
      first = false;
      put(next.added);
      node = next;
    }
    for (const read of reads) {
      work.charge("indexSteps");
      const { root, strip, locals } = this.#identity(
        keyPlace(read.source),
        keptPath(this.#work, read.source),
      );
      const held: Held = { root, strip, at: read.at, locals };
      const id = keptParts(this.#work, root, strip, read.at);
      let found = node.reads.get(id);
      if (found === undefined) node.reads.set(id, (found = this.#readMeets(held, run)));
      put(found);
      if (locals !== null) this.#localsMeet(locals, read.at, node, run, put);
    }
    for (const [, group] of ordered)
      for (const chain of group.locals) this.#localsMeet(chain, group.path, node, run, put);
    return [...out.values()];
  }

  /**
   * What a group adds to the meeting of the groups before it (`#meeting`), listing it (`Running`): every path it lands,
   * its contents beside its landings (`Loose`, `#flatLoose`) where a group before it lands, and every landed path below
   * where those contents are opaque; of those, where a written type landed there may not meet the contents there
   * (`#tested`).
   */
  #joined(group: Group, run: Running, loose: ReadonlyMap<PlaceId, Loose>): (readonly string[])[] {
    const work = this.pass.program.work;
    const touched = new Map<string, readonly string[]>();
    const lands = this.#groupBelow(group, group.path);
    for (const path of lands) {
      work.charge("indexSteps");
      const text = keptText(this.#work, path);
      touched.set(text, path);
      let entry = run.lands.get(text);
      if (entry === undefined) run.lands.set(text, (entry = { path, groups: [] }));
      entry.groups.push(group);
      // (an index of the listed landings by every prefix, for the opaque contents above them)
      for (let length = 0; length <= path.length; length += 1) {
        work.charge("indexSteps");
        const at = keptText(this.#work, path.slice(0, length));
        const list = run.under.get(at);
        if (list === undefined) run.under.set(at, [text]);
        else list.push(text);
      }
    }
    const flat = this.#flatLoose(group.root, group.strip, loose);
    const mark = (map: Map<string, Group[]>, text: string): void => {
      const found = map.get(text);
      if (found === undefined) map.set(text, [group]);
      else if (!found.includes(group)) found.push(group);
    };
    for (const rest of flat.points) {
      work.charge("indexSteps");
      const path = keptSteps(this.#work, group.path, rest);
      const text = keptText(this.#work, path);
      mark(run.points, text);
      if (this.#landsAny(run, path, text)) touched.set(text, path);
    }
    for (const rest of flat.below) {
      work.charge("indexSteps");
      const prefix = keptSteps(this.#work, group.path, rest);
      mark(run.below, keptText(this.#work, prefix));
      for (const path of this.#landedUnder(run, prefix))
        touched.set(keptText(this.#work, path), path);
    }
    return this.#tested(touched, run, null, run.accounts);
  }

  /**
   * What a read meets of a configuration (`#meeting`): its source's own structure where it is smaller than the landings
   * below the read and holds nothing opaque above it (its points where a group lands them, every landed path below its
   * opaque values), else every landed path at or below the read, never a group's whole landing beyond it; tested with
   * the read's contents beside the groups' (`#tested`).
   */
  #readMeets(read: Held, run: Running): (readonly string[])[] {
    const work = this.pass.program.work;
    const touched = new Map<string, readonly string[]>();
    const take = (paths: readonly (readonly string[])[]): void => {
      for (const path of paths) touched.set(keptText(this.#work, path), path);
    };
    const own = this.#ownStructure(read.root);
    const opaque = this.#opaqueAt(read.root);
    let covered = own === null;
    for (let length = 0; length <= read.strip.length && !covered; length += 1) {
      work.charge("indexSteps");
      covered = opaque.has(keptText(this.#work, read.strip.slice(0, length)));
    }
    const groups = [...run.served];
    for (const { groups: landing } of run.lands.values())
      for (const group of landing) if (!groups.includes(group)) groups.push(group);
    if (
      covered ||
      own!.points.length + own!.below.length + own!.reads.length >=
        this.#landingsBelow(groups, read.at)
    )
      take(this.#landedUnder(run, read.at));
    else {
      for (const point of own!.points) {
        work.charge("indexSteps");
        if (!isPrefix(read.strip, point)) continue;
        const path = keptSteps(this.#work, read.at, point.slice(read.strip.length));
        if (this.#landsAny(run, path, keptText(this.#work, path))) take([path]);
      }
      for (const prefixes of [own!.below, own!.reads.map(({ at }) => at)])
        for (const prefix of prefixes) {
          work.charge("indexSteps");
          if (isPrefix(read.strip, prefix))
            take(
              this.#landedUnder(
                run,
                keptSteps(this.#work, read.at, prefix.slice(read.strip.length)),
              ),
            );
        }
    }
    // (a fresh account: the read's contents stand beside the groups' at each path)
    return this.#tested(touched, run, read, new Map());
  }

  /**
   * Where a way's locals stand where a group of a configuration lands (`#meeting`): its points there, every landed path
   * below its opaque values; each decided at the place (its contents are its own). Once per locals node, place path and
   * configuration, a chain's nodes shared by every way through them.
   */
  #localsMeet(
    chain: Locals,
    base: readonly string[],
    node: Configuration,
    run: Running,
    put: (list: readonly (readonly string[])[]) => void,
  ): void {
    const work = this.pass.program.work;
    const key = keptParts(this.#work, node.id, base);
    const pending: Locals[] = [];
    let at: Locals | null = chain;
    let met: LocalsMet | null = null;
    for (; at !== null; at = at.next) {
      work.charge("indexSteps");
      const known = this.#localsMet.get(at)?.get(key);
      if (known !== undefined) {
        met = known;
        break;
      }
      pending.push(at);
    }
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const local = pending[index]!;
      const found: (readonly string[])[] = [];
      for (const point of local.points) {
        work.charge("indexSteps");
        const path = keptSteps(this.#work, base, point);
        if (this.#landsAny(run, path, keptText(this.#work, path))) found.push(path);
      }
      for (const prefix of local.below) {
        work.charge("indexSteps");
        for (const path of this.#landedUnder(run, keptSteps(this.#work, base, prefix)))
          found.push(path);
      }
      // (only the nodes that add a path are kept on the way)
      if (found.length > 0) met = { paths: found, next: met };
      let byKey = this.#localsMet.get(local);
      if (byKey === undefined) this.#localsMet.set(local, (byKey = new Map()));
      byKey.set(key, met ?? NO_LOCALS_MET);
    }
    for (let way = met; way !== null && way !== NO_LOCALS_MET; way = way.next) put(way.paths);
  }

  /**
   * Of these paths, where a written type landed there may not meet the contents there whatever stands first
   * (`compatible`): the terms of the groups landing a path, the contents (their roots' contracts) of the groups landing
   * or holding contents there (`Loose`) and of the read, if any. Each path's account (`Account`) takes each group once:
   * the asked ones when it is opened, the listed ones as their lists grow.
   */
  #tested(
    touched: ReadonlyMap<string, readonly string[]>,
    run: Running,
    read: Held | null,
    accounts: Map<string, Account>,
  ): (readonly string[])[] {
    const { contract } = this.pass;
    const work = this.pass.program.work;
    const out: (readonly string[])[] = [];
    const describe = (items: readonly Item[]): string =>
      items.map((item) => `${item.tag}:${item.cert}:${item.reasons}`).join(",");
    for (const [text, path] of touched) {
      let account = accounts.get(text);
      const opened = account === undefined;
      if (account === undefined) {
        account = {
          landers: 0,
          points: 0,
          below: Array<number>(path.length + 1).fill(0),
          contented: new Set(),
          terms: new Map(),
          contents: new Map(),
          met: false,
        };
        accounts.set(text, account);
      }
      if (account.met) continue;
      const found = account;
      const term = (group: Group): void => {
        work.charge("checks");
        const at = this.#inheritedAt(
          group.root,
          keptSteps(this.#work, group.strip, path.slice(group.path.length)),
        );
        found.terms.set(at === null ? "" : typeTags(at).join("|"), at);
      };
      const content = (key: Key): void => {
        work.charge("checks");
        const items = withoutEmpty(this.#run(contract.contractOf(key)));
        const described = describe(items);
        keepText(this.#work, described.length);
        found.contents.set(described, items);
      };
      const holds = (group: Group): void => {
        if (found.contented.has(group)) return;
        found.contented.add(group);
        content(
          keptKey(this.#work, group.root, joinSteps(group.strip, path.slice(group.path.length))),
        );
      };
      if (opened) {
        // (the asked groups, once: they land, hold, or neither)
        for (const group of run.served) {
          work.charge("indexSteps");
          if (this.#groupLands(group, path)) {
            term(group);
            holds(group);
          } else if (this.#flatHolds(group, path, run.loose)) holds(group);
        }
        if (read !== null && isPrefix(read.at, path))
          content(
            keptKey(this.#work, read.root, joinSteps(read.strip, path.slice(read.at.length))),
          );
      }
      // (the listed ones beyond what the account has taken)
      const landing = run.lands.get(text)?.groups ?? [];
      for (; found.landers < landing.length; found.landers += 1) {
        const group = landing[found.landers]!;
        term(group);
        holds(group);
      }
      const points = run.points.get(text) ?? [];
      for (; found.points < points.length; found.points += 1) holds(points[found.points]!);
      for (let length = 0; length <= path.length; length += 1) {
        work.charge("indexSteps");
        const below = run.below.get(keptText(this.#work, path.slice(0, length))) ?? [];
        for (; found.below[length]! < below.length; found.below[length]! += 1)
          holds(below[found.below[length]!]!);
      }
      if (found.terms.size === 0) continue;
      let meets = !found.terms.has("");
      for (const at of found.terms.values())
        for (const items of found.contents.values()) {
          if (!meets) break;
          work.charge("checks");
          meets = compatible(items, at);
        }
      if (!meets) {
        found.met = true;
        out.push(path);
      }
    }
    return out;
  }

  /** Whether a group of a call lands a place's path (`Running`): listed by its landings, else asked. */
  #landsAny(run: Running, path: readonly string[], text: string): boolean {
    if (run.lands.has(text)) return true;
    for (const group of run.served) {
      this.pass.program.work.charge("indexSteps");
      if (this.#groupLands(group, path)) return true;
    }
    return false;
  }

  /** Whether a group's root holds contents beside its landings at a place's path (`#flatLoose`). */
  #flatHolds(group: Group, path: readonly string[], loose: ReadonlyMap<PlaceId, Loose>): boolean {
    if (!isPrefix(group.path, path)) return false;
    const flat = this.#flatLoose(group.root, group.strip, loose);
    const rest = path.slice(group.path.length);
    if (flat.pointTexts.has(pathText(rest))) return true;
    for (let length = 0; length <= rest.length; length += 1) {
      this.pass.program.work.charge("indexSteps");
      if (flat.belowTexts.has(pathText(rest.slice(0, length)))) return true;
    }
    return false;
  }

  /** The landed paths of a call's groups at or below a place's prefix (`Running`): listed by the index, else asked. */
  #landedUnder(run: Running, prefix: readonly string[]): (readonly string[])[] {
    const out: (readonly string[])[] = [];
    for (const text of run.under.get(keptText(this.#work, prefix)) ?? []) {
      this.pass.program.work.charge("indexSteps");
      out.push(run.lands.get(text)!.path);
    }
    for (const group of run.served)
      for (const path of this.#groupBelow(group, prefix)) out.push(path);
    return out;
  }

  /**
   * A root's contents beside its landings below a strip (`Loose`), flattened to rests from the strip: its points, and the
   * prefixes below which it may hold anything; through its sources' contents, each node, strip and rest once. Once per
   * root and strip.
   */
  #flatLoose(
    root: PlaceId,
    strip: readonly string[],
    loose: ReadonlyMap<PlaceId, Loose>,
  ): FlatLoose {
    const key = keptParts(this.#work, root, strip);
    const known = this.#flatLooses.get(key);
    if (known !== undefined) return known;
    const work = this.pass.program.work;
    const flat: FlatLoose = { points: [], below: [], pointTexts: new Set(), belowTexts: new Set() };
    const seen = new Set<string>();
    const ids = new Map<Loose, number>();
    const tasks: {
      readonly loose: Loose;
      readonly strip: readonly string[];
      readonly rest: readonly string[];
    }[] = [{ loose: loose.get(root) ?? NO_LOOSE, strip, rest: [] }];
    const point = (rest: readonly string[]): void => {
      const text = keptText(this.#work, rest);
      if (flat.pointTexts.has(text)) return;
      flat.pointTexts.add(text);
      flat.points.push(rest);
    };
    const under = (rest: readonly string[]): void => {
      const text = keptText(this.#work, rest);
      if (flat.belowTexts.has(text)) return;
      flat.belowTexts.add(text);
      flat.below.push(rest);
    };
    while (tasks.length > 0) {
      const task = tasks.pop()!;
      if (task.loose === NO_LOOSE) continue;
      let id = ids.get(task.loose);
      if (id === undefined) ids.set(task.loose, (id = ids.size));
      const at = keptParts(this.#work, id, task.strip, task.rest);
      if (seen.has(at)) continue;
      seen.add(at);
      for (const each of task.loose.points) {
        work.charge("indexSteps");
        if (isPrefix(task.strip, each))
          point(keptSteps(this.#work, task.rest, each.slice(task.strip.length)));
      }
      for (const prefix of task.loose.below) {
        work.charge("indexSteps");
        if (isPrefix(task.strip, prefix))
          under(keptSteps(this.#work, task.rest, prefix.slice(task.strip.length)));
        else if (isPrefix(prefix, task.strip)) under(task.rest);
      }
      // (a source's own copies' contents, the two steps composed: theirs, then this one's)
      for (const { copy: inner, loose: from } of task.loose.from) {
        work.charge("indexSteps");
        if (isPrefix(task.strip, inner.path))
          tasks.push({
            loose: from,
            strip: inner.strip,
            rest: keptSteps(this.#work, task.rest, inner.path.slice(task.strip.length)),
          });
        else if (isPrefix(inner.path, task.strip))
          tasks.push({
            loose: from,
            strip: keptSteps(this.#work, inner.strip, task.strip.slice(inner.path.length)),
            rest: task.rest,
          });
      }
    }
    this.#flatLooses.set(key, flat);
    return flat;
  }

  /**
   * A bound on the paths a place's groups land at or below a prefix (`#readMeets`): a group's whole landing where the prefix
   * is above its path, else its root's seeds there (an index lookup) where copies land nothing in it, else its bound.
   */
  #landingsBelow(groups: readonly Group[], prefix: readonly string[]): number {
    const { into, cycleOf } = this.#inheritance();
    let total = 0;
    for (const group of groups) {
      this.pass.program.work.charge("indexSteps");
      const bound = this.#bounds.get(group.root) ?? 0;
      if (isPrefix(prefix, group.path)) total += 1 + bound;
      else if (isPrefix(group.path, prefix))
        total +=
          (into.get(group.root)?.length ?? 0) === 0 && !cycleOf.has(group.root)
            ? this.#seedsUnder(
                group.root,
                keptSteps(this.#work, group.strip, prefix.slice(group.path.length)),
              ).length
            : bound;
    }
    return total;
  }

  /** Whether a group of a place's copies lands a path of the place (`#meeting`): its own path, or its root below. */
  #groupLands(group: Group, path: readonly string[]): boolean {
    if (!isPrefix(group.path, path)) return false;
    return (
      path.length === group.path.length ||
      this.#landed(group.root, keptSteps(this.#work, group.strip, path.slice(group.path.length)))
    );
  }

  /** The paths of a place a group of its copies lands at or below a prefix (`#meeting`), its own path with them. */
  #groupBelow(group: Group, prefix: readonly string[]): (readonly string[])[] {
    const out: (readonly string[])[] = [];
    let under: readonly string[];
    if (isPrefix(group.path, prefix))
      under = keptSteps(this.#work, group.strip, prefix.slice(group.path.length));
    else if (isPrefix(prefix, group.path)) under = group.strip;
    else return out;
    if (prefix.length <= group.path.length) out.push(group.path);
    for (const text of this.#landedBelow(group.root, under)) {
      const steps = splitPath(text);
      if (steps.length > group.strip.length)
        out.push(keptSteps(this.#work, group.path, steps.slice(group.strip.length)));
    }
    return out;
  }

  /**
   * What a place holds at and below a path (`Identity`, TABLE r4.86 (2)): where one copy or read reaching the path is
   * all that brings it there (`#stepOf`), what that copy's or read's source holds at its strip, step by step, with each
   * stepped-through place's own contributions below the path; else the place itself. Once per place and path, on an
   * explicit walk (a place met again ends it: a cycle of reads may grow the path).
   */
  #identity(place: PlaceId, strip: readonly string[]): Identity {
    const work = this.pass.program.work;
    const steps: {
      readonly key: string;
      readonly points: readonly (readonly string[])[];
      readonly below: readonly (readonly string[])[];
    }[] = [];
    const walked = new Set<PlaceId>();
    const asked = keptParts(this.#work, place, strip);
    let at = place;
    let under = strip;
    let found: Identity;
    for (;;) {
      // (through places that hold all of one source, and a chain of copies storing nothing at, above or below the path)
      const whole = this.#forwarded(at);
      if (whole.root !== at) {
        at = whole.root;
        under = keptSteps(this.#work, whole.strip, under);
      }
      at = this.#landsThrough(at, under);
      const key = keptParts(this.#work, at, under);
      const known = this.#identities.get(key);
      if (known !== undefined) {
        found = known;
        break;
      }
      const step = walked.has(at) ? null : this.#stepOf(at, under);
      walked.add(at);
      if (step === null) {
        found = { root: at, strip: under, locals: null };
        this.#identities.set(key, found);
        break;
      }
      steps.push({ key, points: step.points, below: step.below });
      at = step.from;
      under = step.strip;
    }
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      work.charge("indexSteps");
      const { key, points, below } = steps[index]!;
      const locals =
        points.length === 0 && below.length === 0
          ? found.locals
          : { points, below, next: found.locals };
      found = { root: found.root, strip: found.strip, locals };
      this.#identities.set(key, found);
    }
    this.#identities.set(asked, found);
    return found;
  }

  /**
   * The place and path a place holds all of (`#identity`): through a place whose one contribution is one whole copy or
   * read at its root, nothing else of its own, outside every cycle, its source's; else the place itself. Once per place,
   * on an explicit walk.
   */
  #forwarded(place: PlaceId): { readonly root: PlaceId; readonly strip: readonly string[] } {
    const { into, seeds, cycleOf } = this.#inheritance();
    const work = this.pass.program.work;
    const chain: { readonly place: PlaceId; readonly strip: readonly string[] }[] = [];
    const walked = new Set<PlaceId>();
    let at = place;
    let found: { readonly root: PlaceId; readonly strip: readonly string[] } | undefined;
    for (;;) {
      found = this.#forwards.get(at);
      if (found !== undefined) break;
      work.charge("indexSteps");
      const copies = into.get(at) ?? [];
      const own = this.#ownStructure(at);
      let step: { readonly from: PlaceId; readonly strip: readonly string[] } | null = null;
      if (
        !walked.has(at) &&
        !cycleOf.has(at) &&
        !seeds.has(at) &&
        this.#retakenOf(at).length === 0
      ) {
        if (copies.length === 1 && own === null && copies[0]!.path.length === 0)
          step = { from: copies[0]!.from, strip: copies[0]!.strip };
        else if (
          copies.length === 0 &&
          own !== null &&
          own.points.length === 0 &&
          own.below.length === 0 &&
          own.reads.length === 1 &&
          own.reads[0]!.at.length === 0
        )
          step = {
            from: keyPlace(own.reads[0]!.source),
            strip: keptPath(this.#work, own.reads[0]!.source),
          };
      }
      walked.add(at);
      if (step === null) {
        found = { root: at, strip: [] };
        this.#forwards.set(at, found);
        break;
      }
      chain.push({ place: at, strip: step.strip });
      at = step.from;
    }
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      work.charge("indexSteps");
      const step = chain[index]!;
      found = { root: found.root, strip: keptSteps(this.#work, found.strip, step.strip) };
      this.#forwards.set(step.place, found);
    }
    return found;
  }

  /**
   * One step of `#identity`: the source and strip a place's one copy or read reaching a path brings there, with the
   * place's own contributions below the path (rests from it); a fed cycle's member steps to its feeder with every
   * member's contributions; `null` where the place holds more there: another cycle's member,
   * a written type of its own landing at or below it, a store taken again there, another copy or read reaching it or one
   * below it, any other value above it.
   */
  #stepOf(
    place: PlaceId,
    strip: readonly string[],
  ): {
    readonly from: PlaceId;
    readonly strip: readonly string[];
    readonly points: readonly (readonly string[])[];
    readonly below: readonly (readonly string[])[];
  } | null {
    const { into, cycleOf, fed } = this.#inheritance();
    const work = this.pass.program.work;
    work.charge("indexSteps");
    const feeder = fed.get(place);
    if (feeder !== undefined) {
      // a member of a cycle of whole copies one place outside it feeds: that place's landings, with every member's own
      // contributions below the path (the cycle's contents flow round it)
      const points: (readonly string[])[] = [];
      const below: (readonly string[])[] = [];
      for (const member of this.#membersOf(place)) {
        for (const path of this.#retakenOf(member)) {
          work.charge("indexSteps");
          if (isPrefix(path, strip) || isPrefix(strip, path)) return null;
        }
        const own = this.#ownStructure(member);
        for (const { at } of own?.reads ?? []) {
          work.charge("indexSteps");
          if (isPrefix(at, strip)) return null;
          if (isPrefix(strip, at)) below.push(keptSlice(this.#work, at, strip.length));
        }
        for (const path of own?.below ?? []) {
          work.charge("indexSteps");
          if (isPrefix(path, strip)) return null;
          if (isPrefix(strip, path)) below.push(keptSlice(this.#work, path, strip.length));
        }
        for (const path of own?.points ?? []) {
          work.charge("indexSteps");
          if (isPrefix(strip, path)) points.push(keptSlice(this.#work, path, strip.length));
        }
      }
      return { from: feeder, strip, points, below };
    }
    if (cycleOf.has(place) || this.#seedsUnder(place, strip).length > 0) return null;
    for (const path of this.#retakenOf(place)) {
      work.charge("indexSteps");
      if (isPrefix(path, strip) || isPrefix(strip, path)) return null;
    }
    let from: PlaceId | null = null;
    let at: readonly string[] = [];
    let reaching = 0;
    for (const copy of into.get(place) ?? []) {
      work.charge("indexSteps");
      if (isPrefix(copy.path, strip)) {
        reaching += 1;
        from = copy.from;
        at = keptSteps(this.#work, copy.strip, strip.slice(copy.path.length));
      } else if (isPrefix(strip, copy.path)) return null;
    }
    const own = this.#ownStructure(place);
    const points: (readonly string[])[] = [];
    const below: (readonly string[])[] = [];
    for (const read of own?.reads ?? []) {
      work.charge("indexSteps");
      if (isPrefix(read.at, strip)) {
        reaching += 1;
        from = keyPlace(read.source);
        at = keptSteps(this.#work, keptPath(this.#work, read.source), strip.slice(read.at.length));
      } else if (isPrefix(strip, read.at)) below.push(keptSlice(this.#work, read.at, strip.length));
    }
    if (reaching !== 1 || from === null) return null;
    for (const path of own?.below ?? []) {
      work.charge("indexSteps");
      if (isPrefix(path, strip)) return null;
      if (isPrefix(strip, path)) below.push(keptSlice(this.#work, path, strip.length));
    }
    for (const path of own?.points ?? []) {
      work.charge("indexSteps");
      if (isPrefix(strip, path)) points.push(keptSlice(this.#work, path, strip.length));
    }
    return { from, strip: at, points, below };
  }

  /** The members of a place's cycle of copies (`Inheritance.order`), once per pass. */
  #membersOf(place: PlaceId): readonly PlaceId[] {
    const { cycleOf, order } = this.#inheritance();
    if (this.#cycleMembers === null) {
      this.#cycleMembers = new Map();
      for (const component of order) {
        this.pass.program.work.charge("indexSteps");
        const cycle = cycleOf.get(component[0]!);
        if (cycle !== undefined) this.#cycleMembers.set(cycle, [...component]);
      }
    }
    return this.#cycleMembers.get(cycleOf.get(place)!) ?? [place];
  }

  /** The paths where a place's own contributions are opaque, any other value or a read (`#met`), once per place. */
  #opaqueAt(place: PlaceId): ReadonlySet<string> {
    let found = this.#opaque.get(place);
    if (found !== undefined) return found;
    const own = this.#ownStructure(place);
    const texts = new Set<string>();
    for (const prefix of own?.below ?? []) {
      this.pass.program.work.charge("indexSteps");
      texts.add(keptText(this.#work, prefix));
    }
    for (const { at } of own?.reads ?? []) {
      this.pass.program.work.charge("indexSteps");
      texts.add(keptText(this.#work, at));
    }
    this.#opaque.set(place, (found = texts));
    return found;
  }

  /** A place's seeds' paths at or below a prefix (`Inheritance.seeds`), from an index of every seed's prefixes. */
  #seedsUnder(place: PlaceId, prefix: readonly string[]): readonly string[] {
    const own = this.#inheritance().seeds.get(place);
    if (own === undefined) return [];
    let index = this.#seedIndex.get(place);
    if (index === undefined) {
      this.#seedIndex.set(place, (index = new Map()));
      for (const text of own.keys()) {
        const steps = keptSplit(this.#work, text);
        for (let length = 0; length <= steps.length; length += 1) {
          this.pass.program.work.charge("indexSteps");
          const at = keptText(this.#work, steps.slice(0, length));
          const list = index.get(at);
          if (list === undefined) index.set(at, [text]);
          else list.push(text);
        }
      }
    }
    return index.get(pathText(prefix)) ?? [];
  }

  /** A place's paths whose stores are taken again (A6, `#retaken`), once per pass. */
  #retakenOf(place: PlaceId): readonly (readonly string[])[] {
    if (this.#retakenByPlace === null) {
      const byPlace = new Map<PlaceId, (readonly string[])[]>();
      for (const key of this.#retaken.keys()) {
        this.pass.program.work.charge("indexSteps");
        const list = byPlace.get(keyPlace(key));
        if (list === undefined) byPlace.set(keyPlace(key), [keptPath(this.#work, key)]);
        else list.push(keptPath(this.#work, key));
      }
      this.#retakenByPlace = byPlace;
    }
    return this.#retakenByPlace.get(place) ?? [];
  }

  /**
   * A place's contents beside its landings (`Loose`), its sources' before: its own stores' (`#ownStructure`) and its
   * copies' sources'; a place that only copies one source whole, nothing of its own, holds that source's.
   */
  #looseOf(
    owns: readonly (OwnStructure | null)[],
    copies: readonly InheritedCopy[],
    loose: ReadonlyMap<PlaceId, Loose>,
    everything = false,
  ): Loose {
    const from: { readonly copy: InheritedCopy; readonly loose: Loose }[] = [];
    const seen = new Set<string>();
    for (const copy of copies) {
      const of = loose.get(copy.from);
      if (of === undefined || of === NO_LOOSE) continue;
      this.pass.program.work.charge("indexSteps");
      const id = keptParts(this.#work, copy.from, copy.path, copy.strip);
      if (seen.has(id)) continue;
      seen.add(id);
      from.push({ copy, loose: of });
    }
    const points: (readonly string[])[] = [];
    const below: (readonly string[])[] = everything ? [[]] : [];
    for (const own of owns) {
      if (own === null) continue;
      this.pass.program.work.charge(
        "indexSteps",
        own.points.length + own.below.length + own.reads.length,
      );
      points.push(...own.points);
      below.push(...own.below);
      for (const { at } of own.reads) below.push(at);
    }
    if (points.length === 0 && below.length === 0 && from.length === 0) return NO_LOOSE;
    const whole = from[0]?.copy;
    if (
      points.length === 0 &&
      below.length === 0 &&
      from.length === 1 &&
      whole !== undefined &&
      whole.path.length === 0 &&
      whole.strip.length === 0
    )
      return from[0]!.loose;
    return { points, below, from };
  }

  /** Whether a place's contents at a path hold a kind its decision there does not admit (`#hotSets`, A5). */
  #hotAt(place: PlaceId, path: readonly string[]): boolean {
    const found = this.#decided(place, path);
    if (found === null || found.tags === null || found.tags.includes("unknown")) return false;
    return offending(withoutEmpty(this.#run(this.pass.contract.contractOf(found.key))), found);
  }

  /**
   * A path copies land in a place that `groups` left out, decided where an answer asks for it (`decide`'s `lazily`):
   * its contents fit, so its decision owes nothing, and its answer is the one deciding it with the copy gives.
   */
  #lazily(place: PlaceId, path: readonly string[]): void {
    if (this.#attempted.has(keyOf(place, path)) || !this.#landed(place, path)) return;
    this.decide(place, path, true);
  }

  /**
   * Under the member-answer oracle (`withMemberOracle`), after the decisions: every path copies land that `groups` left
   * out, compared as a decided one is, so the oracle covers each landed path as when every one was decided.
   */
  public compareLanded(): void {
    if (memberOracle === null) return;
    for (const place of this.#inheritance().into.keys())
      for (const text of this.#landedBelow(place, [])) {
        const path = splitPath(text);
        if (this.#attempted.has(keyOf(place, path))) continue;
        const inputs = this.#inputs(place, path);
        if (inputs !== null) this.#compareMembers(place, path, inputs.prefixes);
      }
  }

  /**
   * The decision of one place at one path (§5), or `null` where nothing is checked: no store reaches it, it lies below
   * a reference (F19a), a settled family needs no scan (A3), or nothing decides. The decision is recorded for the
   * boundary checks' `against` (C9). `lazily`: a path of a copy `groups` leaves to be decided where an answer asks for
   * it (`#lazily`): recorded, its candidates owe nothing (`#hotSets`) and are not taken.
   */
  public decide(root: PlaceId, path: readonly string[], lazily = false): Decision | null {
    const { program, definitions, lists, contract } = this.pass;
    const work = program.work;
    const key = keptKey(this.#work, root, path);
    this.#attempted.add(key);
    const inputs = this.#inputs(root, path);
    if (inputs === null) return null;
    const { direct, prefixes } = inputs;
    if (memberOracle !== null && !lazily) this.#compareMembers(root, path, prefixes);
    const found = this.#decided(root, path, inputs);
    if (found === null || found.tags === null) return null;
    const { nullable, byWritten, permitsNull, decider, transfer, published } = found;
    if (byWritten && !found.own) this.#inheritsWritten.add(key);
    else this.#inheritsWritten.delete(key);
    // an unrestricted written part, or a copy's, decides nothing: every kind fits there, no store owes it anything
    if (found.tags.includes("unknown")) {
      this.#unrestricted.add(key);
      work.charge("checksSkipped");
      return null;
    }
    const tags = found.tags;
    this.decided.set(key, tags);
    this.#nullable.set(key, nullable);
    if (permitsNull) this.#permitsNull.add(key);
    else this.#permitsNull.delete(key);
    this.#deciderSites.set(key, found.site);
    if (lazily) return null;
    const offends = (items: readonly Item[]): boolean => offending(items, found);
    // A5: the direct stores, and the prefixes' whole stores whose source's contract at the path holds an offending kind
    const candidates = new Map<string, Candidate>();
    work.charge("checks", direct.length);
    for (const candidate of direct)
      if (candidate.d.how !== "argument" || transfer || lists.singleSite(candidate.d.fn))
        candidates.set(keptParts(this.#work, candidate.d.uid, candidate.at), candidate);
    if (transfer && path.length > 0)
      for (const d of [
        ...(definitions.byKey.get(keyOf(root, [])) ?? []),
        ...(definitions.deadArguments.get(keyOf(root, [])) ?? []),
      ])
        if (lists.live(d) && d.kind === "whole")
          candidates.set(keptParts(this.#work, d.uid, path), { d, at: path });
    for (const { key: prefix, rest } of prefixes) {
      const stored = contract.prefixStores(prefix);
      const take = (d: Definition): void => {
        const at = d.kind === "add" && d.how !== "elements" ? rest.slice(1) : rest;
        const members = this.#members.get(d);
        candidates.set(
          keptParts(this.#work, d.uid, at),
          members === undefined || !this.#covers(d, at) ? { d, at } : { d, at, members },
        );
        // (beside or above a literal's alias cell its members are their own candidates: their own terms stand there)
        if (members !== undefined && !this.#covers(d, at))
          for (const member of members)
            candidates.set(keptParts(this.#work, member.uid, at), { d: member, at });
      };
      const takeAll = (stores: ReadonlySet<Definition | null>): void => {
        const { wholes, adds } = this.#takeable(stores, byWritten);
        work.charge("checks", wholes.length);
        for (const d of wholes) take(d);
        if (rest[0] !== "element") return;
        work.charge("checks", adds.length);
        for (const d of adds) take(d);
      };
      for (const entry of stored.list) {
        work.charge("checks");
        if (offends(this.#run(contract.entryAt(entry, rest)))) takeAll(entry.ds);
      }
      for (const sub of contract.relevantSubs(stored, rest)) {
        work.charge("checks");
        if (offends(this.#run(contract.subAt(sub.key, rest)))) takeAll(sub.defs);
      }
      // A6: a rejected store is decided again in every pass, where it was rejected
      const retaken = this.#retaken.get(key) ?? [];
      work.charge("checks", retaken.length);
      for (const d of retaken)
        if (
          d.key === prefix &&
          (byWritten || !this.#hostRead(d.value)) &&
          (d.kind === "whole" || (d.kind === "add" && rest[0] === "element"))
        )
          take(d);
    }
    // (a member its class's candidate holds is checked there only, never as its own candidate too: an add is a direct
    // candidate at its element as well as its list's store, a return into a written result its root's at every path
    // (A9), a rejected member is retaken; each charged where it was taken, #1077)
    for (const [key, candidate] of candidates) {
      const representative = this.#representative.get(candidate.d);
      if (
        representative !== undefined &&
        candidates.get(joinParts(representative.uid, candidate.at))?.members !== undefined
      )
        candidates.delete(key);
    }
    const ordered = [...candidates.values()].sort(
      (a, b) => this.sourceOrder(a.d) - this.sourceOrder(b.d),
    );
    work.charge("checks", ordered.length + sortCost(ordered.length));
    contract.facts.decidedPaths += 1;
    return {
      root,
      path,
      label: this.pathLabel(root, path),
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
   * Once per key and pass, so the paths `groups` tests (`#hotAt`) and their decisions share it.
   */
  #decided(
    root: PlaceId,
    path: readonly string[],
    inputs = this.#inputs(root, path),
  ): Decided | null {
    const key = keptKey(this.#work, root, path);
    const known = this.#decisions.get(key);
    if (known !== undefined) return known;
    const found = inputs === null ? null : this.#decision(root, path, key, inputs);
    this.#decisions.set(key, found);
    return found;
  }

  #decision(root: PlaceId, path: readonly string[], key: Key, inputs: Inputs): Decided {
    const { program, lists, contract } = this.pass;
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
    if (path.length > 0 && this.#run(contract.refReceiver(key))) {
      work.charge("checksSkipped");
      return { ...NOTHING, ...none };
    }
    if (path.length > 0 && term === null) {
      // A3: a settled family needs no scan, where no store on the path was rejected
      const clean = this.#clean(root, path);
      const kinds = clean ? withoutEmpty(this.#run(contract.contractOf(key))) : [];
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
    // an inferred root whose every store's contract is plain scalar kinds of one family accepts every store
    if (tags === null && path.length === 0 && !this.#a4Keys.has(keyOf(root, []))) {
      let plain = true;
      const all: ItemTag[] = [];
      for (const { d, at } of direct) {
        work.charge("checks");
        // a multi-site argument decides nothing (F21); a single-site one is the parameter's start value
        if (d.how === "argument" && !lists.singleSite(d.fn)) continue;
        const kinds = at.length === 0 ? this.#quietKinds(d.value) : null;
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
      this.#clean(root, path) &&
      !withoutEmpty(this.#run(contract.contractOf(key))).some((item) => concrete(item))
    ) {
      work.charge("checksSkipped");
      return { ...NOTHING, ...none };
    }
    if (tags === null) {
      const found = this.#drive(this.#scan(direct, prefixes, key));
      if (found !== null)
        ({ tags, nullable, byWritten, permitsNull, decider, site: deciderSite } = found);
      else {
        // C9 r4.12, r4.50 (1): where no contribution decides, but the contract holds kinds beside external data, those
        // kinds are the type the place is published with, so external data a store brings into it owes its check
        // there, named as well as inline (`published`)
        const kinds = withoutEmpty(this.#run(contract.contractOf(key)));
        if (kinds.some((item) => concrete(item)) && kinds.some(isExternal)) {
          tags = [...new Set(kinds.filter((item) => concrete(item)).map((item) => item.tag))];
          deciderSite = this.#concreteSite(direct, prefixes);
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
      withoutEmpty(this.#run(contract.contractOf(key))).some(admitsNumber)
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
    };
  }

  /** The member-answer oracle at a decided path (`withMemberOracle`): every class at each prefix, at its rest. */
  #compareMembers(
    root: PlaceId,
    path: readonly string[],
    prefixes: readonly { readonly key: Key; readonly rest: readonly string[] }[],
  ): void {
    const { guards } = this.pass;
    const report = memberOracle!.report;
    // (a member read through a chain of copies, or its class's, carries its own links' writers, provenance and not the
    // answer: that pair's answers are compared with them set aside, the published records' writers guarded apart)
    // (and its admission: the written type A4 decides it by at the path, TABLE r4.72)
    const answer = (
      d: Definition,
      rest: readonly string[],
      writers: boolean,
    ): { readonly guard: boolean; readonly domain: string; readonly items: readonly string[] } => {
      const alias = this.#aliases.get(d)!;
      const key = aliasKeyAt(alias, rest);
      return {
        guard: key !== null && guards.narrowed(key, alias.read),
        domain: JSON.stringify(
          key === null ? null : this.#writtenDomainAt(alias, rest.slice(alias.at.length)),
        ),
        items: this.valueAt(d, rest)
          .map((item) => itemText(item, writers))
          .sort(),
      };
    };
    const marks = (d: Definition, rest: readonly string[], writers: boolean): string[] =>
      marked(this.valueAt(d, rest))
        .map((item) => itemText(item, writers))
        .sort();
    // (a prefix's whole stores' classes and, below an element step, its adds', §4.5)
    for (const { key: prefix, rest: below } of prefixes)
      for (const add of below[0] === "element" ? [false, true] : [false])
        for (const representative of this.#wholeOf(prefix, add)) {
          const members = this.#members.get(representative);
          const rest = add ? addRest(representative, below) : below;
          if (members === undefined || !this.#covers(representative, rest)) continue;
          for (const member of members) {
            const writers =
              this.#aliases.get(representative)!.chained !== true &&
              this.#aliases.get(member)!.chained !== true;
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
   * The stores a place's path is decided from (§5): its direct candidates (a store beside an unannotated parameter's
   * default none, F21) and the prefixes of the path whole stores or adds reach; `null` for a literal's own cell or
   * property, and where none reaches it.
   */
  #inputs(root: PlaceId, path: readonly string[]): Inputs | null {
    const { program, definitions } = this.pass;
    const place = program.place(root);
    if (
      place.kind.kind === "cell" ||
      place.kind.kind === "property" ||
      program.cellOwner.has(root) ||
      program.hasOf.has(root)
    )
      return null;
    const direct = (definitions.candidates.get(keyOf(root, path)) ?? []).filter(
      (candidate) => !this.#besideDefault(candidate.d),
    );
    const prefixes: { readonly key: Key; readonly rest: readonly string[] }[] = [];
    for (let length = 0; length < path.length; length += 1) {
      program.work.charge("checks");
      const prefix = keyOf(root, path.slice(0, length));
      if (
        (definitions.byKey.get(prefix) ?? []).some((d) => d.kind === "whole" || d.kind === "add") ||
        definitions.deadArguments.has(prefix)
      )
        prefixes.push({ key: prefix, rest: path.slice(length) });
    }
    return direct.length === 0 && prefixes.length === 0 ? null : { direct, prefixes };
  }

  /**
   * A2, A4: the earliest contribution in source order that decides a path (`into`, the decision's own place and path),
   * with what it decides: a lazy merge of the direct stores and the prefixes' whole stores and adds, each read only as
   * far as the scan goes; `null` where none decides.
   */
  *#scan(
    direct: readonly Candidate[],
    prefixes: readonly { readonly key: Key; readonly rest: readonly string[] }[],
    into: Key,
  ): Inheriting<{
    readonly tags: ItemTag[];
    readonly nullable: boolean;
    readonly byWritten: boolean;
    /** The copied written type admits `null` at the path (`#permitsNull`). */
    readonly permitsNull: boolean;
    /** The copied written type at the path, where a copy decides it (`#inheritedAt`). */
    readonly copied: TypeTerm | null;
    readonly decider: Definition;
    readonly site: SourceSite | null;
  } | null> {
    const { program, lists } = this.pass;
    const work = program.work;
    const seen = new Map<string, Item[]>();
    const evaluate = (d: Definition, at: readonly string[]): Item[] => {
      const memoKey = joinParts(d.uid, at);
      let items = seen.get(memoKey);
      if (items === undefined) {
        keepText(this.#work, memoKey.length);
        seen.set(memoKey, (items = this.valueAt(d, at)));
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
    own.sort((a, b) => this.sourceOrder(a.d) - this.sourceOrder(b.d));
    work.charge("checks", direct.length + sortCost(own.length));
    const scans: {
      readonly ds: readonly Definition[];
      readonly at: (index: number) => readonly string[];
    }[] = [{ ds: own.map((candidate) => candidate.d), at: (index) => own[index]!.at }];
    for (const { key: prefix, rest } of prefixes)
      scans.push({ ds: this.#eligibleOf(prefix, rest), at: () => rest });
    for (const { key: prefix, rest } of prefixes)
      if (rest[0] === "element") {
        const adds = this.#eligibleOf(prefix, rest, true);
        scans.push({ ds: adds, at: (index) => addRest(adds[index]!, rest) });
      }
    const positions = scans.map(() => 0);
    let sawNull = false;
    for (;;) {
      let best = -1;
      for (let index = 0; index < scans.length; index += 1)
        if (
          positions[index]! < scans[index]!.ds.length &&
          (best < 0 ||
            this.sourceOrder(scans[index]!.ds[positions[index]!]!) <
              this.sourceOrder(scans[best]!.ds[positions[best]!]!))
        )
          best = index;
      if (best < 0) break;
      const position = positions[best]!++;
      const d = scans[best]!.ds[position]!;
      const at = scans[best]!.at(position);
      work.charge("checks", scans.length);
      const first =
        d.value === undefined ? null : yield* this.#earliestDecider(d.value, d.node, at, into);
      const copied = first?.term ?? null;
      if (copied !== null) {
        // (its type stays strict, but a literal's `null` elements beside the copy make the place optional, ADR 0021
        // 1.3, A8)
        const copiedTags = typeTags(copied);
        return {
          tags: copiedTags.filter((tag) => tag !== "null"),
          nullable:
            sawNull ||
            copiedTags.includes("null") ||
            (this.pass.program.hasOf.has(d.value!) &&
              evaluate(d, at).some((item) => item.tag === "null")),
          byWritten: true,
          permitsNull: copiedTags.includes("null"),
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
   * The site of the earliest contribution of definite kinds at a path no contribution decides (`decide`'s fallback):
   * per store in source order, the first value standing at the path whose own items there are definite kinds (a
   * literal's element, an operand), else the store's own site; `null` without a store.
   */
  #concreteSite(
    direct: readonly Candidate[],
    prefixes: readonly { readonly key: Key; readonly rest: readonly string[] }[],
  ): SourceSite | null {
    const { program, values } = this.pass;
    const tried = [
      ...direct.map(({ d, at }) => ({ d, at })),
      ...prefixes.flatMap(({ key, rest }) =>
        this.#wholeOf(key, false).map((d) => ({ d, at: rest })),
      ),
    ].sort((a, b) => this.sourceOrder(a.d) - this.sourceOrder(b.d));
    program.work.charge("checks", tried.length + sortCost(tried.length));
    const first = tried[0];
    for (const { d, at } of tried) {
      if (d.value === undefined) continue;
      const stops = this.#stopsOf(d.value, d.node);
      const here = [
        ...(stops.written.get(pathText(at)) ?? []),
        ...(stops.values.get(pathText(at)) ?? []),
        ...(stops.literals.get(pathText(at)) ?? []),
      ].sort((x, y) => compareKeys(x.key, y.key));
      program.work.charge("checks", here.length + sortCost(here.length));
      for (const stop of here)
        if (
          deciding(withoutEmpty(this.#run(values.valueItems(stop.value, stop.node, stop.strip))))
            .length > 0
        )
          return program.places[stop.value]?.site ?? d.site;
    }
    return first === undefined ? null : first.d.site;
  }

  /**
   * C9 r4.12 (A1–A7): a destination's admitted type: the written type (its null included), else the decided kinds (an
   * integer decider already widened by an admitted number, a copy of a written integer never: A4), else, where
   * admission decided nothing, the contract's kinds, one family, an integer widened by an admitted number; with `null`
   * where a null contribution is admitted and the decision admits one (a copy of a written type without it does not),
   * and wherever a copy of a written type with it decided, whatever is stored (`#permitsNull`), a written `null` alone
   * too (`[null]`, a decision like any other, never none: the lead's ruling on the merged S6's B1); never the raw union
   * of contributions.
   */
  public admitted(place: PlaceId, path: readonly string[]): ItemTag[] {
    const { program, contract } = this.pass;
    const written = writtenOf(program.place(place).kind);
    const term = written === null ? null : termAt(written, path);
    if (term !== null) return [...new Set(typeTags(term).filter((tag) => tag !== "unknown"))];
    this.#lazily(place, path);
    const key = keyOf(place, path);
    // (a copy of an unrestricted written part admits every kind, as the part itself: never what is stored)
    if (this.#unrestricted.has(key)) return ["unknown"];
    const kinds = withoutEmpty(this.#run(contract.contractOf(key)));
    const decided = this.decided.get(key);
    let tags = [
      ...(decided ?? new Set(kinds.filter((item) => concrete(item)).map((item) => item.tag))),
    ];
    if (decided === undefined && tags.includes("integer") && kinds.some(admitsNumber))
      tags = [...new Set(tags.map((tag) => (tag === "integer" ? "number" : tag)))];
    const permitsNull = this.#permitsNull.has(key);
    return (tags.length > 0 || permitsNull) &&
      (permitsNull ||
        (this.#nullable.get(key) !== false && kinds.some((item) => item.tag === "null")))
      ? [...tags, "null"]
      : tags;
  }

  /** Whether a copy of a written type decides a place's path, not the place's own written type (A4, r4.75 (1)). */
  public inheritsWritten(place: PlaceId, path: readonly string[]): boolean {
    this.#lazily(place, path);
    return this.#inheritsWritten.has(keyOf(place, path));
  }

  /**
   * The site of the contribution that decided a place's path (A2's earliest definite one, A4's copy, S3 §1), `null`
   * where no store decides it. A path A3 settled without a scan (a settled family, a plain scalar root) has its earliest
   * definite contribution found here, once, where an answer asks for it.
   */
  public deciderAt(place: PlaceId, path: readonly string[]): SourceSite | null {
    this.#lazily(place, path);
    const key = keyOf(place, path);
    if (!this.#deciderSites.has(key)) {
      const inputs = this.#inputs(place, path);
      const below = path.length > 0 && this.#run(this.pass.contract.refReceiver(key));
      keepText(this.#work, key.length);
      this.#deciderSites.set(
        key,
        inputs === null || below
          ? null
          : (this.#drive(this.#scan(inputs.direct, inputs.prefixes, key))?.site ?? null),
      );
    }
    return this.#deciderSites.get(key)!;
  }

  /** Whether no store on the path or a prefix of it was rejected (A6) or copies a written binding (A4). */
  #clean(root: PlaceId, path: readonly string[]): boolean {
    for (let length = 0; length <= path.length; length += 1) {
      this.pass.program.work.charge("checks");
      const at = keyOf(root, path.slice(0, length));
      if (this.#rejectedKeys.has(at) || this.#a4Keys.has(at)) return false;
    }
    return true;
  }

  /**
   * A prefix's whole stores in source order (A2's lazy scan), returns, parameter defaults and single-site arguments among
   * them (a single-site parameter starts as its argument), or its adds. A read of a host value decides no path below it
   * (external data, no kind and no `null`), so the scan passes none.
   */
  #wholeOf(key: Key, add: boolean): Definition[] {
    const memoKey = joinParts(key, add);
    let list = this.#whole.get(memoKey);
    if (list === undefined) {
      const { definitions, lists, program } = this.pass;
      const stores = definitions.byKey.get(key) ?? [];
      program.work.charge("indexSteps", stores.length);
      list = stores.filter(
        (d) =>
          lists.live(d) &&
          !this.#hostRead(d.value) &&
          (add
            ? d.kind === "add"
            : d.kind === "whole" &&
              (d.how !== "argument" || lists.singleSite(d.fn)) &&
              !this.#besideDefault(d)),
      );
      program.work.charge("checks", sortCost(list.length));
      list.sort((a, b) => this.sourceOrder(a) - this.sourceOrder(b));
      list = this.#grouped(list);
      keepText(this.#work, memoKey.length);
      this.#whole.set(memoKey, list);
    }
    return list;
  }

  /**
   * A prefix's whole stores as A2's scan reads them at a rest (S6-CARRIERS §4.2, §4.3): each class's representative,
   * and where a guard of the path holds it, its class's earliest eligible member too, which stands where it is in source
   * order and decides with its own answer (a guard marks a read possible, so it decides nothing).
   */
  #eligibleOf(prefix: Key, below: readonly string[], add = false): Definition[] {
    const list = this.#wholeOf(prefix, add);
    let out: Definition[] | null = null;
    for (const [index, representative] of list.entries()) {
      const members = this.#members.get(representative);
      if (members === undefined) continue;
      const rest = add ? addRest(representative, below) : below;
      if (!this.#covers(representative, rest)) {
        // (beside or above a literal's alias cell each member stands by itself)
        out ??= list.slice(0, index);
        for (const member of members) out.push(member);
        continue;
      }
      const eligible = this.#eligibleAt(representative, prefix, rest);
      if (eligible === null || eligible === representative) continue;
      out ??= list.slice(0, index);
      out.push(eligible);
    }
    if (out === null) return list;
    // (the representatives and the eligible members, in source order)
    const merged = [...new Set([...list, ...out])];
    this.pass.program.work.charge("eligibility", sortCost(merged.length));
    return merged.sort((a, b) => this.sourceOrder(a) - this.sourceOrder(b));
  }

  /**
   * §4.3: a class's earliest member that no test of its read's path holds at `rest`, `null` where every member is
   * guarded there: by the deepest tested key on the path's chain of prefixes, from the class's eligibility index.
   */
  #eligibleAt(representative: Definition, prefix: Key, rest: readonly string[]): Definition | null {
    const { guards } = this.pass;
    const at = aliasKeyAt(this.#aliases.get(representative)!, rest);
    const full = at === null ? null : recordKey(at);
    let deepest = "";
    for (const key of full === null ? [] : [full, ...prefixesOf(full)]) {
      this.pass.program.work.charge("eligibility");
      if (tested(guards, key)) {
        deepest = key;
        break;
      }
    }
    // (while the groups are made, a path `#hotSets` tests asks its chain by itself: the index wants every decided path,
    // which the groups give once made; each chain's answer is the index's, Sol's review r1 B1)
    if (this.#groups === null) {
      let chains = this.#eligibleWhileGrouping.get(representative);
      if (chains === undefined)
        this.#eligibleWhileGrouping.set(representative, (chains = new Map()));
      if (!chains.has(deepest)) {
        keepText(this.#work, deepest.length);
        chains.set(deepest, this.#eligibleBy(representative, [deepest]));
      }
      return chains.get(deepest)!;
    }
    let index = this.#eligible.get(representative);
    if (index === undefined) {
      index = this.#eligibility(representative, prefix);
      this.#eligible.set(representative, index);
    }
    if (!index.has(deepest)) index.set(deepest, this.#eligibleBy(representative, [deepest]));
    return index.get(deepest)!;
  }

  /**
   * §4.3's index of a class, once per class and pass: the tested keys on the chains of its demanded paths as a trie,
   * walked depth first over a segment tree of its members in flow order (each leaf a guard count, each node its least
   * count and the earliest member with it): entering a key adds one to every member a test of that key holds (a branch
   * a range of the flow order, or each member asked where its callable holds more branches than members; an operand
   * region each member it holds, a range of the text order), leaving it undoes that. Each key's eligible member is the
   * earliest with no count.
   */
  #eligibility(representative: Definition, prefix: Key): Map<string, Definition | null> {
    const { guards } = this.pass;
    const alias = this.#aliases.get(representative)!;
    const children = new Map<string, Set<string>>([["", new Set()]]);
    for (const demanded of this.#demandsOf(prefix)) {
      // (an add's class answers below its added value: a demand below the list's element)
      if (
        representative.kind === "add" &&
        representative.how !== "elements" &&
        demanded[0] !== "element"
      )
        continue;
      const at = aliasKeyAt(
        alias,
        representative.kind === "add" ? addRest(representative, demanded) : demanded,
      );
      if (at === null) continue;
      const full = recordKey(at);
      let parent = "";
      for (const key of [...keptPrefixes(this.#work, full).reverse(), full]) {
        this.pass.program.work.charge("eligibility");
        if (!tested(guards, key)) continue;
        if (!children.has(key)) children.set(key, new Set());
        children.get(parent)!.add(key);
        parent = key;
      }
    }
    const out = new Map<string, Definition | null>();
    const walk = this.#walkGuards(representative);
    walk.enter(null);
    out.set("", walk.eligible());
    const pending: { readonly key: string; readonly leave: boolean }[] = [
      ...[...children.get("")!].map((key) => ({ key, leave: false })),
    ];
    while (pending.length > 0) {
      const { key, leave } = pending.pop()!;
      this.pass.program.work.charge("eligibility");
      if (leave) {
        walk.leave();
        continue;
      }
      walk.enter(key);
      out.set(key, walk.eligible());
      pending.push({ key, leave: true });
      for (const child of children.get(key) ?? []) pending.push({ key: child, leave: false });
    }
    return out;
  }

  /** A class's eligible member under a chain of tested keys, the index's walk for one chain (a path not demanded). */
  #eligibleBy(representative: Definition, chain: readonly string[]): Definition | null {
    const { guards } = this.pass;
    const walk = this.#walkGuards(representative);
    walk.enter(null);
    const keys = chain[0] === "" ? [] : [...prefixesOf(chain[0]!).reverse(), chain[0]!];
    for (const key of keys) if (tested(guards, key)) walk.enter(key);
    return walk.eligible();
  }

  /** §4.3's walk over a class's members: guard counts per tested key entered, undone in reverse. */
  #walkGuards(representative: Definition): {
    readonly enter: (key: string | null) => void;
    readonly leave: () => void;
    readonly eligible: () => Definition | null;
  } {
    const { program, guards } = this.pass;
    const work = program.work;
    const members = [representative, ...(this.#members.get(representative) ?? [])];
    const reads = members.map((d) => this.#aliases.get(d)!.read);
    // (an unreached read is never guarded: always eligible)
    const unreached = members.findIndex((_, index) => !program.reached(reads[index]!));
    // members in flow order (their reads' positions) and in text order (file, offset), as leaf indexes
    const flow = members.map((_, index) => index);
    flow.sort((a, b) => program.position(reads[a]!) - program.position(reads[b]!));
    work.charge("eligibility", sortCost(flow.length));
    const leafOf = new Map<number, number>(flow.map((member, leaf) => [member, leaf]));
    const positions = flow.map((member) => program.position(reads[member]!));
    const text = members.map((_, index) => index).filter((index) => reads[index]!.span !== null);
    text.sort(
      (a, b) =>
        reads[a]!.file - reads[b]!.file ||
        reads[a]!.span!.start.offset - reads[b]!.span!.start.offset,
    );
    work.charge("eligibility", sortCost(text.length));
    const byCallable = new Map<Callable | null, number[]>();
    for (const member of flow) {
      const callable = program.callableAt(reads[member]!);
      const list = byCallable.get(callable);
      if (list === undefined) byCallable.set(callable, [member]);
      else list.push(member);
    }
    const tree = new GuardTree(flow, work);
    const log: (readonly [number, number])[][] = [];
    const lowerBound = (list: readonly number[], value: number, from = 0): number => {
      let low = from;
      let high = list.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        work.charge("eligibility");
        if (list[middle]! < value) low = middle + 1;
        else high = middle;
      }
      return low;
    };
    const textStarts = text.map((member) => reads[member]!.span!.start.offset);
    const textFiles = text.map((member) => reads[member]!.file);
    return {
      enter: (key) => {
        const done: (readonly [number, number])[] = [];
        log.push(done);
        if (key === null) return;
        const add = (low: number, high: number): void => {
          tree.add(low, high, 1);
          done.push([low, high]);
        };
        for (const [callable, inCallable] of byCallable) {
          const branches = guards.branchesOf(key, callable);
          if (branches === undefined) continue;
          if (branches.list.length > inCallable.length) {
            for (const member of inCallable)
              if (guards.branchHolds(key, reads[member]!)) {
                const leaf = leafOf.get(member)!;
                add(leaf, leaf);
              }
            continue;
          }
          for (const entry of branches.list) {
            const low = lowerBound(positions, program.position(entry));
            const high = lowerBound(positions, program.positionEnd(entry) + 1) - 1;
            if (low <= high) add(low, high);
          }
        }
        for (const file of new Set(textFiles)) {
          const regions = guards.operandsOf(key, file);
          if (regions === undefined) continue;
          const first = lowerBound(textFiles, file);
          for (const region of regions.list) {
            let at = lowerBound(textStarts, region.start, first);
            for (
              ;
              at < text.length && textFiles[at] === file && textStarts[at]! <= region.end;
              at += 1
            ) {
              const leaf = leafOf.get(text[at]!)!;
              add(leaf, leaf);
            }
          }
        }
      },
      leave: () => {
        for (const [low, high] of log.pop() ?? []) tree.add(low, high, -1);
      },
      eligible: () => {
        const leaf = tree.eligible();
        const found = leaf === null ? -1 : flow[leaf]!;
        const index = unreached >= 0 && (found < 0 || unreached < found) ? unreached : found;
        return index < 0 ? null : members[index]!;
      },
    };
  }

  /** The rests below a key of the paths the pass decides (`groups()`): every split of every decided path, once. */
  #demandsOf(prefix: Key): readonly (readonly string[])[] {
    if (this.#demands === null) {
      const demands = new Map<Key, (readonly string[])[]>();
      for (const { root, path } of this.groups())
        for (let length = 0; length < path.length; length += 1) {
          this.pass.program.work.charge("eligibility");
          const key = keptKey(this.#work, root, path.slice(0, length));
          const rest = keptSlice(this.#work, path, length);
          const list = demands.get(key);
          if (list === undefined) demands.set(key, [rest]);
          else list.push(rest);
        }
      this.#demands = demands;
    }
    return this.#demands.get(prefix) ?? [];
  }

  /**
   * §8, S6-CARRIERS §4.1, §4.5: a key's whole stores, or its adds, by alias class (`#aliasKey`), once per pass, in the
   * key's own list (`#wholeOf`): their earliest as the representative, the later ones its members (`#members`); a scan
   * or a check reads the representative, and a member only where it owes something.
   */
  #grouped(list: readonly Definition[]): Definition[] {
    const out: Definition[] = [];
    const first = new Map<string, Definition>();
    for (const d of list) {
      this.pass.program.work.charge("indexSteps");
      const key = this.#aliasKey(d);
      const representative = key === null ? undefined : first.get(key);
      if (representative === undefined) {
        if (key !== null) {
          keepText(this.#work, key.length);
          first.set(key, d);
        }
        out.push(d);
        continue;
      }
      this.#representative.set(d, representative);
      const members = this.#members.get(representative);
      if (members === undefined) this.#members.set(representative, [d]);
      else members.push(d);
    }
    return out;
  }

  /**
   * Stores as their classes stand for them (§4.1): each store's class representative, from its key's own list, once
   * each, in source order; any other store as itself.
   */
  #representatives(list: readonly Definition[]): Definition[] {
    const out: Definition[] = [];
    const seen = new Set<Definition>();
    for (const d of list) {
      this.pass.program.work.charge("indexSteps");
      if (d.kind === "whole" || d.kind === "add") this.#wholeOf(d.key, d.kind === "add");
      const representative = this.#representative.get(d) ?? d;
      if (seen.has(representative)) continue;
      seen.add(representative);
      out.push(representative);
    }
    return out;
  }

  /**
   * S6-CARRIERS §4.1: the class a whole store's value, or an add's added value (§4.5: its class by its mode, an element
   * or an `addAll`'s elements), is an alias in: where it is a stable source path (`#stablePath`), or a literal whose one
   * read cell is one and whose other cells are terms, at that cell's path, the literal's identity beside it (r4.17: no
   * guard in it). The path, with the read's exact-path signature (`aliasSignature`), the handlers' facts at its node and
   * the written type A4 decides the copy by: stores of one class bring equal answers below the path, their own guards
   * apart (a literal's only below its cell, `#covers`); `null` for any other store (an own entry).
   */
  #aliasKey(d: Definition): string | null {
    const { program, lists, handlers, contract } = this.pass;
    if ((d.kind !== "whole" && d.kind !== "add") || d.value === undefined || !sharing())
      return null;
    program.work.charge("aliasSteps");
    let alias: Alias | null = null;
    let shape = "";
    let written = "";
    const whole = this.#stablePath(d.value, d.node);
    if (whole !== null) {
      alias = { source: whole.source, read: whole.read, at: [], value: d.value };
      written = whole.written;
    } else if (program.hasOf.has(d.value)) {
      const index = contract.literalIndex(d.value);
      if (index.others.size > 0 || index.references.size > 0) return null;
      let cell: { readonly path: string; readonly value: PlaceId } | null = null;
      for (const [path, list] of index.reads)
        for (const entry of list) {
          program.work.charge("aliasSteps");
          if (cell !== null) return null;
          cell = { path, value: entry.value };
        }
      // (one read, one guard: equal reads of one source in one literal are one entry, alike guarded or not; and the
      // read the only contribution at and below its path, no term, object or empty collection of the literal's own
      // there beside it, Codex r22 F5, nor an object on the way to it without its next step, whose `missing` stands
      // there too, Codex r23 F2)
      if (cell === null || [...index.exact.values()].flat().length !== 1) return null;
      const at = cell.path;
      const beside = (path: string): boolean => path === at || path.startsWith(`${at}.`);
      for (const paths of [index.terms.keys(), index.objects.keys(), index.empty.keys()])
        for (const path of paths) {
          program.work.charge("aliasSteps");
          if (beside(path)) return null;
        }
      const steps = splitPath(at);
      for (let length = 0; length < steps.length; length += 1) {
        program.work.charge("aliasSteps");
        const objects = index.objects.get(pathText(steps.slice(0, length)));
        if (objects !== undefined && (objects.count.get(steps[length]!) ?? 0) < objects.list.length)
          return null;
      }
      const read = this.#stablePath(cell.value, d.node);
      if (read === null) return null;
      alias = {
        source: read.source,
        read: read.read,
        at: keptSplit(this.#work, cell.path),
        value: cell.value,
      };
      written = read.written;
      shape = `${contract.identityOf(d.value).id}@${cell.path}`;
    }
    if (alias === null) return null;
    this.#aliases.set(d, alias);
    // (§4.1's chains: the class of the read its clean copy's source is, to the chain's end; a member whose own source a
    // test touches keeps that source in its class, so one key's tests guard each class's members, §4.3)
    const end = this.#chainEnd(alias.source, alias.read);
    if (end !== null) alias.chained = true;
    const read = end ?? { ...alias, written };
    return [
      // (an add's class stands below its added value, element by element or as its elements, §4.5)
      d.kind === "add" ? `add:${d.how === "elements" ? "elements" : "element"}` : "",
      shape,
      end === null || this.#untested(alias.source) ? "" : alias.source,
      read.source,
      read.written,
      lists.aliasSignature(read.source, read.read),
      handlers.afterSomeCreation(read.read) ? "h" : "",
      // (the member's own copied binding's written type at its read, A4's decider, whatever its chain resolves to:
      // `let b: integer[] = raw` is no `let a = raw`, TABLE r4.72)
      this.#writtenDomainKey(alias),
    ].join("|");
  }

  /**
   * The written type an alias's read copies at its path (A4: a copy of a written binding is decided by it), as the class
   * key holds it: the type, or the unwritten place whose own decision it copies with the path into it (`#inheritedAt`),
   * `null` where the copied binding has none; the member's own, never its chain's end's (TABLE r4.72, Astra r5 B1).
   */
  #writtenDomainKey(alias: Alias): string {
    const written = this.#writtenSource(alias.value, []);
    if (written === null) return "null";
    return written.from === null
      ? JSON.stringify(permittedAt(written.term!, written.strip))
      : `inherits ${written.from} ${keptText(this.#work, written.strip)}`;
  }

  /** The written type an alias's read copies at `rest` below its path (`#writtenDomainKey`), `null` where none. */
  #writtenDomainAt(alias: Alias, rest: readonly string[]): TypeTerm | null {
    const written = this.#writtenSource(alias.value, []);
    if (written === null) return null;
    const path = joinSteps(written.strip, rest);
    return written.from === null
      ? permittedAt(written.term!, path)
      : this.#inheritedAt(written.from, path);
  }

  /**
   * §4.1's identity and chains: where a read's exact path is clean (X1–X7 pass: its reaching definition reaches every
   * path below it, with no event between) and that definition's value is itself a stable source path, read where no
   * test of its keys holds it, the read stands for that read, its rest after it; followed to the chain's end, once per
   * read and pass, each link charged once. `null` where the read is its own end.
   */
  #chainEnd(source: Key, read: FlowNode): ChainEnd | null {
    if (chainsOff) return null;
    const first = keptParts(this.#work, source, read.id);
    const known = this.#chains.get(first);
    if (known !== undefined) return known;
    const { program, exact, guards } = this.pass;
    const links = new Set<string>([first]);
    let end: ChainEnd | null = null;
    let current = { source, read };
    for (;;) {
      program.work.charge("aliasSteps");
      const answer = exact.exactPath(current.source, current.read);
      if ("fail" in answer || answer.def.kind !== "whole" || answer.def.value === undefined) break;
      const value = answer.def.value;
      const next = this.#stablePath(value, answer.def.node);
      if (next === null || guards.guardedRead(value) || guards.guardedBelowRead(value).length > 0)
        break;
      current = { source: keptKeyBelow(this.#work, next.source, answer.rest), read: next.read };
      end = {
        ...current,
        written: keptText(
          this.#work,
          joinSteps([next.written], answer.rest).filter((x) => x !== ""),
        ),
      };
      const key = keptParts(this.#work, current.source, current.read.id);
      const known = this.#chains.get(key);
      if (known !== undefined) {
        end = known ?? end;
        break;
      }
      // (a cycle of copies ends where it closes)
      if (links.has(key)) break;
      links.add(key);
    }
    for (const key of links) this.#chains.set(key, end);
    return end;
  }

  /** Whether no test touches a source key: none of it, of a prefix of it, or of a key below it (§3.2). */
  #untested(source: Key): boolean {
    const { guards, program } = this.pass;
    const key = recordKey(source);
    if (guards.belowTested.has(key)) return false;
    for (const each of [key, ...prefixesOf(key)]) {
      program.work.charge("aliasSteps");
      if (tested(guards, each)) return false;
    }
    return true;
  }

  /**
   * Whether a class answers as one at `rest` below its stores (§4.1): a copy's everywhere, a literal's below its alias
   * cell only (beside or above it each literal's own terms stand, with their own writers).
   */
  #covers(representative: Definition, rest: readonly string[]): boolean {
    const at = this.#aliases.get(representative)?.at ?? [];
    return rest.length >= at.length && at.every((step, index) => rest[index] === step);
  }

  /**
   * §4.1's stable source path a value reads: a binding (no host global) and property steps or literal indexes, the node
   * it is read at, and the path as written (distinct literal indexes are distinct paths, one key's `element`).
   */
  #stablePath(
    value: PlaceId,
    node: FlowNode,
  ): { readonly source: Key; readonly read: FlowNode; readonly written: string } | null {
    const { program } = this.pass;
    const steps: string[] = [];
    const written: string[] = [];
    let at = value;
    let reading = node;
    for (let projection = program.projOf.get(at); projection !== undefined;) {
      program.work.charge("aliasSteps");
      const index = projection.step === "index" ? literalIndex(projection.node) : null;
      if (!propertyOnly(projection.step) && index === null) return null;
      steps.push(stepName(projection.step));
      written.push(index === null ? stepName(projection.step) : `[${index}]`);
      reading = projection.node ?? reading;
      at = projection.owner;
      projection = program.projOf.get(at);
    }
    const binding = program.occurrenceOf.get(at);
    if (binding === undefined || program.isHost(binding)) return null;
    return {
      source: keptKey(this.#work, binding, steps.reverse()),
      read: program.occNode.get(at) ?? reading,
      written: keptText(this.#work, written.reverse()),
    };
  }

  /**
   * A5: the stores that brought a prefix's source, as candidates: live, no multi-site argument (F21) (a return, a
   * parameter default and a single-site argument are stores into the result or the parameter, F20–F23), and a read of
   * a host value only against a written type (a read of one below its store owes nothing
   * at a decided type: A7's whole-store exception leaves it the boundary check its own path's candidate owes, C9, and it
   * holds no kind and no `null`); the whole stores and the adds, once per set of stores.
   */
  #takeable(
    stores: ReadonlySet<Definition | null>,
    byWritten: boolean,
  ): { readonly wholes: readonly Definition[]; readonly adds: readonly Definition[] } {
    let known = this.#takeables.get(stores);
    if (known === undefined) this.#takeables.set(stores, (known = []));
    const index = byWritten ? 1 : 0;
    const found = known[index];
    if (found !== undefined) return found;
    const { lists, program } = this.pass;
    program.work.charge("indexSteps", stores.size);
    const wholes: Definition[] = [];
    const adds: Definition[] = [];
    for (const d of stores)
      if (
        d !== null &&
        (byWritten || !this.#hostRead(d.value)) &&
        lists.live(d) &&
        (d.how !== "argument" || lists.singleSite(d.fn)) &&
        !this.#besideDefault(d)
      )
        if (d.kind === "whole") wholes.push(d);
        else if (d.kind === "add") adds.push(d);
    wholes.sort((a, b) => this.sourceOrder(a) - this.sourceOrder(b));
    adds.sort((a, b) => this.sourceOrder(a) - this.sourceOrder(b));
    return (known[index] = {
      wholes: this.#representatives(wholes),
      adds: this.#representatives(adds),
    });
  }

  /** Whether a value is a read of a host value: external data, with no kind and no `null` at any path. */
  #hostRead(value: PlaceId | undefined): boolean {
    const { program } = this.pass;
    const binding = value === undefined ? undefined : program.occurrenceOf.get(value);
    return binding !== undefined && program.isHost(binding);
  }

  /** §3.3: a value's contract kinds, `null` with an unknown. */
  #quietKinds(value: PlaceId | undefined): ItemTag[] | null {
    if (value === undefined) return null;
    const items = withoutEmpty(this.#run(this.pass.contract.contractOfValueAt(value, [])));
    return items.length === 0 || items.some((item) => item.tag === "unknown")
      ? null
      : items.map((item) => item.tag);
  }

  // ------------------------------------------------------------------------------------------- literals

  /**
   * A value's source key: the key a copy reads, a call's callee's result key (F20), a dict's `values` read as its
   * elements (r4.46 (2)); `null` for any other value and for a dict's `keys`, which hold text.
   */
  #sourceOf(value: PlaceId): Key | null {
    const { contract, program } = this.pass;
    const key = contract.copiedKey(value) ?? contract.resultKey(value);
    if (key === null) return null;
    const path: string[] = [];
    for (const [index, step] of keyPath(key).entries()) {
      const list = dictList(step);
      if (list !== undefined) {
        program.work.charge("indexSteps");
        const owner = withoutEmpty(
          this.#run(contract.contractOf(keyOf(keyPlace(key), keyPath(key).slice(0, index)))),
        );
        if (owner.some((item) => item.tag === "dict")) {
          if (list === "keys") return null;
          continue;
        }
      }
      path.push(step);
    }
    return keyOf(keyPlace(key), path);
  }

  /** The value side's decisions the carrier table asks before it carries (`carriers.ts`). */
  readonly #dispatch: Dispatch = {
    kinds: (of) =>
      new Set(this.#run(this.pass.contract.contractOfValue(of)).map((item) => item.tag)),
    reference: (receiver) => heldReference(this.#run(this.pass.contract.valueReceiver(receiver))),
  };

  /** The values a value carries, with the path into each its value is read at: the carrier table's (`carried`). */
  #carriersOf(
    value: PlaceId,
    strip: readonly string[],
  ): readonly (readonly [PlaceId, readonly string[], CarrierRole, number])[] {
    return carried(this.pass.program, value, strip, this.#dispatch);
  }

  /** Whether the receiver's or the key's decision leaves a value's operation its own value (F19a, F19: `keepsOwn`). */
  #keepsOwn(value: PlaceId): boolean {
    return keepsOwn(this.pass.program, value, this.#dispatch);
  }

  /** A stored value's own structure: its literals' fields and elements at every depth, and their sources (F2). */
  #valueStructure(value: PlaceId): Structure {
    const id = `v${value}`;
    let structure = this.#structures.get(id);
    if (structure === undefined) {
      structure = this.#collect([{ value, at: [], strip: [] }]);
      this.#structures.set(id, structure);
    }
    return structure;
  }

  /**
   * A source key's own structure (F2): the elements, at every depth, of the values stored at it or at a prefix of it (an
   * add's below its element), cut to the key's path, and of the keys below it with stores. A copied record's fields are
   * none of it: they are admitted at their first read (A2, TABLE q12).
   */
  #keyStructure(key: Key): Structure {
    const id = `k${key}`;
    const known = this.#structures.get(id);
    if (known !== undefined) return known;
    const { definitions, lists, program } = this.pass;
    const place = keyPlace(key);
    // (its steps, which the roots' rests below keep, charged by the key's text)
    const path = keptPath(this.#work, key);
    const roots: { value: PlaceId; at: readonly string[]; strip: readonly string[] }[] = [];
    const levels: (readonly string[])[] = [];
    // a store's value standing at `below` (an add's below its element), read at `strip`: below the key, at its path or
    // above it (the rest of the path read into it), or beside it (none)
    const root = (d: Definition, below: readonly string[], strip: readonly string[]): void => {
      program.work.charge("indexSteps");
      if (!((d.kind === "whole" || d.kind === "add") && d.value !== undefined && lists.live(d)))
        return;
      const at =
        d.kind === "add" && d.how !== "elements"
          ? keptSteps(this.#work, below, ["element"])
          : below;
      for (let index = 0; index < at.length && index < strip.length; index += 1)
        if (at[index] !== strip[index]) return;
      // (a rest made here is charged as kept; a whole one is shared)
      roots.push(
        at.length > strip.length
          ? {
              value: d.value,
              at: strip.length === 0 ? at : keptSlice(this.#work, at, strip.length),
              strip: [],
            }
          : {
              value: d.value,
              at: [],
              strip: at.length === 0 ? strip : keptSlice(this.#work, strip, at.length),
            },
      );
    };
    for (let length = 0; length <= path.length; length += 1) {
      const stores = definitions.byKey.get(keyOf(place, path.slice(0, length))) ?? [];
      // (a prefix's stores share one rest of the key's path)
      const rest = stores.length === 0 ? [] : keptSlice(this.#work, path, length);
      for (const d of stores) root(d, [], rest);
    }
    for (const below of definitions.keysBelow(key)) {
      const at = keptSlice(this.#work, keptPath(this.#work, below), path.length);
      if (at.some((step) => step !== "element")) continue;
      levels.push(at);
      for (const d of definitions.byKey.get(below) ?? []) root(d, at, []);
    }
    const structure = this.#collect(roots, levels, true);
    keepText(this.#work, id.length);
    this.#structures.set(id, structure);
    return structure;
  }

  /**
   * The structure of values standing at paths below a value or key: each root's value standing at `at`, read below
   * `strip` (a key's path below a prefix's store, a carrier's step into its value): their literals' fields and elements,
   * walked as their literals nest (below a key its elements only), through the values they carry, and the source key of
   * each value no literal holds, with the levels of the keys below with stores.
   */
  #collect(
    roots: readonly { value: PlaceId; at: readonly string[]; strip: readonly string[] }[],
    levels: readonly (readonly string[])[] = [],
    elements = false,
  ): Structure {
    const { program, definitions } = this.pass;
    const paths = new Map<string, readonly string[]>();
    const sources = new Map<string, { readonly below: readonly string[]; readonly key: Key }>();
    // (each path's text charged by its size before it is made, TABLE r4.58)
    const path = (at: readonly string[]): void => {
      if (at.length === 0) return;
      const text = keptText(this.#work, at);
      if (!paths.has(text)) paths.set(text, at);
    };
    for (const at of levels)
      for (let length = 1; length <= at.length; length += 1)
        path(keptSlice(this.#work, at, 0, length));
    const pending: (readonly [PlaceId, readonly string[], readonly string[]])[] = [];
    for (let index = roots.length - 1; index >= 0; index -= 1)
      pending.push([roots[index]!.value, roots[index]!.at, roots[index]!.strip]);
    while (pending.length > 0) {
      const [current, at, strip] = pending.pop()!;
      program.work.charge("indexSteps");
      if (!program.hasOf.has(current)) {
        // a source stands at `at`, read at the rest of the path (a source read at a path no key or read of the program
        // reaches is a recursion: cut); any other value through the values it carries
        const source = this.#sourceOf(current);
        if (source !== null) {
          // (read past the longest key, it is cut there, never dropped: whether a literal holds a source, and so which
          // obligations its paths owe, never depends on the keys elsewhere in the program, TABLE r4.67 (1))
          const room = Math.max(0, this.#longestKey() - keyPath(source).length);
          const key = keptKeyBelow(this.#work, source, strip.slice(0, room));
          sources.set(keptParts(this.#work, at, key), { below: at, key });
          continue;
        }
        const carried = this.#carriersOf(current, strip);
        for (let index = carried.length - 1; index >= 0; index -= 1)
          pending.push([carried[index]![0], at, carried[index]![1]]);
        continue;
      }
      // (its cells' tasks share one rest of the strip, charged as kept)
      let rest: readonly string[] | null = null;
      for (const has of program.hasOf.get(current)!) {
        // while reading into it only the field on the path (its literal's fields indexed once), then every field
        const on = strip.length > 0 ? this.#termAt(has.type, strip[0]!) : undefined;
        const fields: readonly (readonly [string, TypeTerm])[] =
          strip.length === 0 ? fieldsOf(has.type) : on === undefined ? [] : [[strip[0]!, on]];
        for (const [name, term] of fields) {
          program.work.charge("indexSteps");
          if (strip.length === 0 && elements && name !== "element") continue;
          const step = strip.length === 0 ? keptSteps(this.#work, at, [name]) : at;
          if (strip.length === 0) path(step);
          if (term.kind === "ref")
            for (const d of definitions.cellDefs.get(term.place) ?? []) {
              rest ??= strip.length === 0 ? strip : keptSlice(this.#work, strip, 1);
              pending.push([d.value!, step, rest]);
            }
        }
      }
    }
    return { paths: [...paths.values()], sources: [...sources.values()] };
  }

  /** The longest path of a key with stores or of a read's or a call's projections in the program. */
  #longestKey(): number {
    if (this.#keyBound !== null) return this.#keyBound;
    const { program, definitions } = this.pass;
    let longest = 0;
    for (const [key] of definitions.byKey) {
      program.work.charge("indexSteps");
      longest = Math.max(longest, keyPath(key).length);
    }
    const chains = new Map<PlaceId, number>();
    for (const [value] of program.projOf) {
      const way: PlaceId[] = [];
      let current = value;
      while (program.projOf.has(current) && !chains.has(current)) {
        program.work.charge("indexSteps");
        way.push(current);
        current = program.projOf.get(current)!.owner;
      }
      let length = chains.get(current) ?? 0;
      for (let index = way.length - 1; index >= 0; index -= 1)
        chains.set(way[index]!, (length += 1));
      longest = Math.max(longest, length);
    }
    return (this.#keyBound = longest);
  }

  /**
   * The element depth of a source key's known structure, its sources' followed (F2): once per key, a cycle of copies
   * (Tarjan's components) one turn of it for each of its keys, so the copies of one source share it and every order
   * gives one answer.
   */
  #depthOf(key: Key): number {
    const known = this.#depths.get(key);
    if (known !== undefined) return known;
    const { program, contract } = this.pass;
    const work = program.work;
    // (a key whose contract holds no collection has no elements to follow)
    const flat = (at: Key): boolean => {
      const none = !withoutEmpty(this.#run(contract.contractOf(at))).some(
        (item) => item.tag === "list" || item.tag === "set" || item.tag === "dict",
      );
      if (none) this.#depths.set(at, 0);
      return none;
    };
    if (flat(key)) return 0;
    const order = new Map<Key, number>();
    const low = new Map<Key, number>();
    const stack: Key[] = [];
    const open = new Set<Key>();
    const frames: { readonly key: Key; next: number }[] = [];
    const enter = (at: Key): void => {
      order.set(at, order.size);
      low.set(at, order.get(at)!);
      stack.push(at);
      open.add(at);
      frames.push({ key: at, next: 0 });
    };
    enter(key);
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      const { sources } = this.#keyStructure(frame.key);
      if (frame.next < sources.length) {
        const target = sources[frame.next++]!.key;
        work.charge("indexSteps");
        if (this.#depths.has(target)) continue;
        if (!order.has(target) && !flat(target)) enter(target);
        else if (open.has(target))
          low.set(frame.key, Math.min(low.get(frame.key)!, order.get(target)!));
        continue;
      }
      frames.pop();
      const parent = frames.at(-1);
      if (parent !== undefined)
        low.set(parent.key, Math.min(low.get(parent.key)!, low.get(frame.key)!));
      if (low.get(frame.key) !== order.get(frame.key)) continue;
      const members = new Set<Key>();
      for (let member = stack.pop()!; ; member = stack.pop()!) {
        open.delete(member);
        members.add(member);
        if (member === frame.key) break;
      }
      // the deepest own element and source's below the component; a source inside it once around
      let depth = 0;
      let turn = 0;
      for (const member of members) {
        const own = this.#keyStructure(member);
        for (const path of own.paths) depth = Math.max(depth, path.length);
        for (const source of own.sources) {
          work.charge("indexSteps");
          if (members.has(source.key)) turn = Math.max(turn, source.below.length);
          else depth = Math.max(depth, source.below.length + this.#depths.get(source.key)!);
        }
      }
      for (const member of members) this.#depths.set(member, depth + turn);
    }
    return this.#depths.get(key)!;
  }

  /** The paths below a literal's element its known structure gives (F2), and `also`, each once. */
  #pathsBelow(value: PlaceId, also: readonly (readonly string[])[]): (readonly string[])[] {
    const work = this.pass.program.work;
    const out = new Map<string, readonly string[]>();
    const put = (path: readonly string[]): void => {
      work.charge("indexSteps");
      {
        const text = keptText(this.#work, path);
        if (!out.has(text)) out.set(text, path);
      }
    };
    const structure = this.#valueStructure(value);
    for (const path of structure.paths) put(path);
    for (const { below, key } of structure.sources) {
      let path = below;
      for (let depth = this.#depthOf(key); depth > 0; depth -= 1)
        put((path = keptSteps(this.#work, path, ["element"])));
    }
    for (const path of also) put(path);
    return [...out.values()];
  }

  /**
   * The paths below a collection literal's elements that its own literals give or admission decides where the literal
   * lands (a read's path, A2): there a named element's fields are compared too (TABLE q12: a field is copy-only until
   * a literal or a read reaches it).
   */
  #sharedPaths(landing: Key | null, list: readonly Definition[]): (readonly string[])[] {
    const { program } = this.pass;
    const out = new Map<string, readonly string[]>();
    const put = (path: readonly string[]): void => {
      program.work.charge("indexSteps");
      {
        const text = path.length > 0 ? keptText(this.#work, path) : "";
        if (path.length > 0 && !out.has(text)) out.set(text, path);
      }
    };
    for (const d of list)
      if (d.value !== undefined) for (const path of this.#valueStructure(d.value).paths) put(path);
    if (landing !== null) for (const path of this.#decidedBelow(landing)) put(path);
    return [...out.values()];
  }

  /**
   * Where a collection literal's elements land: the store holding the literal, through the literals around it, at its
   * element step; `null` for a literal no store holds.
   */
  #landing(literal: PlaceId): Key | null {
    const { program, definitions } = this.pass;
    const steps: string[] = [];
    for (let value = literal; ;) {
      program.work.charge("indexSteps");
      const d = (definitions.byValue.get(value) ?? []).find(
        (store) => store.kind === "whole" || store.kind === "add",
      );
      if (d === undefined) return null;
      if (program.cellOwner.has(d.place)) {
        const kind = program.place(d.place).kind;
        steps.push(kind.kind === "property" ? propertyStep(kind.name) : "element");
        value = program.cellOwner.get(d.place)!.owner;
        continue;
      }
      // (an `addAll`'s literal's elements are the destination's own elements)
      return keyOf(
        d.place,
        joinSteps(
          d.kind === "add" && d.how === "elements" ? d.path : this.#destPath(d),
          steps.reverse(),
          ["element"],
        ),
      );
    }
  }

  /** The paths admission decides (`groups`) below a key, indexed once by every prefix of each. */
  #decidedBelow(key: Key): readonly (readonly string[])[] {
    if (this.#below === null) {
      this.#below = new Map();
      for (const { root, path } of this.groups())
        for (let length = 0; length < path.length; length += 1) {
          this.pass.program.work.charge("indexSteps");
          const prefix = keptKey(this.#work, root, path.slice(0, length));
          const rest = keptSlice(this.#work, path, length);
          const paths = this.#below.get(prefix);
          if (paths === undefined) this.#below.set(prefix, [rest]);
          else paths.push(rest);
        }
    }
    return this.#below.get(key) ?? [];
  }

  /** A literal's term at one step: an object's property by its step, a collection's element; built once per literal. */
  #termAt(term: TypeTerm, step: string): TypeTerm | undefined {
    const { work } = this.pass.program;
    work.charge("checks");
    if (term.kind === "list" || term.kind === "set" || term.kind === "dict")
      return step === "element" ? term.element : undefined;
    if (term.kind !== "object") return undefined;
    let fields = this.#fields.get(term);
    if (fields === undefined) {
      fields = new Map();
      for (const property of term.properties ?? []) {
        work.charge("indexSteps");
        const at = propertyStep(property.name);
        if (!fields.has(at)) fields.set(at, property.type);
      }
      this.#fields.set(term, fields);
    }
    // V30 §19: a choice object's selected value, its `value` where it has one, else its `text`
    if (step === SELECTED_VALUE) return fields.get("value");
    if (step === SELECTED_TEXT) return fields.has("value") ? undefined : fields.get("text");
    return fields.get(step);
  }

  /** A literal value's stores at one step, in evaluation order: a property's one store, a collection's every element. */
  public literalChildren(value: PlaceId, step: string): Definition[] {
    const { program, definitions } = this.pass;
    const out: Definition[] = [];
    for (const has of program.hasOf.get(value) ?? []) {
      const term = this.#termAt(has.type, step);
      if (term?.kind === "ref")
        for (const d of definitions.cellDefs.get(term.place) ?? []) out.push(d);
    }
    program.work.charge("checks", sortCost(out.length));
    return out.sort(
      (a, b) =>
        (program.places[a.value!]?.site?.start ?? 0) - (program.places[b.value!]?.site?.start ?? 0),
    );
  }

  /**
   * r4.35: an error for a contribution inside literals sits at the innermost offending expression: the stored value
   * walked along the path through record fields, collection elements and dict values, in evaluation order, to the first
   * value at the path's end whose own items offend.
   */
  public offendingAt(
    d: Definition,
    at: readonly string[],
    leaf: (items: readonly Item[]) => boolean,
  ): Definition | null {
    const pending: [PlaceId, FlowNode, number][] = [[d.value!, d.node, 0]];
    while (pending.length > 0) {
      const [value, node, index] = pending.pop()!;
      const children = this.literalChildren(value, at[index]!);
      if (index + 1 === at.length) {
        for (const child of children) {
          this.pass.program.work.charge("checks");
          if (
            leaf(
              withoutEmpty(
                this.#run(this.pass.values.valueItems(child.value!, child.node ?? node, [])),
              ),
            )
          )
            return child;
        }
      } else
        for (let position = children.length - 1; position >= 0; position -= 1)
          pending.push([children[position]!.value!, children[position]!.node ?? node, index + 1]);
    }
    return null;
  }

  /** The site of an error for a store's contribution: the innermost offending expression inside literals, else the store's. */
  public siteAt(
    d: Definition,
    at: readonly string[],
    leaf: (items: readonly Item[]) => boolean,
  ): SourceSite {
    const found = at.length > 0 && d.kind === "whole" ? this.offendingAt(d, at, leaf) : null;
    return found === null ? d.site : (this.pass.program.place(found.value!).site ?? d.site);
  }

  /** A literal value's stores at one step: a property's one store, a collection's every element. */
  public storesAt(value: PlaceId, step: string): readonly Definition[] {
    const { program, definitions } = this.pass;
    for (const has of program.hasOf.get(value) ?? []) {
      const at = this.#termAt(has.type, step);
      if (at?.kind === "ref") return definitions.cellDefs.get(at.place) ?? [];
    }
    return [];
  }

  /**
   * A4: the bindings a stored value copies, with the paths they land at and the path into each (`strip`), directly,
   * through the literals that hold them, or through the values that carry them (a projection, an operation: the path
   * read into it), in element order; once per value.
   */
  #copySources(
    value: PlaceId,
  ): readonly {
    readonly path: readonly string[];
    readonly binding: PlaceId;
    readonly strip: readonly string[];
  }[] {
    const known = this.#copies.get(value);
    if (known !== undefined) return known;
    const { program, definitions } = this.pass;
    const out: { path: readonly string[]; binding: PlaceId; strip: readonly string[] }[] = [];
    const pending: [PlaceId, readonly string[], readonly string[]][] = [[value, [], []]];
    while (pending.length > 0) {
      const [current, path, strip] = pending.pop()!;
      program.work.charge("indexSteps");
      const binding = program.occurrenceOf.get(current);
      if (binding !== undefined) {
        out.push({ path, binding, strip });
        continue;
      }
      const next: [PlaceId, readonly string[], readonly string[]][] = [];
      // (its cells' tasks share one rest of the strip, charged as kept)
      let rest: readonly string[] | null = null;
      if (program.hasOf.has(current))
        for (const has of program.hasOf.get(current)!) {
          const on = strip.length > 0 ? this.#termAt(has.type, strip[0]!) : undefined;
          const fields: readonly (readonly [string, TypeTerm])[] =
            strip.length === 0 ? fieldsOf(has.type) : on === undefined ? [] : [[strip[0]!, on]];
          for (const [name, term] of fields)
            if (term.kind === "ref") {
              // (one path per field, which its cells share, charged before it is made)
              const child = strip.length === 0 ? keptSteps(this.#work, path, [name]) : path;
              for (const d of definitions.cellDefs.get(term.place) ?? []) {
                rest ??= strip.length === 0 ? strip : keptSlice(this.#work, strip, 1);
                next.push([d.value!, child, rest]);
              }
            }
        }
      else
        for (const [carried, rest] of this.#carriersOf(current, strip))
          next.push([carried, path, rest]);
      for (let index = next.length - 1; index >= 0; index -= 1) pending.push(next[index]!);
    }
    this.#copies.set(value, out);
    return out;
  }

  /**
   * A4, F12: the binding a value copies, directly or through its projections (`typed[0]`, `typed.first`), with the path
   * into it the copy stands at: the projections' steps, then `strip`; with its written type (`term`), or, for an
   * unwritten place that may inherit one (`#inheriting`), that place (`from`: its type at each path the one its own
   * decision copies, `#inheritedAt`); `null` for any other value, and for a projection the written type has no path for
   * (a dict's lists, a length).
   */
  #writtenSource(
    value: PlaceId,
    strip: readonly string[],
  ): {
    readonly term: TypeTerm | null;
    readonly from: PlaceId | null;
    readonly strip: readonly string[];
  } | null {
    const { program, contract } = this.pass;
    const binding = program.occurrenceOf.get(value);
    if (binding !== undefined) {
      const term = writtenOf(program.place(binding).kind);
      if (term !== null) return { term, from: null, strip };
      return this.#inheriting.has(binding) ? { term: null, from: binding, strip } : null;
    }
    const key = program.projOf.has(value) ? contract.copiedKey(value) : null;
    if (key === null) return null;
    const place = keyPlace(key);
    const term = writtenOf(program.place(place).kind);
    if (term === null && !this.#inheriting.has(place)) return null;
    // (a projection of a receiver that may be a reference is the runtime's member, no copy: F19a)
    for (let at = value; program.projOf.has(at); at = program.projOf.get(at)!.owner)
      if (this.#keepsOwn(at)) return null;
    const steps = keyPath(key);
    const path = keptSteps(this.#work, steps, strip);
    if (steps.some((step) => dictList(step) !== undefined)) return null;
    if (term === null) return { term: null, from: place, strip: path };
    return permittedAt(term, path) === null ? null : { term, from: null, strip: path };
  }

  /**
   * A stored value's contributions by the path they stand at, in evaluation order: the copies of written bindings
   * (A4), the other values no literal of it holds (a read, a call, external data), and its literals, whose fields and
   * elements stand below them; once per value.
   */
  #stopsOf(value: PlaceId, node: FlowNode): Stops {
    const known = this.#stops.get(value);
    if (known !== undefined) return known;
    const { program, definitions, contract } = this.pass;
    const stops: Stops = { written: new Map(), values: new Map(), literals: new Map() };
    const sources = new Set<string>();
    // a literal's cells at a step, in evaluation order
    const cells = (literal: PlaceId, step: string | null): (readonly [Definition, string])[] => {
      const next: (readonly [Definition, string])[] = [];
      for (const has of program.hasOf.get(literal) ?? []) {
        const fields: readonly (readonly [string, TypeTerm])[] =
          step === null
            ? fieldsOf(has.type)
            : ((on) => (on === undefined ? [] : [[step, on] as const]))(
                this.#termAt(has.type, step),
              );
        for (const [name, field] of fields)
          if (field.kind === "ref")
            for (const d of definitions.cellDefs.get(field.place) ?? []) next.push([d, name]);
      }
      program.work.charge("checks", sortCost(next.length));
      return next.sort(
        ([x], [y]) =>
          (program.places[x.value!]?.site?.start ?? 0) -
          (program.places[y.value!]?.site?.start ?? 0),
      );
    };
    // a task: its value and node, its path, the strip still read into it, whether below an operation, its chain of
    // operations, whether it is a carrier's own contribution, whether single, its evaluation key; each array a task or a
    // stop keeps is the one it came from, shared, or made by a kept helper
    const pending: (readonly [
      PlaceId,
      FlowNode,
      readonly string[],
      readonly string[],
      boolean,
      readonly Via[],
      boolean,
      boolean,
      EvaluationKey,
    ])[] = [[value, node, [], [], false, [], false, true, []]];
    // a cell's position: its value's place in the literal's own source, never its index in a list one step filtered
    // (each evaluation key and chain of operations a task or stop keeps is charged as kept, TABLE r4.78 (5): k nested
    // operations keep k keys and chains up to k long)
    const cellKey = (key: EvaluationKey, d: Definition): EvaluationKey =>
      keptSteps(this.#work, key, [program.places[d.value!]?.site?.start ?? 0]);
    while (pending.length > 0) {
      const [current, at, path, strip, deep, via, after, single, key] = pending.pop()!;
      program.work.charge("indexSteps");
      const written = this.#writtenSource(current, strip);
      const term = written?.term ?? null;
      // A4 through copies: a copy of an unwritten place that may inherit a written type stands as a written copy too,
      // carrying at each path the type that place's own decision copies there (`#inheritedAt`); its value stays where
      // it stood, and decides where it carries none
      if (!after && written !== null && written.from !== null) {
        const inherits: Stop = {
          key,
          value: current,
          node: at,
          path,
          term: null,
          from: written.from,
          strip: written.strip,
          deep,
          single,
          via,
        };
        const text = keptText(this.#work, path);
        const list = stops.written.get(text);
        if (list === undefined) stops.written.set(text, [inherits]);
        else list.push(inherits);
      }
      const literal = term === null && program.hasOf.has(current);
      // a literal read into stands by its cells on the path
      if (literal && strip.length > 0) {
        const next = cells(current, strip[0]!);
        // (its cells' tasks share one rest of the strip, charged as kept)
        const below = next.length === 0 ? strip : keptSlice(this.#work, strip, 1);
        for (let index = next.length - 1; index >= 0; index -= 1)
          pending.push([
            next[index]![0].value!,
            next[index]![0].node ?? at,
            path,
            below,
            deep,
            via,
            false,
            single && next.length === 1,
            cellKey(key, next[index]![0]),
          ]);
        continue;
      }
      // a projection or another carrier is its own contribution at the path, and below it what it carries (F12), an
      // operation's under the certainty of its own value
      // its own contribution comes after what it carries, so a written copy it selects precedes its snapshot (A4)
      if (!after && !literal && term === null && this.#sourceOf(current) === null) {
        const carried = this.#carriersOf(current, strip);
        if (carried.length > 0) {
          pending.push([
            current,
            at,
            path,
            strip,
            deep,
            via,
            true,
            single,
            keptSteps(this.#work, key, [OWN]),
          ]);
          for (let index = carried.length - 1; index >= 0; index -= 1) {
            const [operand, rest, role, position] = carried[index]!;
            const through = program.projOf.has(current)
              ? via
              : keptSteps(this.#work, via, [
                  { value: current, node: at, path, strip, operand, role },
                ]);
            pending.push([
              operand,
              at,
              path,
              rest,
              true,
              through,
              false,
              single,
              keptSteps(this.#work, key, [position]),
            ]);
          }
          continue;
        }
      }
      const map = term !== null ? stops.written : literal ? stops.literals : stops.values;
      const pathKey = keptText(this.#work, path);
      // (a later copy or call of one source identity at a path holds what the first holds: one stop, F2; a copy only
      // where it reads the same snapshot, r4.68 (1); and only through the same operations, selected alike: an operand
      // a `get` never gives is no copy of the store's own element beside it, Astra r5 D1)
      if (
        sharing() &&
        path.length > 0 &&
        map === stops.values &&
        this.#sourceOf(current) !== null
      ) {
        const identity = keptParts(
          this.#work,
          pathKey,
          strip,
          this.#viaSignature(via),
          deep,
          single,
          contract.identityOf(current).id,
          contract.readSnapshot(current) ?? "",
        );
        if (sources.has(identity)) continue;
        sources.add(identity);
      }
      const stop: Stop = {
        key,
        value: current,
        node: at,
        path,
        term,
        from: null,
        strip: term !== null ? written!.strip : strip,
        deep,
        single,
        via,
      };
      const list = map.get(pathKey);
      if (list === undefined) map.set(pathKey, [stop]);
      else list.push(stop);
      if (!literal) continue;
      const next = cells(current, null);
      for (let index = next.length - 1; index >= 0; index -= 1) {
        const [d, step] = next[index]!;
        pending.push([
          d.value!,
          d.node ?? at,
          keptSteps(this.#work, path, [step]),
          [],
          false,
          via,
          false,
          single,
          cellKey(key, d),
        ]);
      }
    }
    // each path's stops in evaluation order: the walk reaches a later row of one operand before an earlier cell
    for (const map of [stops.written, stops.values, stops.literals])
      for (const list of map.values()) {
        program.work.charge("checks", sortCost(list.length));
        list.sort((a, b) => compareKeys(a.key, b.key));
      }
    this.#stops.set(value, stops);
    return stops;
  }

  /**
   * A2, A4, A8 (ADR 0021 1.1–1.3): the earliest contribution in evaluation order that decides a stored value's path: a
   * copy of a written binding (its written type at the rest of the path), or of a place that inherits one there, taken
   * into the decision of `into` (`#inheritedInto`; `null` outside a place's decision), or a value whose items there are
   * of definite kinds; a `null` or an unknown decides nothing, and a value an unknown may stand beside (a read, a copy, a call)
   * neither, while a literal's other elements still may (A8: `[1, hostValue]`'s elements are whole numbers, Sol's
   * records for the owner's F1); a later copy never comes before an earlier definite element. The place's decision and
   * the literal's own elements (`literalElements`) both take it, so they cannot pick opposite deciders. `null` where
   * nothing on the path decides.
   */
  *#earliestDecider(
    value: PlaceId,
    node: FlowNode,
    at: readonly string[],
    into: Key | null,
  ): Inheriting<{ readonly term: TypeTerm | null; readonly site: SourceSite | null } | null> {
    const { program, values } = this.pass;
    const stops = this.#stopsOf(value, node);
    const siteOf = (stop: Stop): SourceSite | null => program.places[stop.value]?.site ?? null;
    // the earliest copy whose written type reaches the rest of the path
    let copy: { readonly key: EvaluationKey; readonly term: TypeTerm; readonly stop: Stop } | null =
      null;
    for (let length = 0; length <= at.length; length += 1) {
      program.work.charge("checks");
      const written = this.#snapshots(stops.written.get(pathText(at.slice(0, length))), false);
      for (const stop of written ?? []) {
        program.work.charge("checks");
        if (copy !== null && compareKeys(stop.key, copy.key) > 0) break;
        // (at the path's end itself a carried copy decides only where it surely is the value there: each literal it was
        // read out of has it alone, and each operation surely gives it)
        if (stop.deep && length === at.length && !(stop.single && this.#selects(stop, true)))
          continue;
        const rest = joinSteps(stop.strip, at.slice(length));
        const term =
          stop.from === null
            ? permittedAt(stop.term!, rest)
            : yield* this.#inheritedInto(stop.from, rest, into);
        // (a written copy an operation carries decides only where the operation selects it: an operand it never gives
        // is no copy of the place, while a selected copy keeps its whole written type, A4)
        if (term !== null && (stop.via.length === 0 || this.#selects(stop)))
          copy = { key: stop.key, term, stop };
      }
    }
    // the values in evaluation order, those standing above the path's end with its rest, the literals at its end
    const lists: { readonly list: readonly Stop[]; readonly length: number }[] = [];
    // (a value a projection selects stands for its parts below the path, never at it)
    for (let length = 0; length <= at.length; length += 1) {
      const list = this.#snapshots(
        stops.values.get(pathText(at.slice(0, length))),
        length === at.length,
      );
      if (list !== undefined) lists.push({ list, length });
    }
    const literals = this.#snapshots(stops.literals.get(pathText(at)), true);
    if (literals !== undefined) lists.push({ list: literals, length: at.length });
    const positions = lists.map(() => 0);
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
        return copy === null ? null : { term: copy.term, site: siteOf(copy.stop) };
      program.work.charge("checks", lists.length);
      positions[best]! += 1;
      // (a typed default's literal is the call's input, not the stored value's own element: where the default holds host
      // data it leaves the path open, and the call decides nothing there beside it, F18, TABLE r4.66 (3))
      if (next.via.some((level) => TYPED_ROLES.has(level.role))) continue;
      const rest = at.slice(lists[best]!.length);
      const items = withoutEmpty(
        this.#run(values.valueItems(next.value, next.node, joinSteps(next.strip, rest))),
      );
      const definite = items.some((item) => item.tag === "unknown") ? [] : deciding(items);
      // (an operand its operation does not give decides nothing, F17a, F17b)
      if (
        definite.length > 0 &&
        this.#chosen(next.via) &&
        this.#through(
          next.via,
          at,
          definite.map((item) => item.tag),
        )
      )
        return { term: null, site: siteOf(next) };
    }
  }

  /**
   * A list of a walk's stops as the decider reads it, once per list: each snapshot once (TABLE §8: one key read here,
   * r4.68 (1)), so of the reads of one key through one chain of operations at one strip that read the same only the
   * first is read, the later ones holding what it holds (k reads of one host global, decided at k paths: Codex r23 F1);
   * so too k calls of one function (r4.15, Codex r24 F2's neighbours); `shallow` leaves out the values a projection
   * selects.
   */
  #snapshots(list: readonly Stop[] | undefined, shallow: boolean): readonly Stop[] | undefined {
    if (list === undefined) return undefined;
    let memo = this.#snapshotLists.get(list);
    if (memo === undefined) this.#snapshotLists.set(list, (memo = []));
    const known = memo[shallow ? 1 : 0];
    if (known !== undefined) return known;
    const out = this.#distinct(shallow ? list.filter((stop) => !stop.deep) : list);
    this.pass.program.work.charge("checks", list.length);
    memo[shallow ? 1 : 0] = out;
    return out;
  }

  /**
   * Stops with each snapshot once, in their order: of the reads of one key through one chain of operations at one strip
   * that read the same (`Contract.readSnapshot`), and of k calls of one function (as in the literal index, r4.15), the
   * first; any other stop as itself.
   */
  #distinct(list: readonly Stop[]): Stop[] {
    if (!sharing()) return [...list];
    const { program, contract } = this.pass;
    const seen = new Set<string>();
    const out: Stop[] = [];
    for (const stop of list) {
      program.work.charge("checks");
      const read =
        contract.readSnapshot(stop.value) ??
        (contract.resultKey(stop.value) === null ? null : `c${contract.identityOf(stop.value).id}`);
      if (read !== null) {
        const snapshot = joinParts(
          this.#viaSignature(stop.via),
          stop.strip,
          stop.deep,
          stop.single,
          read,
        );
        if (seen.has(snapshot)) continue;
        keepText(this.#work, snapshot.length);
        seen.add(snapshot);
      }
      out.push(stop);
    }
    return out;
  }

  /**
   * A chain of operations by what selects through it (S6-CARRIERS §4.5's via signature): each level's carrier value
   * and role, its operand aside, so a choice's options read alike while a fallback's two operands, or a `get`'s receiver
   * and default, stay apart. Once per chain.
   */
  #viaSignature(via: readonly Via[]): string {
    let known = this.#viaSignatures.get(via);
    if (known === undefined) {
      this.pass.program.work.charge("checks", via.length);
      known = via.map((level) => `${level.value}:${level.role}`).join(">");
      this.#viaSignatures.set(via, known);
    }
    return known;
  }

  /**
   * Whether a decider reached through operations decides at `at`: each of them, outermost to innermost, holds its kinds
   * definitely in its own value there.
   */
  #through(via: readonly Via[], at: readonly string[], definite: readonly ItemTag[]): boolean {
    for (const level of via) {
      const carried = withoutEmpty(
        this.#run(
          this.pass.values.valueItems(
            level.value,
            level.node,
            joinSteps(level.strip, at.slice(level.path.length)),
          ),
        ),
      );
      if (!definite.every((tag) => carried.some((own) => own.tag === tag && own.cert === "def")))
        return false;
    }
    return true;
  }

  /**
   * Whether a written copy reached through operations is selected: its own read runs, and each operation gives the
   * operand the walk took to it, by the operation's rule, never by what the copy's items say of their writers (a written
   * parameter's have none): a `get` its receiver's element unless the graph's literal proof leaves only its default, and
   * its default only where that is reached (F17b); `otherwise` its own operand only where that may be a value, and its
   * fallback only where the operand may be null (F17a); the other carriers give every operand that runs.
   */
  #selects(stop: Stop, surely = false): boolean {
    return this.#live(stop.value) && this.#chosen(stop.via, surely);
  }

  /**
   * Whether each operation of a chain gives the operand the walk took (`#selects`'s rule), or `surely` gives it: a `get`
   * its receiver's element where its default is dead and its default where that is the only value, `otherwise` its
   * operand where that is never null and its fallback where the operand is only null; no other carrier surely.
   */
  #chosen(via: readonly Via[], surely = false): boolean {
    const { program, values } = this.pass;
    return via.every((level) => {
      const c = program.opOf.get(level.value);
      const at = c === undefined ? level.node : (program.exprAt(c.site) ?? level.node);
      // (`otherwise` gives its own operand only where that may be a value, and its fallback only where the operand may
      // be null, an unknown either: F17a)
      if (c?.kind === "fallback") {
        const left = withoutEmpty(this.#run(values.valueItems(c.left, at, [])));
        const value = left.some((item) => item.tag !== "null");
        const absent = left.some((item) => item.tag === "null" || item.tag === "unknown");
        if (level.operand === c.left) return value && !(surely && absent);
        return level.operand !== c.right || (absent && !(surely && value));
      }
      if (c?.kind !== "get") return !surely;
      const { reached, only } = getProof(program, c, at);
      if (level.operand === c.receiver) return surely ? !reached : !only;
      return level.operand !== c.fallback || (surely ? only : reached);
    });
  }

  /**
   * A store's contributions at `at`, in evaluation order: the stops of the one walk (`#stopsOf`, the carrier table's)
   * standing at the path or above it, each with the rest of the path to read into it, the ones its operations may give
   * (S: `#chosen`, a live read), each snapshot once (`#distinct`, S6-CARRIERS §4.5). The obligations come from these,
   * as the decider does (invariant O).
   */
  #contributions(
    d: Definition,
    at: readonly string[],
  ): readonly { readonly stop: Stop; readonly rest: readonly string[] }[] {
    if (d.value === undefined) return [];
    const out: { stop: Stop; rest: readonly string[] }[] = [];
    for (let length = 0; length <= at.length; length += 1)
      for (const stop of this.#keyStops(d, pathText(at.slice(0, length))).distinct()) {
        this.pass.program.work.charge("checks");
        out.push({ stop, rest: at.slice(length) });
      }
    return out.sort((a, b) => compareKeys(a.stop.key, b.stop.key));
  }

  /**
   * C1's site for external data a store brings at `at` (§3.4, TABLE r4.60, r4.63 (2)): the earliest of its contributions
   * that is an ingress or reads one through projections of it, or named data in a literal cell below a combining or
   * removing operation, at its own expression (`#contributionSite`); an operation's own read is no such contribution
   * (C10: the destination's check sits at the store), so the store's own site stands for it, as for named data at a
   * decided place below a selecting operation (the set's sites).
   */
  public ingressSiteOf(d: Definition, at: readonly string[], item?: Item): SourceSite {
    if (d.kind !== "whole" || d.value === undefined) return d.site;
    // (the item's own ingress among them first, where it names one: the contribution that brought it; an item carrying
    // named data the store brings beside its inline data, or a fallback's or a default's own read's data (a typed
    // default's is its call's), is that data's C1, sited by its rule (an own read's at the store), the inline data owing
    // only its boundary and a host member beside it its own place's C1: r4.63 (1), (2), TABLE r4.67 (3), r4.70 (1))
    const node = item?.ingress;
    const own = node === undefined ? null : this.#leafIngresses(node);
    const stops = this.#landingIndex().byStore.get(d);
    const named =
      own !== null &&
      stops !== undefined &&
      (this.#perNode(this.#someOwn, d, node!, () => this.#meet(own, this.#ownLeaves(d, false))) ||
        this.#meet(own, this.#namedBeside(d, at)));
    let first: SourceSite | null = null;
    // (each prefix's sitings once per store, read in evaluation order only as far as the answer: Codex r23 F1; for named
    // data only its own sitings, the inline ones it skips never read, Codex r24 F2's neighbours)
    const lists: (readonly Siting[])[] = [];
    for (let length = 0; length <= at.length; length += 1) {
      const stops = this.#keyStops(d, pathText(at.slice(0, length)));
      lists.push(named ? stops.namedSitings() : stops.sitings());
    }
    const positions = lists.map(() => 0);
    for (;;) {
      let best = -1;
      for (let index = 0; index < lists.length; index += 1)
        if (
          positions[index]! < lists[index]!.length &&
          (best < 0 ||
            compareKeys(
              lists[index]![positions[index]!]!.stop.key,
              lists[best]![positions[best]!]!.stop.key,
            ) < 0)
        )
          best = index;
      if (best < 0) break;
      this.pass.program.work.charge("checks", lists.length);
      const { stop, ingress } = lists[best]![positions[best]!++]!;
      if (ingress === null) return this.#contributionSite(stop, d);
      if (named) continue;
      if (own === null || own.has(ingress)) return this.#contributionSite(stop, d);
      first ??= this.#contributionSite(stop, d);
    }
    return first ?? d.site;
  }

  /** Whether two sets of ingresses share one, reading the smaller. */
  #meet(a: ReadonlySet<PlaceId>, b: ReadonlySet<PlaceId>): boolean {
    const [small, large] = a.size <= b.size ? [a, b] : [b, a];
    for (const ingress of small) {
      this.pass.program.work.charge("checks");
      if (large.has(ingress)) return true;
    }
    return false;
  }

  /**
   * A store's stops at one key, once per store and key (Codex r23 F1: a path's readers take its prefixes' lists, never
   * the store's whole walk again): the ones its operations may give (`#selects`), in evaluation order, and, on demand,
   * the ones C1 may be sited at (`ingressSiteOf`) and the named data among them (`#namedBeside`).
   */
  #keyStops(d: Definition, key: string): KeyStops {
    const memoKey = joinParts(d.uid, key);
    const known = this.#keyed.get(memoKey);
    if (known !== undefined) return known;
    const { program, definitions } = this.pass;
    const stops = this.#stopsOf(d.value!, d.node);
    const selected: Stop[] = [];
    for (const map of [stops.written, stops.values, stops.literals])
      for (const stop of map.get(key) ?? []) {
        program.work.charge("checks");
        if (stop.via.length === 0 || this.#selects(stop)) selected.push(stop);
      }
    program.work.charge("checks", sortCost(selected.length));
    selected.sort((a, b) => compareKeys(a.key, b.key));
    // (the ingress a value reads through projections of it, never an iteration's: where its source stands)
    const baseOf = (value: PlaceId): PlaceId => {
      for (
        let projection = program.projOf.get(value);
        projection !== undefined && projection.step !== "iteration";
        projection = program.projOf.get(value)
      ) {
        program.work.charge("checks");
        value = projection.owner;
      }
      return value;
    };
    let sitings: readonly Siting[] | null = null;
    let namedSitings: readonly Siting[] | null = null;
    let distinct: readonly Stop[] | null = null;
    let named: readonly Stop[] | null = null;
    const entry: KeyStops = {
      selected,
      distinct: () => (distinct ??= this.#distinct(selected)),
      // an operation's own read is no contribution C1 is sited at (C10); named data below a combining operation or a
      // member of named data is sited at its own expression (`ingress` null), an ingress where it is read
      sitings: () => {
        if (sitings !== null) return sitings;
        const out: Siting[] = [];
        for (const stop of selected) {
          program.work.charge("checks");
          if (stop.via.some((level) => OWN_ROLES.has(level.role))) continue;
          if (this.#namedBelowCombining(stop) || this.#namedMember(stop))
            out.push(
              definitions.ingress.has(baseOf(stop.value))
                ? { stop, ingress: null, host: true }
                : { stop, ingress: null },
            );
          else {
            const base = baseOf(stop.value);
            if (definitions.ingress.has(base)) out.push({ stop, ingress: base });
          }
        }
        return (sitings = out);
      },
      // (a member of host data beside them is its own place's C1, never the merged item's: TABLE r4.70 (1))
      namedSitings: () =>
        (namedSitings ??= entry
          .sitings()
          .filter((siting) => siting.ingress === null && siting.host === undefined)),
      // named external data outside every ingress the store holds whole and every own read (`#namedBeside`)
      named: () => {
        if (named !== null) return named;
        const { inline } = this.#storeIngresses(d);
        const out: Stop[] = [];
        for (const stop of selected) {
          program.work.charge("checks");
          // (host data itself, or a member of it, is the store's own ingress, no named data: its global has a key too)
          let base = stop.value;
          while (!definitions.ingress.has(base) && program.projOf.has(base)) {
            program.work.charge("checks");
            base = program.projOf.get(base)!.owner;
          }
          if (
            !definitions.ingress.has(base) &&
            this.#sourceOf(stop.value) !== null &&
            !stop.via.some((level) => inline.has(level.value) || OWN_ROLES.has(level.role))
          )
            out.push(stop);
        }
        // (equal snapshots bring equal named data at every path below: each read once, Codex r24 F2's neighbours)
        return (named = this.#distinct(out));
      },
    };
    keepText(this.#work, memoKey.length);
    this.#keyed.set(memoKey, entry);
    return entry;
  }

  /**
   * A contribution's own expression, C1's site for it (§3.4): a member a receiver's operation reads of it (a `get`, a
   * copy, a removal of the data: TABLE r4.60), else the contribution itself, an ingress, a member read of one or a named
   * read.
   */
  #contributionSite(stop: Stop, d: Definition): SourceSite {
    const { program } = this.pass;
    // (only the innermost row takes the stop's value as its operand: a walk descends, each value one row's operand)
    const level = stop.via.at(-1);
    if (level !== undefined && RECEIVER_ROLES.has(level.role) && level.operand === stop.value)
      return program.places[level.value]?.site ?? d.site;
    return program.places[stop.value]?.site ?? d.site;
  }

  /**
   * Whether a contribution is a member of named external data: a property read of it, or what a receiver's operation
   * reads of it (`parcel.field`, `parcel.get(0, default: 1)`): C1 at the member read (TABLE r4.60).
   */
  #namedMember(stop: Stop): boolean {
    const { program, definitions, values } = this.pass;
    if (definitions.ingress.has(stop.value) || this.#sourceOf(stop.value) === null) return false;
    const member =
      program.projOf.has(stop.value) ||
      stop.via.some((level) => RECEIVER_ROLES.has(level.role) && level.operand === stop.value);
    return (
      member && this.#run(values.valueItems(stop.value, stop.node, stop.strip)).some(isExternal)
    );
  }

  /**
   * Whether a contribution is named external data in a cell of a literal that a combining or removing operation takes
   * (`[a] + [named]`, `[k, named].removeAt(1)`): the operand that brought the kind, C1's site (TABLE r4.63 (2)).
   */
  #namedBelowCombining(stop: Stop): boolean {
    const { program, definitions, values } = this.pass;
    return (
      !definitions.ingress.has(stop.value) &&
      this.#sourceOf(stop.value) !== null &&
      stop.via.some(
        (level) =>
          COMBINING_ROLES.has(level.role) &&
          level.operand !== stop.value &&
          program.hasOf.has(level.operand),
      ) &&
      this.#run(values.valueItems(stop.value, stop.node, stop.strip)).some(isExternal)
    );
  }

  /**
   * Where a store's value at `at` carries external data another store brought (r4.50 (1)): the first read among its
   * contributions of a source key (`#sourceOf`: a binding, a member of one, a call's result) no store validates (its
   * contract there holds no kind), whose items there are external, a member the runtime reads included (F15, r4.60: C5's
   * obligation on the receiver waives nothing at the destination); `null` where none does. Inline data is the store's
   * own ingress (C9's boundary): it does not count.
   */
  public namedExternalSite(d: Definition, at: readonly string[]): SourceSite | null {
    const { contract, values } = this.pass;
    const { inline } = this.#storeIngresses(d);
    // (each snapshot once: equal reads of one source through one chain hold equal named data, S6-CARRIERS §4.5)
    for (const { stop, rest } of this.#contributions(d, at)) {
      const source = this.#sourceOf(stop.value);
      if (source === null || inline.has(stop.value)) continue;
      const path = joinSteps(stop.strip, rest);
      const key = keyBelow(source, path);
      if (withoutEmpty(this.#run(contract.contractOf(key))).some(concrete)) continue;
      if (this.#run(values.valueItems(stop.value, stop.node, path)).some(isExternal))
        // (an operation's own read: the destination's check at the store's value, TABLE r4.63 (3))
        return stop.via.some((level) => OWN_ROLES.has(level.role))
          ? d.site
          : this.#contributionSite(stop, d);
    }
    return null;
  }

  /** Whether a value's own expression runs: its flow node is live (an operand an operation never selects is not). */
  #live(value: PlaceId): boolean {
    const { program } = this.pass;
    const site = program.places[value]?.site ?? null;
    const node = site === null ? null : program.exprAt(site);
    return node === null || program.live(node);
  }

  /**
   * Whether an external item a store brings is an operation's own read's data alone (C10: a fallback's, a default's):
   * each ingress it names reaches the store's value through an own read, as host data or in named data. Its boundary is
   * against `[unknown]`, so A7's whole-store exception never stands in for the destination's check of it (TABLE r4.67
   * (2)). It reads no path: once per store and provenance node (Codex r23 F1).
   */
  public ownReadItem(item: Item, d: Definition): boolean {
    if (item.ingress === undefined) return false;
    const ingresses = this.#leafIngresses(item.ingress);
    return this.#perNode(this.#ownItems, d, item.ingress, () => {
      if (ingresses.size === 0) return false;
      const own = this.#ownLeaves(d);
      for (const ingress of ingresses) {
        this.pass.program.work.charge("checks");
        if (!own.has(ingress)) return false;
      }
      return true;
    });
  }

  /**
   * The ingresses that reach a store's value through an operation's own read, once per store; `typed` false leaves out
   * those only a typed default reads (F18: its data's C1 at the call's ingress, TABLE r4.66 (3)).
   */
  #ownLeaves(d: Definition, typed = true): ReadonlySet<PlaceId> {
    const memoKey = joinParts(d.uid, typed);
    const known = this.#ownReads.get(memoKey);
    if (known !== undefined) return known;
    const { program, definitions, values } = this.pass;
    const own = new Set<PlaceId>();
    if (d.value !== undefined) {
      const stops = this.#stopsOf(d.value, d.node);
      for (const map of [stops.written, stops.values, stops.literals])
        for (const list of map.values())
          for (const stop of list) {
            program.work.charge("checks");
            if (
              !stop.via.some(
                (level) => OWN_ROLES.has(level.role) && (typed || !TYPED_ROLES.has(level.role)),
              )
            )
              continue;
            let base = stop.value;
            while (!definitions.ingress.has(base) && program.projOf.has(base)) {
              program.work.charge("checks");
              base = program.projOf.get(base)!.owner;
            }
            if (definitions.ingress.has(base)) {
              own.add(base);
              continue;
            }
            for (const item of this.#run(values.valueItems(stop.value, stop.node, stop.strip)))
              if (isExternal(item) && item.ingress !== undefined)
                for (const ingress of this.#leafIngresses(item.ingress)) own.add(ingress);
          }
    }
    this.#ownReads.set(memoKey, own);
    return own;
  }

  /**
   * The whole value a stored value's path lies below (a copy, external data, an operation), not a field or element of
   * one of its literals, or `null`.
   */
  public wholeBelow(value: PlaceId, at: readonly string[]): PlaceId | null {
    const { program } = this.pass;
    // the values at each depth of the path, and the first whole one there, once per value and path prefix: the paths
    // of a stored value share their prefixes (each field of a list's elements its element step)
    let level: Level = { values: [value], whole: program.hasOf.has(value) ? null : value };
    let key = `${value}`;
    for (let index = 0; index + 1 < at.length && level.whole === null; index += 1) {
      key = stepText(key, at[index]!);
      let next = this.#levels.get(key);
      if (next === undefined) {
        const values: PlaceId[] = [];
        for (const current of level.values)
          for (const d of this.storesAt(current, at[index]!)) values.push(d.value!);
        program.work.charge("checks", values.length + 1);
        next = { values, whole: values.find((current) => !program.hasOf.has(current)) ?? null };
        keepText(this.#work, key.length);
        this.#levels.set(key, next);
      }
      level = next;
    }
    return at.length > 0 ? level.whole : null;
  }

  /**
   * ADR 0021 1.3, A8: a list's, set's or dict's literal elements (values), and the properties its objects share, have
   * one type at every path their known structure gives, a copy's or a call's its source's (F2): the earliest element's,
   * or a copy of a written binding's written type (A4), unless the literal lands directly in a written place, whose
   * type then checks them (A1). A definite element of another type is an error at the innermost offending expression
   * (r4.35) and is rejected: later uses see the earliest element's type (A6). `error` hears of each with the element's
   * store, the literal's cell, the path, the earliest element's kinds there and the offending element's (D1).
   */
  public literalElements(
    order: <T>(list: readonly T[]) => T[],
    error: (
      site: SourceSite,
      found: {
        readonly d: Definition;
        readonly cell: PlaceId;
        readonly path: readonly string[];
        readonly decided: readonly ItemTag[];
        readonly kinds: readonly ItemTag[];
      },
    ) => void,
  ): void {
    const { program, definitions, contract } = this.pass;
    const family = (tag: ItemTag): ItemTag => (NUMERIC.has(tag) ? "number" : tag);
    // a named element: one whose structure holds a source (a copy, a call, what a carrier takes of either)
    const named = (d: Definition): boolean =>
      d.value !== undefined && this.#valueStructure(d.value).sources.length > 0;
    // per landing and the distinct classes of a literal's elements' contracts (flow-insensitive: a source identity, or
    // a typed ingress's type and default), the paths below them where their contracts hold more than one kind: only there
    // can one element offend another (F2)
    const conflicts = new Map<string, readonly (readonly string[])[]>();
    for (const [cell, list] of order([...definitions.cellDefs])) {
      const owner = program.cellOwner.get(cell);
      if (owner?.kind !== "cell" || list.length < 2 || contract.landsIn(owner.owner, []) !== null)
        continue;
      let shared: readonly (readonly string[])[] | null = null;
      if (list.some(named)) {
        const ids = list.map((d) => (d.value === undefined ? "" : contract.identityOf(d.value).id));
        const distinct = [...new Set(ids)].sort();
        // (elements of one source identity hold one value: none offends another)
        if (distinct.length === 1) continue;
        const landing = this.#landing(owner.owner);
        const classes = list.map((d) =>
          d.value === undefined ? "" : this.#conflictClass(d.value),
        );
        const kinds = [...new Set(classes)].sort();
        const key = joinParts(landing ?? "", kinds.join(","));
        let paths = conflicts.get(key);
        if (paths === undefined) {
          const firstOf = new Map<string, Definition>();
          for (const [index, kind] of classes.entries())
            if (!firstOf.has(kind)) firstOf.set(kind, list[index]!);
          program.work.charge("checks", classes.length);
          const representatives = kinds.map((kind) => firstOf.get(kind)!);
          const kept: (readonly string[])[] = [];
          for (const path of this.#pathsBelow(representatives[0]!.value!, [
            ...this.#sharedPaths(landing, representatives),
            ...representatives.slice(1).flatMap((d) => this.#pathsBelow(d.value!, [])),
          ])) {
            const kinds = new Set<ItemTag>();
            for (const d of representatives) {
              program.work.charge("checks");
              for (const item of withoutEmpty(
                this.#run(contract.contractOfValueAt(d.value!, path)),
              ))
                if (concrete(item)) kinds.add(item.tag);
            }
            if (kinds.size > 1) kept.push(path);
          }
          keepText(this.#work, key.length);
          conflicts.set(key, (paths = kept));
        }
        shared = paths;
      }
      const first = new Map<
        string,
        { readonly tags: readonly ItemTag[]; readonly written: boolean }
      >();
      // an element of one family offends where none of its kinds fits: a written type by the kinds themselves (a whole
      // number fits a written integer, a fraction does not), an earliest element's by their family
      const offends = (at: string, tags: readonly ItemTag[]): boolean => {
        const decided = first.get(at)!;
        const families = [...new Set(tags.map(family))];
        return (
          families.length === 1 &&
          (decided.written ? tags : families).every(
            (tag) => !decided.tags.some((ref) => fits(tag, ref, decided.written)),
          )
        );
      };
      // the error at the innermost offending expression (r4.35), the element rejected (A6)
      const offended = (d: Definition, path: readonly string[]): void => {
        const at = pathText(path);
        const inner =
          path.length > 0
            ? this.offendingAt(d, path, (items) =>
                offends(at, [...new Set(deciding(items).map((item) => item.tag))]),
              )
            : null;
        error(inner === null ? d.site : (program.place(inner.value!).site ?? d.site), {
          d,
          cell,
          path,
          decided: first.get(at)!.tags,
          kinds: [...new Set(deciding(this.valueAt(d, path)).map((item) => item.tag))],
        });
        this.reject(d, cell, path);
      };
      // a named literal's elements are compared at those paths, a literal's own elements at their structure's; per source
      // identity in the literal, the paths its first element offends at, where each later one offends too
      const offending = new Map<string, (readonly string[])[]>();
      for (const d of list) {
        if (d.value === undefined) continue;
        const identity = named(d) ? contract.identityOf(d.value).id : null;
        const known = identity === null ? undefined : offending.get(identity);
        const found: (readonly string[])[] = [];
        if (identity !== null && known === undefined) offending.set(identity, found);
        const below = known !== undefined ? [] : (shared ?? this.#pathsBelow(d.value, []));
        for (const path of [[], ...below]) {
          const at = keptText(this.#work, path);
          const own = [...new Set(deciding(this.valueAt(d, path)).map((item) => item.tag))];
          if (!first.has(at)) {
            // A4: a copy of a written binding gives its written type, whatever it holds now, where it is the earliest
            // decider on the path; an element whose structure holds no source holds no copy (#1106: k literals nested
            // in each other asked each other's stops)
            const copied =
              identity === null
                ? null
                : (this.#drive(this.#earliestDecider(d.value, d.node, path, null))?.term ?? null);
            const kinds = [...new Set(own.map(family))];
            if (copied !== null)
              first.set(at, {
                tags: typeTags(copied).filter((tag) => tag !== "null"),
                written: true,
              });
            else if (kinds.length === 1) first.set(at, { tags: kinds, written: false });
            continue;
          }
          if (!offends(at, own)) continue;
          offended(d, path);
          if (path.length > 0) found.push(path);
        }
        for (const path of known ?? []) offended(d, path);
      }
    }
  }

  /**
   * The class of a literal element's contracts, for the conflict paths of `literalElements` (§8): a `load` or a parse is
   * typed by its expected type, else by its default (F18), so the k ingresses of one typed default have one class and
   * share one discovery, while each keeps its own identity and its boundary check (C9, §8 r4.15); any other value its
   * source identity. Values of one class have the same kinds at every path.
   */
  #conflictClass(value: PlaceId): string {
    const { program, contract } = this.pass;
    const c = program.opOf.get(value);
    if (c === undefined) return contract.identityOf(value).id;
    let fallback: PlaceId | undefined;
    if (c.kind === "load" && c.key !== null) fallback = c.fallback ?? undefined;
    else if (
      c.kind === "operation" &&
      c.contract.family === "conversion" &&
      conversionCategory(c.contract.name)?.kind === "parses"
    )
      fallback = defaultOf(c);
    else return contract.identityOf(value).id;
    const expected = (c.kind === "load" ? c.receiver : null) ?? contract.landsIn(c.result, []);
    let term = "";
    if (expected !== null) {
      term = this.#termIds.get(expected) ?? `t${this.#termIds.size}`;
      this.#termIds.set(expected, term);
    }
    const by = c.kind === "load" ? "load" : c.contract.name;
    return joinParts(
      "f18",
      by,
      term,
      fallback === undefined ? "" : contract.identityOf(fallback).id,
    );
  }

  // ------------------------------------------------------------------------------------------- the landing index

  /**
   * S6-CARRIERS §3.2: every store, add and transfer landing that admission does not reject walked once (`#stopsOf`, the
   * walk admission's deciders and C1's contributions read), then every operation's own read, as its own landing; each
   * ingress stop recorded by the store that brings it, or as an own read. Built once per pass, at its first use. A store
   * in dead code and a dead call's argument for a written parameter are walked too: their boundaries are against the
   * destination's admitted type, as in live code (AD-3: a written type is no flow fact).
   */
  #landingIndex(): LandingIndex {
    if (this.#landings !== null) return this.#landings;
    const { program, definitions, lists } = this.pass;
    const byStore = new Map<Definition, IngressStop[]>();
    const byIngress = new Map<PlaceId, Landing>();
    const entry = (ingress: PlaceId): Landing => {
      let found = byIngress.get(ingress);
      if (found === undefined) byIngress.set(ingress, (found = { stores: new Set(), own: false }));
      return found;
    };
    // the ingress a stop is, or reads through projections of it (a member of it); a length of an owner that is surely
    // a text or a collection is derived (F14), no member of its external data (F15), an object's own `length` one
    const ingressOf = (value: PlaceId): PlaceId | null => {
      let at = value;
      while (!definitions.ingress.has(at)) {
        program.work.charge("indexSteps");
        const projection = program.projOf.get(at);
        if (projection === undefined) return null;
        if (measuresLength(projection.step) && this.#measured(projection.owner)) return null;
        at = projection.owner;
      }
      return at;
    };
    // the own reads some walk reached through its own row (§3.2: never walked again as their own landing), and per
    // row of a walk (its carrier and operand) whether it or a row outside it is an own row, and the innermost typed
    // default's call at or outside it: each row once, so a stop costs only the rows no stop before it went through
    // (each value has one syntactic parent, so a row's outer rows are the same in every stop through it; Codex r21 B2)
    // r4.63 (3), r4.66 (2): host data in the default of a `load` or `fromJson` of an inferred place typed by that
    // default (its kinds definite) is the call's: the boundary at the call validates the loaded value, so the default
    // owes no own read; a default without definite kinds types nothing, its read an own read as any; the innermost
    // such call
    const reached = new Set<PlaceId>();
    const rows = new Map<string, { readonly own: boolean; readonly call: PlaceId | null }>();
    const rowOf = (
      via: readonly Via[],
    ): { readonly own: boolean; readonly call: PlaceId | null } => {
      const keyAt = (index: number): string => `${via[index]!.value}:${via[index]!.operand}`;
      let start = via.length;
      while (start > 0 && !rows.has(keyAt(start - 1))) {
        program.work.charge("indexSteps");
        start -= 1;
      }
      let row = start > 0 ? rows.get(keyAt(start - 1))! : { own: false, call: null };
      for (let index = start; index < via.length; index += 1) {
        const level = via[index]!;
        if (OWN_ROLES.has(level.role)) reached.add(level.operand);
        row = {
          own: row.own || OWN_ROLES.has(level.role),
          call: TYPED_ROLES.has(level.role)
            ? this.typedByDefault(level.value)
              ? level.value
              : null
            : row.call,
        };
        rows.set(keyAt(index), row);
      }
      return row;
    };
    const walk = (
      value: PlaceId,
      node: FlowNode,
      found: (stop: Stop, ingress: PlaceId, own: boolean) => void,
    ): void => {
      const stops = this.#stopsOf(value, node);
      for (const map of [stops.written, stops.values, stops.literals])
        for (const list of map.values())
          for (const stop of list) {
            program.work.charge("indexSteps");
            const row = rowOf(stop.via);
            const own = row.own;
            const ingress = this.#lengthAt(stop.value, stop.strip) ? null : ingressOf(stop.value);
            if (ingress === null) continue;
            const call = own ? row.call : null;
            if (call !== null) entry(ingress).call = call;
            else found(stop, ingress, own);
          }
    };
    for (const d of [
      ...definitions.storeDefs,
      ...definitions.transferDefs,
      ...[...definitions.deadArguments.values()].flat(),
    ]) {
      if ((d.kind !== "whole" && d.kind !== "add") || d.value === undefined) continue;
      if (!lists.live(d)) continue;
      walk(d.value, d.node, (stop, ingress, own) => {
        if (own) {
          entry(ingress).own = true;
          return;
        }
        const site = program.places[ingress]?.site;
        if (site === null || site === undefined) return;
        entry(ingress).stores.add(d);
        let list = byStore.get(d);
        if (list === undefined) byStore.set(d, (list = []));
        const property = stop.path.findIndex((step) => step !== "element");
        list.push({
          ingress,
          d,
          path: stop.path,
          recordPath: property < 0 ? stop.path : keptSlice(this.#work, stop.path, 0, property),
          key: stop.key,
          site,
          reads: program.places[stop.value]?.site ?? site,
          contribution: this.#contributionSite(stop, d),
          // (a loop variable's place takes its domain from the iterable, never inline: C1 beside the boundary, r4.63 (4))
          whole:
            d.how !== "loop variable" &&
            ingress === stop.value &&
            stop.strip.every((step) => step === SELECTED_VALUE || step === SELECTED_TEXT),
        });
      });
    }
    // an operation's own read is an own read wherever it stands (C10): one no walk reached is its own landing, the
    // outermost first, so a nested own read its enclosing one's walk reaches is walked once
    const owns: { readonly operand: PlaceId; readonly site: SourceSite }[] = [];
    for (const carrier of [...program.projOf.keys(), ...program.opOf.keys()])
      for (const { operand, own } of operandsOf(program, carrier)) {
        program.work.charge("indexSteps");
        const site = own ? program.places[operand]?.site : null;
        if (site !== null && site !== undefined) owns.push({ operand, site });
      }
    program.work.charge("indexSteps", sortCost(owns.length));
    owns.sort(
      (a, b) => a.site.file - b.site.file || a.site.start - b.site.start || b.site.end - a.site.end,
    );
    for (const { operand, site } of owns) {
      program.work.charge("indexSteps");
      const node = reached.has(operand) ? null : program.exprAt(site);
      if (node !== null) walk(operand, node, (_, ingress) => (entry(ingress).own = true));
    }
    for (const list of byStore.values()) {
      program.work.charge("checks", sortCost(list.length));
      list.sort((a, b) => compareKeys(a.key, b.key));
    }
    // (a typed default's data is the call's that lands: each chain of nested typed defaults followed once)
    for (const landing of byIngress.values()) {
      const chain: Landing[] = [];
      let at: Landing | undefined = landing;
      while (at?.call !== undefined && at.stores.size === 0 && !at.own) {
        program.work.charge("indexSteps");
        chain.push(at);
        const next = byIngress.get(at.call);
        if (next?.call === undefined || next.stores.size > 0 || next.own) break;
        at = next;
      }
      const last = chain.at(-1)?.call;
      if (last !== undefined) for (const member of chain) member.call = last;
    }
    this.#landings = { byStore, byIngress };
    return this.#landings;
  }

  /**
   * Whether an ingress is a `load` or a `fromJson` typed by its default alone (F18): no declared or written expected
   * type, a default whose own kinds type it.
   */
  public typedByDefault(value: PlaceId): boolean {
    const { program, contract } = this.pass;
    const c = program.opOf.get(value);
    if (c === undefined || !("result" in c)) return false;
    const parses =
      c.kind === "operation" &&
      c.contract.family === "conversion" &&
      conversionCategory(c.contract.name)?.kind === "parses";
    if (c.kind !== "load" && !parses) return false;
    if (c.kind === "load" && (c.key === null || c.receiver !== null)) return false;
    const fallback = c.kind === "load" ? (c.fallback ?? undefined) : defaultOf(c);
    return (
      fallback !== undefined &&
      contract.landsIn(c.result, []) === null &&
      this.#f18Kinds(c) !== null
    );
  }

  /** Whether a value is surely a text or a collection, whose length is built in (F14): no kind of it unknown or other. */
  #measured(value: PlaceId, path: readonly string[] = []): boolean {
    const kinds = withoutEmpty(this.#run(this.pass.contract.contractOfValueAt(value, path)));
    return kinds.length > 0 && kinds.every((item) => MEASURED.has(item.tag));
  }

  /** Whether a stop reads a value's length where it is surely measured (F14): derived, no member of external data. */
  #lengthAt(value: PlaceId, strip: readonly string[]): boolean {
    for (let at = 0; at < strip.length; at += 1) {
      this.pass.program.work.charge("indexSteps");
      if (measuresLength(strip[at]!) && this.#measured(value, strip.slice(0, at))) return true;
    }
    return false;
  }

  /** The ingress a leaf names (`ingressLeaf`), or `null` for none of the program's. */
  #leafIngress(leaf: Writer): PlaceId | null {
    return this.pass.definitions.ingressAt.get(writerKey(leaf)) ?? null;
  }

  /** The ingresses an item's leaves name, once per provenance node and pass (C1's membership tests read it). */
  #leafIngresses(node: IngressNode): ReadonlySet<PlaceId> {
    const known = this.#nodeIngresses.get(node);
    if (known !== undefined) return known;
    const out = new Set<PlaceId>();
    const seen = new Set<IngressNode>();
    const pending = [node];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      this.pass.program.work.charge("checks");
      if ("ingress" in current) {
        const ingress = this.#leafIngress(current.ingress);
        if (ingress !== null) out.add(ingress);
      } else if ("parts" in current) for (const part of current.parts) pending.push(part);
      else if (current.contents !== null) pending.push(current.contents);
    }
    this.#nodeIngresses.set(node, out);
    return out;
  }

  /**
   * S6-CARRIERS §3.4's resolution of a provenance node, once per node and pass: each leaf's ingress sends its store's
   * boundary, or its own read's check, once; the answer is whether some ingress below the node no walk reached, whose
   * consumer checks it (r4.10). A node on a cycle through a cell is answered again where it is met (its answer then
   * depends on where the cycle was entered).
   */
  #resolve(root: IngressNode): boolean {
    const known = this.#resolved.get(root);
    if (known !== undefined) return known;
    const { program } = this.pass;
    const index = this.#landingIndex();
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
        const done = this.#resolved.get(part);
        if (done !== undefined) frame.unreached ||= done;
        else if (open.has(part)) frame.cyclic = true;
        else enter(part);
        continue;
      }
      frames.pop();
      open.delete(frame.node);
      if ("ingress" in frame.node) {
        let ingress = this.#leafIngress(frame.node.ingress);
        let found = ingress === null ? undefined : index.byIngress.get(ingress);
        // (a typed default's data is its call's, r4.63 (3): the call's landing checks it)
        const covered = found?.call !== undefined && found.stores.size === 0 && !found.own;
        if (covered) {
          ingress = found!.call!;
          found = index.byIngress.get(ingress);
        }
        if (found !== undefined && found.stores.size > 0)
          for (const d of found.stores) this.boundaryAt(d);
        else if (found?.own === true) this.#boundaryAtRead(ingress!);
        else {
          // (a typed call no store brings is checked where it runs: its F18 check validates its default's data too)
          const call = covered ? program.opOf.get(ingress!) : undefined;
          frame.unreached =
            ingress !== null && (call === undefined || this.#f18Admission(call) === null);
        }
      }
      if (!frame.cyclic) this.#resolved.set(frame.node, frame.unreached);
      const parent = frames.at(-1);
      if (parent === undefined) answer = frame.unreached;
      else {
        parent.unreached ||= frame.unreached;
        parent.cyclic ||= frame.cyclic;
      }
    }
    return answer;
  }

  // ------------------------------------------------------------------------------------------- C9

  /** A store's destination: the stored value's path; an added value's the collection's element (C9 r4.6). */
  #destPath(d: Definition): readonly string[] {
    return d.kind === "add" ? joinSteps(d.path, ["element"]) : d.path;
  }

  /**
   * Whether an item's external data came in at the store `d` itself (C9: its boundary there checks it): data that stands
   * whole in the store's value, with what that ingress holds (a typed default's data is its call's). A member the store
   * brings of host data (r4.60), or named data the store brings beside the inline data at `at`, owes its own check
   * (Codex r21 B3).
   */
  public ownIngress(item: Item, d: Definition, at: readonly string[]): boolean {
    if (item.ingress === undefined) return false;
    const stops = this.#landingIndex().byStore.get(d);
    if (stops === undefined) return false;
    const ingresses = this.#leafIngresses(item.ingress);
    // (whether the store holds the item's data whole and nowhere as a member reads no path: once per provenance node,
    // its leaves asked of the store's index)
    const whole = this.#perNode(this.#wholeItems, d, item.ingress, () => {
      const { inline, members } = this.#storeIngresses(d);
      let held = false;
      for (const ingress of ingresses) {
        this.pass.program.work.charge("checks");
        if (members.has(ingress)) return false;
        if (inline.has(ingress)) held = true;
      }
      return held;
    });
    return whole && !this.#meet(ingresses, this.#namedBeside(d, at));
  }

  /**
   * The ingresses of the named external data a store brings at `at` outside every ingress its value holds whole and
   * every operation's own read (C10's): what an item merging them with inline data owes beside its boundary. Once per
   * store and path, reading only its prefixes' named data (`#keyStops`).
   */
  #namedBeside(d: Definition, at: readonly string[]): ReadonlySet<PlaceId> {
    const memoKey = joinParts(d.uid, at);
    const known = this.#beside.get(memoKey);
    if (known !== undefined) return known;
    const { program, values } = this.pass;
    const out = new Set<PlaceId>();
    for (let length = 0; length <= at.length; length += 1)
      for (const stop of this.#keyStops(d, pathText(at.slice(0, length))).named()) {
        program.work.charge("checks");
        for (const item of this.#run(
          values.valueItems(stop.value, stop.node, joinSteps(stop.strip, at.slice(length))),
        ))
          if (isExternal(item) && item.ingress !== undefined)
            for (const ingress of this.#leafIngresses(item.ingress)) out.add(ingress);
      }
    keepText(this.#work, memoKey.length);
    this.#beside.set(memoKey, out);
    return out;
  }

  /** A store's answer for a provenance node, once: one that reads no path (Codex r23 F1). */
  #perNode<T>(
    memo: Map<number, Map<IngressNode, T>>,
    d: Definition,
    node: IngressNode,
    answer: () => T,
  ): T {
    let known = memo.get(d.uid);
    if (known === undefined) memo.set(d.uid, (known = new Map()));
    const hit = known.get(node);
    if (hit !== undefined) return hit;
    const value = answer();
    known.set(node, value);
    return value;
  }

  /** C9's site for an item a store brings (§3.4): the earliest evaluated of its contributions there, else `site`. */
  public cellSited(site: SourceSite, item: Item, d: Definition): SourceSite {
    return this.#firstStop(item, d)?.reads ?? site;
  }

  /**
   * C1's site for an item an add or an `addAll` brings (§3.4, r4.60): the earliest evaluated of its contributions, what
   * a receiver's operation reads of it at that operation (`xs.add(hostValue.get(0, default: 1))`: the `get`, Codex r21
   * N1), else `site`.
   */
  public contributionSited(site: SourceSite, item: Item, d: Definition): SourceSite {
    return this.#firstStop(item, d)?.contribution ?? site;
  }

  /** The earliest evaluated of a store's stops of an item's ingresses (its own expression), once per provenance node. */
  #firstStop(item: Item, d: Definition): IngressStop | null {
    if (item.ingress === undefined) return null;
    const stops = this.#landingIndex().byStore.get(d);
    if (stops === undefined) return null;
    const ingresses = this.#leafIngresses(item.ingress);
    return this.#perNode(this.#firstStops, d, item.ingress, () => {
      const { first } = this.#storeIngresses(d);
      let earliest = -1;
      for (const ingress of ingresses) {
        this.pass.program.work.charge("checks");
        const index = first.get(ingress);
        if (index !== undefined && (earliest < 0 || index < earliest)) earliest = index;
      }
      return earliest < 0 ? null : stops[earliest]!;
    });
  }

  /**
   * A store's landing stops by ingress, once per store (Codex r24 F1: an item's leaves ask it, never the store's list
   * again): the ingresses it holds whole, those it brings as members, and each ingress's first stop.
   */
  #storeIngresses(d: Definition): StoreIngresses {
    const known = this.#byIngress.get(d.uid);
    if (known !== undefined) return known;
    const inline = new Set<PlaceId>();
    const members = new Set<PlaceId>();
    const first = new Map<PlaceId, number>();
    (this.#landingIndex().byStore.get(d) ?? []).forEach((stop, index) => {
      this.pass.program.work.charge("checks");
      (stop.whole ? inline : members).add(stop.ingress);
      if (!first.has(stop.ingress)) first.set(stop.ingress, index);
    });
    const out: StoreIngresses = { inline, members, first };
    this.#byIngress.set(d.uid, out);
    return out;
  }

  /** C9: the boundary check of an ingress store, once, against its destination's admitted type when it is published. */
  public boundaryAt(d: Definition): void {
    this.#pending.set(d.uid, d);
  }

  /** C10, C9: host data in a fallback or a default is checked at its own read, against its own unknown contract. */
  #boundaryAtRead(value: PlaceId): void {
    if (this.#readSeen.has(value)) return;
    this.#readSeen.add(value);
    const operation = this.pass.program.opOf.get(value);
    // (F18's own check is the boundary)
    if (operation !== undefined && this.#f18Admission(operation) !== null) return;
    const site = this.pass.program.place(value).site;
    if (site === null) return;
    const label = this.pass.program.textAt(site);
    this.readChecks.push(
      boundaryCheck(
        site,
        label,
        ["unknown"],
        `validate external data entering ${label} against its own unknown contract`,
      ),
    );
  }

  /**
   * C9: an external item a consumer meets brings the boundary check of each ingress store it came in by, whichever
   * consumer asks first; host data that no ingress store brought is checked at the consumer (`here`) against `unknown`
   * (r4.10: the kinds the consumer needs are its own obligation).
   */
  public boundaryFor(item: Item, here: Obligation | null): void {
    if (!isExternal(item)) return;
    // the landing index: an ingress's store's boundary, its own read's check, or the consumer's check (r4.10)
    const unreached = item.ingress !== undefined && this.#resolve(item.ingress);
    if (item.ingress !== undefined && item.loose !== true && !unreached) return;
    if (here === null) return;
    const at = keptParts(this.#work, here.target, `${here.site.file}:${here.site.start}`);
    if (this.#hostSeen.has(at)) return;
    this.#hostSeen.add(at);
    this.readChecks.push({
      ...here,
      kind: "copy-type",
      against: ["unknown"],
      on: `validate external data ${here.target}`,
      boundary: true,
    });
  }

  public boundariesAt(items: readonly Item[], here: Obligation | null): void {
    for (const item of items) this.boundaryFor(item, here);
  }

  /** F18: a load or `fromJson` with an expected type that no store takes in is checked where it runs, against that type. */
  #f18Admission(
    c: CorePass["program"]["constraints"][number],
  ): { readonly label: string; readonly tags: readonly ItemTag[] } | null {
    if (!("result" in c)) return null;
    // (a typed ingress no store brings, an own read or unreached, is checked where it runs: §3.3, r4.57)
    const found = this.#landingIndex().byIngress.get(c.result);
    return found === undefined || found.stores.size === 0 ? this.#f18Kinds(c) : null;
  }

  #f18Kinds(
    c: CorePass["program"]["constraints"][number],
  ): { readonly label: string; readonly tags: readonly ItemTag[] } | null {
    if (!("result" in c)) return null;
    const known = this.#f18.get(c.result);
    if (known !== undefined) return known;
    const { program, contract, values } = this.pass;
    const parses =
      c.kind === "operation" &&
      c.contract.family === "conversion" &&
      conversionCategory(c.contract.name)?.kind === "parses";
    let found: { readonly label: string; readonly tags: readonly ItemTag[] } | null = null;
    const node = c.kind === "load" || parses ? program.exprAt(c.site) : null;
    if (node !== null && program.live(node)) {
      const items = withoutEmpty(this.#run(values.valueItems(c.result, node, [])));
      const tags: ItemTag[] = [
        ...new Set(items.filter((item) => concrete(item)).map((item) => item.tag)),
      ];
      // the admitted domain keeps its null: a nullable written type, or an untyped place's `default: null`
      const written = (c.kind === "load" ? c.receiver : null) ?? contract.landsIn(c.result, []);
      const term = written === null ? null : termAt(written, []);
      if (
        tags.length > 0 &&
        items.some((item) => item.tag === "null") &&
        (term === null || typeTags(term).includes("null"))
      )
        tags.push("null");
      if (tags.length > 0) found = { label: `${parses ? "fromJson" : "load"}.result`, tags };
    }
    this.#f18.set(c.result, found);
    return found;
  }

  /** F18 (r4.57): the checks of loads and `fromJson` calls that no store brings in, where they run. */
  public ingressStores(): void {
    for (const c of this.pass.program.constraints) {
      const found = this.#f18Admission(c);
      if (found === null) continue;
      this.readChecks.push(
        boundaryCheck(
          c.site,
          found.label,
          found.tags.map(requiredKind),
          `validate external data entering ${found.label} against ${found.tags.join("|")}`,
        ),
      );
    }
  }

  /**
   * The kinds an ingress store's boundary check is against: the destination's admitted type; for an argument beside an
   * unannotated parameter's default, which that default's decision never constrains (F21, ADR 0021 1.5), the
   * argument's own kinds at the boundary's path (a record carrying the ingress its record, a typed ingress its expected
   * kinds, F18, with their `null`), none for external data alone (`unknown`: the runtime's validation of it).
   */
  #againstOf(d: Definition, path: readonly string[]): ItemTag[] {
    if (!this.#besideDefault(d)) {
      const tags = this.admitted(d.place, path);
      // (an unrestricted destination, a copy's as the written part's, owes no boundary: every kind fits, V30 §13)
      return tags.includes("unknown") ? [] : tags;
    }
    const items = this.valueAt(d, path);
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
   */
  public publish(): void {
    const { definitions, lists, program } = this.pass;
    const index = this.#landingIndex();
    const stores = new Set(definitions.storeDefs);
    const elements = elementsBelow;
    for (const [d, stops] of index.byStore) {
      program.work.charge("checks");
      if (stops.length === 0) continue;
      const destination = this.#destPath(d);
      // (a store or a parameter default of an ingress or carrying a typed one; an argument or a return carrying a typed
      // one)
      const typedIngress = stops.some((stop) => {
        const operation = program.opOf.get(stop.ingress);
        return operation !== undefined && this.#f18Kinds(operation) !== null;
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
        this.#pending.has(d.uid) ||
        (typed
          ? this.#againstOf(d, destination).length > 0
          : lists.live(d) &&
            stops.some(
              (stop) =>
                this.#againstOf(d, joinSteps(destination, elements(d, stop.path))).length > 0,
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
      const tags = this.#againstOf(d, path);
      const label = this.pathLabel(d.place, path);
      const against: RequiredKind[] = tags.length > 0 ? tags.map(requiredKind) : ["unknown"];
      const key = keptKey(this.#work, d.place, path);
      const message = `validate external data entering ${label} against ${against.join("|")}`;
      // (the check keeps its label and its message, each about the path's text)
      keepText(this.#work, label.length);
      keepText(this.#work, message.length);
      const check = boundaryCheck(stops[0]!.site, label, against, message);
      const list = this.boundaries.get(key);
      if (list === undefined) this.boundaries.set(key, [check]);
      else list.push(check);
    }
  }
}

/** Whether a test of exactly `key` guards a branch or an operand region anywhere (§3.2). */
function tested(guards: CorePass["guards"], key: Key): boolean {
  return guards.branchCallables(key) !== undefined || guards.operandCallables(key) !== undefined;
}

/**
 * §4.3's segment tree over a class's members in flow order: per leaf a guard count; per node its least count and,
 * among its leaves with it, the earliest member (the least index in the class's source order); range additions are
 * lazy. Every node a change visits is charged.
 */
class GuardTree {
  readonly #size: number;
  readonly #min: Int32Array;
  readonly #least: Int32Array;
  readonly #lazy: Int32Array;

  public constructor(
    /** The class's member index at each leaf. */
    private readonly members: readonly number[],
    private readonly work: WorkLedger,
  ) {
    this.#size = Math.max(1, members.length);
    this.#min = new Int32Array(4 * this.#size);
    this.#least = new Int32Array(4 * this.#size);
    this.#lazy = new Int32Array(4 * this.#size);
    this.#build(1, 0, this.#size - 1);
  }

  #build(node: number, low: number, high: number): void {
    this.work.charge("eligibility");
    if (low === high) {
      this.#least[node] = low < this.members.length ? low : -1;
      return;
    }
    const middle = (low + high) >> 1;
    this.#build(2 * node, low, middle);
    this.#build(2 * node + 1, middle + 1, high);
    this.#pull(node);
  }

  #pull(node: number): void {
    const left = 2 * node;
    const right = left + 1;
    const a = this.#min[left]!;
    const b = this.#min[right]!;
    if (a !== b) this.#least[node] = a < b ? this.#least[left]! : this.#least[right]!;
    else {
      const x = this.#least[left]!;
      const y = this.#least[right]!;
      this.#least[node] = x < 0 ? y : y < 0 ? x : this.members[x]! <= this.members[y]! ? x : y;
    }
    this.#min[node] = Math.min(a, b) + this.#lazy[node]!;
  }

  /** Adds `delta` to the counts of the leaves `low` to `high`. */
  public add(low: number, high: number, delta: number): void {
    this.#add(1, 0, this.#size - 1, low, high, delta);
  }

  #add(node: number, from: number, to: number, low: number, high: number, delta: number): void {
    this.work.charge("eligibility");
    if (high < from || to < low) return;
    if (low <= from && to <= high) {
      this.#min[node]! += delta;
      this.#lazy[node]! += delta;
      return;
    }
    const middle = (from + to) >> 1;
    this.#add(2 * node, from, middle, low, high, delta);
    this.#add(2 * node + 1, middle + 1, to, low, high, delta);
    this.#pull(node);
  }

  /** The leaf of the earliest member with no guard count, or `null`. */
  public eligible(): number | null {
    return this.#min[1] === 0 && this.#least[1]! >= 0 ? this.#least[1]! : null;
  }
}

/** The integer literal an index projection's expression selects by (`root.items[0]`), else `null`. */
function literalIndex(node: FlowNode | null): string | null {
  const expression = node?.expression;
  if (expression?.kind !== "indexExpression") return null;
  const index = unwrap(expression.index);
  return index.kind === "numberLiteral" && index.numericType === "integer" ? index.raw : null;
}

/** Whether a projection's step is a plain property step, a stable source path's (S6-CARRIERS §4.1). */
function propertyOnly(step: string): boolean {
  return (
    step !== "iteration" &&
    step !== "index" &&
    step !== "entry" &&
    stepName(step) === step &&
    !measuresLength(step) &&
    dictList(step) === undefined
  );
}

/** A path below a store's destination: an `addAll`'s literal's elements are the destination's own elements. */
function elementsBelow(d: Definition, path: readonly string[]): readonly string[] {
  return d.kind === "add" && d.how === "elements" && path[0] === "element" ? path.slice(1) : path;
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

/** A required kind as an obligation names it. */
export function requiredKind(tag: ItemTag): RequiredKind {
  if (tag === "empty") throw new Error("The emptiness mark is no kind a check requires.");
  return tag;
}

/** The fields of a literal's type: an object's properties, a collection's element. */
function fieldsOf(term: TypeTerm): readonly (readonly [string, TypeTerm])[] {
  if (term.kind === "object")
    return (term.properties ?? []).map(
      (property) => [propertyStep(property.name), property.type] as const,
    );
  if (term.kind === "list" || term.kind === "set" || term.kind === "dict")
    return [["element", term.element]];
  return [];
}
