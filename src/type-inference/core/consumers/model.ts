import type { PlaceId, SourceSite, TypeTerm } from "../../graph.js";
import type { Definition, Key } from "../definitions.js";
import type { Item, ItemTag } from "../items.js";

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
 * What the stores into one key give each path below it by their syntax alone (TABLE r4.89 (2)): the types literals
 * have there (`null` among them), the written types copies bring (each from its own path on), the property names, the
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
  readonly names: Set<string>;
  /** The properties of the first object literal given here: an object literal with others makes it opaque. */
  properties: ReadonlySet<string> | null;
  first: Definition | null;
  opaque: boolean;
}

/**
 * What reaches one key and path by syntax: the shapes of the keys at and above it, there; the written types copies bring
 * there; whether every value there is told by syntax (`told`, which holds for each path below only while it holds).
 */
export interface CheapFrontier {
  readonly shapes: readonly CheapShape[];
  readonly written: readonly { readonly term: TypeTerm; readonly by: Definition }[];
  readonly told: boolean;
}

/** A cheap decider's decision of a place at a path (`Consumers.cheapDecided`). */
export interface CheapDecision {
  readonly kinds: readonly ItemTag[];
  readonly names: ReadonlySet<string>;
  readonly decider: Definition;
  readonly inherited: boolean;
}
