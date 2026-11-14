import { familyOf, VALUE_KIND_NAMES, type ValueKind } from "../../value-kinds.js";
import type { SourceSite } from "../graph.js";
import type { WorkLedger } from "./budget.js";
import { Retained } from "./retained/retained.js";

/*
 * The items of the core: what the analysis knows of a value at a read. A value is a
 * list of items, one per kind. An item is one kind with a certainty (`def`: every run that reaches the read has a value
 * of this kind; `pos`: some run may), the reasons of an `unknown`, one writer that explains it (F28) and one context
 * word (`CONTEXT_WORDS`). Some items also carry the ingress stores of external data (C9), the guard mark (`guarded`) or
 * the identity of the one unknown operand whose operator rows they stand for (`fan`).
 */

/**
 * A kind an item can have: a value kind, `unknown` (a value the core does not model, with its reasons), or `empty`, the
 * mark that an element read may find no element on some run.
 */
export type ItemTag = ValueKind | "unknown" | "empty";

export type Certainty = "def" | "pos";

/**
 * Why a value is `unknown`: host data, a typeless load or `fromJson` (`external`); a reference's member or an
 * operation the core does not model (`opaque`); a parameter with several call sites (`deferred`); a source of a record
 * without the property (`missing`); a demand over its allowance (`budget`, B1). An item holds a set of them as bits.
 */
export const REASON = { external: 1, opaque: 2, deferred: 4, missing: 8, budget: 16 } as const;

/**
 * The context words in the order a warning names the first: the reasons' words (`unmodelled` to `unknown`), which are
 * decided first, then those of the exact path's conditions X1 to X7, then A7's `later`, and last `budget`, a value the
 * analysis stopped before deciding (B1, D4). `reasonContext` orders the first four, the reasons' own words,
 * differently (`external`'s `unknown` before `deferred-parameter`).
 */
export const CONTEXT_WORDS = [
  "unmodelled",
  "missing",
  "deferred-parameter",
  "unknown",
  "dead-code",
  "call",
  "member",
  "label",
  "loop",
  "branch",
  "handler",
  "later",
  "budget",
] as const;

export type ContextWord = (typeof CONTEXT_WORDS)[number];

/** A store that explains an item (F28): its kind and its site; the record writes it `kind@file:offset`. */
export interface Writer extends SourceSite {
  readonly kind: string;
}

/**
 * The ingresses of external data that an item holds (C9), as a shared graph: a leaf names one ingress, by its own
 * expression's writer (the store that brought it is a fact of admission's walk, not the value side's),
 * a union two parts, and a cell what one member of a fixpoint brought, which grows in place as the member runs again, so
 * every value that holds the cell sees the growth. Merging items unites their nodes and never copies the leaves.
 */
export type IngressNode =
  | { readonly id: number; readonly ingress: Writer }
  | { readonly id: number; readonly parts: readonly [IngressNode, IngressNode] }
  | IngressCell;

export interface IngressCell {
  readonly id: number;
  contents: IngressNode | null;
}

export interface Item {
  readonly tag: ItemTag;
  readonly cert: Certainty;
  /** The `REASON` bits the item carries: an unknown's own, or those an operation's result took from its operands. */
  readonly reasons: number;
  readonly writer: Writer | null;
  readonly context: ContextWord | null;
  /** The word of a `null` that stands beside external data (a typeless load's `default: null`). */
  readonly word?: ContextWord;
  readonly ingress?: IngressNode;
  /** External data that no ingress store brought, merged beside some that one did (C9). */
  readonly loose?: true;
  /**
   * The guard mark: the value was read under a test of its path, so no consumer errs on it.
   */
  readonly guarded?: true;
  /**
   * The value came through a call: a parameter's or a result's (F20–F22), travelling as the guard mark does. A dead call
   * binds nothing (F21), so in dead code such a kind may lack the marks its call would give: there it is never definite
   * (AD-3).
   */
  readonly called?: true;
  /**
   * A kind a type test proved of external data (`narrowedItems`, #1073), or a stopped read of an ingress: the kind is
   * proved or unknown, never the ingress, so a consumer still asks C9's boundary of the ingress the data came by.
   */
  readonly fromExternal?: true;
  /**
   * Read where a test of its path that removes its kind failed (N2's failing event, the test's kinds without it): a check
   * on every route that the compiler cannot keep, which warns, never the route rule's error (V30 §13).
   */
  readonly tested?: true;
  /** The unknown operand, by `fanIdentity`, whose operator rows this item is one of. */
  readonly fan?: string;
  /**
   * An operation's result kind that every combination giving it holds external data in: possible solely through
   * external data, so no internal contribution admits it (A2, A3).
   */
  readonly extOnly?: true;
  /**
   * The written type the item was made from, as its kinds in their written order (`Spelling`): a list of a value's
   * kinds keeps that order where it alone covers the list (`inItsOrder`, #1398).
   */
  readonly spelling?: Spelling;
}

