import { isScalarKind } from "../../static-types.js";
import { hasIdentity, VALUE_KIND_NAMES, type ValueKind } from "../../value-kinds.js";
import type {
  ChoiceObjectEvidence,
  ChoiceOptionEvidence,
  PlaceId,
  PlaceKind,
  TypeTerm,
} from "../graph.js";
import type { CorePass } from "./answers.js";
import type { ReadRoute } from "./values.js";
import {
  ingressLeaf,
  keyOf,
  keyPath,
  keyPlace,
  recordPath,
  SELECTED_TEXT,
  SELECTED_VALUE,
  sortCost,
  type Definition,
  type Key,
} from "./definitions.js";
import { belowSelected, withoutEmpty, withWriter } from "./exact-path.js";
import type { Callable, FlowNode } from "./flow-graph.js";
import { marked } from "./guards.js";
import {
  builtinResult,
  clockResult,
  conversionCategory,
  declaredResult,
  declaredMethod,
  declaredProperty,
  dictList,
  interactionCategory,
  kindElement,
  memberStep,
  measuresLength,
  memberResult,
  methodCategory,
  selectsElement,
  shownResult,
} from "./method-categories.js";
import {
  EMPTY,
  firstContext,
  firstWriter,
  makeItem,
  mergeItems,
  reasonContext,
  REASON,
  weaken,
  type ContextWord,
  type IngressNode,
  type Item,
  type ItemTag,
  type Writer,
} from "./items.js";
import { operationItems, type Operator } from "./operator-table.js";
import { propertyStep, stepName, type ValueConstraint } from "./program.js";
import { sharing } from "./sharing.js";
import type { Decision, Demand, Work } from "./solver.js";

/*
 * The contract of the coarse core (checkpoint 9, TABLE §1, §3.2, §8): the kinds a key can hold on any run, flow-
 * insensitively: every live definition's value kinds, a written type's tags, `unknown` with its reasons for what the
 * core does not model. An element key's contract is the elements' kinds (E), with the emptiness mark where a source may
 * leave the collection empty (M open). The contract reads its sources through two indexes that share every source by
 * one identity (§8 r4.15): a prefix's whole stores (`prefixStores`, one entry per source identity, with the stores
 * that brought it as A5's provenance) and a literal's structure (`literalIndex`). The marks of §3.2 live beside
 * identity, in one holder per source and projection, whose references compose and are never copied (r4.23).
 */

/**
 * F19a: the reference kinds (V30 §12, §37), the kinds whose values have an identity: a speaker and every handle; an
 * access through one has no modelled member.
 */
export const REFERENCE: ReadonlySet<ItemTag> = new Set(VALUE_KIND_NAMES.filter(hasIdentity));

const COLLECTIONS: ReadonlySet<ItemTag> = new Set(["list", "set", "dict", "object"]);

/** F16: the operators the runtime's table has rows for, by the collector's operation names. */
const OPERATORS: ReadonlyMap<string, Operator> = new Map(
  (["+", "-", "*", "/", "%", "<", "<=", ">", ">="] as const).map((name) => [name, name]),
);

/** An unknown with these reasons (TABLE §1). */
export function unknownItem(reasons: number, writer: Writer | null = null): Item {
  return makeItem("unknown", writer, { reasons });
}

/**
 * §3.2: the mark travels with the value through every transfer: an item a transfer makes from others (F7's declared
 * result, F10's conversion, F14's length, F27's key) is guarded, and possible, where one of them is.
 */
export function carried(item: Item, from: readonly Item[]): Item {
  const guard = from.find((each) => each.guarded === true);
  return guard === undefined
    ? item
    : { ...item, cert: "pos", guarded: true, context: item.context ?? guard.context };
}

/** A typeless load's `default: null` beside its external data: the null carries the ingress's word (§3.4 r4.11). */
export function ingressNull(writer: Writer | null = null): Item {
  return makeItem("null", writer, { cert: "pos", word: "unknown" });
}

/**
 * F18 (r4.5), F19 (r4.1): the kinds a `load` or `fromJson` takes from its default's (the input): the default's own;
 * `unknown` where it has none; `unknown` and, at the value itself, the ingress `null` (with the writer of the default's
 * `null` where `writer` asks) where it holds only `null` (a known `default: null` keeps null). A choice on the default's
 * completed kinds: a provisional default without kinds is not yet one without kinds.
 */
export function typedDefault(rest: readonly string[], writer: boolean): Decision {
  return {
    choose: (input) =>
      withoutEmpty(input).length === 0
        ? "none"
        : input.every((item) => item.tag === "null")
          ? "null"
          : "own",
    answer: (choice, input) => {
      if (choice === "none") return [unknownItem(REASON.external), ...withoutEmpty(input)];
      if (choice !== "null") return input;
      const first = input.find((item) => item.tag === "null");
      return [
        unknownItem(REASON.external),
        ...(rest.length === 0 ? [ingressNull(writer ? (first?.writer ?? null) : null)] : []),
        ...input.filter((item) => item.tag !== "null"),
      ];
    },
  };
}

/** F19 (r4.1): a default holds only `null`, or nothing (`[ingressNull()]`, or none), on its completed kinds. */
export const ONLY_NULL: Decision = {
  choose: (input) => (input.every((item) => item.tag === "null") ? "null" : "other"),
  answer: (choice) => (choice === "null" ? [ingressNull()] : []),
};

/** F11 (r4.4): an object's own `first`, `last` or `random`, which the core does not read. */
export const OWN_SELECTION: Item = Object.freeze(
  makeItem("unknown", null, { reasons: REASON.opaque, context: "unmodelled", cert: "pos" }),
);

/** F19a: a reference's member, the runtime's. */
export const OPAQUE_MEMBER: Item = OWN_SELECTION;

/** F19a (r4.44): what a receiver's kinds hold beside them where its component decided it a reference (`RECEIVER`). */
const HELD_REFERENCE: Item = Object.freeze(makeItem("unknown", null, { reasons: REASON.opaque }));
/** `severalElements`'s answer as its demand's items: one item for several, none for fewer. */
const SEVERAL: readonly Item[] = Object.freeze([HELD_REFERENCE]);

/**
 * F19a (r4.44): a receiver's kinds (the input) and the choice, on its completed kinds, whether it holds a reference
 * kind, whose members are opaque: `HELD_REFERENCE` beside its kinds where it does. Inside a component it is made once
 * on the completed open solve, in which every receiver is read as a record (a prefix that holds only reference kinds
 * holds nothing a step below), and held for the second; so a receiver whose reference comes only round its own cycle
 * is a reference's.
 */
const RECEIVER: Decision = {
  choose: (input) => (input.some((item) => REFERENCE.has(item.tag)) ? "reference" : "other"),
  answer: (choice, input) => (choice === "reference" ? [...input, HELD_REFERENCE] : input),
};

/**
 * Whether a receiver's item has a structure a step below is read from, through the stores into it: a record or a
 * collection. A scalar or `null` has none; a reference's members are the runtime's (F19a); an unknown's members are
 * unknown for its own reasons, from its own ingress (`belowUnknown`), whatever those reasons are.
 */
function holdsBelow(item: Item): boolean {
  return (
    item.tag !== "unknown" &&
    item.tag !== "empty" &&
    item.tag !== "null" &&
    !isScalarKind(item.tag) &&
    !REFERENCE.has(item.tag)
  );
}

/** What a step below an unknown holds: an unknown for the same reasons, from the same ingress (F15, C9). */
function belowUnknown(item: Item): Item {
  return makeItem("unknown", item.writer, {
    cert: item.cert,
    reasons: item.reasons,
    context: item.context,
    ...(item.ingress === undefined ? {} : { ingress: item.ingress }),
    ...(item.loose === true ? { loose: true } : {}),
    ...(item.guarded === true ? { guarded: true } : {}),
  });
}

/** F19a (r4.44): whether a receiver's kinds, as a `RECEIVER` demand answers them, are a reference's. */
export function heldReference(items: readonly Item[]): boolean {
  return items.includes(HELD_REFERENCE);
}

/** The collector's operation of an operator: unary minus is the table's `neg`. */
export function operatorOf(constraint: ValueConstraint): Operator | null {
  if (constraint.kind !== "operation") return null;
  const { family, name } = constraint.contract;
  if (family === "unary") return name === "-" ? "neg" : null;
  if (family !== "operator" && family !== "comparison") return null;
  return OPERATORS.get(name) ?? null;
}

/** The kinds a written type gives (F2): each V30 type its own tag, `unknown` for a type the core does not model. */
export function typeTags(term: TypeTerm): ItemTag[] {
  switch (term.kind) {
    case "atom":
      return [term.name];
    case "list":
    case "set":
    case "dict":
    case "object":
      return [term.kind];
    case "union":
      return term.members.flatMap(typeTags);
    default:
      return ["unknown"];
  }
}

/** A written type at a path: a term, a literal's own cell or property to read further, or nothing. */
export type TypeAt =
  { readonly term: TypeTerm } | { readonly place: PlaceId; readonly rest: readonly string[] };

function typeAtPath(term: TypeTerm, path: readonly string[]): TypeAt | null {
  if (path.length === 0) return { term };
  const [step, ...rest] = path;
  // an optional or union collection: its members' elements
  if (term.kind === "union") {
    const members = term.members
      .map((member) => typeAtPath(member, path))
      .filter((member) => member !== null);
    if (members.length === 1) return members[0]!;
    const terms = members.flatMap((member) => ("term" in member ? [member.term] : []));
    if (members.length > 1 && terms.length === members.length)
      return { term: { kind: "union", members: terms } };
    return null;
  }
  if ((term.kind === "list" || term.kind === "set" || term.kind === "dict") && step === "element")
    return term.element.kind === "ref"
      ? { place: term.element.place, rest }
      : typeAtPath(term.element, rest);
  if (term.kind === "object" && term.properties !== null) {
    const property = term.properties.find((candidate) => propertyStep(candidate.name) === step);
    if (property === undefined) return null;
    return property.type.kind === "ref"
      ? { place: property.type.place, rest }
      : typeAtPath(property.type, rest);
  }
  return null;
}

/** The term of a written type at a path, when the path stays in the written type. */
export function termAt(term: TypeTerm, path: readonly string[]): TypeTerm | null {
  const at = typeAtPath(term, path);
  return at !== null && "term" in at ? at.term : null;
}

/** A source of a mark: one holder per source identity and projection (§8 r4.23). */
/** A holder's reference to another, seen from `shift` below it. */
interface HolderReference {
  readonly to: Holder;
  readonly shift: readonly string[];
}

interface Holder {
  readonly id: string;
  /** Its own reads: a stored read of a key with a tested key below it, at the path it stands at. */
  readonly reads: { readonly value: PlaceId; readonly path: readonly string[] }[];
  readonly readSeen: Set<PlaceId>;
  /** Its references, by the path below it where they stand: another holder, seen from `shift` below it. */
  readonly refsAt: Map<string, HolderReference[]>;
  readonly refSeen: Set<string>;
  /** The paths of a literal's guarded reads. */
  readonly guarded: Set<string>;
  depth?: number;
  memo?: Map<string, boolean>;
}

/** A source's identity, with the guard bit and the mark holder beside it, never in it (§8 r4.15). */
interface Identity {
  readonly id: string;
  readonly key: Key | null;
  readonly guarded: boolean;
  readonly holder: Holder | null;
}

/** One source entry of a prefix's stores (one per identity). */
interface PrefixEntry {
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
interface LevelGroup {
  readonly literal: PlaceId;
  /** The steps into the literal its member stands at: none for a literal stored whole, a projection's otherwise. */
  readonly at: readonly string[];
  readonly w: Writer | null;
  readonly holder: Holder | null;
  readonly guarded: boolean;
  readonly ingress: IngressNode | undefined;
}

/** A prefix's entries as its levels read them (§4.6): the levels' members, and the entries that answer by themselves. */
interface PrefixLevels {
  readonly others: readonly PrefixEntry[];
  readonly base: readonly LevelGroup[];
}

/**
 * The sources a prefix's reads take apart from its entries (§8 r4.15: a replaced alias source's own stores below its
 * root, kept apart by their first step), as a layer over the one its prefix inherits: an alias shares its source's
 * layer and adds only its own sources (r4.38), so k aliases each adding a field are k small layers, never k maps of up
 * to k fields. A layer knows its depth and its ancestors 2^i layers up, and its root which layers on it list each
 * first step at each depth, so a read asks those layers only.
 */
interface SubLayer {
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
type IdentityWork = Generator<() => IdentityWork, void, void>;

/** A prefix's stores while they are collected: one frame per prefix on an explicit stack. */
interface PrefixFrame {
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
interface EntryDraft {
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
interface ReadEntry {
  readonly g: Definition | null;
  readonly value: PlaceId;
  guarded: boolean;
  readonly holder: Holder | null;
  ingress: IngressNode | undefined;
}

interface ValueEntry {
  readonly g: Definition | null;
  readonly value: PlaceId;
}

/** Whether a store goes below a property named `value`, and one named `text` (V30 §19). */
export interface StoredChoiceKeys {
  readonly value: boolean;
  readonly text: boolean;
}

/** A choice object's property its button value reads (V30 §19), or none. */
type Selected = { readonly name: string; readonly type: TypeTerm } | null;

/** One index of a literal's structure, through its nested literals at every step (§8 r4.9). */
export interface LiteralIndex {
  /** Per path, the kinds its own terms give there, with the first literal's token. */
  readonly terms: Map<string, Map<ItemTag, Writer>>;
  readonly reads: Map<string, ReadEntry[]>;
  /** The reads for the value side: once per exact identity (the copied key, guarded or not). */
  readonly exact: Map<string, ValueEntry[]>;
  readonly others: Map<string, ValueEntry[]>;
  readonly objects: Map<
    string,
    {
      readonly list: {
        readonly names: Set<string>;
        readonly token: Writer;
        readonly term: Extract<TypeTerm, { readonly kind: "object" }>;
        /** V30 §19: the property its button value reads, its `value`, else its `text`, or `null`. */
        readonly selected: Selected;
      }[];
      readonly count: Map<string, number>;
    }
  >;
  readonly references: Set<string>;
  readonly empty: Set<string>;
  readonly lacking: Map<string, Writer | null>;
}

const NESTING = 256;

/** The kinds that may have a member an unknown receiver is asked for (A7 r4.10). */
export const MEMBER_KINDS: readonly ValueKind[] = [
  "string",
  "list",
  "set",
  "dict",
  "object",
  "range",
  "duration",
  "calendarDuration",
  "angle",
  "date",
  "time",
  "datetime",
  "absoluteDateTime",
];

/** A set or map: the smaller of two key sets, intersected with the larger. */
function common<T>(
  a: { readonly size: number; has(key: T): boolean; keys(): Iterable<T> },
  b: { readonly size: number; has(key: T): boolean; keys(): Iterable<T> },
): T[] {
  return a.size <= b.size
    ? [...a.keys()].filter((key) => b.has(key))
    : [...b.keys()].filter((key) => a.has(key));
}

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
}

export class Contract {
  readonly facts: ContractFacts = {
    prefixEntries: 0,
    literalEntries: 0,
    markNodes: 0,
    markVisits: 0,
    selectionVisits: 0,
    decidedPaths: 0,
  };
  readonly #prefix = new Map<Key, PrefixStores>();
  readonly #subPaths = new Map<Key, ReadonlySet<string>>();
  readonly #aliasLayers = new WeakMap<PrefixStores, SubLayer | null>();
  readonly #projectedLayers = new Map<string, SubLayer | null>();
  readonly #keys = new Map<Key, Identity>();
  readonly #identities = new Map<PlaceId, Identity>();
  readonly #aliases = new Map<PlaceId, { readonly key: Key; readonly guarded: boolean }>();
  readonly #holders = new Map<string, Holder>();
  readonly #literals = new Map<PlaceId, LiteralIndex>();
  readonly #signatures = new Map<PlaceId, string>();
  /** A carrier value's identity by its shape (`#identityWork`), interned; a plain literal's (`#signatureWork`). */
  readonly #carrierIds = new Map<string, string>();
  readonly #literalIds = new Map<string, string>();
  /** Per read, its snapshot (`readSnapshot`). */
  readonly #snapshots = new Map<PlaceId, string>();
  /** Each value's structure identity (`structureOf`), and its interned shapes. */
  readonly #structures = new Map<PlaceId, string>();
  readonly #structureIds = new Map<string, string>();
  /** The structures that hold a carrier whose operand read is marked below it (`#guardsBelow`): no level's members. */
  readonly #markedStructures = new Set<string>();
  /** A literal's sub-structure below each path, and what stands at each path itself (`#levelsOf`). */
  readonly #literalLevels = new Map<
    PlaceId,
    { readonly below: ReadonlyMap<string, string>; readonly at: ReadonlyMap<string, string> }
  >();
  /** A prefix's literal entries grouped at each path below it (`#groupsAt`), per prefix and path. */
  readonly #levelGroups = new Map<string, readonly LevelGroup[]>();
  readonly #levelBases = new Map<Key, PrefixLevels>();
  readonly #groups = new WeakMap<
    readonly unknown[],
    Map<Key, { readonly byCallable: Map<Callable | null, ReadGroup>; readonly list: ReadGroup[] }>
  >();
  readonly #lands = new Map<string, TypeTerm | null>();
  #placeKeys: Map<PlaceId, Key[]> | null = null;
  #choiceKeysStored: StoredChoiceKeys | null = null;
  #subFirst: Map<PlaceId, Set<string>> | null = null;
  #collected = false;

  /** The value-side literal reads that passed an element step over a copy, by literal, path and node (F12). */
  readonly #overCopy = new Set<string>();

  public constructor(readonly pass: CorePass) {}

