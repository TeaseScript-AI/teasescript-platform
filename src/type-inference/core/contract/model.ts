import type { PlaceId, TypeTerm } from "../../graph.js";
import type { Definition, Key } from "../definitions.js";
import type { Callable, FlowNode } from "../flow-graph.js";
import type { IngressNode, Item, ItemTag, Writer } from "../items.js";
import type { Proof, ProofDemand, Work } from "../solver.js";
import type { IndexObject } from "./literal-index.js";
import { type CanonicalKey, type KeyId, type Steps } from "./key-ids.js";

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
 * root, kept apart by their first step), as a layer over the one its prefix inherits and the ones its source joins:
 * an alias shares its source's layers and adds only its own sources (r4.38), so k aliases each adding a field are k
 * small layers, never k maps of up to k fields, and a join of two copies references both, never a flattened list
 * (r4.46 (3)). A read below a layer is answered once per layer and path (`layerSupport`, `layerDemand`), from its own
 * sources and its parent's and joins' answers (#1466).
 */
export interface SubLayer {
  /** Its own sources by their first step. */
  readonly own: ReadonlyMap<string, ReadonlySet<Key>>;
  readonly parent: SubLayer | null;
  /** The further layers its source joins, in the order its source's stores join them. */
  readonly joins: readonly SubLayer[];
  /** The one source every source of it and its ancestors is, if there is one (`null` where it joins a layer). */
  readonly only: Key | null;
  /** The place and path another pass finds it by (`replayLayer`); `null` where no pass can find it again. */
  readonly origin: LayerOrigin | null;
  /** Per path id read below it, its support and its summary's demand, each made once (`layerSupport`, `layerDemand`). */
  readonly paths: Map<number, LayerPath>;
  /** Its parent's depth and one; 0 for none. */
  readonly depth: number;
  /** Per step, the nearest of it and the layers below it by parents that lists the step (`listerOf`); made with it. */
  listers: StepNode | null;
  /** The nearest of it and the layers below it by parents that joins further layers, or `null`; made with it. */
  joined: SubLayer | null;
  /** The steps it and every layer below it list, as a support of their texts (`holds`); made with it. */
  steps: SupportNode | null;
}

/**
 * A node of a layer's map of steps to the nearest layer listing each (`SubLayer.listers`): a persistent binary radix
 * tree over the steps' code units, as `SupportNode`'s over keys, a layer's its parent's with its own steps added along
 * their paths, so finding the nearest layer that lists a step walks the step's bits, never the layers between.
 */
export interface StepNode {
  /** The bit its children part at; a leaf's `Infinity`. */
  readonly bit: number;
  /** A leaf's step; a branch's first leaf's. */
  readonly step: string;
  readonly left: StepNode | null;
  readonly right: StepNode | null;
  /** A leaf's layer. */
  readonly layer: SubLayer | null;
}

/**
 * A prefix's layers under a step (`Contract.relevantSubs`), by their positions among the layers it inherits or joins:
 * the sources each lists there in its own map, by the positions listing them, and those with a layer below them that
 * lists the step.
 */
export interface StepLayers {
  readonly own: ReadonlyMap<Key, readonly number[]>;
  readonly deep: readonly number[];
}

/**
 * A layer's logical identity (#1466, TABLE r4.227): an alias's the original place whose root it replaces, a projected
 * copy's the place and the path it is copied below, both as a cursor (`place#id`), so a summary's demand names its
 * layer by the program and the path, never by the order the analysis made layers in.
 */
export interface LayerOrigin {
  readonly kind: "alias" | "projected";
  readonly key: KeyId;
}

/** What a layer answers at one path, each made where first asked. */
export interface LayerPath {
  /** The sources there with a store at the path, as a support of source keys (`layerSupport`). */
  support?: SupportNode | null;
  /** The demand of its summary there (`layerDemand`). */
  demand?: ProofDemand<LayerProof>;
}

/**
 * A node of a layer answer's exact support (#1466): a persistent binary radix tree over source keys, by the bits of
 * their UTF-16 code units, each led by a bit that ends the key, so its leaves stand in the keys' order. Leaves are one
 * per source and content, branches one per bit and children (`supportLeaf`, `supportBranch`): two nodes are equal
 * exactly where they hold the same sources with the same content. A summary's node keeps what each consumer reads:
 * the merged items in the sources' order, the distinct sources with items counted to two, and the presence steps.
 */
export interface SupportNode {
  readonly id: number;
  /** The bit its children part at; a leaf's `Infinity`. */
  readonly bit: number;
  /** A leaf's source; a branch's first leaf's. */
  readonly key: Key;
  readonly left: SupportNode | null;
  readonly right: SupportNode | null;
  /** A summary's merged items in its sources' order; `null` for a support of sources alone. */
  readonly items: readonly Item[] | null;
  /** Its sources whose items are not all `empty`, counted to two. */
  readonly count: number;
  /** A summary's presence: per incoming state (lacks 1, has 2), what reading its sources in order makes of it. */
  readonly presence: readonly PresenceStep[] | null;
}

/**
 * C5c's presence after reading some sources in order (`propertyPresence`): whether one lacks the property (1) and one
 * has it (2), whether one gave an unknown, and the earliest literal that lacks it; reading stops once both hold.
 */
export interface PresenceStep {
  readonly mask: number;
  readonly unknown: boolean;
  readonly literal: Writer | null;
}

/** A layer summary's proof (`layerDemand`): its support, `null` where the summary declined. */
export interface LayerProof extends Proof {
  readonly root: SupportNode | null;
  readonly declined: boolean;
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
  readonly pk: CanonicalKey;
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
  proj: Steps | null;
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

/**
 * A member's class, its roles' writers and whether it is mixed (`Contract.classOf`, `classWriters`, `classMixed`), as
 * `roleMinima` reads them: the writers only where another member of its class compares them (#1357).
 */
export interface ValueClass {
  readonly cls: string | null;
  readonly writers: () => readonly (Writer | null)[];
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
  /** The values its other roles rest on, in their order, as its writers' walk reads them (`roleParts`). */
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
  /**
   * #1466: the layer answers' support nodes made (leaves and branches, each once per pass), the links they and the
   * layers' answers keep (a branch's two children, a union's memo, a layer's answer at a path), the summary demands
   * made, and the sources the exact enumeration listed (`relevantSubs`, its output's size).
   */
  supportNodes: number;
  supportEdges: number;
  layerDemands: number;
  listedSources: number;
}

/** A key whose admission decision stopped at its demand allowance (`Contract.stop`). */
/** G3 3a: a chain of property reads of a read, by its read and its first step (`Contract.chainOf`). */
export interface ChainRoot {
  readonly root: PlaceId;
  readonly first: string;
}

/** G3 3a: a literal's one read at a step and the node its value side reads it at (`Contract.literalHop`). */
export interface LoneRead {
  readonly read: PlaceId;
  readonly node: FlowNode | null;
}

/**
 * G3 3a: a wrapper's step (`Contract.wrapperHop`): the declaration of the binding read, its literal, the one read the
 * literal holds at the step, and the declaration's writer, which every read through the step takes.
 */
export interface WrapperHop {
  readonly decl: Definition;
  readonly literal: PlaceId;
  readonly read: PlaceId;
  /** The node the value side reads it at (`gatherAt`: its exact entry's definition's, else the declaration's). */
  readonly node: FlowNode;
  readonly writer: Writer | null;
}

/** What a read's position is asked of (`positionOf`): a value, or a key with its path's length. */
export type Owner = { readonly value: PlaceId } | { readonly key: Key; readonly length: number };

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