/**
 * A written type's kinds in their written order (`typeKinds`'s), which the items made from it carry; `MIXED` where
 * items of two spellings merged. Compared by its kinds, never by identity: two reads of one written type are one
 * spelling.
 */
export type Spelling = readonly ItemTag[];

/** The spelling of items of two different spellings merged: it never covers a list (`inItsOrder`). */
const MIXED: Spelling = Object.freeze([]);

/**
 * The join of two items' spellings: none below one spelling below `MIXED`. Commutative and
 * associative, `MIXED` absorbing, so a merge's spelling is the same in whatever order its items come.
 */
export function joinSpelling(
  a: Spelling | undefined,
  b: Spelling | undefined,
): Spelling | undefined {
  if (a === undefined) return b;
  if (b === undefined || a === b) return a;
  return a.length > 0 && a.length === b.length && a.every((tag, index) => tag === b[index])
    ? a
    : MIXED;
}

/**
 * A spelling's part of an identity (docs/specifications/type-inference-accepted-record/contract.md#r4-277): empty for
 * none, `*` for `MIXED`, else its kinds by value. Every key or snapshot that identifies items or a type test's form
 * includes it (`itemsSignature`, `Values.narrowingMark`), so differently marked lists are different values.
 */
export function spellingIdentity(spelling: Spelling | undefined): string {
  return spelling === undefined ? "" : spelling.length === 0 ? "*" : spelling.join("+");
}

/**
 * The field of the items made from a written type of these kinds in their written order (`makeItem`'s `fields`): each
 * kind once, `unknown` left out, so every maker of one written type gives one spelling. Made once per written type read,
 * at its length, since the items keep it (as `inOrderOf`'s result, #1625).
 */
export function spelledBy(kinds: readonly ItemTag[]): { readonly spelling: Spelling } {
  // (a set keeps its first insertion's order: `unknown`, then each kind where it is first written)
  const seen = new Set<ItemTag>(["unknown"]);
  for (const tag of kinds) seen.add(tag);
  const spelling = new Array<ItemTag>(seen.size - 1);
  let at = 0;
  for (const tag of seen) if (tag !== "unknown") spelling[at++] = tag;
  return { spelling };
}

/** The fields of an item that `makeItem` lets a caller set. */
export type ItemFields = Partial<Omit<Item, "tag" | "writer">>;

/** An item of kind `tag`, definite and without reasons or context unless `fields` says otherwise. */
export function makeItem(
  tag: ItemTag,
  writer: Writer | null = null,
  fields: ItemFields = {},
): Item {
  return { tag, cert: "def", reasons: 0, writer, context: null, ...fields };
}

/**
 * The marks an item made from others takes from them, each where one of them has it: the guard mark (`guarded`), the
 * through-a-call flag (`called`, AD-3) and a test's kind of external data (`fromExternal`). A new mark that travels
 * belongs here and in `computedMarks`.
 */
export function marksOf(from: readonly Item[]): {
  readonly guarded?: true;
  readonly called?: true;
  readonly fromExternal?: true;
} {
  return {
    ...(from.some((each) => each.guarded === true) ? { guarded: true as const } : {}),
    ...(from.some((each) => each.called === true) ? { called: true as const } : {}),
    ...(from.some((each) => each.fromExternal === true) ? { fromExternal: true as const } : {}),
  };
}

/**
 * The marks a computed item takes from its operands (`marksOf` without `fromExternal`): an operator's row, a
 * conversion, a length, a declared result or a key is computed, so it is never external data a test refined (#1073:
 * only a transfer that keeps the value, a copy, a merge of one kind, a literal's element or a selection, carries that
 * mark).
 */
