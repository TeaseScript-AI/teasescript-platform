import type { PlaceId, TypeTerm } from "../../graph.js";
import type { Definition, Key } from "../definitions.js";
import type { Callable, FlowNode } from "../flow-graph.js";
import type { IngressNode, Item, ItemTag, Writer } from "../items.js";
import type { Work } from "../solver.js";
import type { IndexObject } from "./literal-index.js";

// The shapes the contract side's indexes, identities, holders and classes are made of.

/** A written type at a path: a term, a literal's own cell or property to read further, or nothing. */
export type TypeAt =
  { readonly term: TypeTerm } | { readonly place: PlaceId; readonly rest: readonly string[] };

/** A holder's reference to another, seen from `shift` below it. */
export interface HolderReference {
  readonly to: Holder;
  readonly shift: readonly string[];
}

/** A source of a mark: one holder per source identity and projection (§8 r4.23). */
export interface Holder {
  readonly id: string;
  /** Its own reads: a stored read of a key with a tested key below it, at the path it stands at. */
  readonly reads: { readonly value: PlaceId; readonly path: readonly string[] }[];
  readonly readSeen: Set<PlaceId>;
  /** Its references, by the path below it where they stand: another holder, seen from `shift` below it. */
  readonly refsAt: Map<number, HolderReference[]>;
  readonly refSeen: Set<string>;
  /** The paths of a literal's guarded reads, by their ids (`pathAt`). */
  readonly guarded: Set<number>;
  depth?: number;
  memo?: Map<string, boolean>;
  /** #1278: the first steps of the paths its mark can depend on (`markFirsts`), `null` for any. */
  firsts?: ReadonlySet<string> | null;
  /** #1278: per path it holds references at, those references by the first step their marks can depend on. */
  byStep?: Map<number, ReferencesByStep>;
}

/** A holder's references at a path (`marksAt`), by the first step each one's mark can depend on, or any. */
export interface ReferencesByStep {
  readonly byStep: Map<string, HolderReference[]>;
  readonly any: readonly HolderReference[];
}

/** A source's identity, with the guard bit and the mark holder beside it, never in it (§8 r4.15). */
export interface Identity {
  readonly id: string;
  readonly key: Key | null;
  readonly guarded: boolean;
  readonly holder: Holder | null;
}

/** One source entry of a prefix's stores (one per identity). */
export interface PrefixEntry {
  readonly key?: Key;
  readonly unk?: number;
  readonly empty?: true;
  readonly elem?: PlaceId;
  readonly value?: PlaceId;
  readonly at?: readonly string[];
  /** The earliest store that put it there (F28). */
  w: Writer | null;
  /** The prefix's stores that brought it: A5's candidates, a set with a charged insertion per store. */
  readonly ds: Set<Definition | null>;
  readonly holder: Holder | null;
  guarded: boolean;
  ingress: IngressNode | undefined;
}

/**
 * A group of a prefix's literal entries that hold the same structure below a path and the same facts above it (S6-
 * CARRIERS §4.6's level): its earliest member stands for all, with their annotations united.
 */
export interface LevelGroup {
  readonly literal: PlaceId;
  /** The steps into the literal its member stands at: none for a literal stored whole, a projection's otherwise. */
  readonly at: readonly string[];
  readonly w: Writer | null;
  readonly holder: Holder | null;
  readonly guarded: boolean;
  readonly ingress: IngressNode | undefined;
}

/** A prefix's entries as its levels read them (§4.6): the levels' members, and the entries that answer by themselves. */
export interface PrefixLevels {
  readonly others: readonly PrefixEntry[];
  readonly base: readonly LevelGroup[];
}

/** A prefix's entries of one shape (`entryGroups`), the first answering for all where no ingress store differs. */
export interface EntryGroup {
  readonly entries: PrefixEntry[];
  w: Writer | null;
}

