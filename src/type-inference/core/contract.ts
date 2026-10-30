import type { PlaceId, TypeTerm } from "../graph.js";
import type { CorePass } from "./answers.js";
import { countApart, keep, textUnits, type WorkLedger } from "./budget.js";
import {
  aliasWriter,
  boundClass,
  classMixed,
  classOf,
  classWriters,
  readClass,
  readSnapshot,
} from "./contract/classes.js";
import { gathered } from "./contract/gather.js";
import {
  choiceKeysStored,
  copiedKey,
  identityOf,
  identityWork,
  keyIdentity,
  keyIdentityWork,
  resultKey,
  structureOf,
  structureWork,
} from "./contract/identity.js";
import { entered, ingressOf } from "./contract/ingress.js";
import {
  contractOf,
  contractRead,
  keyContract,
  keyListsAt,
  literalRoute,
  receiverKinds,
  refReceiver,
  severalElements,
  subAt,
  valueReceiver,
} from "./contract/key-contract.js";
import { entryAt } from "./contract/levels.js";
import {
  heldBelow,
  indexWork,
  kindsPart,
  literalIndex,
  literalSignature,
  loneRead,
  namesPart,
  pathDepth,
  pathIdOf,
  pathLast,
  pathParent,
  pathStep,
  pathSteps,
  signatureWork,
  standsAlong,
} from "./contract/literal-index.js";
import { contractOfLiteral, indexItems } from "./contract/literal-items.js";
import type { Label } from "./contract/labels.js";
import { wrapperShape, type KeyLane } from "./contract/lanes.js";
import { newHolder } from "./contract/marks.js";
import type {
  ChainRoot,
  ChoiceGroup,
  ClassGroup,
  ContractFacts,
  CopyRing,
  EntryDraft,
  EntryGroup,
  GatherSite,
  Holder,
  Identity,
  IdentityWork,
  IndexNode,
  KeptClass,
  LevelGroup,
  LiteralIndex,
  LiteralObject,
  LoneRead,
  NodeShape,
  OtherGroup,
  PrefixEntry,
  PrefixFrame,
  PrefixLevels,
  PrefixStores,
  ReadClass,
  ReadClassGroup,
  ReadEntry,
  ReadGroup,
  Selection,
  StepLayers,
  StoppedKey,
  StoredChoiceKeys,
  StoredClass,
  SubLayer,
  SubSource,
  ValueEntry,
  WrapperHop,
} from "./contract/model.js";
import { choiceOptions, plusRepeatOf } from "./contract/others.js";
import { chainOf, literalHop, remember } from "./contract/positions.js";
import { prefixStores, prefixWork, relevantSubs, subSources } from "./contract/prefix-index.js";
import {
  contractOfValue,
  contractOfValueAt,
  defaultKinds,
  expectedOf,
  landsIn,
  memberStepOf,
  onlyNull,
} from "./contract/value-kinds.js";
import {
  keyOf,
  keptPath,
  keyPath,
  keyPlace,
  sortCost,
  type Definition,
  type Key,
} from "./definitions.js";
import type { Callable, FlowNode } from "./flow-graph.js";
import type { ContextWord, IngressNode, Item, Writer } from "./items.js";
import type { ValueConstraint } from "./program.js";
import type { Work } from "./solver.js";
import type { ReadRoute } from "./values.js";
export { choiceItems, choiceLabels, WIDE } from "./contract/choices.js";
export {
  carried,
  emptyAt,
  heldReference,
  hostAt,
  ingressNull,
  MEMBER_KINDS,
  ONLY_NULL,
  OPAQUE_MEMBER,
  OWN_SELECTION,
  propertyOnly,
  REFERENCE,
  typedDefault,
  unknownItem,
} from "./contract/kinds.js";
export type {
  ChainRoot,
  ChoiceGroup,
  ChoicePart,
  ContractFacts,
  GatherSite,
  IndexNode,
  KeptClass,
  LiteralIndex,
  LoneRead,
  PrefixStores,
  StoppedKey,
  StoredChoiceKeys,
  SubSource,
  TypeAt,
  ValueClass,
  WrapperHop,
} from "./contract/model.js";
export { operatorOf, plusElements } from "./contract/operations.js";
export {
  conversionKind,
  defaultOf,
  termAt,
  typeTags,
  writtenOf,
  writtenTypeSteps,
} from "./contract/terms.js";
export { withOwnSelection } from "./contract/value-kinds.js";

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
 * A public method whose body lives in `contract/` delegates to the function of its name there; the members those
 * functions read are public for them, and internal to the contract side.
 */
