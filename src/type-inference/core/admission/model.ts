import type { PlaceId, SourceSite, TypeTerm } from "../../graph.js";
import type { CarrierRole } from "../carriers.js";
import type { Label } from "../contract/labels.js";
import type { KeyId, PathRef, PathSteps } from "../contract/key-ids.js";
import type { Definition, Key } from "../definitions.js";
import type { FlowNode } from "../flow-graph.js";
import type { Item, ItemTag } from "../items.js";
import type { LandingTape } from "./landings/inheritance.js";
import type { CoreProgram } from "../program.js";
import type { Touch, TouchRef } from "../touch.js";
import { type CanonicalKey } from "../contract/key-ids.js";
import type { Read, ReadAnswer } from "../inherited/reads.js";

// The shapes admission's state and walks are made of.

/** A copy of a place that may inherit a written type (`inheriting`): where it lands, and the path into the place. */
export interface InheritedCopy {
  readonly place: PlaceId;
  readonly path: readonly string[];
  readonly from: PlaceId;
  readonly strip: readonly string[];
  /**
   * The store making it, and whether the literal cells it passes are all live (a rejected one is dead in the next pass,
   * #1188).
   */
  readonly store?: Definition;
  readonly cellsLive?: boolean;
}

/**
 * A step of `landedBelow`'s walk: a place, the prefix its paths are taken at or below, and how its path is written in
 * the place asked (its first `drop` steps replaced by `prepend`); the step that reached it (`parent`).
 */
export interface LandingTask {
  readonly place: PlaceId;
  readonly below: readonly string[];
  readonly drop: number;
  readonly prepend: readonly string[];
  readonly parent?: LandingTask;
}

/** A point of a call's tape (`LandingTape`): its events, the paths brought by then and the repeat events by then. */
export interface TapePoint {
  readonly events: number;
  readonly paths: number;
  readonly repeats: number;
}

/**
 * The paths copies land in a place at or below a prefix (`landedBelow`), as the walk of one task (`frame`) brought them
 * in one call: the range of that call's tape from `from` to `to`, the task's own paths up to `own`, then per task its
 * walk took next (`children`, in walk order) the range from its point to the next one's. Points of the one tape, never
 * copies of it.
 */
export interface Listing {
  readonly tape: LandingTape;
  readonly frame: LandingTask;
  readonly from: TapePoint;
  readonly own: TapePoint;
  readonly children: readonly { readonly task: LandingTask; readonly from: TapePoint }[];
  readonly to: TapePoint;
}

/** A place's listings by their prefixes' steps (`Admission.listings`). */
export interface ListingNode {
  listing: Listing | null;
  readonly next: Map<string, ListingNode>;
}

/**
 * #1948: a place's copies at one path, by the next step past it of the longer paths `landed` asks (`nextStepCopies`):
 * until its scans pay for the index, their count and its size (-1 until made: the copies and their sources' seeds);
 * then the copies by the steps their sources land past their strips, and those whose sources' landings are not proved
 * (`sourceSteps`), each list in the copies' order.
 */
export interface NextSteps {
  scans: number;
  size: number;
  next: ReadonlyMap<string, readonly number[]> | null;
  any: readonly number[];
}

/**
 * A cycle of whole copies, by reference (#1188): every member lands what the cycle's copies from outside
 * land where they land, the members' written copies (`seeds`, all members') and its root; once per cycle.
 */
export interface WholeCycle {
  readonly members: readonly PlaceId[];
  readonly copies: readonly InheritedCopy[];
  readonly seeds: ReadonlyMap<string, ReadonlySet<TypeTerm>>;
  readonly owned: ReadonlySet<string>;
}

/** A place's touch trie and the paths its contributions meet at (`touchOf`). */
export interface TouchPlace {
  readonly node: Touch | null;
  readonly found: readonly (readonly string[])[];
}

/**
 * One part of a place's touch or landing trie (`touchTask`), by what it is made of: a leaf of one contributor, a copy's
 * source's trie (its landings alone where the copy is rejected), a read's source's, or a cycle's landings.
 */
export type TouchPart =
  | {
      readonly kind: "leaf";
      readonly path: readonly string[];
      readonly ref: TouchRef;
      readonly opaque: boolean;
    }
  | {
      readonly kind: "copy";
      readonly from: PlaceId;
      readonly strip: readonly string[];
      readonly at: readonly string[];
      readonly live: boolean;
    }
  | { readonly kind: "read"; readonly source: Key; readonly at: readonly string[] }
  | { readonly kind: "landing"; readonly place: PlaceId };

