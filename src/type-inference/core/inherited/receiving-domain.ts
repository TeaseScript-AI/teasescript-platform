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
 * A4, the written type a copy of a written binding brings into an unwritten place
 * (docs/specifications/type-inference-accepted-record/admission.md#r4-375): its state, one per pass
 * (`CorePass.receivingDomain`), made with the pass's parts and asking nothing when made. Admission builds it
 * (`copyGraph`) and reads it (`inheritedAt`) as its client; F18 does not read it (#1072 A2). Each key's inherited type
 * is a proof of the pass's solver (`inheritedProof`); what its runs found, the keys that wait on each other and the
 * own-level bits, is the pass's too. An admission made on the pass starts the rest afresh (`reset`), as each
 * admission's own state was.
 */
export class ReceivingDomain {
  /**
   * Every field as a new domain has it, the proofs' findings kept with the solver that holds the proofs: an admission
   * made on a pass that held one before starts from none.
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

  /**
   * The keys at which a store's copy of a written binding, or of an unwritten one that may inherit a written type,
   * lands: a copy of a written binding takes its type there.
   */
  copyLandingKeys = new Set<Key>();
  /** The places those copies land in (`copyLandingKeys`), each with `openAbove`'s walk down its paths from its root. */
  copyLandingPlaces = new Map<PlaceId, OpenStep | null>();
  /** Per place, each cursor's path's step of `openAbove`'s walk (`openAboveKey`, G3 stage 1). */
  openSteps = new Map<PlaceId, Map<number, OpenStep>>();
  /** Each copy of a written binding: the place and path it lands at, and the written type it brings there. */
  writtenCopyLandings: {
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
  inheritingCopyLandings: InheritedCopy[] = [];
  /** A4 through copies (`copyGraph`): the unwritten places a copy of a written binding reaches, copy by copy. */
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
  /** G3 3a: per place and path id, where it lands past wrappers (`landedFrontier`); per place and step, its wrapper's. */
  landedFrontiers = new Map<string, { readonly place: PlaceId; readonly rest: number }>();
  landingHops = new Map<string, PlaceId | null>();
  /** Per place, its landings by first step (`landingSteps`); per walk, its stops by first step (`stopSteps`). */
  landingSteps = new Map<
    PlaceId,
    {
      readonly whole: boolean;
      readonly copies: ReadonlyMap<string, readonly InheritedCopy[]>;
      readonly deeper: ReadonlySet<string>;
    }
  >();
  stopSteps = new WeakMap<
    Stops,
    { readonly root: boolean; readonly deeper: ReadonlySet<string> }
  >();
  /** G3 3a: per place and path id, its frontier past wrappers (`wrappedFrontier`); per place and step, its wrapper's step. */
  frontiers = new Map<string, Frontier>();
  scanHops = new Map<
    string,
    { readonly binding: PlaceId; readonly read: PlaceId; readonly decl: Definition } | null
  >();
  /** Per walk, the deepest path its stops stand at (`earliestDecider`). */
  stopDepths = new WeakMap<
    Stops,
    { readonly written: number; readonly values: number; readonly literals: number }
  >();
  /** A4 through copies' landings (`inheritance`), and per place and path whether its copies land it (`landed`). */
  inherits: Inheritance | null = null;
  landedPaths = new Map<string, boolean>();
  /**
   * Per place and prefix, the paths copies land there as an earlier `landedBelow` call of this pass brought them
   * (#1428, #1547): each a pair of ranges of that call's tape, which charged emits and reports made.
   */
  listings = new Map<PlaceId, ListingNode>();
  /** Per place, the calls' results asked of it not yet kept in `listings` (`trieOf` keeps them at the first look). */
  pendingListings = new Map<PlaceId, Listing[]>();
  /** The copies places answer through (`passThrough`), once per pass. */
  forest: CopyForest | null = null;
  /** Per place, its copies' list and their index by landing path (`copyIndex`); per cycle, its members' landings by path
   * (`cycleLanding`); the cycles of whole copies by component (`membersOf`). */
  copyIndexes = new Map<
    PlaceId,
    { readonly list: readonly InheritedCopy[]; readonly index: ByPath<number> }
  >();
  cycleLandings = new WeakMap<ReadonlySet<string>, ByPath<readonly string[]>>();
  /**
   * #1948: per place and copy path, its copies there by the next step of a longer path their sources can land
   * (`nextStepCopies`); per source and strip, the steps past the strip its landings take, `null` where unproved
   * (`sourceSteps`).
   */
  nextSteps = new Map<string, NextSteps>();
  sourceSteps = new Map<string, ReadonlySet<string> | null>();
  cycleMembers: Map<number, PlaceId[]> | null = null;
  /** Per place, its seeds' paths at or below each prefix (`seedsUnder`), and its stores taken again (`#retakenOf`). */
  seedIndex = new Map<PlaceId, Map<string, string[]>>();
  /** The copies a live store makes, by place, path, source and strip (Astra's B2). */
  liveCopies = new Set<string>();
  /**
   * #2065: per prefix, its whole stores and settled stores by the first steps of the decided paths they can hold
   * (`holdersOf`), for the admission's snapshot of them.
   */
  holders = new Map<Key, PrefixHolders>();
}