export class Contract {
  readonly facts: ContractFacts = {
    prefixEntries: 0,
    literalEntries: 0,
    markNodes: 0,
    markVisits: 0,
    selectionVisits: 0,
    decidedPaths: 0,
    ringComponents: 0,
    ringPorts: 0,
    ringStops: 0,
  };
  readonly prefix = new Map<Key, PrefixStores>();
  /** Per copy-only place its copies reach, the cycle of whole copies it is a port of, `null` for none (`ringOf`). */
  readonly rings = new Map<PlaceId, CopyRing | null>();
  /** The prefixes under discovery (`prefixWork`), each by its frame, so a query reaching one again reads it as it stands. */
  readonly discovering = new Map<Key, PrefixFrame>();
  readonly subPaths = new Map<Key, ReadonlySet<string>>();
  /**
   * Per relative path of a source's own live keys, the sources holding it (`ownPaths`); per prefix and step, its
   * layers there (`stepLayers`).
   */
  readonly subsByPath = new Map<string, Set<Key>>();
  readonly stepLayers = new WeakMap<PrefixStores, Map<string, StepLayers>>();
  readonly aliasLayers = new WeakMap<PrefixStores, SubLayer | null>();
  readonly projectedLayers = new Map<string, SubLayer | null>();
  readonly keys = new Map<Key, Identity>();
  readonly identities = new Map<PlaceId, Identity>();
  readonly aliases = new Map<PlaceId, { readonly key: Key; readonly guarded: boolean }>();
  readonly holders = new Map<string, Holder>();
  readonly literals = new Map<PlaceId, LiteralIndex>();
  /** The literals whose index is being built, each its own cycle's stop (`own`). */
  readonly indexing = new Set<PlaceId>();
  /** Per literal, path, selected key, depth and side, the objects a selection reads (`selectionObjects`). */
  readonly selections = new Map<string, readonly LiteralObject[]>();
  /** Per literal, path, selected key, depth and side, its objects by their names (`selectionOf`). */
  readonly selectionsOf = new Map<string, Selection>();
  /** Per selected cell and per binding read there, the names it holds, or `null` (`heldNames`). */
  readonly heldNamesOf = new Map<PlaceId, ReadonlySet<string> | null>();
  readonly bindingNamesOf = new Map<PlaceId, ReadonlySet<string> | null>();
  /** Per cell, the class of what it stores on either side (`storedClass`), and per class's text, its name. */
  readonly storedClasses = [
    new Map<PlaceId, StoredClass | null>(),
    new Map<PlaceId, StoredClass | null>(),
  ];
  readonly storedNames = new Map<string, string>();
  /**
   * The paths of the literal indexes, each made once per pass (TABLE r4.58) as it is first asked: a path is its parent's
   * and one step, keeping that step alone, never its whole text; its id orders and names it in a literal's signature
   * and structure. The empty path is id 0.
   */
  readonly pathParents: number[] = [-1];
  readonly pathDepths: number[] = [0];
  readonly pathLastSteps: string[] = [""];
  readonly pathChildren: (Map<string, number> | undefined)[] = [];
  /**
   * G3 stage 1 (`key-ids.ts`): per path, made with it from its parent's in constant work, its first step and the
   * nearest path at or above it whose last step a built-in value answers (`memberStep`), 0 for none.
   */
  readonly pathFirstSteps: string[] = [""];
  readonly pathMembers: number[] = [0];
  /** What the key cursors' conversions made, by place and path (`keyOfId`), and by path (`stepsOfId`). */
  readonly keyTexts = new Map<PlaceId, Map<number, Key>>();
  readonly pathStepLists = new Map<number, readonly string[]>();
  /** Per place, its own label's recipe, the root of its labels' recipes (`labels.ts`). */
  readonly labelRoots = new Map<PlaceId, Label>();
  readonly signatures = new Map<PlaceId, string>();
  /** A carrier value's identity by its shape (`identityWork`), interned; a plain literal's (`signatureWork`). */
  readonly carrierIds = new Map<string, string>();
  readonly literalIds = new Map<string, string>();
  /** The shapes of literal indexes' nodes (`nodeShape`), interned. */
  readonly #nodeShapes = new Map<string, string>();
  /** Per read, its snapshot (`readSnapshot`). */
  readonly snapshots = new Map<PlaceId, string>();
  /** Per value, its read class on the contract side and on the value side (`readClass`). */
  readonly readClasses = [new Map<PlaceId, ReadClass>(), new Map<PlaceId, ReadClass>()];
  /** Per read of a stable binding, its class across bindings on the contract side and the value side (`boundClass`). */
  readonly boundClasses = [new Map<PlaceId, KeptClass>(), new Map<PlaceId, KeptClass>()];
  /** Per read, the one definition of its stable binding on the contract side and the value side (`stableDefinition`). */
  readonly stableDefinitions = [
    new Map<PlaceId, Definition | null>(),
    new Map<PlaceId, Definition | null>(),
  ];
  /** Per value, its class on the contract side and on the value side (`classOf`); per class text, its short name. */
  readonly valueClasses = [new Map<PlaceId, KeptClass>(), new Map<PlaceId, KeptClass>()];
  readonly classIds = new Map<string, string>();
  /** Per value, its roles' writers on the contract side and on the value side (`classWriters`), where asked. */
  readonly classWritersBySide = [
    new Map<PlaceId, readonly (Writer | null)[] | null>(),
    new Map<PlaceId, readonly (Writer | null)[] | null>(),
  ];
  /** Per literal's list of computed values at a path, its groups on the contract side and the value side (`othersAt`). */
  readonly otherGroups = [
    new WeakMap<readonly ValueEntry[], readonly OtherGroup[]>(),
    new WeakMap<readonly ValueEntry[], readonly OtherGroup[]>(),
  ];
  /** Per literal's list of reads at a path, its groups for the contract's gather and the value side's (`readGroupsAt`). */
  readonly readClassGroups = [
    new WeakMap<readonly ReadEntry[], readonly ReadClassGroup[]>(),
    new WeakMap<readonly ReadEntry[], readonly ReadClassGroup[]>(),
  ];
  /** Per literal path's computed values on either side (`othersAt`), its computed-key loads below their root. */
  readonly loadsBelowOf = new WeakMap<readonly OtherGroup[], readonly Item[]>();
  /** Per group of a mixed class (`othersAt`), the leaves its other members name by role (`othersLeaves`), or `null`. */
  readonly othersLeavesOf = new WeakMap<ClassGroup<ValueEntry>, IngressNode | null>();
  /** Per value and side, the leaves it names by role in its class (`leafRoles`). */
  readonly leafRolesOf = [
    new Map<PlaceId, readonly IngressNode[] | null>(),
    new Map<PlaceId, readonly IngressNode[] | null>(),
  ];
  /**
   * #1203: per literal path's computed values on either side that hold classes of computed-key loads (`othersAt`),
   * the classes a read below their root takes: in order, those of computed-key loads as one `null` where the first of
   * them stands, which answer there together (`loadsBelow`), so no read passes them one by one.
   */
  readonly othersBelowOf = new WeakMap<readonly OtherGroup[], readonly (OtherGroup | null)[]>();
  /** Per choice, the options its answer reads on the contract side and on the value side (`choiceOptions`). */
  readonly choiceOptionsBySide = [
    new Map<PlaceId, readonly ChoiceGroup[]>(),
    new Map<PlaceId, readonly ChoiceGroup[]>(),
  ];
  /** Per `+`, its place in its run of terms on the contract side and on the value side (`plusRepeatOf`). */
  readonly plusRuns = [
    new Map<PlaceId, { readonly third: PlaceId | null; readonly at: number }>(),
    new Map<PlaceId, { readonly third: PlaceId | null; readonly at: number }>(),
  ];
  /** Each value's structure identity (`structureOf`), and its interned shapes. */
  readonly structures = new Map<PlaceId, string>();
  readonly #structureIds = new Map<string, string>();
  /** The structures that hold a carrier whose operand read is marked below it (`guardsBelow`): no level's members. */
  readonly markedStructures = new Set<string>();
  /** A literal's sub-structure below each path, and what stands at each path itself (`levelsOf`). */
  readonly literalLevels = new Map<
    PlaceId,
    { readonly below: ReadonlyMap<number, string>; readonly at: ReadonlyMap<number, string> }
  >();
  /** A prefix's literal entries grouped at each path below it (`groupsAt`), per prefix and path. */
  readonly levelGroups = new Map<string, readonly LevelGroup[]>();
  readonly levelBases = new Map<Key, PrefixLevels>();
  /** A prefix's entries that answer by themselves, in groups of one class (`entryGroups`). */
  readonly entryGroupsOf = new WeakMap<PrefixLevels, readonly EntryGroup[]>();
  readonly groups = new WeakMap<
    readonly unknown[],
    Map<Key, { readonly byCallable: Map<Callable | null, ReadGroup>; readonly list: ReadGroup[] }>
  >();
  readonly lands = new Map<string, TypeTerm | null>();
  placeKeys: Map<PlaceId, Key[]> | null = null;
  storedChoiceKeys: StoredChoiceKeys | null = null;
  subFirst: Map<PlaceId, Set<string>> | null = null;
  collected = false;