/**
 * The sources a prefix's reads take apart from its entries (§8 r4.15: a replaced alias source's own stores below its
 * root, kept apart by their first step), as a layer over the one its prefix inherits: an alias shares its source's
 * layer and adds only its own sources (r4.38), so k aliases each adding a field are k small layers, never k maps of up
 * to k fields. A layer knows its depth and its ancestors 2^i layers up, and its root which layers on it list each
 * first step at each depth, so a read asks those layers only.
 */
export interface SubLayer {
  /** Its own sources by their first step. */
  readonly own: ReadonlyMap<string, ReadonlySet<Key>>;
  readonly parent: SubLayer | null;
  readonly depth: number;
  readonly jumps: readonly SubLayer[];
  /** The layer at depth 0 it stands on, `null` for that one itself. */
  readonly root: SubLayer | null;
  /** The one source every source of it and its ancestors is, if there is one. */
  readonly only: Key | null;
  /** At its root: per first step and depth, the layers on it that list the step. */
  readonly byStep: Map<string, Map<number, Set<SubLayer>>>;
}

/**
 * A prefix's layers under a step (`Contract.relevantSubs`), by their positions among the layers it inherits or joins:
 * the sources each lists there in its own map, by the positions listing them, and the layers one of whose ancestors
 * lists the step.
 */
export interface StepLayers {
  readonly own: ReadonlyMap<Key, readonly number[]>;
  readonly deep: readonly number[];
}

/** What a prefix stores into the keys below it. */
export interface PrefixStores {
  readonly list: readonly PrefixEntry[];
  /** The sources' own stores below their root: the prefix's layer, or the one it inherits unchanged. */
  readonly subs: SubLayer | null;
  /** It holds something other than whole stores of copies. */
  readonly other: boolean;
  /** The prefix's stores that brought `subs`. */
  readonly inheritedBy: ReadonlySet<Definition | null>;
  /**
   * The further layers its stores join it to (a copy of one source, then of another), each referenced with the stores
   * that brought it, never flattened into a layer of its own (r4.46 (3)).
   */
  readonly also: readonly {
    readonly layer: SubLayer;
    readonly defs: ReadonlySet<Definition | null>;
  }[];
  readonly cut: boolean;
}

/**
 * G5 (5a): a cycle of whole copies, a strongly connected component of the places that the live, unguarded, exact whole
 * copies `prefixWork` follows link (`copiedRoot`), with its members as ports. A member with one live store at its
 * root (the copy of another member) is a link, an alias `prefixWork` replaces by its source's entry as before; every
 * other member is a stop, and a copy of a stop is an entry of its key wherever the copy is: the cut every entry into the
 * cycle takes at once. Before, a stop's two or more entries gave that entry where the walk reached the stop, and the
 * open stop's cut where it did not; a stop whose entries merge into one was replaced by it where the walk reached it.
 */
export interface CopyRing {
  readonly ports: readonly PlaceId[];
  readonly stops: ReadonlySet<PlaceId>;
}

/** A source a prefix's read at a path takes, with the prefix's stores that brought it (A5's candidates). */
export interface SubSource {
  readonly key: Key;
  readonly defs: ReadonlySet<Definition | null>;
}

/**
 * A computation of the identity layer (a value's or a key's identity, a prefix's stores, a literal's index and
 * signature): it yields each such computation it needs first, which runs on an explicit stack, and memoises its own
 * answer, so a flat chain of k wrappers or copies is k frames there, never k native ones.
 */
export type IdentityWork = Generator<() => IdentityWork, void, void>;

/** A prefix's stores while they are collected: one frame per prefix on an explicit stack. */
export interface PrefixFrame {
  readonly pk: Key;
  readonly defs: readonly Definition[];
  i: number;
  readonly out: PrefixEntry[];
  readonly seen: Map<string, number>;
  w: Writer | null;
  d: Definition | null;
  /** The layer it inherits and its stores that inherited it; the further layers, each with its stores. */
  inherit: SubLayer | null;
  readonly inheritedBy: Set<Definition | null>;
  readonly also: Map<SubLayer, Set<Definition | null>>;
  ck: Key | null;
  proj: readonly string[] | null;
  inner: PrefixStores | undefined;
  other: boolean;
  cut: boolean;
}