/** A trie being built (`build`): its parts, the next one whose trie is to be built first, and its members. */
export interface TouchTask {
  readonly kind: "touch" | "landing";
  readonly place: PlaceId;
  readonly members: readonly PlaceId[];
  readonly parts: readonly TouchPart[];
  next: number;
}

/**
 * The members of a cycle of whole copies joined by live copies (`liveGroup`): whether a rejected copy split the
 * cycle, and whether a live copy of a fed cycle's feeder lands in them.
 */
export interface LiveGroup {
  readonly members: readonly PlaceId[];
  readonly has: ReadonlySet<PlaceId>;
  readonly split: boolean;
  readonly fedLive: boolean;
}

/**
 * Written types inherited through copies' landings: where copies of written types land in each place, and the copies
 * of inheriting places each place takes; a place's landed paths are its own, its copies' own paths and below them its
 * copies' sources' landed paths below their strips, asked of those sources, never made per copy. A cycle of copies has
 * its members' landed paths made once, as the landing within it brings them.
 */
export interface Inheritance {
  /** Per place, the paths copies of written types land at in it (their elements too), with each type at the path. */
  readonly seeds: ReadonlyMap<PlaceId, ReadonlyMap<string, ReadonlySet<TypeTerm>>>;
  /** Per place, the copies of inheriting places that land in it, each distinct one once. */
  readonly into: ReadonlyMap<PlaceId, readonly InheritedCopy[]>;
  /** Per place, the paths its copies land at (their own paths), each once (`landed`). */
  readonly owned: ReadonlyMap<PlaceId, ReadonlySet<string>>;
  /** The places in a cycle of copies, by cycle (`cyclesOf`). */
  readonly cycleOf: ReadonlyMap<PlaceId, number>;
  /** Per member of a cycle of copies, its landed paths. */
  readonly cycles: ReadonlyMap<PlaceId, ReadonlySet<string>>;
  /**
   * Per member of a cycle of whole copies with no written type of its own that whole copies of one place outside it
   * feed, that place: the member lands that place's paths and its own root, asked of it (`copiesOf`).
   */
  readonly fed: ReadonlyMap<PlaceId, PlaceId>;
  /** The places copies join, each one's sources' before its own (`cyclesOf`). */
  readonly order: readonly (readonly PlaceId[])[];
  /** The members of the cycles of whole copies not fed by one place, by reference (#1188). */
  readonly wholes: ReadonlyMap<PlaceId, WholeCycle>;
}

/**
 * The copies a place answers through (`passThrough`): each place whose only store at its root is one whole copy of an
 * unwritten inheriting place, by that place (its parent), with the keys below its root it stores at, which stop it
 * answering as its parent there; each tree of them in depth-first order (entry and last entry below), and per key the
 * places storing at it (`Storing`).
 */
export interface CopyForest {
  readonly parent: ReadonlyMap<PlaceId, PlaceId>;
  readonly stores: ReadonlyMap<PlaceId, ReadonlySet<string>>;
  /** Per place, its keys' prefixes' texts, its root's too: whether it stores at or below a path (`landsThrough`). */
  readonly under: ReadonlyMap<PlaceId, ReadonlySet<string>>;
  readonly top: ReadonlyMap<PlaceId, PlaceId>;
  readonly depth: ReadonlyMap<PlaceId, number>;
  readonly entry: ReadonlyMap<PlaceId, number>;
  readonly exit: ReadonlyMap<PlaceId, number>;
  readonly storing: ReadonlyMap<string, Storing>;
  /** Per key, the places storing at it or below it (`landedBelow`). */
  readonly beneath: ReadonlyMap<string, Storing>;
}

/**
 * A place's own contributions besides its copies of inheriting places (`ownStructure`): its literals' and constants'
 * paths, other values' paths with what lies below them, and its reads of other places' keys (a copy of a place that
 * inherits nothing, a call's result) with where each stands.
 */
export interface OwnStructure {
  readonly points: readonly (readonly string[])[];
  readonly below: readonly (readonly string[])[];
  readonly reads: readonly { readonly at: readonly string[]; readonly source: Key }[];
}

/** A live store's own structure and what the held view (`held.ts`) takes beside it (`heldPoints`, `heldReads`). */
export interface HeldOwn extends OwnStructure {
  readonly held: { readonly points: OwnStructure["points"]; readonly reads: OwnStructure["reads"] };
}