  /** The value-side literal reads that passed an element step over a copy, by literal, path and node (F12). */
  readonly overCopy = new Set<string>();

  /** The paths whose admission decision stopped at its demand allowance, by place (`stop`). */
  readonly #stopped = new Map<PlaceId, (readonly string[])[]>();
  #stoppedCount = 0;
  /** The demands whose runs asked whether a key stopped, by place, with the keys they asked (`#asked`, `stop`). */
  readonly #askers = new Map<PlaceId, Map<string, Set<Key>>>();
  /**
   * The demands of the property and index reads' occurrence answers and of the positions (`positions.ts`) made since the
   * last stop (`contractOfValue`, `stop`).
   */
  readonly occurrences: string[] = [];
  /** Per holder, whether it marks no path whatever the path (`marksNothing`), and its finding while its component is open. */
  readonly quiet = new Map<Holder, boolean>();
  readonly pendingQuiet = new Map<Holder, boolean>();
  /**
   * Per binding and step, its wrapper's step or `null` (`wrapperShape`), and those being found; per literal and step its
   * read (`literalHop`).
   */
  readonly hops = new Map<string, WrapperHop | null>();
  readonly shaping = new Set<string>();
  /** Per binding and first step, the lane its keys take this pass (`keyLane`). */
  readonly lanes = new Map<PlaceId, Map<string, KeyLane>>();
  /** How many computations of the identity layer and collections of marks are running (`settle`, `collectMarks`). */
  building = 0;
  /** Per projection, the key it copies, or `null` (`copiedKey`). */
  readonly copiedKeys = new Map<PlaceId, Key | null>();
  /** Per value, its chain of property reads of a read, or `null` (`chainOf`). */
  readonly chains = new Map<PlaceId, ChainRoot | null>();
  readonly literalHops = new Map<string, LoneRead | null>();