/** An entry to add to a prefix's stores. */
export interface EntryDraft {
  readonly key?: Key;
  readonly unk?: number;
  readonly empty?: true;
  readonly elem?: PlaceId;
  readonly value?: PlaceId;
  readonly at?: readonly string[];
  readonly w?: Writer | null;
  readonly guarded?: boolean;
  readonly ingress?: IngressNode | undefined;
}

/** A literal's read entry at a path: one per source identity, with its guards and ingress stores as annotations. */
export interface ReadEntry {
  readonly g: Definition | null;
  readonly value: PlaceId;
  guarded: boolean;
  readonly holder: Holder | null;
  ingress: IngressNode | undefined;
}

export interface ValueEntry {
  readonly g: Definition | null;
  readonly value: PlaceId;
}

/** A read's class (`Contract.readClass`), and the writer of the alias it reads, which its answer takes. */
export interface ReadClass {
  readonly cls: string | null;
  readonly writer: Writer | null;
  /**
   * For a read of an alias with no steps and no guard, the class of the read its alias's chain ends at, which a read of
   * an alias of it takes in its place: a chain of guard-free aliases of one source is one class.
   */
  readonly base: string | null;
}

/**
 * A literal's computed values of one class at a path (`othersAt`): those its answer reads, the others of a mixed class,
 * and the class's earliest cell writer.
 */
export interface OtherGroup {
  readonly read: readonly ValueEntry[];
  readonly rest: readonly ValueEntry[];
  readonly writer: Writer | null;
  readonly mixed: number;
  /** Whether the group is one of computed-key loads, which no path below their root changes (`loadsBelow`). */
  readonly loads: boolean;
}

/**
 * A literal's values of one class at a path (`OtherGroup`, `ReadClassGroup`): those its answer reads, the others of a
 * mixed class, and the class's earliest cell writer.
 */
export interface ClassGroup<E extends ValueEntry> {
  readonly read: readonly E[];
  readonly rest: readonly E[];
  readonly writer: Writer | null;
  readonly mixed: number;
}

/** A literal's reads of one class at a path (`readGroupsAt`). */
export type ReadClassGroup = ClassGroup<ReadEntry>;

/** A choice's options of one class (`Contract.choiceOptions`): those its answer reads, the others of a mixed class. */
export interface ChoiceGroup {
  readonly read: readonly number[];
  readonly rest: readonly number[];
  readonly mixed: number;
}

/** A value's class, its roles' writers and whether it is mixed (`Contract.classOf`, `classWriters`, `classMixed`). */
export interface ValueClass {
  readonly cls: string | null;
  readonly writers: readonly (Writer | null)[] | null;
  /** What its values can differ by beside writers (`MIXED_LEAF`, `MIXED_FAN`), 0 for nothing. */
  readonly mixed: number;
}

/**
 * A value's class as `classOf` keeps it: its roles' writers (`classWriters`) are its own, then its parts' in turn, read
 * from them where asked, so a chain of k operations keeps k parts, not k lists of up to k writers (#1357).
 */
export interface KeptClass {
  readonly cls: string | null;
  readonly mixed: number;
  /** Its own role's writer: a read's alias's, a literal's own place's; none for any other value. */
  readonly own: readonly (Writer | null)[];
  /** The values its other roles rest on, in their order (`classParts`). */
  readonly parts: readonly PlaceId[];
}

/** Whether a store goes below a property named `value`, and one named `text` (V30 §19). */
export interface StoredChoiceKeys {
  readonly value: boolean;
  readonly text: boolean;
}

