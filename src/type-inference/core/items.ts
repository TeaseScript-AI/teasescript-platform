import { familyOf, type ValueKind } from "../../value-kinds.js";
import type { SourceSite } from "../graph.js";
import type { WorkLedger } from "./budget.js";

/**
 * The items of the coarse core (checkpoint 9, TABLE §1): what the analysis knows of a value at a read. A value is a
 * list of items, one per kind. An item is one kind with a certainty (`def`: every run that reaches the read has a value
 * of this kind; `pos`: some run may), the reasons of an `unknown`, one writer that explains it (F28) and one context
 * word (§3.4). Some items also carry the ingress stores of external data (C9), the guard mark (§3.2) or the identity of
 * the one unknown operand whose operator rows they stand for (§4 r4.14).
 */

/**
 * A kind an item can have: a value kind, `unknown` (a value the core does not model, with its reasons), or `empty`, the
 * mark that an element read may find no element on some run (TABLE §1, M `open`).
 */
export type ItemTag = ValueKind | "unknown" | "empty";

export type Certainty = "def" | "pos";

/**
 * Why a value is `unknown` (TABLE §1): host data, a typeless load or `fromJson` (`external`); a reference's member or an
 * operation the core does not model (`opaque`); a parameter with several call sites (`deferred`); a source of a record
 * without the property (`missing`); a demand over its allowance (`budget`, B1). An item holds a set of them as bits.
 */
export const REASON = { external: 1, opaque: 2, deferred: 4, missing: 8, budget: 16 } as const;

/**
 * The context words in the order a warning names the first (§3.4): the words of §3's steps 1 and 2, which are decided
 * first, then those of the exact path's conditions X1 to X7, then A7's `later`.
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
] as const;

export type ContextWord = (typeof CONTEXT_WORDS)[number];

/** A store that explains an item (F28): its kind and its site; the record writes it `kind@file:offset`. */
export interface Writer extends SourceSite {
  readonly kind: string;
}

/**
 * The ingresses of external data that an item holds (C9), as a shared graph: a leaf names one ingress, by its own
 * expression's writer (S6-CARRIERS §3.1: the store that brought it is a fact of admission's walk, not the value side's),
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
  /** The word of a `null` that stands beside external data (a typeless load's `default: null`, §3.4 r4.11). */
  readonly word?: ContextWord;
  readonly ingress?: IngressNode;
  /** External data that no ingress store brought, merged beside some that one did (C9). */
  readonly loose?: true;
  /**
   * The guard mark: the value was read under a test of its path, so no consumer errs on it (§3.2). An item made from
   * others takes it from them through `marksOf`, as it takes `called`.
   */
  readonly guarded?: true;
  /**
   * The value came through a call: a parameter's or a result's (F20–F22), travelling as the guard mark does. A dead call
   * binds nothing (F21), so in dead code such a kind may lack the marks its call would give: there it is never definite
   * (AD-3).
   */
  readonly called?: true;
  /** The unknown operand, by `fanIdentity`, whose operator rows this item is one of (§4 r4.14). */
  readonly fan?: string;
  /**
   * An operation's result kind that every combination giving it holds external data in: possible solely through
   * external data, so no internal contribution admits it (A2, A3 r4.36, r4.37).
   */
  readonly extOnly?: true;
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
 * The marks an item made from others takes from them: the guard mark where one of them is guarded (§3.2), and the
 * through-a-call flag where one came through a call (AD-3). Every item rebuilt from others takes its marks here (the
 * merge of one kind, an operator's rows, `carried`'s transfers, a written domain's kinds, a step below an unknown), so
 * the two travel together.
 */
export function marksOf(from: readonly Item[]): {
  readonly guarded?: true;
  readonly called?: true;
} {
  return {
    ...(from.some((each) => each.guarded === true) ? { guarded: true as const } : {}),
    ...(from.some((each) => each.called === true) ? { called: true as const } : {}),
  };
}

/** The mark of an element read that may find no element (TABLE §1 M): not a value, so no consumer checks it. */
export const EMPTY: Item = Object.freeze(makeItem("empty"));

/** The identity of a writer, as `kind@file:offset` with the file's index. */
export function writerKey(writer: Writer): string {
  return `${writer.kind}@${writer.file}:${writer.start}`;
}

/** The identity of an unknown operand in an operation (§4 r4.14): its writer's, or else the operation's site. */
export function fanIdentity(writer: Writer | null, operation: SourceSite): string {
  return writer === null ? `op@${operation.file}:${operation.start}` : writerKey(writer);
}

function contextRank(context: ContextWord | null): number {
  return context === null ? CONTEXT_WORDS.length : CONTEXT_WORDS.indexOf(context);
}

/** Of two context words, the one a warning names first (§3.4); no word comes last. */
export function firstContext(a: ContextWord | null, b: ContextWord | null): ContextWord | null {
  return contextRank(b) < contextRank(a) ? b : a;
}

/**
 * The word of one unknown's reasons (TABLE §1 r4.23): the first present in the rank `external` (`unknown`), `opaque`
 * (`unmodelled`), `deferred` (`deferred-parameter`), `missing` (`missing`); `budget` comes last and has no word of its
 * own yet (B1, the budget's fallback), nor has an unknown without reasons: both say `unknown`.
 */
export function reasonContext(reasons: number): ContextWord {
  if ((reasons & REASON.external) !== 0) return "unknown";
  if ((reasons & REASON.opaque) !== 0) return "unmodelled";
  if ((reasons & REASON.deferred) !== 0) return "deferred-parameter";
  if ((reasons & REASON.missing) !== 0) return "missing";
  return "unknown";
}

/**
 * The word an item brings where words meet: an unknown its reasons' word, whatever word it carries, since its reasons
 * name it (TABLE §1) and come before any condition's word (§3.4); any other item its own word.
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
    return { id: this.#next++, contents: null };
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
  };
}

/**
 * The items of one value, one per kind: an item is definite when one of its kind is (and none is guarded); the reasons
 * and ingress stores of all are kept, so no merge drops a boundary check (C9); the earliest writer and the first context
 * word stand for the kind (F28, §3.4); a guarded one marks the kind (§3.2). Kinds keep the order of their first item.
 */
export function mergeItems(items: readonly Item[], scope: ItemScope): Item[] {
  const byTag = new Map<ItemTag, Item>();
  for (const item of items) {
    scope.work.charge("mergeItems");
    const earlier = byTag.get(item.tag);
    byTag.set(item.tag, earlier === undefined ? item : mergePair(earlier, item, scope.ingress));
  }
  return [...byTag.values()];
}

/**
 * The alternatives of one read (a list's elements, an element added beside earlier ones, a value or its default),
 * merged: of two definite families neither stays definite, since a run has one of them (integers and numbers are one
 * family, ADR 0021 1.2). A `null` is no family and never decides (A8 r4.13): beside one family it is a possibility.
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
 * Every item a possibility, with `context` where no word comes first; an `unknown` keeps its own word, the reason's,
 * which comes before any condition's (§3.4).
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
 * ingress stores are left out: a fixpoint member's stores grow in its cell, which every value holding it shares.
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
        `${item.guarded === true ? "g" : ""}${item.called === true ? "c" : ""}${item.loose === true ? "l" : ""}${item.extOnly === true ? "e" : ""}`,
        item.fan ?? "",
      ].join("|"),
    )
    .sort()
    .join(",");
}