  public constructor(readonly pass: CorePass) {}

  /**
   * TABLE B1, S3 §5: an admission decision that stopped at its demand allowance leaves its key's contract `unknown` with
   * the reason `budget` for every read, and every key's below it: `contractOf` and every value read of such a key
   * (`Values.keyItems`) answer `STOPPED` before their memo, so whatever reads it, directly or composed, carries it. The
   * pass in which a decision stops is not settled (TABLE r4.180): the next starts with the key stopped (`analyseCore`),
   * so no result read the key before its stop, in any order. An answer the solver kept before the stop read the key if
   * its run asked whether the key, or one below it, stopped (`stopped`, `keyStopped`): the solver forgets those answers
   * and every answer that read one of them (`Solver.forget`), so each next read of them reaches the stop (TABLE r4.186,
   * #1403); an answer that never asked is kept. A property or index read's occurrence answer and every position
   * (`positions.ts`) made since the last stop are forgotten too, and no position stands past a wrapper of a stopped place
   * (`wrapperHop`).
   */
  public stop(place: PlaceId, path: readonly string[]): void {
    const paths = this.#stopped.get(place);
    if (paths === undefined) this.#stopped.set(place, [path]);
    else paths.push(path);
    this.#stoppedCount += 1;
    const below = (key: Key): boolean => {
      const steps = keyPath(key);
      return path.length <= steps.length && path.every((step, i) => steps[i] === step);
    };
    const askers = [...(this.#askers.get(place) ?? [])];
    this.pass.solver.forget(
      askers.filter(([, keys]) => [...keys].some(below)).map(([demand]) => demand),
    );
    this.pass.solver.forget(this.occurrences);
    this.occurrences.length = 0;
  }

  /** The running demand asked whether `key` stopped: kept for `stop`, each new ask counted apart from the allowance. */
  #asked(place: PlaceId, key: () => Key): void {
    const demand = this.pass.solver.reading;
    if (demand === null) return;
    let byDemand = this.#askers.get(place);
    if (byDemand === undefined) this.#askers.set(place, (byDemand = new Map()));
    let keys = byDemand.get(demand);
    if (keys === undefined) byDemand.set(demand, (keys = new Set()));
    const asked = key();
    if (keys.has(asked)) return;
    keys.add(asked);
    countApart(this.work, "stopAsks");
  }

  public remember(demand: string): void {
    remember(this, demand);
  }

  /** The keys whose decision stopped (`stop`), the set the next pass starts with. */
  public stoppedKeys(): readonly StoppedKey[] {
    return [...this.#stopped].flatMap(([place, paths]) => paths.map((path) => ({ place, path })));
  }

  /** How many decisions stopped (`stop`). */
  public get stoppedCount(): number {
    return this.#stoppedCount;
  }

  /** Whether any decision stopped (`stop`). */
  public get anyStopped(): boolean {
    return this.#stopped.size > 0;
  }

  /** Whether the decision of `place` at `path`, or at a key above it, stopped (`stop`); the running demand asked. */
  public stopped(place: PlaceId, path: readonly string[]): boolean {
    this.#asked(place, () => keyOf(place, path));
    return this.#stoppedAt(place, path);
  }

  /** `stopped` for a key. */
  public keyStopped(key: Key): boolean {
    const place = keyPlace(key);
    this.#asked(place, () => key);
    return (
      this.anyStopped &&
      this.#stopped.has(place) &&
      this.#stoppedAt(place, keptPath(this.work, key))
    );
  }

  #stoppedAt(place: PlaceId, path: readonly string[]): boolean {
    const paths = this.#stopped.get(place);
    if (paths === undefined) return false;
    this.work.charge("checks");
    return paths.some((at) => at.length <= path.length && at.every((step, i) => path[i] === step));
  }

  /** The analysis's ledger, which the paths and keys built here are charged to (`keptKey`, `keptText`). */
  public get work(): WorkLedger {
    return this.pass.program.work;
  }

  public literalRoute(literal: PlaceId, rest: readonly string[], node: FlowNode | null): ReadRoute {
    return literalRoute(this, literal, rest, node);
  }

  public contractOf(key: Key): Work<readonly Item[]> {
    return contractOf(this, key);
  }

  /**
   * A key's contract along a path through a member a built-in value answers by itself from the step `from` on, its
   * receiver decided as a reference's or not once (F19a, r4.44): a reference's member is the runtime's.
   */
  public keyThrough(key: Key, from: number): Work<readonly Item[]> {
    const at = memberStepOf(this, keyPath(key), from);
    return at < 0 ? keyContract(this, key) : keyListsAt(this, key, at);
  }

  public severalElements(key: Key): Work<boolean> {
    return severalElements(this, key);
  }

  public contractRead(
    key: Key,
    node: FlowNode,
    context: ContextWord,
    later?: boolean,
  ): Work<readonly Item[]> {
    return contractRead(this, key, node, context, later);
  }

  public refReceiver(key: Key): Work<boolean> {
    return refReceiver(this, key);
  }

  public receiverKinds(key: Key): Work<readonly Item[]> {
    return receiverKinds(this, key);
  }

  public valueReceiver(receiver: PlaceId): Work<readonly Item[]> {
    return valueReceiver(this, receiver);
  }

  public entryAt(entry: PrefixEntry, rest: readonly string[]): Work<readonly Item[]> {
    return entryAt(this, entry, rest);
  }

  public subAt(sub: Key, rest: readonly string[]): Work<readonly Item[]> {
    return subAt(this, sub, rest);
  }

  public contractOfValueAt(value: PlaceId, rest: readonly string[]): Work<readonly Item[]> {
    return contractOfValueAt(this, value, rest);
  }

  public contractOfValue(value: PlaceId): Work<readonly Item[]> {
    return contractOfValue(this, value);
  }

  public chainOf(value: PlaceId): ChainRoot | null {
    return chainOf(this, value);
  }

  public pathStep(parent: number, step: string): number {
    return pathStep(this, parent, step);
  }

  public pathLast(id: number): string {
    return pathLast(this, id);
  }

  public pathDepth(id: number): number {
    return pathDepth(this, id);
  }

  public pathParent(id: number): number {
    return pathParent(this, id);
  }

  public pathSteps(id: number): string[] {
    return pathSteps(this, id);
  }

  /**
   * G3 3a: a wrapper's step (`positions.ts`), or `null`. A read `read` of a binding (or the binding's key itself) is
   * passed at `step` to the one read its value holds there, a wrapper's, when every read of the binding at a path through
   * `step` is that read's at the rest of the path with the binding's writer, whatever the rest: the binding is a plain
   * unwritten `let` whose one definition anywhere at or below it is its declaration, live, outside block code, storing a
   * literal; no test names a key of it, no other callable stores it, no decision of it stopped; its declaration's entry is
   * the prefix's one entry and marks nothing whatever the path; the literal holds at `step` one read, of a binding,
   * unguarded and naming no ingress, and nothing else there or below, and every object at its root has `step`; and the
   * read occurrence names no ingress. Every condition is a fact of the program and of the pass's live stores (and its
   * stops, which forget every position made), so no read of a path below the step differs. G3 stage 1: the occurrence's
   * and the stops' conditions are checked here, live; the program's and the live stores' are the binding's wrapper shape
   * (`wrapperShape`), frozen for the pass.
   */
  public wrapperHop(read: PlaceId, step: string): WrapperHop | null {
    const { program } = this.pass;
    const occurrence = program.occurrenceOf.get(read);
    const binding = occurrence ?? read;
    if (occurrence !== undefined && (program.projOf.has(read) || this.ingressOf(read) !== null))
      return null;
    if (this.#stopped.has(binding)) return null;
    return wrapperShape(this, binding, step, "hop");
  }

  public literalHop(literal: PlaceId, step: string): LoneRead | null {
    return literalHop(this, literal, step);
  }

  public expectedOf(c: ValueConstraint, rest: readonly string[]): Work<readonly Item[] | null> {
    return expectedOf(this, c, rest);
  }

  public defaultKinds(fallback: PlaceId, rest: readonly string[]): Work<readonly Item[]> {
    return defaultKinds(this, fallback, rest);
  }

  public onlyNull(fallback: PlaceId): Work<readonly Item[]> {
    return onlyNull(this, fallback);
  }

  public landsIn(value: PlaceId, path: readonly string[], depth?: number): TypeTerm | null {
    return landsIn(this, value, path, depth);
  }

  public copiedKey(value: PlaceId): Key | null {
    return copiedKey(this, value);
  }

  public readSnapshot(value: PlaceId): string | null {
    return readSnapshot(this, value);
  }

  public readClass(value: PlaceId, exact: boolean): string | null {
    return readClass(this, value, exact);
  }

  public aliasWriter(value: PlaceId, exact: boolean): Writer | null {
    return aliasWriter(this, value, exact);
  }

  public boundClass(value: PlaceId, exact: boolean): KeptClass {
    return boundClass(this, value, exact);
  }

  public classOf(value: PlaceId, exact: boolean): string | null {
    return classOf(this, value, exact);
  }

  public classWriters(value: PlaceId, exact: boolean): readonly (Writer | null)[] | null {
    return classWriters(this, value, exact);
  }

  public classMixed(value: PlaceId, exact: boolean): number {
    return classMixed(this, value, exact);
  }

  public choiceOptions(
    c: Extract<ValueConstraint, { readonly kind: "operation" }>,
    exact: boolean,
  ): readonly ChoiceGroup[] {
    return choiceOptions(this, c, exact);
  }

  public plusRepeatOf(value: PlaceId, exact: boolean): PlaceId {
    return plusRepeatOf(this, value, exact);
  }

  public resultKey(value: PlaceId): Key | null {
    return resultKey(this, value);
  }

  public choiceKeysStored(): StoredChoiceKeys {
    return choiceKeysStored(this);
  }

  public keyIdentity(key: Key): Identity {
    return keyIdentity(this, key);
  }

  public identityOf(value: PlaceId): Identity {
    return identityOf(this, value);
  }

  public structureOf(value: PlaceId): string {
    return structureOf(this, value);
  }

  public internStructure(shape: string): string {
    const id = this.#structureIds.get(shape) ?? `t${this.#structureIds.size}`;
    this.#structureIds.set(shape, id);
    return id;
  }

  public *needStructure(value: PlaceId): Generator<() => IdentityWork, string, void> {
    if (!this.structures.has(value)) {
      if (this.indexing.has(value)) return `v${value}`;
      yield () => structureWork(this, value);
    }
    return this.structures.get(value)!;
  }

  /** Runs a computation of the identity layer and those it needs on an explicit stack. */
  public settle(work: IdentityWork): void {
    const stack: IdentityWork[] = [work];
    this.building += 1;
    try {
      while (stack.length > 0) {
        const step = stack.at(-1)!.next();
        if (step.done === true) stack.pop();
        else stack.push(step.value());
      }
    } finally {
      this.building -= 1;
    }
  }

  /** A key's identity inside the identity layer: computed first where it is not known (a cycle's is its stop). */
  public *needKey(key: Key): Generator<() => IdentityWork, Identity, void> {
    if (!this.keys.has(key)) yield () => keyIdentityWork(this, key);
    return this.keys.get(key)!;
  }

  public *needValue(value: PlaceId): Generator<() => IdentityWork, Identity, void> {
    if (!this.identities.has(value)) {
      if (this.indexing.has(value)) return this.own(value);
      yield () => identityWork(this, value);
    }
    return this.identities.get(value)!;
  }

  /**
   * #1229: a literal whose index is being built, read back by its own cycle (an element's identity reaching the literal
   * again through copies, as a ring of copies through one list does), stands as itself, as one holding a reference does,
   * so its index is built once, never again for each element on the way; kept nowhere, so its own identity, structure
   * and signature are made from its finished index.
   */
  public own(literal: PlaceId): Identity {
    const id = `v${literal}`;
    return { id, key: null, guarded: false, holder: this.holders.get(id) ?? newHolder(this, id) };
  }

  public *needPrefix(prefix: Key): Generator<() => IdentityWork, PrefixStores, void> {
    if (!this.prefix.has(prefix)) yield () => prefixWork(this, prefix);
    return this.prefix.get(prefix)!;
  }

  public *needIndex(literal: PlaceId): Generator<() => IdentityWork, LiteralIndex, void> {
    if (!this.literals.has(literal)) yield () => indexWork(this, literal);
    return this.literals.get(literal)!;
  }

  public *needSignature(literal: PlaceId): Generator<() => IdentityWork, string, void> {
    if (!this.signatures.has(literal)) {
      if (this.indexing.has(literal)) return `v${literal}`;
      yield () => signatureWork(this, literal);
    }
    return this.signatures.get(literal)!;
  }

  /** The identities an entry draft's id and holder read, computed first. */
  public *ready(e: EntryDraft): IdentityWork {
    if (e.key !== undefined) yield* this.needKey(e.key);
    else if (e.elem !== undefined) {
      yield* this.needValue(e.elem);
      yield* this.needStructure(e.elem);
    } else if (e.value !== undefined) {
      yield* this.needValue(e.value);
      yield* this.needStructure(e.value);
    }
  }

  public prefixStores(prefix: Key): PrefixStores {
    return prefixStores(this, prefix);
  }

  public relevantSubs(stores: PrefixStores, rest: readonly string[]): readonly SubSource[] {
    return relevantSubs(this, stores, rest);
  }

  public subSources(stores: PrefixStores): Key[] {
    return subSources(stores);
  }

  public entered(value: PlaceId, items: readonly Item[]): readonly Item[] {
    return entered(this, value, items);
  }

  public ingressOf(value: PlaceId): PlaceId | null {
    return ingressOf(this, value);
  }

  /**
   * Charges what the literal work keeps before it keeps it (TABLE r4.58): `units` entries, scheduled tasks or elements
   * of a sorted copy, or a text's `textUnits`; so the allowance stops a deep literal's indexes before the heap does.
   */
  public keep(units: number): void {
    keep(this.work, units);
  }

  /** Charges a text of `length` UTF-16 code units the literal work keeps. */
  public keepText(length: number): void {
    this.keep(textUnits(length));
  }

  /** A text the literal work keeps, charged by its length. */
  public kept(text: string): string {
    this.keepText(text.length);
    return text;
  }

  /** `parts` joined by `separator`, the joined text's length charged first. */
  public joined(parts: readonly string[], separator: string): string {
    let length = parts.length === 0 ? 0 : separator.length * (parts.length - 1);
    for (const part of parts) length += part.length;
    this.keepText(length);
    return parts.join(separator);
  }

  public standsAlong(
    literal: PlaceId,
    path: readonly string[],
    kind: "reads" | "others",
  ): readonly { readonly depth: number; readonly entries: readonly ValueEntry[] }[] {
    return standsAlong(this, literal, path, kind);
  }

  public loneRead(
    literal: PlaceId,
  ): { readonly steps: readonly string[]; readonly value: PlaceId } | null {
    return loneRead(this, literal);
  }

  public pathIdOf(steps: readonly string[]): number {
    return pathIdOf(this, steps);
  }

  public literalIndex(literal: PlaceId): LiteralIndex {
    return literalIndex(this, literal);
  }

  public literalSignature(literal: PlaceId): string {
    return literalSignature(this, literal);
  }

  /**
   * A node's shape for a literal's signature (`sig`: its reads' and computed values' identities) or structure (`str`:
   * their structures), once per node, bottom-up on an explicit walk: its own terms' kinds, its entries, its objects'
   * names, an empty collection, and per step below it that holds anything the shape there, by step; interned, so a
   * node that nested literals share is shaped once. Two literals' indexes hold the same at every path exactly where
   * their roots' shapes are one.
   */
  public *nodeShape(
    top: IndexNode,
    kind: "sig" | "str",
  ): Generator<() => IdentityWork, NodeShape, void> {
    const known = top.shapes?.[kind];
    if (known !== undefined) return known;
    const { program, definitions } = this.pass;
    const stack: {
      readonly node: IndexNode;
      readonly below: (readonly [string, IndexNode])[];
      at: number;
    }[] = [];
    const open = (node: IndexNode): void => {
      const below = [...node.children]
        .filter(([, child]) => heldBelow(this, child).holds)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      this.keep(below.length);
      program.work.charge("invSteps", sortCost(below.length));
      stack.push({ node, below, at: 0 });
    };
    open(top);
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      if (frame.at < frame.below.length) {
        const child = frame.below[frame.at]![1];
        if (child.shapes?.[kind] === undefined) open(child);
        else frame.at += 1;
        continue;
      }
      stack.pop();
      const { node } = frame;
      program.work.charge("invSteps");
      let plain = !node.reference;
      let marked = false;
      const parts: string[] = [kindsPart(this, -1, node.terms)];
      for (const [mark, entries] of [
        ["r", node.reads],
        ["o", node.others],
      ] as const)
        for (const entry of entries) {
          let part: string;
          if (kind === "sig") {
            // (an ingress occurrence is its own source; a projection of one reads its key, its leaf unioned in the
            // entry)
            const id = (yield* this.needValue(entry.value)).id;
            if (
              mark === "r" &&
              "ingress" in entry &&
              entry.ingress !== undefined &&
              definitions.ingress.has(entry.value)
            )
              plain = false;
            if (mark === "o" && id.startsWith("v")) plain = false;
            part = `${mark}${id}`;
          } else {
            const structure = yield* this.needStructure(entry.value);
            if (structure.startsWith("v")) plain = false;
            marked ||= this.markedStructures.has(structure);
            part = `s${structure}`;
          }
          parts.push(this.kept(part));
        }
      for (const object of node.objects?.list ?? []) parts.push(namesPart(this, object.names));
      if (node.empty) parts.push("empty");
      for (const [step, child] of frame.below) {
        const below = child.shapes![kind]!;
        plain &&= below.plain;
        marked ||= below.marked;
        parts.push(this.kept(`${step}=${below.name}`));
      }
      const shape = this.joined(parts, ";");
      const name = this.#nodeShapes.get(shape) ?? `n${this.#nodeShapes.size}`;
      this.#nodeShapes.set(shape, name);
      node.shapes ??= {};
      node.shapes[kind] = { name, plain, marked };
      const parent = stack.at(-1);
      if (parent !== undefined) parent.at += 1;
    }
    return top.shapes![kind]!;
  }

  public indexItems(
    literal: PlaceId,
    rest: readonly string[],
    node: FlowNode | null,
    exact: boolean,
    below?: boolean,
  ): Work<readonly Item[]> {
    return indexItems(this, literal, rest, node, exact, below);
  }

  public gathered(
    site: GatherSite,
    node: FlowNode | null,
    rest: readonly string[],
    lo: number,
    hi: number,
  ): Work<readonly Item[]> {
    return gathered(this, site, node, rest, lo, hi);
  }

  public contractOfLiteral(literal: PlaceId, rest: readonly string[]): Work<readonly Item[]> {
    return contractOfLiteral(this, literal, rest);
  }
}
