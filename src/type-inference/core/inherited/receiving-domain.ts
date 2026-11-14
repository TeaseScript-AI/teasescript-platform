import type { PlaceId, TypeTerm } from "../../graph.js";
import type {
  ByPath,
  CopyForest,
  Frontier,
  Inheritance,
  InheritedCopy,
  Listing,
  ListingNode,
  NextSteps,
  OpenStep,
  Stops,
} from "../admission/model.js";
import type { PrefixHolders } from "../admission/holders.js";
import type { CanonicalKey } from "../contract/key-ids.js";
import type { Definition, Key } from "../definitions.js";
import type { Proof, ProofDemand } from "../solver.js";

/**
 * The written type a copy of a written binding brings into an unwritten place
 * (docs/specifications/type-inference-accepted-record/admission.md#r4-375): its state, one per pass, made with the
 * pass's parts and asking nothing when made. Each key's inherited type is a proof of the pass's solver
 * (`inheritedProof`); what its runs found, the keys that wait on each other and the own-level bits, is the pass's too.
 */
export class ReceivingDomain {
  /**
   * Every field as a new domain has it, but the proofs' findings (`cycles`, `cycleSizes`, `inheritedOwn`, `joins`,
   * `joinsSettled`), kept as long as the solver that holds the proofs: an admission made on a pass that held one
   * before starts the rest afresh.
   */
  public reset(): void {
    const { cycles, cycleSizes, inheritedOwn, joins, joinsSettled } = this;
    Object.assign(this, new ReceivingDomain(), {
      cycles,
      cycleSizes,
      inheritedOwn,
      joins,
      joinsSettled,
    });
  }

  /**
   * A key's inherited proof by its demand's key, as the admission made on the pass makes it (`inheritedProofOf`), for a
   * replay of the demands the pass settled; `null` before an admission is made.
   */
  replayProof: ((key: string) => ProofDemand<Proof>) | null = null;