  /** S3 §1's route of a literal's value at a path: the contract's past an element step over a copy (F12). */
  public literalRoute(literal: PlaceId, rest: readonly string[], node: FlowNode | null): ReadRoute {
    return this.#overCopy.has(`${literal}|${rest.join(".")}|${node?.id ?? "-"}`)
      ? "contract"
      : "exact";
  }

  // ------------------------------------------------------------------------------------------- the contract of a key

  /** The contract of a key (§3.2): a demand, once per key and pass. */
  public *contractOf(key: Key): Work<readonly Item[]> {
    const site = this.pass.program.places[keyPlace(key)]?.site ?? null;
    return yield {
      key: `c|${key}`,
      kind: "contract",
      file: site?.file ?? -1,
      offset: site?.start ?? -1,
      make: () => this.#contractOf(key),
    };
  }

  *#contractOf(key: Key): Work<readonly Item[]> {
    const { program } = this.pass;
    const place = keyPlace(key);
    const found = program.places[place];
    if (found === undefined) return [unknownItem(REASON.external)];
    if (program.isHost(place)) return [unknownItem(REASON.external)];
    if (program.speakerPlaces.has(place)) return [unknownItem(REASON.opaque)];
    // a key through a member a built-in value answers by itself (a copy of `d.values`, of `date.year`)
    return yield* this.#keyThrough(key, 0);
  }

  /**
   * A key's contract along a path through a member a built-in value answers by itself from the step `from` on, its
   * receiver decided as a reference's or not once (F19a, r4.44): a reference's member is the runtime's.
   */
  #keyThrough(key: Key, from: number): Work<readonly Item[]> {
    const at = memberStep(keyPath(key), from);
    return at < 0 ? this.#keyContract(key) : this.#keyListsAt(key, at);
  }