export function computedMarks(from: readonly Item[]): {
  readonly guarded?: true;
  readonly called?: true;
} {
  return {
    ...(from.some((each) => each.guarded === true) ? { guarded: true as const } : {}),
    ...(from.some((each) => each.called === true) ? { called: true as const } : {}),
  };
}

/** The mark of an element read that may find no element: not a value, so no consumer checks it. */
export const EMPTY: Item = Object.freeze(makeItem("empty"));

/**
 * Every value's answer once the analysis stopped (D4): `unknown` with the reason `budget`, the terminal contract
 * every key has, so each consumer owes its check when the script runs and no further proof is made.
 */
export const STOPPED: readonly Item[] = Object.freeze([
  makeItem("unknown", null, { reasons: REASON.budget, context: "budget", cert: "pos" }),
]);

/** The identity of a writer, as `kind@file:offset` with the file's index. */
export function writerKey(writer: Writer): string {
  return `${writer.kind}@${writer.file}:${writer.start}`;
}

/** The identity of an unknown operand in an operation (`fan`): its writer's, or else the operation's site. */
export function fanIdentity(writer: Writer | null, operation: SourceSite): string {
  return writer === null ? `op@${operation.file}:${operation.start}` : writerKey(writer);
}

function contextRank(context: ContextWord | null): number {
  return context === null ? CONTEXT_WORDS.length : CONTEXT_WORDS.indexOf(context);
}

/** Of two context words, the one a warning names first (`CONTEXT_WORDS`); no word comes last. */
export function firstContext(a: ContextWord | null, b: ContextWord | null): ContextWord | null {
  return contextRank(b) < contextRank(a) ? b : a;
}

/**
 * The word of one unknown's reasons: the first present in the rank `external` (`unknown`), `opaque`
 * (`unmodelled`), `deferred` (`deferred-parameter`), `missing` (`missing`), `budget` (`budget`); an unknown without
 * reasons says `unknown`. This order differs from `CONTEXT_WORDS`' (`deferred-parameter` comes before `unknown` there).
 */
export function reasonContext(reasons: number): ContextWord {
  if ((reasons & REASON.external) !== 0) return "unknown";
  if ((reasons & REASON.opaque) !== 0) return "unmodelled";
  if ((reasons & REASON.deferred) !== 0) return "deferred-parameter";
  if ((reasons & REASON.missing) !== 0) return "missing";
  if ((reasons & REASON.budget) !== 0) return "budget";
  return "unknown";
}

/** The reasons whose words come before every condition's (`CONTEXT_WORDS`), and those words. */
const EARLY_REASONS = REASON.external | REASON.opaque | REASON.deferred | REASON.missing;
const EARLY_WORDS: ReadonlySet<ContextWord> = new Set([
  "unmodelled",
  "missing",
  "deferred-parameter",
  "unknown",
]);

/**
 * The word an item brings where words meet: an unknown its reasons' word (`reasonContext`), whatever word it carries;
 * any other item its own word.
 */
export function ownContext(item: Item): ContextWord | null {
  return item.tag === "unknown" ? reasonContext(item.reasons) : item.context;
}

/**
 * The source order of writers (ADR 0021 §1.6): by file in project order, which is the request's file order, then by
 * offset, then by kind.
 */
function compareWriters(a: Writer, b: Writer): number {
  if (a.file !== b.file) return a.file - b.file;
  if (a.start !== b.start) return a.start - b.start;
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}

/** A class holding an ingress, whose external data names its own leaf (C9; `Contract.classMixed`). */
export const MIXED_LEAF = 1;
/** A class holding an operator's result, which names its unknown operand (`fan`, F16; `Contract.classMixed`). */
export const MIXED_FAN = 2;

/** Whether an item can differ between values of one class mixed as `mixed` says: by a leaf, by an operand's identity. */
export function differsIn(item: Item, mixed: number): boolean {
  return (
    ((mixed & MIXED_LEAF) !== 0 &&
      item.tag === "unknown" &&
      (item.reasons & REASON.external) !== 0) ||
    ((mixed & MIXED_FAN) !== 0 && item.fan !== undefined)
  );
}

