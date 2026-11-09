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

/**
 * A4, the written type a copy of a written binding brings into an unwritten place (r4.75 (1), TABLE r4.375): its state, one
 * per pass (`CorePass.receivingDomain`), made with the pass's parts and asking nothing when made. Admission builds it
 * (`copyGraph`) and reads it (`inheritedAt`) as its client; the F18 receiving domain is read from it in a later step
 * (#1072 A2). An admission made on the pass starts it afresh (`reset`), as each admission's own state was.
 */
export class ReceivingDomain {
  /** Every field as a new domain has it: an admission made on a pass that held one before starts from none. */
  public reset(): void {
    Object.assign(this, new ReceivingDomain());
  }

  a4Keys = new Set<Key>();
  /** The places `a4Keys` lands copies in, each with `openAbove`'s walk down its paths from its root. */
  a4Places = new Map<PlaceId, OpenStep | null>();
  /** Per place, each cursor's path's step of `openAbove`'s walk (`openAboveKey`, G3 stage 1). */
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
    }[]
  >();
  /** The copies of places that may inherit a written type (`inheriting`), where they land. */
  a4Inherits: InheritedCopy[] = [];
  /** A4 through copies (`copyGraph`): the unwritten places a copy of a written binding reaches, copy by copy. */
  inheriting = new Set<PlaceId>();
  /** Per unwritten place and path, the written type its own decision copies there (`inheritedAt`), or none. */
  inherited = new Map<CanonicalKey, TypeTerm | null>();
  /**
   * #1901: per such path, whether the copy that decides it reads its written type at its own root (a scalar copy
   * stored at the path) rather than below it (a collection's element). Written beside `inherited`; propagated by the
   * inheritance pass and read by both decider paths for diagnostic descriptions. Decision outcomes do not consume it.
   */
  inheritedOwn = new Map<CanonicalKey, boolean>();
  /** The places and paths whose decisions wait on each other through copies, by cycle (`cut`): a union-find. */
  cycles = new Map<CanonicalKey, CanonicalKey>();
  /** Each cycle's size, by its root (`cycleOf`). */
  cycleSizes = new Map<CanonicalKey, number>();
  /**
   * The deepest path a written type can reach through copies (`inheritedAt`): the written copies' landing paths with
   * their types' element levels, and every copy of an inheriting place's own landing path beside them.
   */
  reach = 0;
  /** Per written type, its element levels (`levelsOf`). */
  termLevels = new Map<TypeTerm, readonly TypeTerm[]>();
  resolving = false;
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