  /** `#keyThrough` at the step `at`, the first of the key's path from its `from` on that a built-in value answers. */
  *#keyListsAt(key: Key, at: number): Work<readonly Item[]> {
    const place = keyPlace(key);
    const path = keyPath(key);
    const receiver = yield* this.receiverKinds(keyOf(place, path.slice(0, at)));
    if (heldReference(receiver)) return yield* this.#keyContract(key);
    return yield* this.#members(path, at, receiver, (along, start) =>
      this.#keyThrough(keyOf(place, along), start),
    );
  }

  /** The contract of a key from its stores and its prefixes' (§3.2). */
  *#keyContract(key: Key): Work<readonly Item[]> {
    const { program } = this.pass;
    const place = keyPlace(key);
    const path = keyPath(key);
    const found = program.place(place);
    if (program.cellOwner.has(place) || program.hasOf.has(place))
      return yield* this.contractOfLiteral(place, path);
    // F19a: a reference's member is opaque, whatever is stored through it
    const receiver = yield* this.#receiver(key);
    if (receiver.reference) return [unknownItem(REASON.opaque)];
    const written = writtenOf(found.kind);
    // F2, F22: the written type is the contract; the stores keep M. §3.2 (r4.9): it fixes the kinds, never removes the
    // mark of what is stored
    if (written !== null) {
      const at = termAt(written, path);
      if (at !== null) {
        const stored = yield* this.#contractAlong(place, path, 0, receiver.floor);
        const guarded = stored.some((item) => item.guarded === true);
        const tags = typeTags(at).map((tag) =>
          makeItem(tag, null, guarded ? { cert: "pos", guarded: true } : {}),
        );
        return path.at(-1) === "element" && stored.some((item) => item.tag === "empty")
          ? [...tags, EMPTY]
          : tags;
      }
    }
    const along = yield* this.#contractAlong(place, path, 0, receiver.floor);
    // below a prefix without a structure, what its unknowns and references hold there
    return mergeItems([...along, ...receiver.below], program.scope);
  }

  /** The contract's answer to a read (§3.2): every kind as an item, definite only by P3; the read's word. */
  /**
   * TABLE §3.4, F12 (r4.48 (5)): whether an element read at the key's first element step is answered by the contract
   * there, that is where several element-contributing sources, or a literal with several elements, meet at that step;
   * a single exact contribution is no such meeting. Over the collection's own stores and every prefix's, as its
   * contract reads them; a copy's own elements by the same question; once per element step.
   */
  public *severalElements(key: Key): Work<boolean> {
    const place = keyPlace(key);
    const path = keyPath(key);
    const step = path.indexOf("element");
    if (step < 0) return false;
    const at = keyOf(place, path.slice(0, step + 1));
    const site = this.pass.program.places[place]?.site ?? null;
    // a demand per element step, so a chain of collections read from collections (a function's result returning
    // another's) is followed on the solver's explicit stack, and a copy cycle is solved as its component
    const several = yield {
      key: `s|${at}`,
      kind: "contract",
      file: site?.file ?? -1,
      offset: site?.start ?? -1,
      make: () => this.#severalWork(at),
    };
    return several.length > 0;
  }

  *#severalWork(at: Key): Work<readonly Item[]> {
    const place = keyPlace(at);
    const collection = keyPath(at).slice(0, -1);
    let count = 0;
    for (let length = collection.length; length >= 0 && count < 2; length -= 1) {
      this.pass.program.work.charge("invSteps");
      const stored = this.prefixStores(keyOf(place, collection.slice(0, length)));
      const below = [...collection.slice(length), "element"];
      for (const entry of stored.list) {
        if (count >= 2) break;
        count += yield* this.#elementsOf(entry, below);
      }
      for (const sub of this.relevantSubs(stored, below)) {
        if (count >= 2) break;
        this.pass.program.work.charge("invSteps");
        if (withoutEmpty(yield* this.subAt(sub.key, below)).length > 0) count += 1;
      }
    }
    return count >= 2 ? SEVERAL : [];
  }

  /** The elements one source entry gives at `below` (which ends with an element step), counted to two. */
  *#elementsOf(entry: PrefixEntry, below: readonly string[]): Work<number> {
    const { program, definitions } = this.pass;
    program.work.charge("invSteps");
    if (withoutEmpty(yield* this.entryAt(entry, below)).length === 0) return 0;
    if (entry.key !== undefined)
      return (yield* this.severalElements(
        keyOf(keyPlace(entry.key), [...keyPath(entry.key), ...below]),
      ))
        ? 2
        : 1;
    if (entry.value === undefined || entry.elem !== undefined || !program.hasOf.has(entry.value))
      return 1;
    // a literal: its elements at the step, through its own fields and elements; a value it holds counts once
    const path = [...(entry.at ?? []), ...below];
    let values: readonly PlaceId[] = [entry.value];
    let count = 0;
    for (const [index, step] of path.entries()) {
      const next: PlaceId[] = [];
      for (const value of values) {
        program.work.charge("invSteps");
        const types = program.hasOf.get(value);
        if (types === undefined) {
          count += 1;
          continue;
        }
        for (const has of types) {
          const at = typeAtPath(has.type, [step]);
          if (at === null || !("place" in at)) continue;
          const cells = definitions.cellDefs.get(at.place) ?? [];
          if (index === path.length - 1) count += cells.length;
          else for (const d of cells) next.push(d.value!);
        }
      }
      if (count >= 2) return 2;
      values = next;
    }
    return Math.min(count, 2);
  }

  public *contractRead(
    key: Key,
    node: FlowNode,
    context: ContextWord,
    later = false,
  ): Work<readonly Item[]> {
    const { program, definitions, lists } = this.pass;
    const items = yield* this.contractOf(key);
    const kinds = withoutEmpty(items);
    const place = keyPlace(key);
    const path = keyPath(key);
    const found = program.place(place);
    const declaration = definitions.declOf.get(place);
    // P3: one kind, not unknown, no guarded source, the root's declaration dominates the read, the read live
    let definite =
      kinds.length === 1 &&
      kinds[0]!.tag !== "unknown" &&
      kinds[0]!.guarded !== true &&
      !node.dead &&
      (found.kind.kind === "parameter" ||
        found.kind.kind === "result" ||
        (declaration !== undefined &&
          lists.live(declaration) &&
          program.reached(declaration.node) &&
          program.dom.dominates(declaration.node, node)));
    // every selection on the way holds an element
    for (let length = 1; length <= path.length && definite; length += 1)
      if (path[length - 1] === "element") {
        const elements = yield* this.contractOf(keyOf(place, path.slice(0, length)));
        if (
          elements.length === 0 ||
          elements.some((item) => item.tag === "empty" || item.tag === "unknown")
        )
          definite = false;
      }
    // §3.4: an unknown's reason word comes before any X context: its own, and a deferred parameter's every item's
    const deferred = kinds.some(
      (item) => item.tag === "unknown" && (item.reasons & REASON.deferred) !== 0,
    );
    // §3.4: the word is the read's first failing condition; where `context` is a later condition's or the value's
    // arrival (`later`), an element read the contract answers fails X3 before it (r4.48 (5))
    const word: ContextWord = deferred
      ? "deferred-parameter"
      : later && path.includes("element") && (yield* this.severalElements(key))
        ? "member"
        : context;
    return items.map((item) =>
      item.tag === "empty"
        ? item
        : {
            ...item,
            cert: definite ? "def" : "pos",
            context: item.tag === "unknown" ? reasonContext(item.reasons) : word,
          },
    );
  }

  /** §3 step 1, F19a: a receiver on the key's path whose contract holds a reference kind (one object behind every alias). */
  public *refReceiver(key: Key): Work<boolean> {
    return (yield* this.#receiver(key)).reference;
  }

  /**
   * One walk of a key's receivers (its prefixes, each a `RECEIVER` demand): whether one is decided a reference's
   * (F19a, r4.44), and else the longest prefix whose kinds hold nothing a step below can be read from (none yet, or
   * only scalars, `null`, reference kinds and unknowns: no record or collection, `holdsBelow`), -1 for none, and what
   * a path below it holds instead (`below`: each unknown's own, `belowUnknown`, and a reference's member, the
   * runtime's). A path below such a value holds nothing else, so the contract asks no shorter prefix's stores: the
   * stores through a prefix are followed only for its record and collection alternatives, so a recursive projection is
   * not followed below a receiver without one (Astra B2, B2-r2, and the open solve of r4.44, which reads every receiver
   * as a record); the read reruns when the prefix gains a kind with a structure (C5 reports a member read the kinds
   * lack).
   */
  *#receiver(
    key: Key,
  ): Work<{
    readonly reference: boolean;
    readonly floor: number;
    readonly below: readonly Item[];
  }> {
    const place = keyPlace(key);
    const path = keyPath(key);
    let floor = -1;
    let below: readonly Item[] = [];
    for (let length = 0; length < path.length; length += 1) {
      this.pass.program.work.charge("invSteps");
      const items = yield* this.receiverKinds(keyOf(place, path.slice(0, length)));
      if (heldReference(items)) return { reference: true, floor, below };
      if (!items.some(holdsBelow)) {
        floor = length;
        below = [
          ...items.filter((item) => item.tag === "unknown").map(belowUnknown),
          ...(items.some((item) => REFERENCE.has(item.tag)) ? [unknownItem(REASON.opaque)] : []),
        ];
      }
    }
    return { reference: false, floor, below };
  }

  /** A receiver's contract as a demand of its own, with F19a's decision whether it is a reference's (r4.44). */
  public *receiverKinds(key: Key): Work<readonly Item[]> {
    const site = this.pass.program.places[keyPlace(key)]?.site ?? null;
    return yield {
      key: `rc|${key}`,
      kind: "contract",
      file: site?.file ?? -1,
      offset: site?.start ?? -1,
      make: () => this.contractOf(key),
      decision: RECEIVER,
    };
  }

  /**
   * A value's contract as a receiver (a method's, a length's owner), a demand of its own with F19a's decision (r4.44):
   * the one decision both sides take before an exact answer or a transfer's alternatives.
   */
  public *valueReceiver(receiver: PlaceId): Work<readonly Item[]> {
    const site = this.pass.program.places[receiver]?.site ?? null;
    return yield {
      key: `cv|${receiver}`,
      kind: "contract",
      file: site?.file ?? -1,
      offset: site?.start ?? -1,
      make: () => this.contractOfValue(receiver),
      decision: RECEIVER,
    };
  }

  /**
   * The definitions of a key and of its prefixes from the prefix of length `from` on (0: every one, the key's contract;
   * 1: a replaced source's own stores below its root, which `prefixStores` keeps apart from the root's whole stores),
   * none at or below `floor`, the longest prefix that holds nothing below it (`#receiver`).
   */
  *#contractAlong(place: PlaceId, path: readonly string[], from: number, floor = -1): Work<Item[]> {
    const { program, definitions, lists } = this.pass;
    const out: Item[] = [];
    for (let length = path.length; length >= from && length > floor; length -= 1) {
      const prefix = keyOf(place, path.slice(0, length));
      const rest = path.slice(length);
      if (rest.length > 0) {
        // a prefix's whole stores, shared by every property below it; its literals by level (§4.6), each group of the
        // same structure below the path once (with a selection step, every entry by itself)
        const stores = this.prefixStores(prefix);
        if (rest.some((step) => step === SELECTED_VALUE || step === SELECTED_TEXT))
          for (const entry of stores.list) out.push(...(yield* this.entryAt(entry, rest)));
        else {
          const levels = this.#prefixLevels(prefix, stores);
          for (const entry of levels.others) out.push(...(yield* this.entryAt(entry, rest)));
          if (levels.base.length > 0)
            for (const group of this.#groupsAt(prefix, levels.base, rest))
              out.push(
                ...this.#annotated(
                  group,
                  rest,
                  withWriter(
                    yield* this.contractOfValueAt(group.literal, [...group.at, ...rest]),
                    group.w,
                  ),
                ),
              );
        }
        // a replaced source's own stores below the prefix, only where they lie, marked as its copies' entries are
        // (§3.2: a guarded read of a copy of it is a mark of its holder)
        for (const sub of this.relevantSubs(stores, rest)) {
          const items = yield* this.subAt(sub.key, rest);
          out.push(
            ...(this.#marksAt(this.keyIdentity(sub.key).holder, rest) ? marked(items) : items),
          );
        }
        continue;
      }
      for (const d of definitions.byKey.get(prefix) ?? []) {
        program.work.charge("invSteps");
        if (!lists.live(d)) continue;
        if (d.kind === "const") {
          out.push(...(d.items ?? []));
          continue;
        }
        // F5–F7: the collection's kind is unchanged
        if (d.kind !== "whole") continue;
        const parameter = program.place(place).kind;
        if (
          (d.how === "argument" || d.how === "parameter default") &&
          parameter.kind === "parameter" &&
          parameter.written === null &&
          !lists.singleSite(d.fn)
        )
          // F21: several sites
          out.push(unknownItem(REASON.deferred, definitions.writerOf(d)));
        out.push(
          ...withWriter(yield* this.contractOfValueAt(d.value!, []), definitions.writerOf(d)),
        );
      }
    }
    return out;
  }

  /** A prefix entry's kinds at the rest of the path. */
  public *entryAt(entry: PrefixEntry, rest: readonly string[]): Work<readonly Item[]> {
    this.pass.program.work.charge("invSteps");
    if (entry.unk !== undefined) return [unknownItem(entry.unk, entry.w)];
    // F6, F7: the contract's M is open
    if (entry.empty === true) return rest.length === 1 && rest[0] === "element" ? [EMPTY] : [];
    // F5: an add's element; an `addAll` contributes kinds, never emptiness (M unchanged)
    if (entry.elem !== undefined) {
      if (rest[0] !== "element") return [];
      const at = [...(entry.at ?? []), ...rest.slice(1)];
      const items = this.#annotated(
        entry,
        at,
        withWriter(yield* this.contractOfValueAt(entry.elem, at), entry.w),
      );
      return rest.length === 1 ? withoutEmpty(items) : items;
    }
    // §3.2: a copy read under a guard; a tested child's mark by the entry's holder at the path (r4.15)
    if (entry.key !== undefined)
      return this.#annotated(
        entry,
        rest,
        withWriter(
          yield* this.contractOf(keyOf(keyPlace(entry.key), [...keyPath(entry.key), ...rest])),
          entry.w,
        ),
      );
    return this.#annotated(
      entry,
      rest,
      withWriter(
        yield* this.contractOfValueAt(entry.value!, [...(entry.at ?? []), ...rest]),
        entry.w,
      ),
    );
  }

  /**
   * A prefix's entries as its levels read them (§4.6), once per prefix: each entry a level's member (`#levelMember`)
   * starts the levels, every other entry answers each path by itself.
   */
  #prefixLevels(prefix: Key, stores: PrefixStores): PrefixLevels {
    const known = this.#levelBases.get(prefix);
    if (known !== undefined) return known;
    const others: PrefixEntry[] = [];
    const base: LevelGroup[] = [];
    for (const entry of stores.list) {
      this.pass.program.work.charge("structureSteps");
      const member = this.#levelMember(entry);
      if (member === null) others.push(entry);
      else base.push(member);
    }
    const levels = { others, base };
    this.#levelBases.set(prefix, levels);
    return levels;
  }

  /**
   * A prefix entry as a level's member (§4.6): a literal stored whole, or a projection of one by property or index
   * steps, the selected prefix normalized to the literal and the steps into it, so the k projections
   * `({noise: hostValue otherwise null, data: root}).data` are the literals at `data`, whose level holds the read of
   * `root` once; `null` for any other entry, which answers each path itself, and for a literal holding a carrier whose
   * operand read is marked below it: such literals differ by where their reads are marked, so a level of k of them
   * would be k groups at every path, its work beside each entry's own answer (Codex r21 B1).
   */
  #levelMember(entry: PrefixEntry): LevelGroup | null {
    if (
      !sharing() ||
      entry.value === undefined ||
      entry.at !== undefined ||
      entry.key !== undefined ||
      entry.elem !== undefined
    )
      return null;
    const { program } = this.pass;
    const steps: string[] = [];
    let value = entry.value;
    while (!program.hasOf.has(value)) {
      const projection = program.projOf.get(value);
      // (a property or an index selects what its owner holds there; a selection, a length, a dict's lists and the
      // temporal members answer otherwise)
      if (projection === undefined || !plainStep(projection.step)) return null;
      program.work.charge("structureSteps");
      steps.push(stepName(projection.step));
      value = projection.owner;
    }
    if (this.#markedStructures.has(this.structureOf(value))) return null;
    return {
      literal: value,
      at: steps.reverse(),
      w: entry.w,
      holder: entry.holder,
      guarded: entry.guarded,
      ingress: entry.ingress,
    };
  }

  /**
   * S6-CARRIERS §4.6: a prefix's level members grouped at a path below it, built from the groups one step up: groups
   * that hold the same structure below the path (`#levelsOf`, at the member's steps into its literal) and the same
   * facts at every step above it merge, the earliest standing for the group and the annotations united; a group whose
   * marks may depend on steps past the path stays its own. Once per prefix and path, so k literals that differ only
   * beside the path are one group there, never k at every path below.
   */
  #groupsAt(
    prefix: Key,
    base: readonly LevelGroup[],
    path: readonly string[],
  ): readonly LevelGroup[] {
    const memoKey = `${prefix}|${path.join(".")}`;
    const known = this.#levelGroups.get(memoKey);
    if (known !== undefined) return known;
    const { program } = this.pass;
    this.#collectMarks();
    // each group's key, to its position in the list; the members themselves at the prefix (a projection's literal at
    // its steps into it)
    const merged = new Map<string, number>();
    const groups: LevelGroup[] = [];
    for (const group of path.length === 0
      ? base
      : this.#groupsAt(prefix, base, path.slice(0, -1))) {
      program.work.charge("structureSteps");
      const levels = this.#levelsOf(group.literal);
      const full = [...group.at, ...path];
      // (what stands at each step above the path: entries read below it, objects lacking the next step, a
      // reference, an empty collection; and whether the literal is a cell, every path then below an element)
      const above = Array.from(
        { length: full.length },
        (_, length) => levels.at.get(full.slice(0, length).join(".")) ?? "",
      ).join("|");
      const cell = program.cellOwner.get(group.literal)?.kind === "cell" ? "cell" : "";
      // (its marks: alike where they cannot depend on steps past the path, else its own, §3.2 r4.23)
      const marks =
        group.holder === null
          ? ""
          : this.#depthOf(group.holder) <= path.length
            ? String(this.#marksAt(group.holder, path))
            : group.holder.id;
      const key = `${levels.below.get(full.join(".")) ?? ""}|${above}|${cell}|${marks}`;
      const position = merged.get(key);
      if (position === undefined) {
        merged.set(key, groups.length);
        groups.push(group);
        continue;
      }
      const into = groups[position]!;
      groups[position] = {
        literal: into.literal,
        at: into.at,
        w: firstWriter(into.w, group.w),
        holder: into.holder,
        guarded: into.guarded || group.guarded,
        ingress: program.scope.ingress.union(into.ingress, group.ingress),
      };
    }
    this.#levelGroups.set(memoKey, groups);
    return groups;
  }

  /**
   * A literal's structure by path, once (§4.6): what stands at each path of its index itself (its own terms' kinds,
   * its reads' and other values' structures, its objects' property names, a reference, an empty collection), and below
   * each path everything under it, interned.
   */
  #levelsOf(literal: PlaceId): {
    readonly below: ReadonlyMap<string, string>;
    readonly at: ReadonlyMap<string, string>;
  } {
    const known = this.#literalLevels.get(literal);
    if (known !== undefined) return known;
    const { program } = this.pass;
    const index = this.literalIndex(literal);
    // (the literal's own path too: its whole structure is a member's key at the prefix)
    const paths = new Set<string>([
      "",
      ...index.terms.keys(),
      ...index.reads.keys(),
      ...index.others.keys(),
      ...index.objects.keys(),
      ...index.references,
      ...index.empty,
    ]);
    for (const path of [...paths])
      for (let cut = path.lastIndexOf("."); cut >= 0; cut = path.lastIndexOf(".", cut - 1))
        paths.add(path.slice(0, cut));
    const at = new Map<string, string>();
    for (const path of paths) {
      program.work.charge("structureSteps");
      const parts = [
        [...(index.terms.get(path)?.keys() ?? [])].sort().join(","),
        ...[...(index.reads.get(path) ?? []), ...(index.others.get(path) ?? [])].map((entry) =>
          this.structureOf(entry.value),
        ),
        ...(index.objects.get(path)?.list ?? []).map(
          (object) => `{${[...object.names].sort().join(",")}}`,
        ),
        index.references.has(path) ? "ref" : "",
        index.empty.has(path) ? "empty" : "",
      ];
      at.set(path, this.#internStructure(`at(${parts.join(";")})`));
    }
    // below a path: its own and, deepest first, every path one step under it
    const below = new Map<string, string>();
    const children = new Map<string, string[]>();
    for (const path of paths) {
      const cut = path.lastIndexOf(".");
      if (path === "") continue;
      const parent = cut < 0 ? "" : path.slice(0, cut);
      let list = children.get(parent);
      if (list === undefined) children.set(parent, (list = []));
      list.push(path);
    }
    const depth = (path: string): number => (path === "" ? 0 : path.split(".").length);
    for (const path of [...paths].sort((a, b) => depth(b) - depth(a))) {
      program.work.charge("structureSteps");
      const under = (children.get(path) ?? [])
        .map((child) => `${child}=${below.get(child)}`)
        .sort()
        .join(",");
      below.set(path, this.#internStructure(`below(${at.get(path)};${under})`));
    }
    const levels = { below, at };
    this.#literalLevels.set(literal, levels);
    return levels;
  }

  /**
   * A projected source's stores below its path start after the path: a demand, once per source and path, whatever
   * number of its copies read there (r4.46 (3)).
   */
  public *subAt(sub: Key, rest: readonly string[]): Work<readonly Item[]> {
    const site = this.pass.program.places[keyPlace(sub)]?.site ?? null;
    return yield {
      key: `s|${sub}|${rest.join(".")}`,
      kind: "contract",
      file: site?.file ?? -1,
      offset: site?.start ?? -1,
      make: () => this.#subAt(sub, rest),
    };
  }

  *#subAt(sub: Key, rest: readonly string[]): Work<readonly Item[]> {
    const { program } = this.pass;
    program.work.charge("invSteps");
    const base = keyPath(sub);
    return mergeItems(
      yield* this.#contractAlong(keyPlace(sub), [...base, ...rest], base.length + 1),
      program.scope,
    );
  }

  /** The kinds at a path of a value: a literal's field, a copied record's field. */
  public contractOfValueAt(value: PlaceId, rest: readonly string[]): Work<readonly Item[]> {
    return this.#through(value, rest, 0);
  }

  /**
   * A value's kinds along a path through a member a built-in value answers by itself, from the step `from` on, where
   * the path ends: at a literal or an operation (a projection passes its step to its owner, and a variable or a call its
   * key to `#keyThrough`). A dict's `values` is a new list of its values and its `keys` one of text (TABLE r4.46 (2)),
   * either may hold none (no count proof, no `null`); a temporal field or a calendar duration's part gives its declared
   * result (V30 §35); an object's own property of the name is read as any property (F11), and a receiver that may be a
   * reference has the runtime's members (F19a).
   */
  #through(value: PlaceId, rest: readonly string[], from: number): Work<readonly Item[]> {
    const { program } = this.pass;
    const at = memberStep(rest, from);
    if (
      at < 0 ||
      program.occurrenceOf.has(value) ||
      program.projOf.has(value) ||
      program.speakerPlaces.has(value) ||
      program.callOutOf.has(value)
    )
      return this.#valueAt(value, rest);
    return this.#listsAt(value, rest, at, from);
  }

  /** `#through` at the step `at`, the first of `rest` from `from` on that is a dict's `values` or `keys`. */
  *#listsAt(
    value: PlaceId,
    rest: readonly string[],
    at: number,
    from: number,
  ): Work<readonly Item[]> {
    const receiver = yield* this.#through(value, rest.slice(0, at), from);
    // F19a, r4.44: a receiver that may be a reference has the runtime's members, decided once for a whole value
    const decided = at === 0 ? yield* this.valueReceiver(value) : receiver;
    if (heldReference(decided) || decided.some((item) => REFERENCE.has(item.tag)))
      return yield* this.#through(value, rest, at + 1);
    return yield* this.#members(rest, at, receiver, (path, start) =>
      this.#through(value, path, start),
    );
  }

  /**
   * The kinds along `path` whose step `at` is a member a built-in value answers by itself, given the receiver's kinds
   * before it, by `read` (a path through such steps from a step on): a dict's lists, a temporal field's or a calendar
   * duration's part's declared result, and an object's own property of the name read as any property.
   */
  *#members(
    path: readonly string[],
    at: number,
    receiver: readonly Item[],
    read: (path: readonly string[], from: number) => Work<readonly Item[]>,
  ): Work<readonly Item[]> {
    const before = path.slice(0, at);
    const after = path.slice(at + 1);
    const out: Item[] = [];
    let own = false;
    const step = path[at]!;
    for (const item of withoutEmpty(receiver)) {
      const declared = declaredProperty(item.tag, step);
      if (item.tag === "dict" && dictList(step) !== undefined) {
        if (after.length === 0) out.push(carried(makeItem("list", item.writer), [item]));
        else if (after[0] === "element") {
          // the list's own selection takes its own emptiness (open); a deeper selection's marker is that selection's
          if (dictList(step) === "values") {
            const below = yield* read([...before, ...after], at);
            out.push(...(after.length === 1 ? withoutEmpty(below) : below));
          } else if (after.length === 1)
            // a key is text, possible: no literal holds a derived list's element (r4.47, P3)
            out.push(carried(makeItem("string", item.writer, { cert: "pos" }), [item]));
          if (after.length === 1) out.push(EMPTY);
        }
      } else if (declared !== undefined) {
        // a temporal field or a calendar duration's part: its declared result (V30 §35)
        if (after.length === 0) out.push(carried(makeItem(declared, item.writer), [item]));
      } else if (item.tag === "object") own = true;
      else if (item.tag === "unknown") out.push(item);
    }
    if (own) out.push(...(yield* read(path, at + 1)));
    return mergeItems(out, this.pass.program.scope);
  }

  /** The kinds at a path of a value, by the value's kind. */
  *#valueAt(value: PlaceId, rest: readonly string[]): Work<readonly Item[]> {
    if (rest.length === 0) return yield* this.contractOfValue(value);
    const { program, guards } = this.pass;
    program.work.charge("invSteps");
    if (program.speakerPlaces.has(value)) return [unknownItem(REASON.opaque)];
    const binding = program.occurrenceOf.get(value);
    if (binding !== undefined) {
      const items = this.entered(value, yield* this.contractOf(keyOf(binding, rest)));
      // §3.2: the mark travels with the value (r4.6)
      return guards.guardedRead(value, rest) ? marked(items) : items;
    }
    const projection = program.projOf.get(value);
    if (projection !== undefined) {
      if (projection.step === "iteration")
        return yield* this.#contractIteration(projection.owner, rest);
      if (measuresLength(projection.step))
        return yield* this.#contractLength(projection.owner, projection.step, rest);
      const elements = yield* this.contractOfValueAt(projection.owner, [
        stepName(projection.step),
        ...rest,
      ]);
      if (!selectsElement(projection.step)) return elements;
      const owners = withoutEmpty(yield* this.contractOfValue(projection.owner));
      return withOwnSelection(elements, owners, this.pass);
    }
    if (program.callOutOf.has(value))
      return yield* this.contractOf(keyOf(this.#resultOf(value), rest));
    if (program.hasOf.has(value) || program.cellOwner.has(value))
      return yield* this.contractOfLiteral(value, rest);
    const operation = program.opOf.get(value);
    if (operation !== undefined)
      return this.entered(value, yield* this.#contractOfOp(operation, rest));
    return [unknownItem(REASON.opaque)];
  }

  /** The kinds a value can have at any point, mirroring the value side's dispatch. */
  public *contractOfValue(value: PlaceId): Work<readonly Item[]> {
    const { program, guards } = this.pass;
    program.work.charge("invSteps");
    if (program.speakerPlaces.has(value)) return [unknownItem(REASON.opaque)];
    const binding = program.occurrenceOf.get(value);
    if (binding !== undefined) {
      const items = this.entered(value, yield* this.contractOf(keyOf(binding, [])));
      // §3.2: the mark travels with the value (r4.6)
      return guards.guardedRead(value) ? marked(items) : items;
    }
    const projection = program.projOf.get(value);
    if (projection !== undefined) {
      // a property read, a loop's visit, a length
      if (projection.step === "iteration")
        return yield* this.#contractIteration(projection.owner, []);
      if (measuresLength(projection.step))
        return yield* this.#contractLength(projection.owner, projection.step, []);
      const elements = yield* this.contractOfValueAt(projection.owner, [stepName(projection.step)]);
      if (!selectsElement(projection.step)) return elements;
      const owners = withoutEmpty(yield* this.contractOfValue(projection.owner));
      return withOwnSelection(elements, owners, this.pass);
    }
    if (program.callOutOf.has(value))
      return yield* this.contractOf(keyOf(this.#resultOf(value), []));
    const operation = program.opOf.get(value);
    // once per operation, whatever asks
    if (operation !== undefined) {
      const site = program.places[value]?.site ?? operation.site;
      const demand: Demand = {
        key: `cop|${value}`,
        kind: "contract",
        file: site.file,
        offset: site.start,
        make: () => this.#contractOfOp(operation, []),
      };
      return this.entered(value, yield demand);
    }
    if (program.hasOf.has(value) || program.cellOwner.has(value))
      return yield* this.contractOfLiteral(value, []);
    if (program.isHost(value)) return [unknownItem(REASON.external)];
    return yield* this.contractOf(keyOf(value, []));
  }

  /** The result place of a call's value (F20). */
  #resultOf(value: PlaceId): PlaceId {
    const call = this.pass.program.opOf.get(value);
    if (call?.kind !== "call") throw new Error(`The value ${value} is no call's result.`);
    return this.pass.program.functionOf(call.fn).result;
  }

  /** F27: a loop visits a list's or a set's elements, a dict's keys, a range's whole numbers. */
  *#contractIteration(owner: PlaceId, rest: readonly string[]): Work<readonly Item[]> {
    const out: Item[] = [];
    for (const item of withoutEmpty(yield* this.contractOfValue(owner))) {
      if (item.tag === "list" || item.tag === "set")
        out.push(
          ...belowSelected(yield* this.contractOfValueAt(owner, ["element", ...rest]), rest),
        );
      else if ((item.tag === "dict" || kindElement(item.tag) !== undefined) && rest.length === 0)
        out.push(
          carried(makeItem(item.tag === "dict" ? "string" : kindElement(item.tag)!, item.writer), [
            item,
          ]),
        );
      else if (item.tag === "unknown") out.push(item);
    }
    return mergeItems(out, this.pass.program.scope);
  }

  /** F14: a text's or a collection's length is a whole number; an object's own `length` is its property (F11). */
  *#contractLength(owner: PlaceId, step: string, rest: readonly string[]): Work<readonly Item[]> {
    // F19a before F14: a receiver that may be a reference has the runtime's members, its `length` among them
    if (heldReference(yield* this.valueReceiver(owner)))
      return yield* this.contractOfValueAt(owner, [step, ...rest]);
    const out: Item[] = [];
    for (const item of withoutEmpty(yield* this.contractOfValue(owner))) {
      if (
        item.tag === "string" ||
        item.tag === "list" ||
        item.tag === "set" ||
        item.tag === "dict"
      ) {
        if (rest.length === 0) out.push(carried(makeItem("integer", item.writer), [item]));
      } else if (item.tag === "object" || REFERENCE.has(item.tag))
        // an object's own `length` (F11), a reference's member (F19a)
        out.push(...(yield* this.contractOfValueAt(owner, [step, ...rest])));
      else if (item.tag === "unknown") out.push(item);
    }
    return mergeItems(out, this.pass.program.scope);
  }

  /** The kinds an operation's result can have, mirroring the value side's dispatch. */
  *#contractOfOp(c: ValueConstraint, rest: readonly string[]): Work<readonly Item[]> {
    const { program } = this.pass;
    const scope = program.scope;
    if (c.kind === "fallback") {
      const left = (yield* this.contractOfValueAt(c.left, rest)).filter(
        (item) => rest.length > 0 || item.tag !== "null",
      );
      return mergeItems([...left, ...(yield* this.contractOfValueAt(c.right, rest))], scope);
    }
    // F19a before F17b: a receiver that may be a reference has the runtime's `get`, no default merged beside it
    if (c.kind === "get" && heldReference(yield* this.valueReceiver(c.receiver)))
      return [unknownItem(REASON.opaque)];
    if (c.kind === "get")
      return mergeItems(
        [
          ...belowSelected(yield* this.contractOfValueAt(c.receiver, ["element", ...rest]), rest),
          ...(yield* this.contractOfValueAt(c.fallback, rest)),
        ],
        scope,
      );
    if (c.kind === "load") {
      // F19: a computed key
      if (c.key === null) {
        const nullDefault =
          rest.length === 0 && c.fallback !== null && (yield* this.onlyNull(c.fallback)).length > 0;
        return [unknownItem(REASON.external), ...(nullDefault ? [ingressNull()] : [])];
      }
      const expected = yield* this.expectedOf(c, rest);
      if (expected !== null) return expected;
      if (c.fallback !== null)
        return [...(yield* this.defaultKinds(c.fallback, rest)), ...emptyAt(rest)];
    }
    if (c.kind !== "operation") return [unknownItem(REASON.external)];
    const { family, name } = c.contract;
    // F19a: a reference's method is opaque, a decision of its component (r4.44)
    if (
      family === "method" &&
      c.receiver !== null &&
      heldReference(yield* this.valueReceiver(c.receiver))
    )
      return [unknownItem(REASON.opaque)];
    // F26b (r5): always text
    if (family === "interpolation") return rest.length === 0 ? [makeItem("string")] : [];
    // a message's handle (F19a)
    if (family === "say")
      return rest.length > 0 ? [unknownItem(REASON.opaque)] : [makeItem("messageHandle")];
    // `2 s`, `1 calendar day`, `20 deg`
    if (family === "unit" || family === "angle")
      return rest.length > 0 ? [] : [makeItem(unitKind(family, name))];
    // the builtins' declared results
    if (family === "builtin") {
      if (rest.length > 0) return [];
      const fallback = defaultOf(c);
      return mergeItems(
        [
          makeItem(builtinResult(name)),
          ...(fallback === undefined ? [] : yield* this.contractOfValue(fallback)),
        ],
        scope,
      );
    }
    const method = family === "method" && c.receiver !== null ? methodCategory(name) : undefined;
    // F7a–c, F25: a declared result, or what a removal gives
    if (method !== undefined && c.receiver !== null && method.gives.kind !== "copy") {
      const gives = method.gives;
      const out: Item[] = [];
      for (const item of withoutEmpty(yield* this.contractOfValue(c.receiver))) {
        if (gives.kind === "declared") {
          if (rest.length === 0)
            out.push(
              ...declaredResult(name, gives.kinds, item.tag).map((tag) =>
                carried(makeItem(tag), [item]),
              ),
            );
        } else if (item.tag === "unknown") {
          // a dict's removed value, or a list's or a set's `null` where it gives that
          out.push(item);
          if (gives.fromList === "null" && rest.length === 0)
            out.push(carried(makeItem("null"), [item]));
        } else if (gives.fromList === "null" && item.tag !== "dict") {
          if (rest.length === 0) out.push(carried(makeItem("null"), [item]));
        } else if (COLLECTIONS.has(item.tag))
          out.push(
            ...belowSelected(yield* this.contractOfValueAt(c.receiver, ["element", ...rest]), rest),
          );
      }
      return mergeItems(out, scope);
    }
    // F10: a copy of the elements, which may hold none where it takes a count: a receiver's own elements, or those its
    // kind declares (a range's whole numbers)
    if (method !== undefined && c.receiver !== null && method.gives.kind === "copy") {
      const copy = method.gives;
      const receiver = yield* this.contractOfValue(c.receiver);
      if (rest.length === 0) return [carried(makeItem(copy.into), receiver)];
      const kinds = withoutEmpty(receiver);
      const declared = kinds.some((item) => kindElement(item.tag) !== undefined);
      return [
        // a kind's declared elements may be none (a range's bounds decide): the copy's element step keeps that mark
        ...(declared && rest.length === 1 ? [EMPTY] : []),
        ...(rest.length === 1
          ? kinds.flatMap((item) => {
              const element = kindElement(item.tag);
              return element === undefined ? [] : [carried(makeItem(element, item.writer), [item])];
            })
          : []),
        ...(kinds.some((item) => kindElement(item.tag) === undefined)
          ? yield* this.contractOfValueAt(c.receiver, ["element", ...rest.slice(1)])
          : []),
        ...(copy.mayHoldNone && rest.length === 1 ? [EMPTY] : []),
      ];
    }
    if (family === "operator" && name === "+" && rest.length > 0) {
      const operands: (readonly Item[])[] = [];
      for (const argument of c.arguments)
        operands.push(yield* this.contractOfValueAt(argument, rest));
      return plusElements(operands, rest, this.pass);
    }
    const conversion = family === "conversion" ? conversionCategory(name) : undefined;
    if (conversion?.kind === "converts") {
      if (rest.length > 0) return [];
      const fallback = defaultOf(c);
      return mergeItems(
        [
          makeItem(conversionKind(conversion.result)),
          ...(fallback !== undefined
            ? yield* this.contractOfValue(fallback)
            : conversion.optional
              ? [makeItem("null")]
              : []),
        ],
        scope,
      );
    }
    if (conversion?.kind === "parses") {
      const fallback = defaultOf(c);
      return (
        (yield* this.expectedOf(c, rest)) ?? [
          ...(fallback === undefined
            ? [unknownItem(REASON.external)]
            : yield* this.defaultKinds(fallback, rest)),
          ...emptyAt(rest),
        ]
      );
    }
    const interaction = family === "interaction" ? interactionCategory(name) : undefined;
    if (interaction?.kind === "asks")
      return rest.length === 0 ? [makeItem(interaction.result)] : [];
    // r4.47 (5): a clock read gives its declared kind, as an ask does
    const clock = family === "clock" ? clockResult(name) : undefined;
    if (clock !== undefined) return rest.length === 0 ? [makeItem(clock)] : [];
    // V30 §19: askChoice's answer, per option its label, or each of its buttons' values
    if (interaction?.kind === "options")
      return mergeItems(
        yield* choiceItems(
          c,
          rest,
          (value, path) => this.contractOfValueAt(value, path),
          this.choiceKeysStored(),
        ),
        scope,
      );
    if (rest.length > 0) return [unknownItem(REASON.opaque)];
    // F16: the runtime's operator table
    const operator = operatorOf(c);
    if (operator !== null) {
      const operands: (readonly Item[])[] = [];
      for (const argument of c.arguments)
        operands.push(withoutEmpty(yield* this.contractOfValue(argument)));
      return operationItems(operator, operands, scope, c.site);
    }
    if (family === "logic" || family === "comparison" || family === "typeTest")
      return [makeItem("boolean")];
    const member = family === "member" ? memberResult(name) : undefined;
    if (member !== undefined) return member.map((kind) => makeItem(kind));
    // F19a: a handle's member is opaque
    if (family === "timer" || family === "media") return [makeItem(family)];
    // F25: a button's, a popup's or a camera's fixed result
    const shown = shownResult(name);
    if (shown !== undefined) return [makeItem(shown)];
    if (family === "range") return [makeItem("range")];
    // a method without a category, per receiver alternative: its declared result per receiver kind (F25), else the
    // runtime's opaque answer on a known kind (r4.47 (1)); what the core cannot know keeps its own reasons. A receiver
    // without items yet is a provisional bottom: the result stays the bottom (S3 §1, r4.44)
    if (family === "method" && c.receiver !== null) {
      const receiver = withoutEmpty(yield* this.contractOfValue(c.receiver));
      return mergeItems(
        receiver.map((item) => {
          if (item.tag === "unknown") return item;
          const declared = declaredMethod(item.tag, name);
          return declared === undefined
            ? unknownItem(REASON.opaque)
            : carried(makeItem(declared, item.writer), [item]);
        }),
        scope,
      );
    }
    return [unknownItem(REASON.external)];
  }

  /**
   * F18: a load's or `fromJson`'s expected type, possible: the declared type, or the written type of the place its
   * value lands in directly (V30 §12); `null` without one.
   */
  public *expectedOf(c: ValueConstraint, rest: readonly string[]): Work<readonly Item[] | null> {
    const written = (c.kind === "load" ? c.receiver : null) ?? this.landsIn(c.result, []);
    if (written === null) return null;
    const term = termAt(written, rest);
    const fallback = c.kind === "load" ? (c.fallback ?? undefined) : defaultOf(c);
    const nullDefault =
      rest.length === 0 && fallback !== undefined && (yield* this.onlyNull(fallback)).length > 0;
    return [
      ...(term === null ? ["unknown" as const] : typeTags(term)).map((tag) =>
        tag === "unknown" ? unknownItem(REASON.external) : makeItem(tag, null, { cert: "pos" }),
      ),
      ...(nullDefault ? [makeItem("null", null, { cert: "pos" })] : []),
      ...emptyAt(rest),
    ];
  }

  /** The kinds a `load` or `fromJson` takes from its default at `rest` (`typedDefault`), on the default's contract. */
  public *defaultKinds(fallback: PlaceId, rest: readonly string[]): Work<readonly Item[]> {
    const site = this.pass.program.places[fallback]?.site ?? null;
    return yield {
      key: `dk|${fallback}|${rest.join(".")}`,
      kind: "contract",
      file: site?.file ?? -1,
      offset: site?.start ?? -1,
      make: () => this.contractOfValueAt(fallback, rest),
      decision: typedDefault(rest, false),
    };
  }

  /** F19 (r4.1): whether a default holds only `null` (or nothing), by its contract (`ONLY_NULL`). */
  public *onlyNull(fallback: PlaceId): Work<readonly Item[]> {
    const site = this.pass.program.places[fallback]?.site ?? null;
    return yield {
      key: `dn|${fallback}`,
      kind: "contract",
      file: site?.file ?? -1,
      offset: site?.start ?? -1,
      make: () => this.contractOfValue(fallback),
      decision: ONLY_NULL,
    };
  }

  /**
   * V30 §18: the written type a value lands in directly at a path, also as an element of literals or through a
   * fallback or default (A1, C10, F18); a lookup cut by the nesting limit is an unknown destination, never memoised.
   */
  public landsIn(value: PlaceId, path: readonly string[], depth = 0): TypeTerm | null {
    if (depth >= NESTING) return CUT;
    const { program, definitions } = this.pass;
    const memoKey = `${value}|${path.join(".")}`;
    if (this.#lands.has(memoKey)) return this.#lands.get(memoKey)!;
    this.#lands.set(memoKey, null);
    const keep = (found: TypeTerm | null): TypeTerm | null => {
      if (found === CUT) this.#lands.delete(memoKey);
      else this.#lands.set(memoKey, found);
      return found;
    };
    for (const d of definitions.byValue.get(value) ?? []) {
      program.work.charge("checks");
      const written = d.kind === "whole" ? writtenOf(program.place(d.place).kind) : null;
      const term = written === null ? null : termAt(written, [...d.path, ...path]);
      if (term !== null) return keep(term);
      const owner = program.cellOwner.get(d.place);
      if (owner?.kind === "cell") {
        const found = this.landsIn(owner.owner, ["element", ...path], depth + 1);
        if (found !== null) return keep(found);
      }
    }
    const operation = definitions.fallbackOf.get(value);
    return keep(operation === undefined ? null : this.landsIn(operation, path, depth + 1));
  }

  // ----------------------------------------------------------------------------- the one identity function (§8 r4.15)

  /** The key a value copies, through its projections: `seed.f0` reads `seed|f0`; `null` for no read. */
  public copiedKey(value: PlaceId): Key | null {
    const { program } = this.pass;
    const steps: string[] = [];
    let current = value;
    while (!program.occurrenceOf.has(current)) {
      const projection = program.projOf.get(current);
      if (projection === undefined || projection.step === "iteration") return null;
      program.work.charge("invSteps");
      steps.push(stepName(projection.step));
      current = projection.owner;
    }
    return keyOf(program.occurrenceOf.get(current)!, steps.reverse());
  }

  /**
   * A read's snapshot (TABLE §8, r4.68 (1)): the key it copies, its guard bit, that key's exact-path signature at the
   * read's own node (`readSignature`, where the value side reads it: X1–X6, X7's block reach, P3) and the handlers' fact
   * the signature leaves to its caller (X7: whether a handler that may store the key has been created there, H9), so
   * reads of one key in one literal are one key read only where they read the same: a guard, a call storing to the key,
   * or one registering a handler between them keeps them apart (Codex r25 F1). Once per read; `null` for no read.
   */
  public readSnapshot(value: PlaceId): string | null {
    const known = this.#snapshots.get(value);
    if (known !== undefined) return known;
    const copied = this.copiedKey(value);
    if (copied === null) return null;
    const { program, lists, guards, handlers } = this.pass;
    let root = value;
    for (let projection = program.projOf.get(root); projection !== undefined;) {
      root = projection.owner;
      projection = program.projOf.get(root);
    }
    const node = program.occNode.get(root) ?? null;
    const snapshot = `${guards.guardedRead(value) ? "g" : ""}${copied}|${node === null ? "-" : `${lists.readSignature(copied, node)}|${handlers.afterSomeCreation(node) ? "h" : ""}`}`;
    this.#snapshots.set(value, snapshot);
    return snapshot;
  }

  /** A call's result read further (`snapshot()`, `snapshot().data`): the callee's result key (F20), else `null`. */
  public resultKey(value: PlaceId): Key | null {
    const { program } = this.pass;
    const steps: string[] = [];
    let current = value;
    for (let projection = program.projOf.get(current); projection !== undefined;) {
      if (projection.step === "iteration") return null;
      program.work.charge("invSteps");
      steps.push(stepName(projection.step));
      current = projection.owner;
      projection = program.projOf.get(current);
    }
    return program.callOutOf.has(current) ? keyOf(this.#resultOf(current), steps.reverse()) : null;
  }

  /** A place that only copies hold: no host, speaker or literal place. */
  #copyOnly(place: PlaceId): boolean {
    const { program } = this.pass;
    return (
      program.places[place] !== undefined &&
      !program.isHost(place) &&
      !program.speakerPlaces.has(place) &&
      !program.cellOwner.has(place) &&
      !program.hasOf.has(place)
    );
  }

  /**
   * Per key, whether a store goes below a property named `value`, and one named `text` (a choice object changed after it
   * is made): then a held choice object's button value is read by that key, not per record (V30 §19).
   */
  public choiceKeysStored(): StoredChoiceKeys {
    if (this.#choiceKeysStored === null) {
      let value = false;
      let text = false;
      for (const [key] of this.pass.definitions.byKey) {
        this.pass.program.work.charge("invSteps");
        const path = keyPath(key);
        value ||= path.includes("value");
        text ||= path.includes("text");
        if (value && text) break;
      }
      this.#choiceKeysStored = { value, text };
    }
    return this.#choiceKeysStored;
  }

  /** The keys of a place that have definitions. */
  #keysOfPlace(place: PlaceId): readonly Key[] {
    if (this.#placeKeys === null) {
      this.#placeKeys = new Map();
      for (const [key] of this.pass.definitions.byKey) {
        this.pass.program.work.charge("invSteps");
        const list = this.#placeKeys.get(keyPlace(key));
        if (list === undefined) this.#placeKeys.set(keyPlace(key), [key]);
        else list.push(key);
      }
    }
    return this.#placeKeys.get(place) ?? [];
  }

  /** Per place, the first steps of its live stores below the root (a preset's changed field). */
  #subFirstOf(place: PlaceId): ReadonlySet<string> {
    if (this.#subFirst === null) {
      this.#subFirst = new Map();
      for (const [key, list] of this.pass.definitions.byKey) {
        const path = keyPath(key);
        this.pass.program.work.charge("invSteps");
        if (path.length > 0 && list.some((d) => this.pass.lists.live(d))) {
          let steps = this.#subFirst.get(keyPlace(key));
          if (steps === undefined) this.#subFirst.set(keyPlace(key), (steps = new Set()));
          steps.add(path[0]!);
        }
      }
    }
    return this.#subFirst.get(place) ?? NO_STEPS;
  }

  /**
   * The key a place is an alias of: one whole store of a copy or of a call's result, no store below it, no written
   * type, its aliases followed, with the guard bit along the chain (§3.2). A cycle of aliases stops at itself. A loop up
   * the chain to a place answered or no alias, then each link answered from the top.
   */
  #rootOfPlace(place: PlaceId): { readonly key: Key; readonly guarded: boolean } {
    const known = this.#aliases.get(place);
    if (known !== undefined) return known;
    const { definitions, lists, program, guards } = this.pass;
    const chain: { readonly place: PlaceId; readonly up: Key; readonly guarded: boolean }[] = [];
    let at = place;
    let top: { readonly key: Key; readonly guarded: boolean };
    for (;;) {
      const unaliased = { key: keyOf(at, []), guarded: false };
      this.#aliases.set(at, unaliased);
      program.work.charge("invSteps");
      const stores = (definitions.byKey.get(keyOf(at, [])) ?? []).filter((d) => lists.live(d));
      const one =
        stores.length === 1 &&
        stores[0]!.kind === "whole" &&
        this.#keysOfPlace(at).length === 1 &&
        this.#copyOnly(at) &&
        writtenOf(program.place(at).kind) === null;
      const copied = one ? this.copiedKey(stores[0]!.value!) : null;
      const up = copied ?? (one ? this.resultKey(stores[0]!.value!) : null);
      if (up === null) {
        top = unaliased;
        break;
      }
      chain.push({
        place: at,
        up,
        guarded: copied !== null && guards.guardedRead(stores[0]!.value!),
      });
      const answered = this.#aliases.get(keyPlace(up));
      if (answered !== undefined) {
        top = answered;
        break;
      }
      at = keyPlace(up);
    }
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const link = chain[index]!;
      top = {
        key: keyOf(keyPlace(top.key), [...keyPath(top.key), ...keyPath(link.up)]),
        guarded: top.guarded || link.guarded,
      };
      this.#aliases.set(link.place, top);
    }
    return this.#aliases.get(place)!;
  }

  /**
   * A key's source identity: the key itself through its aliases, and a place of whole copies of one source followed
   * to that source; with its holder (§8 r4.15, r4.23). A loop along those places, then each answered from the last.
   */
  public keyIdentity(key: Key): Identity {
    if (!this.#keys.has(key)) this.#settle(this.#keyIdentityWork(key));
    return this.#keys.get(key)!;
  }

  *#keyIdentityWork(key: Key): IdentityWork {
    if (this.#keys.has(key)) return;
    const { program } = this.pass;
    const chain: { readonly key: Key; readonly rooted: Key; readonly guarded: boolean }[] = [];
    let at = key;
    let last: Identity;
    for (;;) {
      // a copy cycle stops here
      this.#keys.set(at, { id: `k${at}`, key: at, guarded: false, holder: this.#holderOfKey(at) });
      program.work.charge("invSteps");
      const top = this.#rootOfPlace(keyPlace(at));
      const rooted = keyOf(keyPlace(top.key), [...keyPath(top.key), ...keyPath(at)]);
      let identity: Identity = {
        id: `k${rooted}`,
        key: rooted,
        guarded: top.guarded,
        holder: this.#holderOfKey(rooted),
      };
      const place = keyPlace(rooted);
      let inner: Key | null = null;
      if (
        top.key === keyOf(place, []) &&
        this.#copyOnly(place) &&
        writtenOf(program.place(place).kind) === null
      ) {
        const stores = yield* this.#needPrefix(keyOf(place, []));
        const entry =
          stores.list.length === 1 &&
          !stores.other &&
          stores.subs === null &&
          stores.also.length === 0
            ? stores.list[0]!
            : null;
        const path = keyPath(rooted);
        if (entry !== null && entry.key !== undefined) {
          inner = keyOf(keyPlace(entry.key), [...keyPath(entry.key), ...path]);
          chain.push({ key: at, rooted, guarded: identity.guarded || entry.guarded });
        } else if (entry !== null && entry.value !== undefined) {
          const within = [...(entry.at ?? []), ...path];
          const source = yield* this.#needValue(entry.value);
          identity = {
            id: `${source.id}@${within.join(".")}`,
            key: rooted,
            guarded: identity.guarded || entry.guarded,
            holder: this.#holderAt(source.holder, within),
          };
        }
      }
      if (inner === null) {
        this.#keys.set(at, identity);
        last = identity;
        break;
      }
      const answered = this.#keys.get(inner);
      if (answered !== undefined) {
        last = answered;
        break;
      }
      at = inner;
    }
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const link = chain[index]!;
      last = {
        id: last.id,
        key: link.rooted,
        guarded: link.guarded || last.guarded,
        holder: last.holder,
      };
      this.#keys.set(link.key, last);
    }
  }

  /**
   * A value's source identity: the key a read copies, its callee's result key for a call, a literal's structure, or the
   * value itself; the read's guard an annotation, each with its mark holder (§8 r4.23).
   */
  public identityOf(value: PlaceId): Identity {
    if (!this.#identities.has(value)) this.#settle(this.#identityWork(value));
    return this.#identities.get(value)!;
  }

  *#identityWork(value: PlaceId): IdentityWork {
    if (this.#identities.has(value)) return;
    this.pass.program.work.charge("invSteps");
    let identity: Identity;
    const copied = this.copiedKey(value);
    if (copied !== null) {
      const source = yield* this.#needKey(copied);
      identity = {
        // S6-CARRIERS §3.1: an ingress occurrence is fresh, so no identity merge shares it (its leaf stays its own)
        id: this.pass.definitions.ingress.has(value) ? `v${value}` : source.id,
        key: source.key,
        guarded: source.guarded || this.pass.guards.guardedRead(value),
        holder: source.holder,
      };
    } else {
      const result = this.resultKey(value);
      if (result !== null) {
        const source = yield* this.#needKey(result);
        identity = { id: source.id, key: result, guarded: false, holder: source.holder };
      } else if (this.pass.program.hasOf.has(value)) {
        const id = yield* this.#needSignature(value);
        identity = {
          id,
          key: null,
          guarded: false,
          holder: this.#holders.get(id) ?? this.#newHolder(id),
        };
      } else {
        // a computed value (an operation's result): its own holder, so a guarded read of a copy of it is a mark there;
        // a value a carrier gives (`otherwise`, `get`, a copy of the elements, a removal, a list's `+`, a projection of
        // a computed value) by what it takes, so k such values of one source are one entry, as k copies are (F2)
        // (interned: an identity names its inputs by their own short identities, never by their expansions)
        const carried = this.#carried(value, false);
        let id = `v${value}`;
        if (carried !== null) {
          const parts: string[] = [];
          for (const input of carried.of)
            parts.push(input === null ? "" : (yield* this.#needValue(input)).id);
          // (a value carrying a fresh one is fresh itself: §3.1, never shared across its occurrences)
          if (!parts.some((part) => part.startsWith("v"))) {
            const shape = `${carried.name}(${parts.join(",")})`;
            id = this.#carrierIds.get(shape) ?? `c${this.#carrierIds.size}`;
            this.#carrierIds.set(shape, id);
          }
        }
        identity = {
          id,
          key: null,
          guarded: false,
          holder: this.#holders.get(id) ?? this.#newHolder(id),
        };
      }
    }
    this.#identities.set(value, identity);
  }

  /**
   * What a carrier's value takes, by the carrier (`#identityWork`), or only what its result reads (`structural`: a
   * `get`'s receiver and default, never its key, §4.6); `null` for any other computed value.
   */
  #carried(
    value: PlaceId,
    structural: boolean,
  ): { readonly name: string; readonly of: readonly (PlaceId | null)[] } | null {
    const { program } = this.pass;
    const projection = program.projOf.get(value);
    if (projection !== undefined && projection.step !== "iteration")
      return { name: `.${projection.step}`, of: [projection.owner] };
    const c = program.opOf.get(value);
    if (c?.kind === "fallback") return { name: "otherwise", of: [c.left, c.right] };
    if (c?.kind === "get")
      return {
        name: "get",
        of: structural ? [c.receiver, c.fallback] : [c.receiver, c.key, c.fallback],
      };
    if (c?.kind !== "operation") return null;
    const { family, name } = c.contract;
    const gives =
      family === "method" && c.receiver !== null ? methodCategory(name)?.gives : undefined;
    if (
      gives?.kind === "copy" ||
      gives?.kind === "removed" ||
      (family === "operator" && name === "+")
    )
      return { name: `${family}.${name}`, of: [c.receiver, ...c.arguments] };
    return null;
  }

  /**
   * S6-CARRIERS §4.6: a value's structure identity, what its contract reads: a read's key and its guard, a call's
   * result key, a carrier by the structures of the operands its result reads (a `get`'s key apart) and their guards, a
   * literal by its cells' structures; fresh (`v`) where an ingress occurrence stands at a position its result reads,
   * so a structure shared by reference never merges an occurrence the result carries. A key's prefix entries are keyed
   * by it.
   */
  public structureOf(value: PlaceId): string {
    if (!this.#structures.has(value)) this.#settle(this.#structureWork(value));
    return this.#structures.get(value)!;
  }

  *#structureWork(value: PlaceId): IdentityWork {
    if (this.#structures.has(value)) return;
    const { program, definitions } = this.pass;
    program.work.charge("structureSteps");
    let id = `v${value}`;
    if (this.copiedKey(value) !== null || this.resultKey(value) !== null) {
      // (a read under a test of its path is marked, §3.2)
      if (!definitions.ingress.has(value)) {
        const identity = yield* this.#needValue(value);
        id = identity.guarded ? `${identity.id}g` : identity.id;
      }
    } else if (program.hasOf.has(value)) {
      const index = yield* this.#needIndex(value);
      let plain = index.references.size === 0;
      let marked = false;
      const parts: string[] = [];
      const paths = new Set([
        ...index.terms.keys(),
        ...index.reads.keys(),
        ...index.others.keys(),
        ...index.objects.keys(),
      ]);
      for (const path of [...paths].sort()) {
        program.work.charge("structureSteps");
        parts.push(`${path}:${[...(index.terms.get(path)?.keys() ?? [])].sort().join(",")}`);
        for (const entry of [...(index.reads.get(path) ?? []), ...(index.others.get(path) ?? [])]) {
          const part = yield* this.#needStructure(entry.value);
          if (part.startsWith("v")) plain = false;
          marked ||= this.#markedStructures.has(part);
          parts.push(`s${part}`);
        }
        for (const object of index.objects.get(path)?.list ?? [])
          parts.push(`{${[...object.names].sort().join(",")}}`);
      }
      parts.push(`empty:${[...index.empty].sort().join(",")}`);
      if (plain) {
        id = this.#internStructure(`l(${parts.join(";")})`);
        if (marked) this.#markedStructures.add(id);
      }
    } else {
      const carried = this.#carried(value, true);
      if (carried !== null) {
        const parts: string[] = [];
        let marked = false;
        for (const input of carried.of) {
          if (input === null) {
            parts.push("");
            continue;
          }
          const part = yield* this.#needStructure(input);
          const below = this.#guardsBelow(input);
          marked ||= below !== "" || this.#markedStructures.has(part);
          parts.push(`${part}${below}`);
        }
        if (!parts.some((part) => part.startsWith("v"))) {
          id = this.#internStructure(`${carried.name}(${parts.join(",")})`);
          if (marked) this.#markedStructures.add(id);
        }
      }
    }
    this.#structures.set(value, id);
  }

  /**
   * The tested paths below a carrier's operand read that the read is guarded at (§3.2), as part of the carrier's
   * structure: no holder records a carrier operand's marks, as a literal's holder records its reads' (r4.15), so two
   * carriers share a structure only where their operand reads are marked alike below them (Codex r20 B1). Each the
   * outermost of nested ones, the guard index's regions holding the read, never each tested path in turn (Codex r21 B1).
   */
  #guardsBelow(operand: PlaceId): string {
    const { guards, definitions } = this.pass;
    if (
      this.copiedKey(operand) === null ||
      definitions.ingress.has(operand) ||
      this.identityOf(operand).guarded
    )
      return "";
    const marked = guards.guardedBelowRead(operand);
    return marked.length === 0 ? "" : `g[${marked.join(";")}]`;
  }

  #internStructure(shape: string): string {
    const id = this.#structureIds.get(shape) ?? `t${this.#structureIds.size}`;
    this.#structureIds.set(shape, id);
    return id;
  }

  *#needStructure(value: PlaceId): Generator<() => IdentityWork, string, void> {
    if (!this.#structures.has(value)) yield () => this.#structureWork(value);
    return this.#structures.get(value)!;
  }

  /** Runs a computation of the identity layer and those it needs on an explicit stack. */
  #settle(work: IdentityWork): void {
    const stack: IdentityWork[] = [work];
    while (stack.length > 0) {
      const step = stack.at(-1)!.next();
      if (step.done === true) stack.pop();
      else stack.push(step.value());
    }
  }

  /** A key's identity inside the identity layer: computed first where it is not known (a cycle's is its stop). */
  *#needKey(key: Key): Generator<() => IdentityWork, Identity, void> {
    if (!this.#keys.has(key)) yield () => this.#keyIdentityWork(key);
    return this.#keys.get(key)!;
  }

  *#needValue(value: PlaceId): Generator<() => IdentityWork, Identity, void> {
    if (!this.#identities.has(value)) yield () => this.#identityWork(value);
    return this.#identities.get(value)!;
  }

  *#needPrefix(prefix: Key): Generator<() => IdentityWork, PrefixStores, void> {
    if (!this.#prefix.has(prefix)) yield () => this.#prefixWork(prefix);
    return this.#prefix.get(prefix)!;
  }

  *#needIndex(literal: PlaceId): Generator<() => IdentityWork, LiteralIndex, void> {
    if (!this.#literals.has(literal)) yield () => this.#indexWork(literal);
    return this.#literals.get(literal)!;
  }

  *#needSignature(literal: PlaceId): Generator<() => IdentityWork, string, void> {
    if (!this.#signatures.has(literal)) yield () => this.#signatureWork(literal);
    return this.#signatures.get(literal)!;
  }

  /** The identities an entry draft's id and holder read, computed first. */
  *#ready(e: EntryDraft): IdentityWork {
    if (e.key !== undefined) yield* this.#needKey(e.key);
    else if (e.elem !== undefined) {
      yield* this.#needValue(e.elem);
      yield* this.#needStructure(e.elem);
    } else if (e.value !== undefined) {
      yield* this.#needValue(e.value);
      yield* this.#needStructure(e.value);
    }
  }

  // ------------------------------------------------------------------------------------------- the prefix index

  /**
   * The whole stores of a prefix, which every key below it shares (`state = preset` stored k times and read at k fields
   * is k stores, not k × k): one entry per source identity; a copied place that holds nothing but whole stores and has
   * at most one entry (an alias) is replaced by that entry; an add is an entry of its element, a clear or a removal one
   * of emptiness; an argument of an unwritten parameter with several sites is a deferred unknown. An explicit stack,
   * memoised per pass; a key still open (a copy cycle) stays an entry, which the solver's fixpoint then closes.
   */
  public prefixStores(prefix: Key): PrefixStores {
    if (!this.#prefix.has(prefix)) this.#settle(this.#prefixWork(prefix));
    return this.#prefix.get(prefix)!;
  }

  *#prefixWork(prefix: Key): IdentityWork {
    if (this.#prefix.has(prefix)) return;
    const { program, definitions, lists, guards } = this.pass;
    const work = program.work;
    const frame = (pk: Key): PrefixFrame => ({
      pk,
      defs: definitions.byKey.get(pk) ?? [],
      i: 0,
      out: [],
      seen: new Map(),
      w: null,
      d: null,
      inherit: null,
      inheritedBy: new Set(),
      also: new Map(),
      ck: null,
      proj: null,
      inner: undefined,
      other: false,
      cut: false,
    });
    const entryId = (e: EntryDraft): string =>
      e.key !== undefined
        ? this.keyIdentity(e.key).id
        : e.unk !== undefined
          ? `u${e.unk}`
          : e.empty === true
            ? "e"
            : e.elem !== undefined
              ? `a${this.structureOf(e.elem)}@${(e.at ?? []).join(".")}`
              : `${this.structureOf(e.value!)}@${(e.at ?? []).join(".")}`;
    const add = (f: PrefixFrame, e: EntryDraft): void => {
      work.charge("invSteps");
      const id = entryId(e);
      const w = e.w !== undefined ? e.w : f.w;
      const value = e.elem ?? e.value;
      const leaf =
        (value !== undefined && e.at === undefined) || e.elem !== undefined
          ? this.#ingressLeaf(value!)
          : undefined;
      const ingress = leaf === undefined ? e.ingress : program.scope.ingress.union(e.ingress, leaf);
      const index = f.seen.get(id);
      if (index === undefined) {
        f.seen.set(id, f.out.length);
        this.facts.prefixEntries += 1;
        // its marks: its identity's holder; a stored value at a path is that value's holder lifted there
        const holder =
          e.key !== undefined
            ? this.keyIdentity(e.key).holder
            : e.elem !== undefined
              ? this.identityOf(e.elem).holder
              : e.value !== undefined
                ? this.#holderAt(this.identityOf(e.value).holder, e.at ?? [])
                : null;
        f.out.push({
          ...(e.key !== undefined ? { key: e.key } : {}),
          ...(e.unk !== undefined ? { unk: e.unk } : {}),
          ...(e.empty === true ? { empty: true as const } : {}),
          ...(e.elem !== undefined ? { elem: e.elem } : {}),
          ...(e.value !== undefined ? { value: e.value } : {}),
          ...(e.at !== undefined ? { at: e.at } : {}),
          w,
          ds: new Set([f.d]),
          holder,
          guarded: e.guarded === true,
          ingress,
        });
      } else {
        const entry = f.out[index]!;
        entry.ds.add(f.d);
        entry.w = firstWriter(entry.w, w);
        if (e.guarded === true) entry.guarded = true;
        if (ingress !== undefined)
          entry.ingress = program.scope.ingress.union(entry.ingress, ingress);
      }
    };
    // an entry with the identities it reads computed first
    const adding = function* (contract: Contract, f: PrefixFrame, e: EntryDraft): IdentityWork {
      yield* contract.#ready(e);
      add(f, e);
    };
    // an inherited layer is shared, never copied; a further one, a join of two copies, is referenced beside it with the
    // stores that brought it, never flattened per destination (r4.46 (3))
    const addSubs = (f: PrefixFrame, layer: SubLayer | null): void => {
      if (layer === null) return;
      work.charge("invSteps");
      if (f.inherit === null || f.inherit === layer) {
        f.inherit = layer;
        f.inheritedBy.add(f.d);
        return;
      }
      let defs = f.also.get(layer);
      if (defs === undefined) {
        f.also.set(layer, (defs = new Set()));
        this.facts.prefixEntries += 1;
      }
      defs.add(f.d);
    };
    const open = new Set<Key>([prefix]);
    const stack: PrefixFrame[] = [frame(prefix)];
    while (stack.length > 0) {
      const f = stack.at(-1)!;
      if (f.inner !== undefined && f.proj !== null) {
        // a projected copy (`state.stats = preset7.stats`): an alias root is replaced by its target at the path, its
        // own stores below the path kept apart, so k such copies are one entry, not k entries asked at every property
        const inner = f.inner;
        const projection = f.proj;
        f.inner = undefined;
        f.proj = null;
        const copiedPlace = keyPlace(f.ck!);
        // the root's own stores below it only (rescanned below at the path), no source inherited through the alias
        const ownSubsOnly =
          inner.also.length === 0 &&
          (inner.subs === null || inner.subs.only === keyOf(copiedPlace, []));
        const e = inner.list.length === 1 && !inner.other && ownSubsOnly ? inner.list[0]! : null;
        if (e === null || (e.key === undefined && e.value === undefined))
          yield* adding(this, f, { key: f.ck! });
        else {
          yield* adding(this, f, {
            ...(e.key !== undefined
              ? { key: keyOf(keyPlace(e.key), [...keyPath(e.key), ...projection]) }
              : { value: e.value!, at: [...(e.at ?? []), ...projection] }),
            ...(e.guarded ? { guarded: true } : {}),
            ingress: e.ingress,
          });
          // a source's own stores below the path, listed once per source and path and shared by every prefix that
          // copies it there (§8 r4.15, r4.38)
          addSubs(f, this.#projectedLayer(copiedPlace, projection));
        }
        continue;
      }
      // an alias (at most one entry) is replaced, with its own stores below the root kept apart by their first step
      // (a preset changed in one field); a longer list stays one entry, so copies of it do not copy it
      if (f.inner !== undefined) {
        const inner = f.inner;
        f.inner = undefined;
        if (inner.list.length > 1 || inner.other) yield* adding(this, f, { key: f.ck! });
        else {
          // the copied entries keep their identity, so their marks are their holders: nothing to carry
          for (const e of inner.list) {
            work.charge("invSteps");
            yield* adding(this, f, { ...e, w: f.w, guarded: e.guarded, ingress: e.ingress });
          }
          // the source's own stores below its root over the sources it inherits, one layer per source shared by its
          // copies (r4.38: k copies of a source edited at k fields are k inheritances, not k × k listings)
          addSubs(f, this.#aliasLayer(inner, keyPlace(f.ck!)));
          for (const joined of inner.also) addSubs(f, joined.layer);
        }
      }
      if (f.i < f.defs.length) {
        const d = f.defs[f.i++]!;
        work.charge("invSteps");
        if (!lists.live(d)) continue;
        f.w = definitions.writerOf(d);
        f.d = d;
        if (d.kind === "const") {
          f.other = true;
          yield* adding(this, f, { unk: REASON.opaque });
          continue;
        }
        if (d.kind === "add") {
          f.other = true;
          // an add's marks stand below the inserted value
          const source = yield* this.#needValue(d.value!);
          yield* adding(this, f, {
            elem: d.value!,
            at: d.how === "elements" ? ["element"] : [],
            guarded: source.guarded,
          });
          continue;
        }
        if (d.kind !== "whole") {
          f.other = true;
          yield* adding(this, f, { empty: true });
          continue;
        }
        if (d.how === "argument" || d.how === "parameter default") {
          const parameter = program.place(d.place).kind;
          const deferred =
            parameter.kind === "parameter" && parameter.written === null && !lists.singleSite(d.fn);
          // F21: a single non-recursive call's binding is exact, its argument's and its default's alike; an exact
          // argument that copies a record is a copy of it, as a `let` is, shared by every field below it (W34)
          if (d.how === "parameter default" || deferred || this.copiedKey(d.value!) === null) {
            f.other = true;
            if (deferred) yield* adding(this, f, { unk: REASON.deferred });
            const source = yield* this.#needValue(d.value!);
            yield* adding(this, f, { value: d.value!, guarded: source.guarded });
            continue;
          }
        }
        const copied = this.copiedKey(d.value!);
        if (copied === null) {
          // a call's result is its callee's result key (F20, §8 r4.13): k stores of one function's result, one entry
          const result = this.resultKey(d.value!);
          yield* adding(this, f, result !== null ? { key: result } : { value: d.value! });
          continue;
        }
        // §3.2: a copy read under a guard is one marked entry of its source, its aliases followed (r4.6)
        if (guards.guardedRead(d.value!)) {
          const source = yield* this.#needValue(d.value!);
          yield* adding(this, f, { key: source.key!, guarded: true });
          continue;
        }
        // §3.2 (r4.15, r4.23): a copy of a record with a tested key below it is a mark of its source's holder
        // (collected once), looked up at the read of each path; the entry stays its source's
        const path = keyPath(copied);
        if (path.length > 0) {
          const root = keyOf(keyPlace(copied), []);
          let direct = false;
          for (let length = 1; length <= path.length && !direct; length += 1) {
            work.charge("invSteps");
            if (
              (definitions.byKey.get(keyOf(keyPlace(copied), path.slice(0, length))) ?? []).length >
              0
            )
              direct = true;
          }
          if (direct || open.has(root) || !this.#copyOnly(keyPlace(copied))) {
            if (open.has(root)) f.cut = true;
            yield* adding(this, f, { key: copied });
            continue;
          }
          f.ck = copied;
          f.proj = path;
          const memoised = this.#prefix.get(root);
          if (memoised !== undefined) {
            f.inner = memoised;
            continue;
          }
          open.add(root);
          stack.push(frame(root));
          continue;
        }
        if (open.has(copied) || !this.#copyOnly(keyPlace(copied))) {
          if (open.has(copied)) f.cut = true;
          yield* adding(this, f, { key: copied });
          continue;
        }
        f.ck = copied;
        const memoised = this.#prefix.get(copied);
        if (memoised !== undefined) {
          f.inner = memoised;
          continue;
        }
        open.add(copied);
        stack.push(frame(copied));
        continue;
      }
      stack.pop();
      open.delete(f.pk);
      const stores: PrefixStores = {
        list: f.out,
        subs: f.inherit,
        other: f.other,
        inheritedBy: f.inheritedBy,
        also: [...f.also].map(([layer, defs]) => ({ layer, defs })),
        cut: f.cut,
      };
      // a result cut at an open copy cycle depends on where the query entered it: kept only for its own query, so
      // every order gives one answer
      if (!stores.cut || stack.length === 0) this.#prefix.set(f.pk, stores);
      else stack.at(-1)!.cut = true;
      if (stack.length > 0) stack.at(-1)!.inner = stores;
    }
  }

  /** The layer an alias of `place` inherits: the place's own stores below its root over the place's sources, once. */
  #aliasLayer(inner: PrefixStores, place: PlaceId): SubLayer | null {
    if (this.#aliasLayers.has(inner)) return this.#aliasLayers.get(inner)!;
    const own = new Map<string, Set<Key>>();
    for (const step of this.#subFirstOf(place)) {
      this.pass.program.work.charge("invSteps");
      own.set(step, new Set([keyOf(place, [])]));
    }
    const layer = this.#layer(own, inner.subs);
    this.#aliasLayers.set(inner, layer);
    return layer;
  }

  /**
   * The layer a projected copy of `place` at `projection` takes: the place's own live stores below the path, once, from
   * the keys below the path alone (r4.46 (3): never the place's whole key set per copy).
   */
  #projectedLayer(place: PlaceId, projection: readonly string[]): SubLayer | null {
    const id = `${place}|${projection.join(".")}`;
    if (this.#projectedLayers.has(id)) return this.#projectedLayers.get(id)!;
    const { program, definitions, lists } = this.pass;
    const sub = keyOf(place, projection);
    const own = new Map<string, Set<Key>>();
    for (const below of definitions.keysBelow(sub)) {
      program.work.charge("invSteps");
      if ((definitions.byKey.get(below) ?? []).some((d) => lists.live(d)))
        own.set(keyPath(below)[projection.length]!, new Set([sub]));
    }
    const layer = this.#layer(own, null);
    this.#projectedLayers.set(id, layer);
    return layer;
  }

  /** A prefix's layer: its own sources over the layer it inherits, indexed by their first steps; none if it adds none. */
  #layer(own: Map<string, Set<Key>> | null, parent: SubLayer | null): SubLayer | null {
    if (own === null || own.size === 0) return parent;
    const work = this.pass.program.work;
    const jumps: SubLayer[] = [];
    if (parent !== null) {
      jumps.push(parent);
      for (let level = 0; jumps[level]!.jumps[level] !== undefined; level += 1) {
        work.charge("invSteps");
        jumps.push(jumps[level]!.jumps[level]!);
      }
    }
    let only: Key | null | undefined = parent === null ? undefined : parent.only;
    for (const [, set] of own)
      for (const sub of set) {
        work.charge("invSteps");
        only = only === undefined || only === sub ? sub : null;
      }
    const layer: SubLayer = {
      own,
      parent,
      depth: parent === null ? 0 : parent.depth + 1,
      jumps,
      root: parent === null ? null : (parent.root ?? parent),
      only: only ?? null,
      byStep: new Map(),
    };
    const index = (layer.root ?? layer).byStep;
    for (const step of own.keys()) {
      work.charge("invSteps");
      let byDepth = index.get(step);
      if (byDepth === undefined) index.set(step, (byDepth = new Map()));
      const layers = byDepth.get(layer.depth);
      if (layers === undefined) byDepth.set(layer.depth, new Set([layer]));
      else layers.add(layer);
    }
    return layer;
  }

  /** A layer's ancestor at a depth no greater than its own: by its jumps, one per power of two. */
  #ancestorAt(layer: SubLayer, depth: number): SubLayer {
    let at = layer;
    while (at.depth > depth) {
      this.pass.program.work.charge("invSteps");
      let level = 0;
      while (at.jumps[level + 1] !== undefined && at.jumps[level + 1]!.depth >= depth) level += 1;
      at = at.jumps[level]!;
    }
    return at;
  }

  /** The relative paths of a source's live keys below it, once per source, from the keys below it alone (r4.46 (3)). */
  #ownPaths(sub: Key): ReadonlySet<string> {
    const known = this.#subPaths.get(sub);
    if (known !== undefined) return known;
    const { program, definitions, lists } = this.pass;
    const paths = new Set<string>();
    const base = keyPath(sub);
    for (const below of definitions.keysBelow(sub)) {
      program.work.charge("invSteps");
      if ((definitions.byKey.get(below) ?? []).some((d) => lists.live(d)))
        paths.add(keyPath(below).slice(base.length).join("."));
    }
    this.#subPaths.set(sub, paths);
    return paths;
  }

  /**
   * The sources a prefix's property reads apart from the shared entries: those listed under the property's first step
   * with stores of their own at the property's path or above it below their root; per layer the prefix inherits or
   * joins (one lookup each), the layers asked are that layer and, per depth at which a layer lists the step, its
   * ancestor there, with the stores that brought that layer.
   */
  public relevantSubs(stores: PrefixStores, rest: readonly string[]): readonly SubSource[] {
    if (rest.length === 0) return [];
    const work = this.pass.program.work;
    const step = rest[0]!;
    const found = new Map<Key, Set<Definition | null>>();
    const tops = [
      ...(stores.subs === null ? [] : [{ layer: stores.subs, defs: stores.inheritedBy }]),
      ...stores.also,
    ];
    for (const { layer: top, defs: brought } of tops)
      for (const [depth, layers] of (top.root ?? top).byStep.get(step) ?? []) {
        work.charge("invSteps");
        if (depth > top.depth) continue;
        const layer = this.#ancestorAt(top, depth);
        if (!layers.has(layer)) continue;
        for (const sub of layer.own.get(step) ?? []) {
          work.charge("invSteps");
          const own = this.#ownPaths(sub);
          let held = false;
          for (let length = 1; length <= rest.length && !held; length += 1) {
            work.charge("invSteps");
            held = own.has(rest.slice(0, length).join("."));
          }
          if (!held) continue;
          let defs = found.get(sub);
          if (defs === undefined) found.set(sub, (defs = new Set()));
          for (const d of brought) defs.add(d);
        }
      }
    return [...found]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, defs]) => ({ key, defs }));
  }

  /** Every source of a prefix's layers, inherited and joined (the answers' properties). */
  public subSources(stores: PrefixStores): Key[] {
    const out = new Set<Key>();
    for (const top of [stores.subs, ...stores.also.map((joined) => joined.layer)])
      for (let layer = top; layer !== null; layer = layer.parent)
        for (const [, set] of layer.own) for (const sub of set) out.add(sub);
    return [...out];
  }

  // ------------------------------------------------------------------------------------ the mark holders (§8 r4.23)

  #newHolder(id: string): Holder {
    this.facts.markNodes += 1;
    const holder: Holder = {
      id,
      reads: [],
      readSeen: new Set(),
      refsAt: new Map(),
      refSeen: new Set(),
      guarded: new Set(),
    };
    this.#holders.set(id, holder);
    return holder;
  }

  /** A reference from `holder` to `to`, seen from `shift` below `to`'s identity, standing at `at` below `holder`'s. */
  #refer(
    holder: Holder,
    to: Holder,
    shift: readonly string[] = [],
    at: readonly string[] = [],
  ): void {
    this.pass.program.work.charge("invSteps");
    const key = `${to.id}|${shift.join(".")}|${at.join(".")}`;
    if (holder.refSeen.has(key)) return;
    holder.refSeen.add(key);
    this.facts.markNodes += 1;
    const where = at.join(".");
    const list = holder.refsAt.get(where);
    if (list === undefined) holder.refsAt.set(where, [{ to, shift }]);
    else list.push({ to, shift });
  }

  /** A key's holder: its own reads, and a reference to its prefix's at its last step (one per projection). */
  #holderOfKey(key: Key): Holder {
    const known = this.#holders.get(`k${key}`);
    if (known !== undefined) return known;
    const holder = this.#newHolder(`k${key}`);
    const path = keyPath(key);
    if (path.length > 0)
      this.#refer(
        holder,
        this.#holderOfKey(keyOf(keyPlace(key), path.slice(0, -1))),
        path.slice(-1),
      );
    return holder;
  }

  /** A stored value's holder at a path below it (a place of copies of one value, lifted). */
  #holderAt(holder: Holder | null, path: readonly string[]): Holder | null {
    if (holder === null || path.length === 0) return holder;
    const id = `${holder.id}@${path.join(".")}`;
    const known = this.#holders.get(id);
    if (known !== undefined) return known;
    const lifted = this.#newHolder(id);
    this.#refer(lifted, holder, path);
    return lifted;
  }

  /** A holder's reads grouped once: per base key the groups by callable and file, in dominator and source order. */
  #readGroups(
    reads: Holder["reads"],
  ): Map<
    Key,
    { readonly byCallable: Map<Callable | null, ReadGroup>; readonly list: ReadGroup[] }
  > {
    const known = this.#groups.get(reads);
    if (known !== undefined) return known;
    const { program } = this.pass;
    const groups = new Map<
      Key,
      { readonly byCallable: Map<Callable | null, ReadGroup>; readonly list: ReadGroup[] }
    >();
    const byKey = new Map<string, ReadGroup>();
    const callables = new Map<Callable | null, number>();
    for (const read of reads) {
      program.work.charge("eventSteps");
      let current = read.value;
      const steps: string[] = [];
      for (let projection = program.projOf.get(current); projection !== undefined;) {
        steps.push(projection.step === "iteration" ? "element" : stepName(projection.step));
        current = projection.owner;
        projection = program.projOf.get(current);
      }
      const node = program.occNode.get(current);
      const binding = program.occurrenceOf.get(current);
      if (binding === undefined || node === undefined || node === null || !program.reached(node))
        continue;
      const callable = program.callableAt(node);
      if (!callables.has(callable)) callables.set(callable, callables.size);
      const base = keyOf(binding, [...steps.reverse(), ...read.path]);
      const groupKey = `${base}#${callables.get(callable)}#${node.file}`;
      let group = byKey.get(groupKey);
      if (group === undefined) {
        byKey.set(
          groupKey,
          (group = { callable, file: node.file, nodes: [], byPosition: [], byStart: [] }),
        );
        let entry = groups.get(base);
        if (entry === undefined) groups.set(base, (entry = { byCallable: new Map(), list: [] }));
        entry.byCallable.set(callable, group);
        entry.list.push(group);
      }
      group.nodes.push(node);
    }
    for (const [, entry] of groups)
      for (const group of entry.list) {
        program.work.charge("eventSteps", sortCost(group.nodes.length));
        group.byPosition = [...group.nodes].sort(
          (a, b) => program.position(a) - program.position(b),
        );
        group.byStart = group.nodes
          .filter((node) => node.span !== null)
          .map((node) => node.span!.start.offset)
          .sort((a, b) => a - b);
      }
    this.#groups.set(reads, groups);
    return groups;
  }

  /** Whether a sorted list holds a position in [low, high]. */
  #within<T>(
    list: readonly T[],
    position: (entry: T) => number,
    low: number,
    high: number,
  ): boolean {
    let a = 0;
    let b = list.length;
    while (a < b) {
      const middle = (a + b) >> 1;
      this.pass.program.work.charge("eventSteps");
      if (position(list[middle]!) < low) a = middle + 1;
      else b = middle;
    }
    return a < list.length && position(list[a]!) <= high;
  }

  /** A group's reads under a guard region of tested key t: the cheaper of each read's search and each region's. */
  #groupHit(group: ReadGroup, tested: Key): boolean {
    const { program, guards } = this.pass;
    const branches = guards.branchesOf(tested, group.callable);
    const regions = guards.operandsOf(tested, group.file);
    program.work.charge("eventSteps");
    const branchCount = branches?.list.length ?? 0;
    const regionCount = regions?.list.length ?? 0;
    if (branchCount + regionCount === 0) return false;
    if (group.nodes.length <= branchCount + regionCount)
      return group.byPosition.some(
        (node) =>
          (branches !== undefined &&
            guards.encloses(
              branches,
              (entry) => program.position(entry),
              program.position(node),
            )) ||
          (regions !== undefined &&
            node.span !== null &&
            guards.encloses(regions, (region) => region.start, node.span.start.offset)),
      );
    return (
      (branches?.list.some((entry) =>
        this.#within(
          group.byPosition,
          (node) => program.position(node),
          program.position(entry),
          program.positionEnd(entry),
        ),
      ) ??
        false) ||
      (regions?.list.some((region) =>
        this.#within(group.byStart, (start) => start, region.start, region.end),
      ) ??
        false)
    );
  }

  /**
   * A holder's own reads at path `rest` below it: per non-empty prefix q, the keys tested q below them and the reads of
   * such a key (the smaller side walked), each group of only the callables and files a test of the tested path stands
   * in (W40, r4.28, r4.33); the first hit ends the lookup; every visit charged.
   */
  #readsAt(reads: Holder["reads"], rest: readonly string[]): boolean {
    const { program, guards } = this.pass;
    const byBase = this.#readGroups(reads);
    const visit = (group: ReadGroup, tested: Key): boolean => {
      program.work.charge("eventSteps");
      this.facts.markVisits += 1;
      return this.#groupHit(group, tested);
    };
    for (let length = 1; length <= rest.length; length += 1) {
      const q = rest.slice(0, length);
      const candidates = guards.testedBelow(q.join("."));
      if (candidates === undefined) continue;
      program.work.charge("eventSteps", Math.min(candidates.size, byBase.size) + 1);
      for (const base of common(candidates, byBase)) {
        const entry = byBase.get(base)!;
        const tested = keyOf(keyPlace(base), [...keyPath(base), ...q]);
        const branchCallables = guards.branchCallables(tested);
        const operandCallables = guards.operandCallables(tested);
        if (branchCallables !== undefined) {
          program.work.charge("eventSteps", Math.min(branchCallables.size, entry.byCallable.size));
          for (const callable of common(branchCallables, entry.byCallable))
            if (visit(entry.byCallable.get(callable)!, tested)) return true;
        }
        // a logical operand's regions stand in its expression's callable: the groups of those callables only
        if (operandCallables !== undefined) {
          program.work.charge("eventSteps", Math.min(operandCallables.size, entry.byCallable.size));
          for (const callable of common(operandCallables, entry.byCallable))
            if (
              branchCallables?.has(callable) !== true &&
              visit(entry.byCallable.get(callable)!, tested)
            )
              return true;
        }
      }
    }
    return false;
  }

  /**
   * Every contribution, once per pass before the first query: each live stored read of a key with a tested key below
   * it into its source's holder (stores, adds, arguments, returns, literal cells, alias bindings); each literal's reads
   * as references from the literal's holder under their path, and its guarded reads' paths.
   */
  #collectMarks(): void {
    if (this.#collected) return;
    this.#collected = true;
    const { program, definitions, lists, guards } = this.pass;
    const stores = new Set([...definitions.storeDefs, ...definitions.transferDefs]);
    for (const [, cells] of definitions.cellDefs) for (const d of cells) stores.add(d);
    for (const d of stores) {
      program.work.charge("invSteps");
      if (d.value === undefined || !lists.live(d)) continue;
      const copied = this.copiedKey(d.value);
      if (copied === null || !guards.belowTested.has(copied)) continue;
      const holder = this.identityOf(d.value).holder;
      if (holder === null || holder.readSeen.has(d.value)) continue;
      holder.readSeen.add(d.value);
      this.facts.markNodes += 1;
      holder.reads.push({ value: d.value, path: [] });
    }
    for (const value of program.hasOf.keys()) {
      program.work.charge("invSteps");
      const holder = this.identityOf(value).holder;
      if (holder === null) continue;
      for (const [path, list] of this.literalIndex(value).reads)
        for (const entry of list) {
          program.work.charge("invSteps");
          if (entry.guarded) holder.guarded.add(path);
          if (entry.holder !== null)
            this.#refer(holder, entry.holder, [], path === "" ? [] : path.split("."));
        }
    }
  }

  /**
   * How many leading steps of a path a holder's answer can depend on: the longest tested path, its guarded literal
   * paths, and each reference's place plus what the referenced holder needs beyond the shift; a cycle: no limit. A walk
   * on an explicit stack, each holder once.
   */
  #depthOf(holder: Holder): number {
    if (holder.depth !== undefined) return holder.depth;
    const { guards, program } = this.pass;
    const steps = (at: string): number => (at === "" ? 0 : at.split(".").length);
    const stack: {
      readonly holder: Holder;
      readonly references: readonly (readonly [string, HolderReference])[];
      index: number;
      depth: number;
    }[] = [];
    const open = (each: Holder): void => {
      each.depth = Infinity;
      let depth = guards.testedLength();
      for (const at of each.guarded) depth = Math.max(depth, steps(at));
      stack.push({
        holder: each,
        references: [...each.refsAt].flatMap(([at, list]) =>
          list.map((reference) => [at, reference] as const),
        ),
        index: 0,
        depth,
      });
    };
    open(holder);
    while (stack.length > 0) {
      const top = stack.at(-1)!;
      if (top.index < top.references.length) {
        const [at, reference] = top.references[top.index]!;
        if (reference.to.depth === undefined) {
          open(reference.to);
          continue;
        }
        top.index += 1;
        program.work.charge("invSteps");
        top.depth = Math.max(
          top.depth,
          steps(at) + Math.max(0, reference.to.depth - reference.shift.length),
        );
        continue;
      }
      stack.pop();
      top.holder.depth = top.depth;
    }
    return holder.depth!;
  }

  /**
   * §3.2: a holder's mark at `path` (memoised per holder and the leading steps it can depend on): a literal's guarded
   * read at a prefix, the references standing at a prefix (each asked once, for the rest under its shift), its own
   * reads; a choice's selection step as the record key it reads. A walk on an explicit stack: a holder's ask waits on the
   * references it asks.
   */
  #marksAt(holder: Holder | null, read: readonly string[]): boolean {
    if (holder === null) return false;
    this.#collectMarks();
    const work = this.pass.program.work;
    const stack: {
      readonly holder: Holder;
      readonly rest: readonly string[];
      readonly memoKey: string;
      length: number;
      references: readonly HolderReference[];
      index: number;
      hit: boolean;
    }[] = [];
    // an ask: its answer if known, else a frame for it
    const ask = (asked: Holder, at: readonly string[]): boolean | undefined => {
      // every ask, an answered one too
      work.charge("eventSteps");
      const depth = this.#depthOf(asked);
      const rest = at.length > depth ? at.slice(0, depth) : at;
      const memoKey = rest.join(".");
      asked.memo ??= new Map();
      const known = asked.memo.get(memoKey);
      if (known !== undefined) return known;
      // a reference back to itself answers no
      asked.memo.set(memoKey, false);
      work.charge("eventSteps", 1 + rest.length);
      stack.push({
        holder: asked,
        rest,
        memoKey,
        length: 0,
        references: asked.refsAt.get("") ?? [],
        index: 0,
        hit: asked.guarded.has(""),
      });
      return undefined;
    };
    let answer = ask(holder, recordPath(read));
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      if (answer === true) frame.hit = true;
      answer = undefined;
      if (frame.index < frame.references.length) {
        const reference = frame.references[frame.index++]!;
        work.charge("eventSteps");
        this.facts.markVisits += 1;
        if (!frame.hit)
          answer = ask(reference.to, [...reference.shift, ...frame.rest.slice(frame.length)]);
        continue;
      }
      if (!frame.hit && frame.length < frame.rest.length) {
        frame.length += 1;
        const at = frame.rest.slice(0, frame.length).join(".");
        if (frame.holder.guarded.has(at)) frame.hit = true;
        frame.references = frame.holder.refsAt.get(at) ?? [];
        frame.index = 0;
        continue;
      }
      if (
        !frame.hit &&
        frame.holder.reads.length > 0 &&
        this.#readsAt(frame.holder.reads, frame.rest)
      )
        frame.hit = true;
      frame.holder.memo!.set(frame.memoKey, frame.hit);
      stack.pop();
      answer = frame.hit;
    }
    return answer!;
  }

  /**
   * An entry's answer with its annotations: its guard bit or a mark at the path marks it (§3.2); the ingress stores of
   * every value it stands for go to its external items (C9: one boundary check per ingress store).
   */
  #annotated(
    entry: {
      readonly guarded: boolean;
      readonly holder: Holder | null;
      readonly ingress: IngressNode | undefined;
    },
    rest: readonly string[],
    items: readonly Item[],
  ): readonly Item[] {
    const ingress = this.pass.program.scope.ingress;
    const annotated =
      entry.ingress === undefined
        ? items
        : items.map((item) =>
            item.tag === "unknown" && (item.reasons & REASON.external) !== 0
              ? { ...item, ingress: ingress.union(item.ingress, entry.ingress)! }
              : item,
          );
    return entry.guarded || this.#marksAt(entry.holder, rest) ? marked(annotated) : annotated;
  }

  /** C9: external data that entered by a load, `fromJson` or a host read names its ingress. */
  public entered(value: PlaceId, items: readonly Item[]): readonly Item[] {
    const leaf = this.#ingressLeaf(value);
    if (leaf === undefined) return items;
    const ingress = this.pass.program.scope.ingress;
    return items.map((item) =>
      item.tag === "unknown" && (item.reasons & REASON.external) !== 0
        ? { ...item, ingress: ingress.union(item.ingress, leaf)! }
        : item,
    );
  }

  /**
   * The leaf naming an ingress value (S6-CARRIERS §3.1): every ingress's, where it lands being admission's; else
   * `undefined`, external data created where no ingress is, loose.
   */
  #ingressLeaf(value: PlaceId): IngressNode | undefined {
    const { definitions, program } = this.pass;
    const site = program.places[value]?.site;
    if (!definitions.ingress.has(value) || site === null || site === undefined) return undefined;
    return program.scope.ingress.leaf(ingressLeaf(program, site));
  }

  // ---------------------------------------------------------------------------------------- the literal index (§8)

  /**
   * One index of a literal's structure per literal value or cell, built once in the literal's size, through its nested
   * literals at every step. Per path: the kinds its own terms give (once per kind), the values standing there that are
   * no literal (a read once per source identity, once per exact identity for the value side; a call once per callee
   * result; every other value), the objects there with their properties (F11's missing), the references and the empty
   * collections. A query reads only the entries at its path and its prefixes.
   */
  public literalIndex(literal: PlaceId): LiteralIndex {
    if (!this.#literals.has(literal)) this.#settle(this.#indexWork(literal));
    return this.#literals.get(literal)!;
  }

  *#indexWork(literal: PlaceId): IdentityWork {
    if (this.#literals.has(literal)) return;
    const { program, definitions } = this.pass;
    const index: LiteralIndex = {
      terms: new Map(),
      reads: new Map(),
      exact: new Map(),
      others: new Map(),
      objects: new Map(),
      references: new Set(),
      empty: new Set(),
      lacking: new Map(),
    };
    const seen = new Set<string>();
    const reads = new Map<string, ReadEntry>();
    const put = <T>(map: Map<string, T[]>, path: string, entry: T): void => {
      const list = map.get(path);
      if (list === undefined) map.set(path, [entry]);
      else list.push(entry);
    };
    type Task =
      | {
          readonly kind: "value";
          readonly g: Definition | null;
          readonly value: PlaceId;
          readonly path: string;
        }
      | {
          readonly kind: "term";
          readonly site: Writer;
          readonly term: TypeTerm;
          readonly path: string;
        };
    const pending: Task[] = [];
    const at = (path: string, step: string): string => (path === "" ? step : `${path}.${step}`);
    if (program.hasOf.has(literal))
      pending.push({ kind: "value", g: null, value: literal, path: "" });
    else
      for (const d of [...(definitions.cellDefs.get(literal) ?? [])].reverse())
        // a literal's element that admission rejected is ignored (A6, ADR 0021 1.3)
        if (this.pass.lists.live(d))
          pending.push({ kind: "value", g: d, value: d.value!, path: "" });
    while (pending.length > 0) {
      const task = pending.pop()!;
      program.work.charge("invSteps");
      if (task.kind === "value") {
        const { g, value, path } = task;
        const literals = program.hasOf.get(value) ?? [];
        if (literals.length > 0) {
          for (const has of [...literals].reverse())
            pending.push({
              kind: "term",
              site: program.writer("literal", has.site),
              term: has.type,
              path,
            });
          continue;
        }
        // §8 r4.13, r4.15: a call is a read of its callee's result key (F20) and a read its source: k calls of one
        // function, k copies of one source, are one entry at the path, their guards and ingress its annotations
        const source = yield* this.#needValue(value);
        if (this.copiedKey(value) === null) {
          if (source.key === null) {
            put(index.others, path, { g, value });
            continue;
          }
          if (seen.has(`${path}|${source.id}`)) continue;
          seen.add(`${path}|${source.id}`);
          this.facts.literalEntries += 1;
          put(index.others, path, { g, value });
          continue;
        }
        // one snapshot: one key read here, where nothing between the reads changes what they read (r4.68 (1))
        const snapshot = this.readSnapshot(value)!;
        // (k reads of one host global are one entry as well, by their snapshot, their leaves unioned: an occurrence
        // stays fresh as its own leaf, never as an entry each path reads again, S6-CARRIERS §3.1, Codex r23 F1)
        const leaf = this.#ingressLeaf(value);
        const id = !sharing()
          ? `${path}|v${value}`
          : `${path}|${leaf === undefined ? source.id : snapshot}`;
        // (the value side reads an exact entry by its first read alone, so an ingress occurrence keeps its own: its
        // items carry its own leaf, which one shared entry would drop; the read entry above unions them, TABLE r4.72)
        const exactId =
          !sharing() || leaf !== undefined ? `${path}|v${value}` : `${path}|${snapshot}`;
        const read = reads.get(id);
        if (read === undefined) {
          this.facts.literalEntries += 1;
          const entry: ReadEntry = {
            g,
            value,
            guarded: source.guarded,
            holder: source.holder,
            ingress: leaf,
          };
          reads.set(id, entry);
          put(index.reads, path, entry);
        } else {
          program.work.charge("invSteps");
          if (source.guarded) read.guarded = true;
          if (leaf !== undefined) read.ingress = program.scope.ingress.union(read.ingress, leaf);
        }
        if (!seen.has(`x${exactId}`)) {
          seen.add(`x${exactId}`);
          put(index.exact, path, { g, value });
        }
        continue;
      }
      // a term of a literal's type standing at the path
      const { site, term, path } = task;
      if (term.kind === "ref") {
        for (const d of [...(definitions.cellDefs.get(term.place) ?? [])].reverse())
          if (this.pass.lists.live(d)) pending.push({ kind: "value", g: d, value: d.value!, path });
        continue;
      }
      let kinds = index.terms.get(path);
      if (kinds === undefined) index.terms.set(path, (kinds = new Map()));
      for (const tag of typeTags(term)) if (!kinds.has(tag)) kinds.set(tag, site);
      if (term.kind === "atom" && REFERENCE.has(term.name)) index.references.add(path);
      if (term.kind === "object") {
        let objects = index.objects.get(path);
        if (objects === undefined)
          index.objects.set(path, (objects = { list: [], count: new Map() }));
        // its property names, and the property its button value reads, decided once per record (V30 §19)
        const names = new Set<string>();
        let value: Selected = null;
        let text: Selected = null;
        for (const property of term.properties ?? []) {
          this.facts.selectionVisits += 1;
          names.add(propertyStep(property.name));
          if (property.name === "value") value ??= property;
          else if (property.name === "text") text ??= property;
        }
        objects.list.push({ names, token: site, term, selected: value ?? text });
        for (const name of names) objects.count.set(name, (objects.count.get(name) ?? 0) + 1);
        for (const property of [...(term.properties ?? [])].reverse())
          pending.push({
            kind: "term",
            site,
            term: property.type,
            path: at(path, propertyStep(property.name)),
          });
      } else if (term.kind === "list" || term.kind === "set" || term.kind === "dict") {
        const element = term.element;
        if (element.kind === "ref" && (definitions.cellDefs.get(element.place) ?? []).length === 0)
          index.empty.add(at(path, "element"));
        pending.push({ kind: "term", site, term: element, path: at(path, "element") });
      }
    }
    this.#literals.set(literal, index);
  }

  /**
   * §8 r4.15: a literal's identity is its structure when no reference and no ingress stands in it (the kinds of its own
   * terms, the sources of its reads and calls, its objects' properties at every path), else the literal itself; the
   * marks of its reads are never identity (r4.17).
   */
  public literalSignature(literal: PlaceId): string {
    if (!this.#signatures.has(literal)) this.#settle(this.#signatureWork(literal));
    return this.#signatures.get(literal)!;
  }

  *#signatureWork(literal: PlaceId): IdentityWork {
    if (this.#signatures.has(literal)) return;
    const index = yield* this.#needIndex(literal);
    let plain = index.references.size === 0;
    const parts: string[] = [];
    const paths = new Set([
      ...index.terms.keys(),
      ...index.reads.keys(),
      ...index.others.keys(),
      ...index.objects.keys(),
    ]);
    for (const path of [...paths].sort()) {
      this.pass.program.work.charge("invSteps");
      parts.push(`${path}:${[...(index.terms.get(path)?.keys() ?? [])].sort().join(",")}`);
      for (const entry of index.reads.get(path) ?? []) {
        if (entry.ingress !== undefined) plain = false;
        parts.push(`r${(yield* this.#needValue(entry.value)).id}`);
      }
      for (const entry of index.others.get(path) ?? []) {
        const id = (yield* this.#needValue(entry.value)).id;
        if (id.startsWith("v")) plain = false;
        parts.push(`o${id}`);
      }
      for (const object of index.objects.get(path)?.list ?? [])
        parts.push(`{${[...object.names].sort().join(",")}}`);
    }
    parts.push(`empty:${[...index.empty].sort().join(",")}`);
    // (interned: a literal names its inputs by their own short identities, never by their expansions)
    let signature = `v${literal}`;
    if (plain) {
      const shape = parts.join(";");
      signature = this.#literalIds.get(shape) ?? `l${this.#literalIds.size}`;
      this.#literalIds.set(shape, signature);
    }
    this.#signatures.set(literal, signature);
  }

  /** F11: the first object at the path without the property, once per (path, property): its token, or `null`. */
  #lackingAt(index: LiteralIndex, path: string, step: string): Writer | null {
    const key = `${path}|${step}`;
    const known = index.lacking.get(key);
    if (known !== undefined) return known;
    const objects = index.objects.get(path);
    let token: Writer | null = null;
    if (objects !== undefined && (objects.count.get(step) ?? 0) < objects.list.length)
      for (const object of objects.list) {
        this.pass.program.work.charge("invSteps");
        if (!object.names.has(step)) {
          token = object.token;
          break;
        }
      }
    index.lacking.set(key, token);
    return token;
  }

  /**
   * F12 (r4.7): below a read that stands below an element step, the read's contract answer at the rest of the path
   * (definite by P3, else possible; context `member`), with the read's ingress stores and guard mark.
   */
  *#belowRead(read: PlaceId, below: readonly string[]): Work<readonly Item[]> {
    const { program, guards } = this.pass;
    let root = read;
    for (let projection = program.projOf.get(root); projection !== undefined;) {
      root = projection.owner;
      projection = program.projOf.get(root);
    }
    const copied = this.copiedKey(read)!;
    const node = program.occNode.get(root);
    const items = this.entered(
      root,
      node === undefined || node === null
        ? yield* this.contractOf(keyOf(keyPlace(copied), [...keyPath(copied), ...below]))
        : yield* this.contractRead(
            keyOf(keyPlace(copied), [...keyPath(copied), ...below]),
            node,
            "member",
          ),
    );
    return guards.guardedRead(read, below) ? marked(items) : items;
  }

  /**
   * A literal's items at a path from its index: the value side (`exact`: F12 r4.7, a read below an element step is not
   * followed below its own kinds but takes its contract), else the contract.
   */
  public *indexItems(
    literal: PlaceId,
    rest: readonly string[],
    node: FlowNode | null,
    exact: boolean,
    below = false,
  ): Work<readonly Item[]> {
    const { program, definitions, values } = this.pass;
    const index = this.literalIndex(literal);
    // an element cell, or a literal read as one (`below`): every path below lies below an element step
    const inElement = below || program.cellOwner.get(literal)?.kind === "cell";
    const out: Item[] = [];
    // the read passes an element step over a copy (F12: X3)
    let overCopy = false;
    // the contributions the read gathers: past an element step, several of them are several elements, of which
    // positions do not tell which one (F12)
    let sources = 0;
    for (const [tag, token] of index.terms.get(rest.join(".")) ?? []) {
      out.push(makeItem(tag, token));
      sources += 1;
    }
    for (let length = 0; length <= rest.length; length += 1) {
      program.work.charge("invSteps");
      const path = rest.slice(0, length).join(".");
      const below = rest.slice(length);
      const elementAbove = inElement || rest.slice(0, length).includes("element");
      if (!exact) {
        for (const entry of index.reads.get(path) ?? [])
          out.push(
            ...this.#annotated(
              entry,
              below,
              withWriter(
                yield* this.contractOfValueAt(entry.value, below),
                entry.g === null ? null : definitions.writerOf(entry.g),
              ),
            ),
          );
        for (const entry of index.others.get(path) ?? [])
          out.push(
            ...withWriter(
              yield* this.contractOfValueAt(entry.value, below),
              entry.g === null ? null : definitions.writerOf(entry.g),
            ),
          );
      } else {
        const copies = length < rest.length && elementAbove ? (index.reads.get(path) ?? []) : null;
        if (copies !== null && copies.length > 0) overCopy = true;
        if (copies !== null)
          for (const entry of copies)
            out.push(...this.#annotated(entry, below, yield* this.#belowRead(entry.value, below)));
        else
          for (const entry of index.exact.get(path) ?? [])
            out.push(...(yield* values.valueItems(entry.value, entry.g?.node ?? node, below)));
        const others = index.others.get(path) ?? [];
        for (const entry of others)
          out.push(...(yield* values.valueItems(entry.value, entry.g?.node ?? node, below)));
        sources += (copies ?? index.exact.get(path) ?? []).length + others.length;
      }
      // V30 §19, r4.46 (1): a choice object's button value, per record alternative here
      const step = rest[length];
      if (step === SELECTED_VALUE || step === SELECTED_TEXT) {
        const selected = yield* this.#selectedAt(
          index,
          path,
          step === SELECTED_VALUE,
          rest.slice(length + 1),
          node,
          exact,
          elementAbove,
        );
        out.push(...selected.items);
        // each alternative a selection takes is a contribution of the read (§3.4: several past an element step)
        sources += selected.sources;
        break;
      }
      if (length === rest.length) break;
      // F11: an object here without the next step contributes `missing`; a reference, an opaque member (F19a)
      const lacking = this.#lackingAt(index, path, rest[length]!);
      if (lacking !== null)
        out.push(
          exact
            ? makeItem("unknown", lacking, { reasons: REASON.missing, context: "missing" })
            : unknownItem(REASON.missing, lacking),
        );
      if (index.references.has(path)) out.push(exact ? OPAQUE_MEMBER : unknownItem(REASON.opaque));
      // an empty collection on the way holds no element (the contract's M below it; the value's at its end)
      if (
        rest[length] === "element" &&
        index.empty.has(rest.slice(0, length + 1).join(".")) &&
        (!exact || length === rest.length - 1)
      )
        out.push(EMPTY);
    }
    // S3 §1's route: past an element step over a copy the contract answered (F12)
    if (exact && overCopy) this.#overCopy.add(`${literal}|${rest.join(".")}|${node?.id ?? "-"}`);
    // §3.4 r4.11: the X word is the read's (`member` past an element step over a copy), shared by every known-kind
    // item, definite ones included, whatever its writer; an unknown keeps its reason's word. Past an element step that
    // gathers several elements the element read makes each kind only possible: its word too, by the precedence
    if (overCopy)
      return out.map((item) =>
        item.tag === "unknown" || item.tag === "empty" ? item : { ...item, context: "member" },
      );
    return exact && sources > 1 && (inElement || rest.includes("element"))
      ? out.map((item) =>
          item.tag === "unknown" || item.tag === "empty"
            ? item
            : { ...item, context: firstContext(item.context, "member") },
        )
      : out;
  }

  /**
   * V30 §19, TABLE r4.46 (1): the button values of the options a literal holds at `path`, read at `after` below them,
   * per record alternative: the `value` of a record that has the key (`byValue`), the `text` of one that has none (the
   * property's own cell, its sources kept); a value that is no record is its own button's value, and a record whose keys
   * are unknown, or a reference, has the runtime's (both with the `value`s). With the number of alternatives it chooses
   * among, whichever key it reads: each is a contribution of the read (§3.4: the element step over the options).
   */
  *#selectedAt(
    index: LiteralIndex,
    path: string,
    byValue: boolean,
    after: readonly string[],
    node: FlowNode | null,
    exact: boolean,
    below: boolean,
  ): Work<{ readonly items: readonly Item[]; readonly sources: number }> {
    const out: Item[] = [];
    const terms = [...(index.terms.get(path) ?? [])].filter(([tag]) => tag !== "object");
    const objects = index.objects.get(path)?.list ?? [];
    const sources = terms.length + objects.length + (index.references.has(path) ? 1 : 0);
    if (byValue && after.length === 0)
      for (const [tag, token] of terms) out.push(makeItem(tag, token));
    if (byValue && index.references.has(path))
      out.push(exact ? OPAQUE_MEMBER : unknownItem(REASON.opaque));
    for (const object of objects) {
      this.pass.program.work.charge("invSteps");
      this.facts.selectionVisits += 1;
      const { selected } = object;
      if (object.term.properties === null ? !byValue : (selected?.name === "value") !== byValue)
        continue;
      if (object.term.properties === null)
        out.push(exact ? OPAQUE_MEMBER : unknownItem(REASON.opaque));
      else if (selected === null)
        out.push(
          exact
            ? makeItem("unknown", object.token, { reasons: REASON.missing, context: "missing" })
            : unknownItem(REASON.missing, object.token),
        );
      else if (selected.type.kind === "ref")
        out.push(...(yield* this.indexItems(selected.type.place, after, node, exact, below)));
      else {
        const at = termAt(selected.type, after);
        if (at !== null) for (const tag of typeTags(at)) out.push(makeItem(tag, object.token));
      }
    }
    return { items: out, sources };
  }

  /**
   * A literal's type at the path, or the stores into a literal cell (an empty collection's cell holds no element, so
   * nothing below it either).
   */
  public *contractOfLiteral(literal: PlaceId, rest: readonly string[]): Work<readonly Item[]> {
    const { program, definitions } = this.pass;
    if (!program.hasOf.has(literal) && (definitions.cellDefs.get(literal) ?? []).length === 0)
      return [program.cellOwner.get(literal)?.kind === "cell" ? EMPTY : unknownItem(REASON.opaque)];
    return mergeItems(yield* this.indexItems(literal, rest, null, false), program.scope);
  }
}