  a4Keys = new Set<Key>();
  /** The places `a4Keys` lands copies in, each with `openAbove`'s walk down its paths from its root. */
  a4Places = new Map<PlaceId, OpenStep | null>();
  /** Per place, each cursor's path's step of `openAbove`'s walk (`openAboveKey`). */
  openSteps = new Map<PlaceId, Map<number, OpenStep>>();
  a4Copies: {
    readonly place: PlaceId;
    readonly path: readonly string[];
    readonly term: TypeTerm;
  }[] = [];
  copies = new Map<
    PlaceId,
    readonly {
      readonly path: readonly string[];
      readonly binding: PlaceId;
      readonly strip: readonly string[];
      readonly cellsLive: boolean;
      readonly literal: boolean;
    }[]
  >();
  /** The copies of places that may inherit a written type (`inheriting`), where they land. */
  a4Inherits: InheritedCopy[] = [];
  /** The unwritten places a copy of a written binding reaches, copy by copy. */
  inheriting = new Set<PlaceId>();
  /**
   * #1901: per unwritten place and path, whether the copy that decides it reads its written type at its own root (a
   * scalar copy stored at the path) rather than below it (a collection's element): its finished proof's, as a read of it
   * finds it (`inheritedProof`); read by both decider paths for diagnostic descriptions. Decision outcomes do not
   * consume it.
   */
  inheritedOwn = new Map<CanonicalKey, boolean>();
  /**
   * The places and paths whose decisions wait on each other through copies, by cycle (`cut`): a union-find, two joined
   * where one's proof reads the other's while their component is solved.
   */
  cycles = new Map<CanonicalKey, CanonicalKey>();
  /** Each cycle's size, by its root (`join`). */
  cycleSizes = new Map<CanonicalKey, number>();
  /**
   * Each join of `cycles`, with the demand key of the proof whose read made it: a join stands while that proof is
   * finished in the solver, and `cycles` is made again from those that stand after a run stops or the solver forgets
   * (`settleCycles`).
   */
  joins: { readonly reader: string; readonly a: CanonicalKey; readonly b: CanonicalKey }[] = [];
  /** The solver's `forgets` when `cycles` was last made again from `joins`. */
  joinsSettled = 0;
  /**
   * The deepest path a written type can reach through copies (`inheritedAt`): the written copies' landing paths with
   * their types' element levels, and every copy of an inheriting place's own landing path beside them.
   */
  reach = 0;
  /** Per written type, its element levels (`levelsOf`). */
  termLevels = new Map<TypeTerm, readonly TypeTerm[]>();
  /** Per place and path id, where it lands past wrappers (`landedFrontier`). */
  landedFrontiers = new Map<string, { readonly place: PlaceId; readonly rest: number }>();
  /** Per place and step, its wrapper's step as `landed` reads it (`landingHop`). */
  landingHops = new Map<string, PlaceId | null>();
  /** Per place, its landings by first step (`landingSteps`). */
  landingSteps = new Map<
    PlaceId,
    {
      readonly whole: boolean;
      readonly copies: ReadonlyMap<string, readonly InheritedCopy[]>;
      readonly deeper: ReadonlySet<string>;
    }
  >();
  /** Per walk, its stops by first step (`stopSteps`). */
  stopSteps = new WeakMap<
    Stops,
    { readonly root: boolean; readonly deeper: ReadonlySet<string> }
  >();
  /** Per place and path id, its frontier past wrappers (`wrappedFrontier`). */
  frontiers = new Map<string, Frontier>();
  /** Per place and step, its wrapper's step as the earliest contribution's scan reads it (`scanHop`). */
  scanHops = new Map<
    string,
    { readonly binding: PlaceId; readonly read: PlaceId; readonly decl: Definition } | null
  >();
  /** Per walk, the deepest path its stops stand at (`earliestDecider`). */
  stopDepths = new WeakMap<
    Stops,
    { readonly written: number; readonly values: number; readonly literals: number }
  >();
  /** Where copies of written types land (`inheritance`). */
  inherits: Inheritance | null = null;
  /** Per place and path, whether its copies land it (`landed`). */
  landedPaths = new Map<string, boolean>();
  /**
   * Per place and prefix, the paths copies land there as an earlier `landedBelow` call of this pass brought them
   * (#1428, #1547): each a pair of ranges of that call's tape, which charged emits and reports made.
   */
  listings = new Map<PlaceId, ListingNode>();
  /** Per place, the calls' results asked of it not yet kept in `listings`. */
  pendingListings = new Map<PlaceId, Listing[]>();
  /** The copies places answer through (`passThrough`), once per pass. */
  forest: CopyForest | null = null;
  /** Per place, its copies' list and their index by landing path (`copyIndex`). */
  copyIndexes = new Map<
    PlaceId,
    { readonly list: readonly InheritedCopy[]; readonly index: ByPath<number> }
  >();
  /** Per cycle, its members' landings by path (`cycleLanding`). */
  cycleLandings = new WeakMap<ReadonlySet<string>, ByPath<readonly string[]>>();
  /**
   * #1948: per place and copy path, its copies there by the next step of a longer path their sources can land
   * (`nextStepCopies`).
   */
  nextSteps = new Map<string, NextSteps>();
  /** #1948: per source and strip, the steps past the strip its landings take, `null` where unproved (`sourceSteps`). */
  sourceSteps = new Map<string, ReadonlySet<string> | null>();
  /** The cycles of whole copies by component (`membersOf`). */
  cycleMembers: Map<number, PlaceId[]> | null = null;
  /** Per place, its seeds' paths at or below each prefix (`seedsUnder`). */
  seedIndex = new Map<PlaceId, Map<string, string[]>>();
  /** The copies a live store makes, by place, path, source and strip. */
  liveCopies = new Set<string>();
  /**
   * #2065: per prefix, its whole stores and settled stores by the first steps of the decided paths they can hold
   * (`holdersOf`), for the admission's snapshot of them.
   */
  holders = new Map<Key, PrefixHolders>();
}