/** Of two writers, the earlier in source order; no writer comes last. */
export function firstWriter(a: Writer | null, b: Writer | null): Writer | null {
  if (a === null) return b;
  if (b === null) return a;
  return compareWriters(b, a) < 0 ? b : a;
}

/** The ingress graph of one analysis: one leaf per ingress and one union per pair of nodes, each made once. */
export class IngressGraph {
  readonly #leaves = new Map<string, IngressNode>();
  readonly #unions = new Map<string, IngressNode>();
  #next = 0;

  public leaf(ingress: Writer): IngressNode {
    const key = writerKey(ingress);
    let node = this.#leaves.get(key);
    if (node === undefined) this.#leaves.set(key, (node = { id: this.#next++, ingress }));
    return node;
  }

  public union(a: IngressNode | undefined, b: IngressNode | undefined): IngressNode | undefined {
    if (a === undefined) return b;
    if (b === undefined || a === b) return a;
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    let node = this.#unions.get(key);
    if (node === undefined) this.#unions.set(key, (node = { id: this.#next++, parts: [a, b] }));
    return node;
  }

  public cell(): IngressCell {
    // (#1072: a record, so the solver's growth of a fixpoint's cell is a recorded write)
    return Retained.record("IngressCell", { id: this.#next++, contents: null });
  }
}

/** Every ingress below `node`, each node visited once, in source order. */
export function ingressLeaves(node: IngressNode): Writer[] {
  const leaves = new Map<string, Writer>();
  const seen = new Set<IngressNode>();
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    if ("ingress" in current) leaves.set(writerKey(current.ingress), current.ingress);
    else if ("parts" in current) pending.push(...current.parts);
    else if (current.contents !== null) pending.push(current.contents);
  }
  return [...leaves.values()].sort(compareWriters);
}

/**
 * Whether every one of `leaves` lies below `node`, with no cell on the way (a fixpoint's cell grows as its member runs
 * again): each node visited once, charged.
 */
export function holdsLeaves(
  node: IngressNode | undefined,
  leaves: readonly IngressNode[],
  scope: ItemScope,
): boolean {
  const found = new Set<IngressNode>();
  const seen = new Set<IngressNode>();
  const pending = node === undefined ? [] : [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    scope.work.charge("mergeItems");
    seen.add(current);
    if ("ingress" in current) found.add(current);
    else if ("parts" in current) pending.push(...current.parts);
    else return false;
  }
  return leaves.every((leaf) => found.has(leaf));
}

/** Appends the leaves below `node` to `out`, each node visited once, charged; `false` where a cell lies on the way. */
export function leafNodes(node: IngressNode, out: IngressNode[], scope: ItemScope): boolean {
  const seen = new Set<IngressNode>();
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    scope.work.charge("mergeItems");
    seen.add(current);
    if ("ingress" in current) out.push(current);
    else if ("parts" in current) pending.push(...current.parts);
    else return false;
  }
  return true;
}

/** What the item operations of one analysis share: its ledger and its ingress graph. */
export interface ItemScope {
  readonly work: WorkLedger;
  readonly ingress: IngressGraph;
}

/** External data that no ingress store brought, or merged beside such data (C9). */
function isLoose(item: Item): boolean {
  return (
    (item.reasons & REASON.external) !== 0 && (item.ingress === undefined || item.loose === true)
  );
}

function mergePair(first: Item, other: Item, ingress: IngressGraph): Item {
  const marks = marksOf([first, other]);
  const node =
    first.ingress === undefined && other.ingress === undefined
      ? undefined
      : ingress.union(first.ingress, other.ingress);
  // A `null` keeps its ingress word only while every contribution has one.
  const word =
    first.word !== undefined && other.word !== undefined
      ? (firstContext(first.word, other.word) ?? undefined)
      : undefined;
  const loose = first.loose === true || (node !== undefined && (isLoose(first) || isLoose(other)));
  // Still the rows of one unknown only when both are; still possible solely through external data only when both are.
  const fan = first.fan !== undefined && first.fan === other.fan ? first.fan : undefined;
  const extOnly = first.extOnly === true && other.extOnly === true;
  // (a kind a written type spells keeps its spelling beside an inferred one of that kind, which adds nothing to it)
  const spelling = joinSpelling(first.spelling, other.spelling);
  return {
    tag: first.tag,
    cert: marks.guarded !== true && (first.cert === "def" || other.cert === "def") ? "def" : "pos",
    reasons: first.reasons | other.reasons,
    writer: firstWriter(first.writer, other.writer),
    context: firstContext(first.context, other.context),
    ...(word === undefined ? {} : { word }),
    ...(node === undefined ? {} : { ingress: node }),
    ...(loose ? { loose: true } : {}),
    ...marks,
    ...(fan === undefined ? {} : { fan }),
    ...(extOnly ? { extOnly: true } : {}),
    ...(spelling === undefined ? {} : { spelling }),
  };
}