/** A group of a holder's reads of one base key in one callable and file. */
interface ReadGroup {
  readonly callable: Callable | null;
  readonly file: number;
  readonly nodes: FlowNode[];
  byPosition: FlowNode[];
  byStart: number[];
}

const NO_STEPS: ReadonlySet<string> = new Set();

/** The written type of a place, when it has one. */
export function writtenOf(kind: PlaceKind): TypeTerm | null {
  return kind.kind === "binding" || kind.kind === "parameter" || kind.kind === "result"
    ? kind.written
    : null;
}

/**
 * V30 §19: per option of an `askChoice`, by index, the kind its written label gives, `null` for a labelled list or set
 * written empty (no button), or `undefined` without a label.
 */
export function choiceLabels(c: ValueConstraint): readonly (ValueKind | null | undefined)[] {
  const evidence = "evidence" in c ? c.evidence : undefined;
  if (evidence?.kind !== "choice") return [];
  return evidence.options.map((option) =>
    option.label === null
      ? undefined
      : (option.content.kind === "list" || option.content.kind === "set") &&
          option.content.elements.length === 0
        ? null
        : option.label.kind,
  );
}

/**
 * V30 §19, TABLE r4.46 (1): an `askChoice`'s answer at `rest`, read by `read`: per option its label's kind, or each of
 * its buttons' values. Whether a choice object gives its `value` or its `text` is decided by the key's presence in the
 * object, never by what the key's value resolves to (an empty answer is unresolved, the solver's bottom, never an absent
 * key): a written choice object (the whole option, or an element of a written list or set) by the keys it writes; one
 * the options hold without writing it (a variable's, a call's) per record alternative where its path meets the records
 * (`SELECTED_VALUE`, `SELECTED_TEXT`, the literal's objects). Where a store goes below a property of that name after
 * a record is made (`stored`), that key is read by its key instead, as the literal's records no longer say what it
 * holds: the `value` as its key gives it, and every record's `text` where some record lacks the `value` (F11's
 * `missing`), possible where some has one.
 */