/**
 * What the held view takes beside a store's own structure (`ownOf`): its copies of written bindings, whose contents
 * are their types', as points, and a value its place's copies list stands for, where it stands, as without the list.
 */
export interface HeldExtra {
  readonly points: (readonly string[])[];
  readonly reads: { readonly at: readonly string[]; readonly source: Key }[];
}

/** Entries by path (`byPath`): each under every prefix of its path (the path's own text included), and at its path. */
export interface ByPath<T> {
  readonly under: ReadonlyMap<string, readonly T[]>;
  readonly at: ReadonlyMap<string, readonly T[]>;
}

/** Places of a copy forest by entry, with the greatest last entry below over each range (a max segment tree). */
export interface Storing {
  readonly places: readonly PlaceId[];
  readonly entries: readonly number[];
  readonly exits: readonly number[];
}

/**
 * A computation that may need an unwritten place's inherited type at a path first (`inheritedAt`): it yields that place
 * and path's key and is resumed with the type, so a scan that waits on another stops where it stands and goes on from
 * there, never taken again from its start. It yields its semantic reads too (`Read`), each resumed with its answer.
 */
export type Inheriting<T> = Generator<CanonicalKey | Read, T, ReadAnswer>;

/**
 * Where a key's inherited type stands past wrappers (`wrappedFrontier`): the binding and read its last wrapper
 * holds (the key's own place and no read before the first), and the path below it (a path id).
 */
export interface Frontier {
  readonly place: PlaceId;
  readonly read: PlaceId | null;
  readonly rest: number;
}

/** A key's scan's answer (`scanOf`): the copied written type and whether it holds `null`, or none. */
export type WaitingAnswer = {
  readonly copied: TypeTerm | null;
  readonly nullable: boolean;
  /** Whether the deciding copy reads its written type at its own root (`Admission.inheritedOwn`, #1901). */
  readonly own?: boolean;
} | null;

/**
 * A path of a place in `openAbove`'s walk: the written types copies landed above it carry down to it (`permittedAt`,
 * each once), or `true` where one of them leaves it unrestricted; its paths one step below by their step.
 */
export interface OpenStep {
  readonly carried: readonly TypeTerm[] | true;
  readonly below: Map<string, OpenStep>;
}

/**
 * An evaluation key: from the stored value down to a stop, each carrier's operand position (its own
 * contribution after all of them, `OWN`) and each literal cell's source position. Keys compare lexicographically, a
 * shorter key before the keys it prefixes. A walk keeps each key once, as a node of its tree of keys one position below
 * the key it extends (`longerKey`), so k nested operations keep k nodes, never k keys up to k long (#1230); the
 * lexicographic order is the tree's preorder, each key's longer ones by position (`rankKeys`).
 */
export interface EvaluationKey {
  readonly position: number;
  /** The keys one position longer, by that position. */
  longer: Map<number, EvaluationKey> | null;
  /** Its place in evaluation order among its walk's keys, once the walk is done. */
  rank: number;
}

/**
 * A whole store's alias: the stable source path its value reads at `at` below it (the value itself,
 * or a literal's one read cell) and the node it is read at, its own guard's key and node whatever its class.
 */
export interface Alias {
  readonly source: Key;
  readonly read: FlowNode;
  readonly at: readonly string[];
  /**
   * The read itself: the copy whose binding's written type its class keeps
   * (docs/specifications/type-inference-accepted-record/sharing.md#r4-72).
   */
  readonly value: PlaceId;
  /** Whether its class is its read's chain's end (`chainEnd`): its items keep their own link's writer. */
  chained?: true;
}

/** A chain of clean copies' end (`chainEnd`): the read it stands for and that read's path as written. */
export interface ChainEnd {
  readonly source: Key;
  readonly read: FlowNode;
  readonly written: string;
}

/**
 * An ingress stop of a landing's walk: the ingress it is or reads through projections, its store,
 * its contribution path and its boundary path (the contribution path up to the first object property step), its
 * evaluation key, the ingress's own span, and whether it is the ingress whole.
 */
export interface IngressStop {
  readonly ingress: PlaceId;
  readonly d: Definition;
  readonly path: readonly string[];
  readonly recordPath: readonly string[];
  readonly key: EvaluationKey;
  /** The ingress's own expression, where its boundary check stands. */
  readonly site: SourceSite;
  /** The stop's own expression: the ingress itself where it is whole, a member read of it else. */
  readonly reads: SourceSite;
  /**
   * The store check's site for it (`contributionSite`): the stop's own expression, or what a receiver's operation reads
   * of it.
   */
  readonly contribution: SourceSite;
  readonly whole: boolean;
}