/** Each kind's place in a value's items: the value kinds' table order, then `unknown`, then `empty` (#1398). */
const TAG_RANK: ReadonlyMap<ItemTag, number> = new Map(
  [...VALUE_KIND_NAMES, "unknown" as const, "empty" as const].map((tag, index) => [tag, index]),
);

/**
 * The one order of a list of a value's kinds (#1398): a written spelling's where exactly one spelling
 * covers every kind of the list but `null`, `unknown` and `empty` (an inferred kind it spells adds nothing to it, as
 * G5 rules), then the others in the table's; else the table's (`TAG_RANK`), never the order the analysis met them,
 * which the consumers' and the solver's orders and the sharing change. It reads the kinds and the spellings alone, so it
 * is the same in whatever order the entries come; entries of one kind keep their order. A list is made in it (a merge, a
 * stopped answer, a finishing read) and reaches its publication through steps that keep it, and a list composed with
 * another passes here again where it is completed. A fixed table's order and a tuple by position keep their own. One
 * pass over the entries and one over the ranks, so it costs no more than the entries it is given, each already charged
 * where it was made, and it charges nothing of its own. The result is made at its length: a flattened
 * one keeps spare capacity, which the many answers kept multiply (#1625).
 */
function inOrderOf<T>(
  entries: Iterable<T>,
  kindOf: (entry: T) => ItemTag,
  spelling: Spelling | undefined,
): T[] {
  const list = [...entries];
  const order = covering(
    list.map((entry) => kindOf(entry)),
    spelling,
  );
  const rankOf =
    order === undefined
      ? (tag: ItemTag): number => TAG_RANK.get(tag)!
      : (tag: ItemTag): number => {
          const at = order.indexOf(tag);
          return at >= 0 ? at : order.length + TAG_RANK.get(tag)!;
        };
  const byRank: (T[] | undefined)[] = [];
  for (const entry of list) (byRank[rankOf(kindOf(entry))] ??= []).push(entry);
  const ordered = new Array<T>(list.length);
  let at = 0;
  for (const bucket of byRank)
    if (bucket !== undefined) for (const entry of bucket) ordered[at++] = entry;
  return ordered;
}

/** `spelling` where it covers every one of `kinds` but `null`, `unknown` and `empty` (`inOrderOf`), else none. */
export function covering(
  kinds: readonly ItemTag[],
  spelling: Spelling | undefined,
): Spelling | undefined {
  return spelling !== undefined &&
    spelling.length > 0 &&
    kinds.every(
      (tag) => tag === "null" || tag === "unknown" || tag === "empty" || spelling.includes(tag),
    )
    ? spelling
    : undefined;
}

/** The spelling a value's items join to (`joinSpelling`), `MIXED` included; none where no item has one. */
export function spellingOf(items: readonly Item[]): Spelling | undefined {
  let spelling: Spelling | undefined;
  for (const item of items) spelling = joinSpelling(spelling, item.spelling);
  return spelling;
}

/** A value's items in their one order (`inOrderOf`), by the spelling their marks join to (`spellingOf`). */
export function inItsOrder(items: Iterable<Item>): Item[] {
  const list = [...items];
  return inOrderOf(list, (item) => item.tag, spellingOf(list));
}

/** Kinds taken from a value's items, in their one order (`inOrderOf`) by the spelling that wrote them, if any. */
export function kindsInItsOrder<Kind extends ItemTag>(
  kinds: Iterable<Kind>,
  spelling: Spelling | undefined,
): Kind[] {
  return inOrderOf(kinds, (kind) => kind, spelling);
}