export function* choiceItems(
  c: Extract<ValueConstraint, { readonly kind: "operation" }>,
  rest: readonly string[],
  read: (value: PlaceId, path: readonly string[], element?: true) => Work<readonly Item[]>,
  stored: StoredChoiceKeys,
): Work<Item[]> {
  const out: Item[] = [];
  const evidence = "evidence" in c && c.evidence?.kind === "choice" ? c.evidence.options : [];
  const labels = choiceLabels(c);
  // a choice object the options hold without writing it: per record alternative its `value` or its `text`; a key with a
  // store below it by its key: the `value` as its key gives it, the `text` of every record where some lacks the `value`,
  // possible where some has one
  const held = function* (option: PlaceId, at: readonly string[]): Work<void> {
    const value =
      stored.value || stored.text ? withoutEmpty(yield* read(option, [...at, "value"])) : [];
    const lacking = value.some(isMissing);
    const present = withoutMissing(value);
    if (!stored.value) out.push(...(yield* read(option, [...at, SELECTED_VALUE, ...rest])));
    else if (present.length > 0 || !lacking)
      out.push(...(rest.length === 0 ? present : yield* read(option, [...at, "value", ...rest])));
    if (!stored.text) out.push(...(yield* read(option, [...at, SELECTED_TEXT, ...rest])));
    else if (lacking) {
      const text = yield* read(option, [...at, "text", ...rest]);
      out.push(...(present.length > 0 ? weaken(text) : text));
    }
  };
  // a written choice object's `value`, or its `text` without one; any other option or element by its value
  const button = function* (
    place: PlaceId,
    object: ChoiceObjectEvidence | null,
    element: boolean,
  ): Work<void> {
    const selected = object === null ? null : (object.value ?? object.text);
    if (object !== null && selected !== null) {
      // an element of a written list or set reads as its literal analogue, below the list's element step (F12 r4.7)
      const key = object.value !== null ? "value" : "text";
      const reading = element ? read(place, [key, ...rest], true) : read(selected, rest);
      out.push(...(yield* reading));
      return;
    }
    const items = withoutEmpty(yield* read(place, []));
    if (items.some((item) => item.tag === "object")) yield* held(place, []);
    for (const item of items)
      if (item.tag !== "object" && (rest.length === 0 || item.tag === "unknown")) out.push(item);
  };
  for (const [index, argument] of c.arguments.entries()) {
    const label = labels[index];
    if (label !== undefined) {
      if (label !== null && rest.length === 0) out.push(makeItem(label));
      continue;
    }
    const content: ChoiceOptionEvidence["content"] | undefined = evidence[index]?.content;
    if (content?.kind === "object") {
      yield* button(argument, content.object, false);
      continue;
    }
    if (content?.kind === "list" || content?.kind === "set") {
      // written choice objects alone: together below the list's element step, as its literal analogue reads them
      // (§3.4: several elements), each by the keys it writes, which no store reaches before the choice
      if (
        content.elements.length > 0 &&
        content.elements.every((element) => element.object !== null)
      )
        for (const step of [SELECTED_VALUE, SELECTED_TEXT])
          out.push(...(yield* read(argument, ["element", step, ...rest])));
      else
        for (const element of content.elements) yield* button(element.place, element.object, true);
      continue;
    }
    // a computed option: a list's or a set's elements, a choice object, or a value
    const option = withoutEmpty(yield* read(argument, []));
    if (option.some((item) => item.tag === "list" || item.tag === "set"))
      for (const item of withoutEmpty(yield* read(argument, ["element"])))
        if (item.tag === "object") yield* held(argument, ["element"]);
        else if (rest.length === 0 || item.tag === "unknown") out.push(item);
    if (option.some((item) => item.tag === "object")) yield* held(argument, []);
    for (const item of option)
      if (item.tag === "list" || item.tag === "set" || item.tag === "object") continue;
      else if (rest.length === 0 || item.tag === "unknown") out.push(item);
  }
  return out;
}