/**
 * The landing index, once per pass: per store, its non-own ingress stops in evaluation order; per
 * ingress, the stores that bring it and whether it is an own read. An ingress neither brought nor own is unreached.
 */
export interface LandingIndex {
  readonly byStore: ReadonlyMap<Definition, readonly IngressStop[]>;
  readonly byIngress: ReadonlyMap<PlaceId, Landing>;
}

/** Where an ingress lands: the stores that bring it, whether it is an own read, the typed call whose default it is. */
export interface Landing {
  readonly stores: Set<Definition>;
  own: boolean;
  /** A typed `load` or `fromJson` of an inferred place whose default holds the ingress. */
  call?: PlaceId;
}

/** A contribution of a stored value at one path (`stopsOf`): its evaluation key, value and node, its written type. */
export interface Stop {
  readonly key: EvaluationKey;
  readonly value: PlaceId;
  readonly node: FlowNode;
  /** The path below the stored value it stands at. */
  readonly path: readonly string[];
  /** A copy of a written binding's written type, else `null`. */
  readonly term: TypeTerm | null;
  /**
   * A copy of an unwritten place that may inherit a written type (`inheriting`): that place, its type at each path the
   * one its own decision copies there (`inheritedAt`); else `null`.
   */
  readonly from: PlaceId | null;
  /** The path into the value its contribution stands at (a projection's step into its owner). */
  readonly strip: readonly string[];
  /**
   * A value a projection selects: it stands for its fields and elements below the path, while at the path itself the
   * projection's own value, the union of what it may select, contributes (an unknown beside a kind decides nothing).
   */
  readonly deep: boolean;
  /** Whether each literal it was read out of has it alone at the step (`[typed][0]`, never `[typed, 2][0]`). */
  readonly single: boolean;
  /**
   * The operations it was reached through (`get` with its default, a copy of the elements, a list's `+`, ...): its
   * contribution decides only where each of them holds its kinds definitely.
   */
  readonly via: ViaChain | null;
}

/**
 * An operation a decider was reached through: its value, node, position and the path into it, and the operand the walk
 * took (`Stop.via`).
 */
export interface Via {
  readonly value: PlaceId;
  readonly node: FlowNode;
  readonly path: readonly string[];
  readonly strip: readonly string[];
  readonly operand: PlaceId;
  /** The operand's role for the carrier (`carriers.ts`), part of a via's signature. */
  readonly role: CarrierRole;
}

/**
 * A chain of operations (`Stop.via`): its innermost one and the chain outside it, `null` for none. Each operand's chain
 * is one link onto its operation's, so k nested operations keep k links, never k chains up to k long, and what a stop
 * asks of its chain is each link's answer from the one outside it, never a walk of the chain per stop (#1230). A walk
 * descends through syntactic operations only (a call is a source, never a carrier), so of a chain's operations only the
 * innermost takes the stop's own value as its operand.
 */
export interface ViaChain {
  readonly level: Via;
  readonly outer: ViaChain | null;
  /** Whether some operation of the chain is an own read's (`OWN_ROLES`), one of no typed default's, a typed default's. */
  readonly own: boolean;
  readonly ownUntyped: boolean;
  readonly typed: boolean;
  /** Whether some operation of the chain combines or removes a literal operand (`COMBINING_ROLES`). */
  readonly combining: boolean;
  /** Whether some operation of the chain is a list join, its operand's elements the joined list's (`joinedDomain`). */
  readonly joined: boolean;
}

/** A stored value's contributions by path (`stopsOf`): written copies, other whole values, and literals. */
export interface Stops {
  readonly written: Map<string, Stop[]>;
  readonly values: Map<string, Stop[]>;
  readonly literals: Map<string, Stop[]>;
}

/**
 * #2289: a literal a view's walk meets where a step of it has several elements (a cell), by the path it stands
 * at and the context it is read in there: one contribution, answered by its body's cell (`literals/cell.ts`), never
 * walked into. Its path and context are its view's own.
 */
export interface Link {
  readonly key: EvaluationKey;
  readonly value: PlaceId;
  readonly node: FlowNode;
  readonly path: readonly string[];
  readonly strip: readonly string[];
  readonly deep: boolean;
  readonly single: boolean;
  readonly via: ViaChain | null;
}