/** Kinds no written type spelled, in the table's order (`kindsInItsOrder` without a spelling). */
export function kindsInOrder<Kind extends ItemTag>(kinds: Iterable<Kind>): Kind[] {
  return inOrderOf(kinds, (kind) => kind, undefined);
}

/**
 * The items of one value, one per kind, in their one order (`inItsOrder`): an item is definite when one of its
 * kind is (and none is guarded); the reasons and ingress stores of all are kept, so no merge drops a boundary check
 * (C9); the earliest writer and the first context word stand for the kind (F28), but an `unknown` whose first word and
 * reasons come before every condition's takes its reasons' word (`reasonContext`); a guarded one marks the kind.
 */
export function mergeItems(items: readonly Item[], scope: ItemScope): Item[] {
  const byTag = new Map<ItemTag, Item>();
  for (const item of items) {
    scope.work.charge("mergeItems");
    const earlier = byTag.get(item.tag);
    byTag.set(item.tag, earlier === undefined ? item : mergePair(earlier, item, scope.ingress));
  }
  // (#2486: the unknown takes its reasons' word (`reasonContext`), which changes only as they grow, where its word is
  // one of the four before every condition's (`EARLY_WORDS`) and its reasons hold one of their bits: kept by the word
  // order, an earlier word outlived the reasons that gave it and went round a solver component. A condition's word,
  // `later` and no word stay as the order gives them: they name where the value comes from, and a type test hands them
  // to the kind it proves (`narrowedItems`). `budget` stays too: rewriting a word to it, which comes after every
  // condition's, would let a condition's word win a later merge that it lost before, so the merge would depend on its
  // grouping)
  const unknown = byTag.get("unknown");
  if (
    unknown !== undefined &&
    unknown.context !== null &&
    EARLY_WORDS.has(unknown.context) &&
    (unknown.reasons & EARLY_REASONS) !== 0
  ) {
    const context = reasonContext(unknown.reasons);
    if (context !== unknown.context) byTag.set("unknown", { ...unknown, context });
  }
  return inItsOrder(byTag.values());
}

/**
 * The alternatives of one read (a list's elements, an element added beside earlier ones, a value or its default),
 * merged: of two definite families neither stays definite, since a run has one of them (integers and numbers are one
 * family, ADR 0021 1.2). A `null` is no family and never decides (A8): beside one family it is a possibility.
 */
export function alternatives(items: readonly Item[], scope: ItemScope): Item[] {
  const merged = mergeItems(items, scope);
  const families = new Set<ValueKind>();
  for (const item of merged)
    if (
      item.cert === "def" &&
      item.tag !== "empty" &&
      item.tag !== "unknown" &&
      item.tag !== "null"
    )
      families.add(familyOf(item.tag));
  if (families.size > 1)
    return merged.map((item) => (item.tag === "empty" ? item : { ...item, cert: "pos" }));
  if (families.size === 1)
    return merged.map((item) => (item.tag === "null" ? { ...item, cert: "pos" } : item));
  return merged;
}

/**
 * Every item a possibility, with `context` where no word comes first; an `unknown` keeps the word it carries.
 */
export function weaken(items: readonly Item[], context: ContextWord | null = null): Item[] {
  return items.map((item) => ({
    ...item,
    cert: "pos",
    context: item.tag === "unknown" ? item.context : firstContext(item.context, context),
  }));
}

/**
 * The items as one comparable text, independent of their order, for a fixpoint's test whether a value changed. The
 * ingress stores are left out: a fixpoint member's stores grow in its cell, which every value holding it shares. An
 * item's spelling is part of it (`spellingIdentity`): differently marked items order a later list differently, so they
 * are different values (#1398).
 */
export function itemsSignature(items: readonly Item[], scope: ItemScope): string {
  scope.work.charge("sigItems", items.length + 1);
  return items
    .map((item) =>
      [
        item.tag,
        item.cert,
        item.reasons,
        item.writer === null ? "" : writerKey(item.writer),
        item.context ?? "",
        item.word ?? "",
        `${item.guarded === true ? "g" : ""}${item.called === true ? "c" : ""}${item.loose === true ? "l" : ""}${item.extOnly === true ? "e" : ""}${item.fromExternal === true ? "x" : ""}`,
        item.fan ?? "",
        spellingIdentity(item.spelling),
      ].join("|"),
    )
    .sort()
    .join(",");
}
