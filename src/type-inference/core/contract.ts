import { CONVERSIONS, isConversion } from "../../conversions.js";
import { hasIdentity, VALUE_KIND_NAMES, type ValueKind } from "../../value-kinds.js";
import type { PlaceId, PlaceKind, TypeTerm } from "../graph.js";
import type { CorePass } from "./answers.js";
import { keyOf, keyPath, keyPlace, sortCost, type Definition, type Key } from "./definitions.js";
import { withoutEmpty, withWriter } from "./exact-path.js";
import type { Callable, FlowNode } from "./flow-graph.js";
import { marked } from "./guards.js";
import {
  EMPTY,
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
import { stepName, type ValueConstraint } from "./program.js";
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

/** F25: the declared results of the built-in methods the core models. */
export const METHOD_RESULT: Readonly<Record<string, readonly ValueKind[]>> = {
  contains: ["boolean"],
  count: ["integer"],
  indexOf: ["integer", "null"],
  lastIndexOf: ["integer", "null"],
  join: ["string"],
  uppercase: ["string"],
  lowercase: ["string"],
  trim: ["string"],
  sort: ["null"],
  shuffle: ["null"],
  reverse: ["null"],
  clear: ["null"],
};

/** F25: `askInteger`, `askBoolean`, `askText`. */
export const ASKED: Readonly<Record<string, ValueKind>> = {
  integer: "integer",
  boolean: "boolean",
  text: "string",
};

export const REMOVALS: ReadonlySet<string> = new Set([
  "removeAt",
  "remove",
  "removeFirst",
  "removeLast",
]);

/** C6: the element selections; on an object, its own property of that name (F11). */
export const SELECTIONS: ReadonlySet<string> = new Set(["first", "last", "random"]);

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
    const property = term.properties.find((candidate) => candidate.name === step);
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

/** What a prefix stores into the keys below it. */
export interface PrefixStores {
  readonly list: readonly PrefixEntry[];
  /** The sources' own stores below their root, by their first step: once per source and projection. */
  readonly subs: Map<string, Set<Key>> | null;
  /** It holds something other than whole stores of copies. */
  readonly other: boolean;
  /** The prefix's stores that copied each source. */
  readonly subDefs: Map<Key, Set<Definition | null>>;
  readonly cut: boolean;
  deep?: Map<string, Set<Key>>;
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
  readonly subDefs: Map<Key, Set<Definition | null>>;
  subs: Map<string, Set<Key>> | null;
  shared: boolean;
  ck: Key | null;
  proj: readonly string[] | null;
  inner: PrefixStores | undefined;
  other: boolean;
  cut: boolean;
  readonly subPlaces: Set<Key>;
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
      readonly list: { readonly names: Set<string>; readonly token: Writer }[];
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
}

export class Contract {
  readonly facts: ContractFacts = {
    prefixEntries: 0,
    literalEntries: 0,
    markNodes: 0,
    markVisits: 0,
  };
  readonly #prefix = new Map<Key, PrefixStores>();
  readonly #sources = new WeakMap<Map<string, Set<Key>>, readonly Key[]>();
  readonly #keys = new Map<Key, Identity>();
  readonly #identities = new Map<PlaceId, Identity>();
  readonly #aliases = new Map<PlaceId, { readonly key: Key; readonly guarded: boolean }>();
  readonly #holders = new Map<string, Holder>();
  readonly #literals = new Map<PlaceId, LiteralIndex>();
  readonly #signatures = new Map<PlaceId, string>();
  readonly #groups = new WeakMap<
    readonly unknown[],
    Map<Key, { readonly byCallable: Map<Callable | null, ReadGroup>; readonly list: ReadGroup[] }>
  >();
  readonly #lands = new Map<string, TypeTerm | null>();
  #placeKeys: Map<PlaceId, Key[]> | null = null;
  #subFirst: Map<PlaceId, Set<string>> | null = null;
  #collected = false;

  public constructor(readonly pass: CorePass) {}

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
    const path = keyPath(key);
    const found = program.places[place];
    if (found === undefined) return [unknownItem(REASON.external)];
    if (program.isHost(place)) return [unknownItem(REASON.external)];
    if (program.speakerPlaces.has(place)) return [unknownItem(REASON.opaque)];
    if (program.cellOwner.has(place) || program.hasOf.has(place))
      return yield* this.contractOfLiteral(place, path);
    // F19a: a reference's member is opaque, whatever is stored through it
    if (yield* this.refReceiver(key)) return [unknownItem(REASON.opaque)];
    const written = writtenOf(found.kind);
    // F2, F22: the written type is the contract; the stores keep M. §3.2 (r4.9): it fixes the kinds, never removes the
    // mark of what is stored
    if (written !== null) {
      const at = termAt(written, path);
      if (at !== null) {
        const stored = yield* this.#contractAlong(place, path, 0);
        const guarded = stored.some((item) => item.guarded === true);
        const tags = typeTags(at).map((tag) =>
          makeItem(tag, null, guarded ? { cert: "pos", guarded: true } : {}),
        );
        return path.at(-1) === "element" && stored.some((item) => item.tag === "empty")
          ? [...tags, EMPTY]
          : tags;
      }
    }
    return mergeItems(yield* this.#contractAlong(place, path, 0), program.scope);
  }

  /** The contract's answer to a read (§3.2): every kind as an item, definite only by P3; the read's word. */
  public *contractRead(key: Key, node: FlowNode, context: ContextWord): Work<readonly Item[]> {
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
    const word: ContextWord = deferred ? "deferred-parameter" : context;
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
    const place = keyPlace(key);
    const path = keyPath(key);
    for (let length = 0; length < path.length; length += 1) {
      this.pass.program.work.charge("invSteps");
      const items = yield* this.contractOf(keyOf(place, path.slice(0, length)));
      if (items.some((item) => REFERENCE.has(item.tag))) return true;
    }
    return false;
  }

  /**
   * The definitions of a key and of its prefixes from the prefix of length `from` on (0: every one, the key's contract;
   * 1: a replaced source's own stores below its root, which `prefixStores` keeps apart from the root's whole stores).
   */
  *#contractAlong(place: PlaceId, path: readonly string[], from: number): Work<Item[]> {
    const { program, definitions, lists } = this.pass;
    const out: Item[] = [];
    for (let length = path.length; length >= from; length -= 1) {
      const prefix = keyOf(place, path.slice(0, length));
      const rest = path.slice(length);
      if (rest.length > 0) {
        // a prefix's whole stores, shared by every property below it
        const stores = this.prefixStores(prefix);
        for (const entry of stores.list) out.push(...(yield* this.entryAt(entry, rest)));
        // a replaced source's own stores below the prefix, only where they lie
        for (const sub of this.relevantSubs(stores, rest))
          out.push(...(yield* this.subAt(sub, rest)));
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

  /** A projected source's stores below its path start after the path. */
  public *subAt(sub: Key, rest: readonly string[]): Work<readonly Item[]> {
    this.pass.program.work.charge("invSteps");
    const base = keyPath(sub);
    return yield* this.#contractAlong(keyPlace(sub), [...base, ...rest], base.length + 1);
  }

  /** The kinds at a path of a value: a literal's field, a copied record's field. */
  public *contractOfValueAt(value: PlaceId, rest: readonly string[]): Work<readonly Item[]> {
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
      if (projection.step === "length") return yield* this.#contractLength(projection.owner, rest);
      const elements = yield* this.contractOfValueAt(projection.owner, [
        stepName(projection.step),
        ...rest,
      ]);
      if (!SELECTIONS.has(projection.step)) return elements;
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
      if (projection.step === "length") return yield* this.#contractLength(projection.owner, []);
      const elements = yield* this.contractOfValueAt(projection.owner, [stepName(projection.step)]);
      if (!SELECTIONS.has(projection.step)) return elements;
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
        out.push(...withoutEmpty(yield* this.contractOfValueAt(owner, ["element", ...rest])));
      else if ((item.tag === "dict" || item.tag === "range") && rest.length === 0)
        out.push(
          carried(makeItem(item.tag === "dict" ? "string" : "integer", item.writer), [item]),
        );
      else if (item.tag === "unknown") out.push(item);
    }
    return mergeItems(out, this.pass.program.scope);
  }

  /** F14: a text's or a collection's length is a whole number; an object's own `length` is its property (F11). */
  *#contractLength(owner: PlaceId, rest: readonly string[]): Work<readonly Item[]> {
    const out: Item[] = [];
    for (const item of withoutEmpty(yield* this.contractOfValue(owner))) {
      if (
        item.tag === "string" ||
        item.tag === "list" ||
        item.tag === "set" ||
        item.tag === "dict"
      ) {
        if (rest.length === 0) out.push(carried(makeItem("integer", item.writer), [item]));
      } else if (item.tag === "object")
        out.push(...(yield* this.contractOfValueAt(owner, ["length", ...rest])));
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
    if (c.kind === "get")
      return mergeItems(
        [
          ...withoutEmpty(yield* this.contractOfValueAt(c.receiver, ["element", ...rest])),
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
    // F19a: a reference's method is opaque
    if (family === "method" && c.receiver !== null) {
      const receiver = yield* this.contractOfValue(c.receiver);
      if (receiver.some((item) => REFERENCE.has(item.tag))) return [unknownItem(REASON.opaque)];
    }
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
          makeItem(name === "script" ? "script" : "string"),
          ...(fallback === undefined ? [] : yield* this.contractOfValue(fallback)),
        ],
        scope,
      );
    }
    // F7a–c, F25
    if (
      family === "method" &&
      (REMOVALS.has(name) || METHOD_RESULT[name] !== undefined) &&
      c.receiver !== null
    ) {
      const out: Item[] = [];
      for (const item of withoutEmpty(yield* this.contractOfValue(c.receiver))) {
        const declared = METHOD_RESULT[name];
        if (declared !== undefined) {
          if (rest.length === 0) out.push(...declared.map((tag) => carried(makeItem(tag), [item])));
        } else if (name === "remove" && item.tag !== "dict") {
          if (rest.length === 0) out.push(carried(makeItem("null"), [item]));
        } else if (COLLECTIONS.has(item.tag))
          out.push(
            ...withoutEmpty(yield* this.contractOfValueAt(c.receiver, ["element", ...rest])),
          );
        else if (item.tag === "unknown") out.push(item);
      }
      return mergeItems(out, scope);
    }
    // F10: a `take` may hold none
    if (
      family === "method" &&
      ["toSet", "toList", "take", "takeLast"].includes(name) &&
      c.receiver !== null
    )
      return rest.length === 0
        ? [
            carried(
              makeItem(name === "toSet" ? "set" : "list"),
              yield* this.contractOfValue(c.receiver),
            ),
          ]
        : [
            ...(yield* this.contractOfValueAt(c.receiver, ["element", ...rest.slice(1)])),
            ...(name.startsWith("take") && rest.length === 1 ? [EMPTY] : []),
          ];
    if (family === "operator" && name === "+" && rest.length > 0) {
      const operands: (readonly Item[])[] = [];
      for (const argument of c.arguments)
        operands.push(yield* this.contractOfValueAt(argument, rest));
      return plusElements(operands, rest, this.pass);
    }
    if (family === "conversion" && isConversion(name) && CONVERSIONS[name].result !== "unknown") {
      if (rest.length > 0) return [];
      const conversion = CONVERSIONS[name];
      const fallback = defaultOf(c);
      return mergeItems(
        [
          makeItem(conversionKind(conversion.result)),
          ...(fallback !== undefined
            ? yield* this.contractOfValue(fallback)
            : conversion.fallback?.type === "optional"
              ? [makeItem("null")]
              : []),
        ],
        scope,
      );
    }
    if (name === "fromJson") {
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
    if (family === "interaction" && ASKED[name] !== undefined)
      return rest.length === 0 ? [makeItem(ASKED[name])] : [];
    if (family === "interaction") {
      const out: Item[] = [];
      for (const argument of c.arguments) {
        out.push(
          ...(yield* this.contractOfValueAt(argument, rest)).filter(
            (item) => item.tag !== "list" && item.tag !== "set",
          ),
        );
        for (const item of withoutEmpty(yield* this.contractOfValueAt(argument, ["element"])))
          out.push(
            ...(item.tag === "object"
              ? yield* this.contractOfValueAt(argument, ["element", "value", ...rest])
              : rest.length === 0
                ? [item]
                : []),
          );
      }
      return mergeItems(out, scope);
    }
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
    if (family === "member" && name === "length") return [makeItem("integer")];
    // F19a: a handle's member is opaque
    if (family === "timer" || family === "media") return [makeItem(family)];
    if (family === "range") return [makeItem("range")];
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
          (stores.subs === null || stores.subs.size === 0)
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
   * value itself; the read's guard an annotation.
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
        id: source.id,
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
      } else identity = { id: `v${value}`, key: null, guarded: false, holder: null };
    }
    this.#identities.set(value, identity);
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
    else if (e.elem !== undefined) yield* this.#needValue(e.elem);
    else if (e.value !== undefined) yield* this.#needValue(e.value);
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
      subDefs: new Map(),
      subs: null,
      shared: false,
      ck: null,
      proj: null,
      inner: undefined,
      other: false,
      cut: false,
      subPlaces: new Set(),
    });
    const entryId = (e: EntryDraft): string =>
      e.key !== undefined
        ? this.keyIdentity(e.key).id
        : e.unk !== undefined
          ? `u${e.unk}`
          : e.empty === true
            ? "e"
            : e.elem !== undefined
              ? `a${this.identityOf(e.elem).id}@${(e.at ?? []).join(".")}`
              : `${this.identityOf(e.value!).id}@${(e.at ?? []).join(".")}`;
    const add = (f: PrefixFrame, e: EntryDraft): void => {
      work.charge("invSteps");
      const id = entryId(e);
      const w = e.w !== undefined ? e.w : f.w;
      const value = e.elem ?? e.value;
      const store =
        (value !== undefined && e.at === undefined) || e.elem !== undefined
          ? definitions.ingressStore.get(value!)
          : undefined;
      const ingress =
        store === undefined
          ? e.ingress
          : program.scope.ingress.union(e.ingress, program.scope.ingress.leaf(store));
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
    const own = (f: PrefixFrame): Map<string, Set<Key>> => {
      if (f.subs === null) f.subs = new Map();
      else if (f.shared) {
        const copy = new Map<string, Set<Key>>();
        for (const [step, set] of f.subs) {
          work.charge("invSteps", set.size);
          copy.set(step, new Set(set));
        }
        f.subs = copy;
      }
      f.shared = false;
      return f.subs;
    };
    const subDef = (f: PrefixFrame, sub: Key): void => {
      work.charge("invSteps");
      let set = f.subDefs.get(sub);
      if (set === undefined) f.subDefs.set(sub, (set = new Set()));
      set.add(f.d);
    };
    // one inherited map is shared, not copied, and its sources take the store once each (an edited record copied
    // through k aliases lists its source under k first steps: k insertions per alias would be k × k)
    const addSubs = (f: PrefixFrame, subs: Map<string, Set<Key>> | null): void => {
      if (subs === null || subs.size === 0 || f.subs === subs) return;
      for (const sub of this.#sourcesOf(subs)) subDef(f, sub);
      if (f.subs === null) {
        f.subs = subs;
        f.shared = true;
        return;
      }
      const target = own(f);
      for (const [step, set] of subs) {
        work.charge("invSteps", set.size);
        let into = target.get(step);
        if (into === undefined) target.set(step, (into = new Set()));
        for (const sub of set) into.add(sub);
      }
    };
    const addSub = (f: PrefixFrame, step: string, sub: Key): void => {
      work.charge("invSteps");
      subDef(f, sub);
      const target = own(f);
      let set = target.get(step);
      if (set === undefined) target.set(step, (set = new Set()));
      if (!set.has(sub)) this.facts.prefixEntries += 1;
      set.add(sub);
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
          inner.subs === null ||
          this.#sourcesOf(inner.subs).every((sub) => sub === keyOf(copiedPlace, []));
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
          // a source's own stores listed once per prefix, however many of its stores copy it (§8 r4.15)
          const sub = keyOf(copiedPlace, projection);
          work.charge("invSteps");
          if (f.subPlaces.has(sub)) subDef(f, sub);
          else {
            f.subPlaces.add(sub);
            for (const below of this.#keysOfPlace(copiedPlace)) {
              const path = keyPath(below);
              work.charge("invSteps");
              if (
                path.length > projection.length &&
                projection.every((step, index) => path[index] === step) &&
                (definitions.byKey.get(below) ?? []).some((d) => lists.live(d))
              )
                addSub(f, path[projection.length]!, sub);
            }
          }
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
          addSubs(f, inner.subs);
          const sub = keyOf(keyPlace(f.ck!), []);
          work.charge("invSteps");
          if (f.subPlaces.has(sub)) subDef(f, sub);
          else {
            f.subPlaces.add(sub);
            for (const step of this.#subFirstOf(keyPlace(f.ck!))) addSub(f, step, sub);
          }
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
          f.other = true;
          const parameter = program.place(d.place).kind;
          // F21: a single non-recursive call's binding is exact, its argument's and its default's alike
          if (
            parameter.kind === "parameter" &&
            parameter.written === null &&
            !lists.singleSite(d.fn)
          )
            yield* adding(this, f, { unk: REASON.deferred });
          const source = yield* this.#needValue(d.value!);
          yield* adding(this, f, { value: d.value!, guarded: source.guarded });
          continue;
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
        subs: f.subs,
        other: f.other,
        subDefs: f.subDefs,
        cut: f.cut,
      };
      // a result cut at an open copy cycle depends on where the query entered it: kept only for its own query, so
      // every order gives one answer
      if (!stores.cut || stack.length === 0) this.#prefix.set(f.pk, stores);
      else stack.at(-1)!.cut = true;
      if (stack.length > 0) stack.at(-1)!.inner = stores;
    }
  }

  /** The distinct sources a map of sources by first step lists, once per map (a finished map never changes). */
  #sourcesOf(subs: Map<string, Set<Key>>): readonly Key[] {
    let sources = this.#sources.get(subs);
    if (sources === undefined) {
      const found = new Set<Key>();
      for (const [, set] of subs)
        for (const sub of set) {
          this.pass.program.work.charge("invSteps");
          found.add(sub);
        }
      sources = [...found];
      this.#sources.set(subs, sources);
    }
    return sources;
  }

  /**
   * The sources a prefix's property reads apart from the shared entries: those with stores of their own at the
   * property's path or above it below their root.
   */
  public relevantSubs(stores: PrefixStores, rest: readonly string[]): Key[] {
    if (stores.subs === null) return [];
    const { program, definitions, lists } = this.pass;
    let deep = stores.deep;
    if (deep === undefined) {
      deep = new Map();
      stores.deep = deep;
      const steps = new Map<Key, Set<string>>();
      // each source's place is scanned once, not once per step it is listed under (k fields of one source: k × k)
      for (const [step, set] of stores.subs)
        for (const sub of set) {
          program.work.charge("invSteps");
          let found = steps.get(sub);
          if (found === undefined) steps.set(sub, (found = new Set()));
          found.add(step);
        }
      for (const [sub, firstSteps] of steps) {
        const place = keyPlace(sub);
        const base = keyPath(sub);
        for (const below of this.#keysOfPlace(place)) {
          const path = keyPath(below);
          program.work.charge("invSteps");
          if (
            path.length <= base.length ||
            !base.every((step, index) => path[index] === step) ||
            !firstSteps.has(path[base.length]!) ||
            !(definitions.byKey.get(below) ?? []).some((d) => lists.live(d))
          )
            continue;
          const relative = path.slice(base.length).join(".");
          let set = deep.get(relative);
          if (set === undefined) deep.set(relative, (set = new Set()));
          set.add(sub);
        }
      }
    }
    const out = new Set<Key>();
    for (let length = 1; length <= rest.length; length += 1) {
      program.work.charge("invSteps");
      for (const sub of deep.get(rest.slice(0, length).join(".")) ?? []) out.add(sub);
    }
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
   * reads. A walk on an explicit stack: a holder's ask waits on the references it asks.
   */
  #marksAt(holder: Holder | null, path: readonly string[]): boolean {
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
    let answer = ask(holder, path);
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

  /** C9: external data that entered by a load, `fromJson`, `askChoice` or a host read names its ingress store. */
  public entered(value: PlaceId, items: readonly Item[]): readonly Item[] {
    const store = this.pass.definitions.ingressStore.get(value);
    if (store === undefined) return items;
    const ingress = this.pass.program.scope.ingress;
    return items.map((item) =>
      item.tag === "unknown" && (item.reasons & REASON.external) !== 0
        ? { ...item, ingress: ingress.union(item.ingress, ingress.leaf(store))! }
        : item,
    );
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
    const { program, definitions, guards } = this.pass;
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
        const id = `${path}|${source.id}`;
        // one snapshot: one key read here
        const exactId = `${path}|${guards.guardedRead(value) ? "g" : ""}${this.copiedKey(value)}`;
        const store = definitions.ingressStore.get(value);
        const read = reads.get(id);
        if (read === undefined) {
          this.facts.literalEntries += 1;
          const entry: ReadEntry = {
            g,
            value,
            guarded: source.guarded,
            holder: source.holder,
            ingress: store === undefined ? undefined : program.scope.ingress.leaf(store),
          };
          reads.set(id, entry);
          put(index.reads, path, entry);
        } else {
          program.work.charge("invSteps");
          if (source.guarded) read.guarded = true;
          if (store !== undefined)
            read.ingress = program.scope.ingress.union(
              read.ingress,
              program.scope.ingress.leaf(store),
            );
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
          pending.push({ kind: "value", g: d, value: d.value!, path });
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
        const names = new Set((term.properties ?? []).map((property) => property.name));
        objects.list.push({ names, token: site });
        for (const name of names) objects.count.set(name, (objects.count.get(name) ?? 0) + 1);
        for (const property of [...(term.properties ?? [])].reverse())
          pending.push({ kind: "term", site, term: property.type, path: at(path, property.name) });
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
        if (id.startsWith("v") || this.pass.definitions.ingressStore.has(entry.value))
          plain = false;
        parts.push(`o${id}`);
      }
      for (const object of index.objects.get(path)?.list ?? [])
        parts.push(`{${[...object.names].sort().join(",")}}`);
    }
    parts.push(`empty:${[...index.empty].sort().join(",")}`);
    const signature = plain ? `l${parts.join(";")}` : `v${literal}`;
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
  ): Work<readonly Item[]> {
    const { program, definitions, values } = this.pass;
    const index = this.literalIndex(literal);
    // an element cell: every path below lies below an element step
    const inElement = program.cellOwner.get(literal)?.kind === "cell";
    const out: Item[] = [];
    // the read passes an element step over a copy (F12: X3)
    let overCopy = false;
    for (const [tag, token] of index.terms.get(rest.join(".")) ?? [])
      out.push(makeItem(tag, token));
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
        for (const entry of index.others.get(path) ?? [])
          out.push(...(yield* values.valueItems(entry.value, entry.g?.node ?? node, below)));
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
    // §3.4 r4.11: the X word is the read's (`member` past an element step over a copy), shared by every known-kind
    // item, definite ones included, whatever its writer; an unknown keeps its reason's word
    return overCopy
      ? out.map((item) =>
          item.tag === "unknown" || item.tag === "empty" ? item : { ...item, context: "member" },
        )
      : out;
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