/** A property read that found no such property. */
const isMissing = (item: Item): boolean =>
  item.tag === "unknown" && (item.reasons & REASON.missing) !== 0;

/** Items without their missing alternative: an unknown only missing goes, one with another reason keeps that reason. */
function withoutMissing(items: readonly Item[]): Item[] {
  return items.flatMap((item) =>
    !isMissing(item)
      ? [item]
      : item.reasons === REASON.missing
        ? []
        : [{ ...item, reasons: item.reasons & ~REASON.missing }],
  );
}

/**
 * Whether a projection's step selects what its owner holds at the step's path, so the projection's contract below it is
 * its owner's there (§4.6's normalization): a property or an index; never an iteration, a list's selection, a length,
 * a dict's lists or a temporal member, which answer by themselves.
 */
function plainStep(step: string): boolean {
  if (step === "index") return true;
  return (
    step !== "iteration" &&
    stepName(step) === step &&
    !measuresLength(step) &&
    dictList(step) === undefined &&
    memberStep([step], 0) < 0
  );
}

/** The value of a `default:` named argument. */
export function defaultOf(c: ValueConstraint): PlaceId | undefined {
  return "named" in c ? c.named.find((argument) => argument.name === "default")?.value : undefined;
}

/** The kind of a unit literal: `2 s`, `1 calendar day`, `20 deg`. */
function unitKind(family: "unit" | "angle", name: string): ItemTag {
  if (family === "angle") return "angle";
  return name.startsWith("calendar ") ? "calendarDuration" : "duration";
}

