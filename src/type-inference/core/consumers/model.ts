import type { PlaceId, SourceSite, TypeTerm } from "../../graph.js";
import type { Definition, Key } from "../definitions.js";
import type { Item, ItemTag, Spelling } from "../items.js";

// The shapes the consumers' reaches and literal landings are made of.

/** C5b: whether a kind has the method, by the compiler's own member rules. */
/**
 * What reaches one level of a path below a key or a value (A2, ADR 0021 rule 1.1): the literals standing there, whose
 * children bring the next level; the whole copies met on the way, this level's included, and the first of them; whether
 * a value on the way is neither a copy nor a literal (`other`: what it brings is unknown); how many values stand at this
 * level itself (`here`: at a property's level, its own contributions); the elements a key's adds bring one step below
 * (`added`); and the levels below, each made once (`below`), from its literals' children indexed by step.
 */
export interface Reach {
  readonly literals: readonly PlaceId[];
  readonly copies: number;
  readonly copy: PlaceId | null;
  readonly other: boolean;
  readonly here: number;
  readonly added: readonly PlaceId[];
  readonly next: Map<string, Reach>;
  children: Map<string, PlaceId[]> | null;
}

/** A level of a place's paths (A2): what reaches it, its key, and the levels below by step. */
export interface KeyReach {
  readonly reach: Reach;
  readonly key: Key;
  readonly next: Map<string, KeyReach>;
}

/**
 * Where a literal lands (A2): the place, the node above (a literal's own landing) and the step below it, the key path
 * made once when first asked, and the nodes below by step, so sibling literals at one step share one node.
 */
export interface Landing {
  readonly id: number;
  readonly place: PlaceId;
  readonly above: Landing | null;
  readonly step: string;
  path: readonly string[] | null;
  readonly below: Map<string, Landing>;
}

/** A mixed literal's question at a landing and a path below it (A2), answered once for every element that asks it. */
export interface LandingQuestion {
  readonly path: readonly string[];
  readonly copiesOnly: boolean;
  first: SourceSite | null | undefined;
  into: string | null;
}

/** A member check's offending kind beside the default one: its item, its `on` words. */
export type Offending = readonly [Item, string];

/**
 * What the stores into one key give each path below it by their syntax alone: the types literals
 * have there (`null` among them), the written types copies bring (each from its own path on), the
 * earliest store that gives a type there, and whether a store gives it a value its syntax does not tell (`opaque`).
 */
export interface CheapShape {
  readonly tags: Set<ItemTag>;
  readonly written: {
    readonly term: TypeTerm;
    readonly path: readonly string[];
    readonly by: Definition;
  }[];
  readonly children: Map<string, CheapShape>;
  /** The properties of the first object literal given here: an object literal with others makes it opaque. */
  properties: ReadonlySet<string> | null;
  first: Definition | null;
  opaque: boolean;
  /**
   * The copies of inferred places stored here (#1604): each copies its source's own syntax there, from its path on,
   * read through the source's frontier (`cheapFrontier`), its types given by the store that copies.
   */
  readonly copies: {
    readonly root: PlaceId;
    readonly path: readonly string[];
    readonly by: Definition;
  }[];
}

/**
 * What reaches one key and path by syntax: the shapes of the key's own stores and of the keys above it, there; the
 * written types copies of written places bring there; the frontiers of the inferred places copied there (`links`), each
 * by reference with the earliest store that copies it, once a source, so no source's shapes are copied into another's
 * (#1604); whether every value there is told by syntax (`told`, which holds for each path below only while it holds).
 */
export interface CheapFrontier {
  readonly shapes: readonly CheapShape[];
  readonly written: readonly { readonly term: TypeTerm; readonly by: Definition }[];
  readonly links: readonly {
    readonly root: PlaceId;
    readonly path: readonly string[];
    readonly by: Definition;
    readonly frontier: CheapFrontier;
  }[];
  readonly told: boolean;
  /** The longest chain of copies of inferred places it follows (`Infinity` where one passed the bound, #1604). */
  readonly reach: number;
}

/** A cheap decider's decision of a place at a path (`Consumers.cheapDecided`). */
export interface CheapDecision {
  readonly kinds: readonly ItemTag[];
  /** The written spelling that orders the kinds, where one covers them (`covering`, #1398). */
  readonly spelling?: Spelling;
  readonly decider: Definition;
  readonly inherited: boolean;
}

/**
 * How deep in copies (`FRONTIER_DEPTH`) and how many copies met (`FRONTIER_COPIES`: each copy standing at a frontier's
 * path, each time it is met, and each single copy a frontier is followed through, `sameOf`) a read's host data is followed
 * before the read answers its place's component's: each read's walk is then bounded by a constant, so the finishing reads' work stays linear
 * in the program by construction, whatever the copy graph's shape. Where the walk is cut, the read answers the host
 * data its place's component of the place-level copy graph reaches (`placeIngress`): every path, so a superset, never a
 * dropped check. Measured with this walk over the stop corpus (170 sources), the repository's scripts (19) and the held
 * family (480), at sampled settled stops in two orders: of 9,933 finishing reads, 9,722 end at their own frontier (depth
 * 0), 179 one copy deep and 32 two; no read meets more than 7 copies (2,096 none, 4,304 one, 2,162 two, 694 three, 677
 * four to seven). At 2 and 8, 15 reads are cut (the family's rings), each naming the same writers as its exact walk, so
 * the cut adds no mark, warning, runtime check or boundary there. `FRONTIER_COPIES` also bounds the chain of copies of
 * inferred places the stores' syntax follows from a key (`consumers/syntax.ts`, #1604): past it the key is not told by
 * syntax, so a read answers its later sources or `STOPPED`, never a dropped check. Chains past it occur only in generated
 * or constructed families (the areas: 339 of 45,796 measured sources, to 1,025; the 15,406-source set: 9, to 17), and
 * the walk recurses once a link, so a chain of a thousand copies followed whole overflows the native stack (#1664).
 */
export const FRONTIER_DEPTH = 2;
export const FRONTIER_COPIES = 8;