/** A choice object's property its button value reads (V30 §19), or none. */
export type Selected = { readonly name: string; readonly type: TypeTerm } | null;

/**
 * What one path of a literal's index holds (§8 r4.9), with a node per step below it. A nested literal that alone
 * stands at a step is its own index's root there, shared, never copied (TABLE r4.164's local recipes): k nested
 * literals keep k nodes, never k indexes each through the literals below it.
 */
export interface IndexNode {
  /** The kinds its own terms give here, with the first literal's token. */
  readonly terms: Map<ItemTag, Writer>;
  readonly reads: ReadEntry[];
  /** The reads for the value side: once per exact identity (the copied key, guarded or not). */
  readonly exact: ValueEntry[];
  readonly others: ValueEntry[];
  objects: { readonly list: IndexObject[]; readonly count: Map<string, number> } | null;
  /** A reference kind stands here (F19a). */
  reference: boolean;
  /** A collection's element without a cell stands here. */
  empty: boolean;
  readonly children: Map<string, IndexNode>;
  /** The identities its entries were taken by: a computed value's source, a read's and an exact read's (`indexWork`). */
  readonly seen: Set<string>;
  readonly readIds: Map<string, ReadEntry>;
  /** What it and the nodes below it hold, once asked (`heldBelow`). */
  below?: NodeBelow;
  /** Its first read's and first computed value's place in the walk (`WalkRank`); per step, the tasks it came from. */
  firstRead: WalkRank | null;
  firstOther: WalkRank | null;
  readonly via: Map<string, WalkRank[]>;
  /** Its shape and everything below it as a literal's signature or structure takes it, once asked (`nodeShape`). */
  shapes?: { sig?: NodeShape; str?: NodeShape };
}

/**
 * What a node of a literal's index and the nodes below it hold (`heldBelow`): anything, a reference kind, a
 * computed value, a read a mark rests on (a guarded one, or one with a holder).
 */
export interface NodeBelow {
  readonly holds: boolean;
  readonly reference: boolean;
  readonly others: boolean;
  readonly marks: boolean;
  /** Its read and exact entries, and the nodes holding reads and computed values, counted at every path. */
  readonly reads: number;
  readonly exact: number;
  readonly readStands: number;
  readonly otherStands: number;
  /** A term's kind, an object or an empty collection stands at it or below it. */
  readonly beside: boolean;
}

/**
 * Where a node's first entry of a kind, or the task a step below it came from, stands in the walk of its node's own
 * tasks (`at`), and which of its node's first tasks it descends from (`top`): with each step's `via`, the order of the
 * literal's one walk before its index was a trie, a path's tasks in turn and a task's steps below it before the next
 * (`#walkOrder`).
 */
export interface WalkRank {
  readonly top: number;
  readonly at: number;
}

/**
 * A node's part of a literal's signature (`sig`) or structure (`str`), and everything below it (`Contract.nodeShape`):
 * its interned name, whether each part is plain (no reference kind, no ingress occurrence, no value standing for
 * itself), and for a structure whether a part is marked.
 */
export interface NodeShape {
  readonly name: string;
  readonly plain: boolean;
  readonly marked: boolean;
}

/** One index of a literal's structure, through its nested literals at every step (§8 r4.9). */
export interface LiteralIndex {
  readonly root: IndexNode;
  /** Its nodes by the pass's path ids (`nodeAt`), each found once; `null` where it holds no node. */
  readonly byId: Map<number, IndexNode | null>;
  /** F11: per path id and property, the first object there without it (`lackingAt`). */
  readonly lacking: Map<string, Writer | null>;
}

/** What a cell stores, as a class (`storedClass`): its name, and the source extent of its writers. */
export interface StoredClass {
  readonly name: string;
  readonly file: number;
  readonly start: number;
  readonly end: number;
}

/** An object of a literal at a path (a selection's alternative, `selectedAt`). */
export type LiteralObject = IndexObject;