/**
 * #2289: a value's stops as the decider and the comparisons read them (`viewOfRead`), in its own coordinates: the
 * stops outside every cell and each literal with a cell as a link. Shared by each reader of the value's recipe; a
 * nested literal's body is linked, never copied into the view of a value that holds it. The raw `Stops` of the walk
 * keep every stop for the other readers. `depths`: the deepest path of each map, once asked.
 */
export interface View {
  readonly written: Map<string, Stop[]>;
  readonly values: Map<string, Stop[]>;
  readonly literals: Map<string, Stop[]>;
  readonly links: Map<string, Link[]>;
  depths: { readonly written: number; readonly values: number; readonly literals: number } | null;
}

/**
 * One task of the store walk by its value, node and strip alone (`expand`), its own recipe: what it stands as at its
 * own path and the parts the walk takes below it, each a task of its own, whatever reached it. A walk (`stopsOf`) and
 * every transfer read over it (`admission/transfers/`) take a task's recipe once per pass.
 */
export interface Expansion {
  readonly id: number;
  readonly value: PlaceId;
  readonly node: FlowNode;
  readonly strip: readonly string[];
  /** A copy of an unwritten place that may inherit a written type: a written copy too, beside what it stands as. */
  readonly inherits: { readonly from: PlaceId; readonly strip: readonly string[] } | null;
  /** A literal value with no written type, read whole or through a projection: its cells are its parts. */
  readonly literal: boolean;
  /** Its own stop, where it is one (no literal read into, no carrier): its list, written type and strip. */
  readonly stop: {
    readonly list: "written" | "values" | "literals";
    readonly term: TypeTerm | null;
    readonly strip: readonly string[];
  } | null;
  /** Its parts in the walk's order: a literal's cells, or a carrier's operands and then its own contribution. */
  readonly parts: readonly Part[];
}

/** A part of a walk's task (`Expansion.parts`): a value standing in it, and how the walk enters it. */
export interface Part {
  readonly value: PlaceId;
  readonly node: FlowNode;
  /** A literal's own cell: the step it stands at below the task's path; else `null`, at the task's own path. */
  readonly step: string | null;
  readonly strip: readonly string[];
  /** An operand stands below its operation (`true`), a literal's own cell at its step (`false`); `null` keeps the task's. */
  readonly deep: boolean | null;
  /** Whether it keeps the task's `single` (`Stop.single`): not one of several cells of a literal read into. */
  readonly single: boolean;
  /** Its evaluation key's position below the task's: an operand's, a cell's start, the carrier's own last. */
  readonly position: number;
  /** The carrier's own contribution, after what it carries. */
  readonly after: boolean;
  /** The role of an operand of an operation (a carrier no projection is): a link of its chain (`Via`). */
  readonly role: CarrierRole | null;
  /** Its own task's recipe, made when first asked (`partOf`). */
  expansion: Expansion | null;
}

/** A store's stops at one key (`keyStops`): the selected ones in evaluation order, its sitings and named data. */
export interface KeyStops {
  readonly selected: readonly Stop[];
  /** The selected ones, each snapshot once (`distinctStops`). */
  readonly distinct: () => readonly Stop[];
  readonly sitings: () => readonly Siting[];
  /** Of the sitings, the named data's (`ingress` null, no member of host data). */
  readonly namedSitings: () => readonly Siting[];
  readonly named: () => readonly Stop[];
}

/** A store's landing stops by ingress (`storeIngresses`): held whole, brought as members, each one's first stop. */
export interface StoreIngresses {
  readonly inline: ReadonlySet<PlaceId>;
  readonly members: ReadonlySet<PlaceId>;
  /** The index of an ingress's first stop in the store's list (`LandingIndex.byStore`). */
  readonly first: ReadonlyMap<PlaceId, number>;
}

/**
 * A contribution the store check may be sited at (`ingressSiteOf`): the ingress it reads, or `null` for named data
 * sited by itself.
 */
export interface Siting {
  readonly stop: Stop;
  readonly ingress: PlaceId | null;
  /** A member of host data the store reads: its own place's store check, no named data's. */
  readonly host?: true;
}

/** The values at one depth of a stored value's path, and the first of them no literal of it holds (`wholeBelow`). */
export interface Level {
  readonly values: readonly PlaceId[];
  readonly whole: PlaceId | null;
}

/**
 * The known structure of a stored value or a source key: the paths below it its literals and the stores below the
 * key give, and the source keys copied or called below it, each where it stands; below a source key, its elements only
 * (`depthOf`).
 */
export interface Structure {
  readonly paths: readonly (readonly string[])[];
  readonly sources: readonly { readonly below: readonly string[]; readonly key: CanonicalKey }[];
}