/** A conversion's result as a value kind. */
export function conversionKind(result: string): ItemTag {
  const kind = VALUE_KIND_NAMES.find((candidate) => candidate === result);
  if (kind === undefined) throw new Error(`A conversion gives no value kind '${result}'.`);
  return kind;
}

/** A stored or parsed collection may hold none. */
export function emptyAt(rest: readonly string[]): Item[] {
  return rest.at(-1) === "element" ? [EMPTY] : [];
}

/** The lookup cut by the nesting limit: an unknown destination (V30 §18). */
const CUT: TypeTerm = { kind: "dynamic", why: "unknown member" };

/**
 * F11 (r4.4): the collector reads an object's own `first`, `last` or `random` as an element selection; the core makes it
 * opaque, beside the element where the owner may also be a collection.
 */
export function withOwnSelection(
  elements: readonly Item[],
  owners: readonly Item[],
  pass: CorePass,
): readonly Item[] {
  if (!owners.some((item) => item.tag === "object")) return elements;
  if (owners.every((item) => item.tag === "object")) return [OWN_SELECTION];
  return mergeItems([...elements, OWN_SELECTION], pass.program.scope);
}

/**
 * F10: the elements of `l + r`, held when either side holds one; no position is a fact (F8, F10, F12 r5): where both
 * sides contribute elements, which one an element read takes is unknown, so each kind is possible.
 */
export function plusElements(
  operands: readonly (readonly Item[])[],
  rest: readonly string[],
  pass: CorePass,
): readonly Item[] {
  const held =
    rest.length === 1 &&
    operands.some((items) => items.length > 0 && !items.some((item) => item.tag === "empty"));
  const items = mergeItems(
    held ? withoutEmpty(operands.flat()) : operands.flat(),
    pass.program.scope,
  );
  return operands.filter((items) => withoutEmpty(items).length > 0).length > 1
    ? weaken(items, "member")
    : items;
}