/**
 * #1278: a selection's objects on one side (`selectionOf`): those it reads, in order, and by position those whose
 * selected value may hold any property (`open`) and those that hold only their names (`closed`), with per property the
 * names' sets that hold it and per set the positions of its objects (one set per source, shared by its reads); per
 * property read below, the parts a read takes (`selectionPieces`).
 */
export interface Selection {
  readonly objects: readonly LiteralObject[];
  readonly open: readonly number[];
  readonly closed: readonly number[];
  readonly sets: ReadonlyMap<string, readonly ReadonlySet<string>[]>;
  readonly holding: ReadonlyMap<ReadonlySet<string>, readonly number[]>;
  /** Every object's position, the parts of a read that answers no property alike. */
  readonly every: readonly number[];
  readonly pieces: Map<string, readonly SelectionPiece[]>;
}

/** A part of a selection's answer (`selectionPieces`): an object's position, or a run [lo, hi) of its closed objects. */
export type SelectionPiece = number | { readonly lo: number; readonly hi: number };

/** A gather site of a literal's index (`gatherCount`). */
export type IndexSite = Exclude<GatherSite, { readonly byValue: boolean }>;

/**
 * A wide gather (`Contract.gathered`): on the value side a literal's exact entries, its copies past an element step or
 * its computed values' groups at a path (`deeper`: a path the read goes below), or a selection's parts there; on the
 * contract side its reads or its computed values' groups at a path (`reads`, `groups`); on either side a selection's
 * closed objects, each read at `ABSENT` (`absent`).
 */
export type GatherSite =
  | {
      readonly kind: "exact" | "copies" | "others" | "reads" | "groups";
      readonly literal: PlaceId;
      /** Its path's id (`pathAt`). */
      readonly path: number;
      readonly deeper: boolean;
    }
  | {
      readonly kind: "selected";
      readonly literal: PlaceId;
      readonly path: number;
      readonly byValue: boolean;
      readonly below: boolean;
    }
  | {
      readonly kind: "absent";
      readonly literal: PlaceId;
      readonly path: number;
      readonly byValue: boolean;
      readonly below: boolean;
      readonly exact: boolean;
    };

/** The run facts of the indexes, for the ledger's identity and mark controls (not work). */
export interface ContractFacts {
  prefixEntries: number;
  literalEntries: number;
  markNodes: number;
  markVisits: number;
  /**
   * The record properties and records a choice's selection inspects (V30 §19): each property once where the literal
   * index decides it, each record once per read.
   */
  selectionVisits: number;
  /** The paths admission decided, in every pass (S6-CARRIERS §4.4: the member visits' bound). */
  decidedPaths: number;
  /** The cycles of whole copies found (`ringOf`), their ports and their stops, each once per pass. */
  ringComponents: number;
  ringPorts: number;
  ringStops: number;
}

/** A key whose admission decision stopped at its demand allowance (`Contract.stop`). */
export interface StoppedKey {
  readonly place: PlaceId;
  readonly path: readonly string[];
}

/** A group of a holder's reads of one base key in one callable and file. */
export interface ReadGroup {
  readonly callable: Callable | null;
  readonly file: number;
  readonly nodes: FlowNode[];
  byPosition: FlowNode[];
  byStart: number[];
}

/**
 * The part of a choice's answer `choiceItems` reads (a wide choice's, S10 part 2b): its option groups of [`lo`, `hi`);
 * or one written list's or set's elements of [`lo`, `hi`) (`elements`); `wide`, a wide such list's elements read as
 * their own tree of demands (`Values.choiceElements`) at the answer's `rest`.
 */
export interface ChoicePart {
  readonly lo?: number;
  readonly hi?: number;
  readonly elements?: { readonly index: number; readonly lo: number; readonly hi: number };
  readonly wide?: (index: number, count: number, rest: readonly string[]) => Work<readonly Item[]>;
}