/** A candidate of a decided type: a store and the path below its destination it reaches the place at. */
export interface Candidate {
  readonly d: Definition;
  readonly at: PathSteps | readonly string[];
  /** The later stores of `d`'s alias class (`aliasKey`): checked only where `d` owes something. */
  readonly members?: readonly Definition[];
}

/** What decides a place: the kinds, by a written type, a written copy's or the first definite store's. */
export interface Decision {
  readonly root: PlaceId;
  /** Its path's steps; `null` for a cursor's (its steps are the arena's, never made). */
  readonly path: readonly string[] | null;
  /** Its path's label, as a recipe: its text made only where a diagnostic or a check shows it (`labelText`). */
  readonly label: Label;
  readonly tags: readonly ItemTag[];
  /** By a written type, at the place or of a copied binding: no number of an integer fits there. */
  readonly written: boolean;
  /** Whether the place's own written type decides, and whether it is a parameter's or a result's. */
  readonly own: boolean;
  readonly nullable: boolean;
  /** The store that decided, `null` for a written type. */
  readonly decider: Definition | null;
  /**
   * #2289: the decider is a strict literal cell one of whose elements decides nothing and may hold host data: the
   * decider's own store is a candidate too, its value's host data checked against the decision.
   */
  readonly deciderHost?: true;
  /** The candidates in source order. */
  readonly candidates: readonly Candidate[];
  /**
   * Decided by no contribution, the contract's kinds it is published with beside external data: only the external data
   * another store brought owes its check at each candidate; data a store brings inline has its boundary check, an
   * opaque value its member check at its access.
   */
  readonly published: boolean;
}

/** A path's stores: the direct ones and the prefixes whole stores or adds reach (`inputsOf`), each with its rest. */
export type Inputs = {
  readonly direct: readonly Candidate[];
  readonly prefixes: readonly { readonly key: Key; readonly rest: PathRef }[];
};

/**
 * A path admission decides (`groups`): a place and the steps below it; or, where its family is a wrapper's (`keyLane`),
 * its key's cursor alone, whose steps are the arena's and never made.
 */
export type DecidedAt =
  | { readonly root: PlaceId; readonly path: readonly string[]; readonly key?: undefined }
  | { readonly root: PlaceId; readonly path?: undefined; readonly key: KeyId };

/** A decision before it is recorded and its candidates taken (`decided`). */
export interface Decided {
  readonly key: Key;
  /** The decided kinds; `null` where nothing is checked; with `unknown` where an unrestricted part decides nothing. */
  readonly tags: readonly ItemTag[] | null;
  readonly nullable: boolean;
  readonly byWritten: boolean;
  /** Whether the place's own written type decides. */
  readonly own: boolean;
  /**
   * Whether the place is a parameter or a result with a written type: every argument or return into it is a candidate.
   */
  readonly transfer: boolean;
  readonly permitsNull: boolean;
  readonly decider: Definition | null;
  /** #2289: as `Decision.deciderHost`. */
  readonly deciderHost?: true;
  readonly site: SourceSite | null;
  readonly published: boolean;
  /**
   * Where a copy decides the path: the written type it copies there, the decision's `null` added (`optionalOf`),
   * whole below the path, so a store above a stopped decision is checked against it (`storeRequirement`, #1416).
   */
  readonly copied: TypeTerm | null;
  /**
   * Where a settled single-family contract decided the path without a scan: the one family of kinds that contract
   * holds, which names it (`kindsAt`).
   */
  readonly settled: readonly Item[] | null;
  /** #2289: its scan met a literal element a stop left undecided, so it is undecided (`budgetUndecided`). */
  readonly budget?: true;
}

/** A list `+` (`joinElements`). */
export type Join = Extract<CoreProgram["constraints"][number], { kind: "operation" }>;

/** What a joined value's element type is at a path: its kinds, whether each fits as itself, and the own kinds. */
export interface JoinDecided {
  readonly tags: readonly ItemTag[];
  /**
   * Whether each kind fits as itself rather than by its family: the kinds of a written type (a copy's, or a place's
   * decided by one), or a value's own kinds of several families.
   */
  readonly exact: boolean;
  /** Whether a written type decides it (a copy's, a place's): the later operands of a join add nothing to it. */
  readonly typed: boolean;
  readonly own: readonly ItemTag[];
  /** Whether a written type there holds `null` (an element's own `null` is its items'). */
  readonly nullable?: boolean;
}
