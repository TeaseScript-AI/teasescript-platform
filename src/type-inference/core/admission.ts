import type { PlaceId, SourceSite, TypeTerm } from "../graph.js";
import { admitted, deciderAt, inheritsWritten, retained } from "./admission/admitted.js";
import {
  boundariesAt,
  boundaryAt,
  boundaryFor,
  ingressStores,
  publish,
  takeBackReadChecks,
} from "./admission/boundaries.js";
import { compareLanded, decide, decisionStopped, stopDecision } from "./admission/decision.js";
import { groups, stores } from "./admission/groups.js";
import { atCopy } from "./admission/held.js";
import {
  cellSited,
  contributionSited,
  ingressSiteOf,
  namedExternalSite,
  ownIngress,
  ownReadItem,
  wholeBelow,
} from "./admission/ingress.js";
import { copyGraph } from "./admission/inherited.js";
import { typedByDefault } from "./admission/landing-index.js";
import {
  literalChildren,
  literalElements,
  offendingAt,
  siteAt,
  storesAt,
} from "./admission/literals.js";
import type {
  Alias,
  ByPath,
  ChainEnd,
  CopyForest,
  Decided,
  Decision,
  Frontier,
  HeldOwn,
  IngressStop,
  Inheritance,
  InheritedCopy,
  KeyStops,
  LandingIndex,
  Level,
  LiveGroup,
  OpenStep,
  OwnStructure,
  Stop,
  Stops,
  StoreIngresses,
  Structure,
  TouchPlace,
  ViaChain,
} from "./admission/model.js";
import { levelsOf, permittedAt } from "./admission/permitted.js";
import { copySources } from "./admission/walk.js";
import type { CorePass } from "./answers.js";
import { joinSteps, keptSteps, stepText, type WorkLedger } from "./budget.js";
import { carried, keepsOwn, type CarrierRole, type Dispatch } from "./carriers.js";
import { heldReference, termAt, typeTags, writtenOf } from "./contract.js";
import {
  keptKey,
  keyOf,
  SELECTED_TEXT,
  SELECTED_VALUE,
  type Definition,
  type Key,
} from "./definitions.js";
import { withoutEmpty } from "./exact-path.js";
import type { FlowNode } from "./flow-graph.js";
import type { IngressNode, Item, ItemTag } from "./items.js";
import { propertyStep } from "./program.js";
import { elementStep, type Obligation } from "./result.js";
import type { Work } from "./solver.js";
import { Touches, type Touch } from "./touch.js";
export { requiredKind } from "./admission/boundaries.js";
export { withoutChains } from "./admission/classes.js";
export { withMemberOracle } from "./admission/decision.js";
export { concrete, contributes, deciding, fits, isExternal, isOpaque } from "./admission/kinds.js";
export type { Candidate, Decision } from "./admission/model.js";

/*
 * Admission (checkpoint 9, TABLE §5) and the boundary checks of external data (C9). A place's type is decided once,
 * in source order, at a destination store, from the value that store transfers at its own node (§3): a written type
 * decides (A1, A9); a copy of a written binding is decided by its type (A4); otherwise the earliest definite
 * contribution in source order (A2), where a settled family needs no scan (A3); the candidates a decided type is checked
 * against are the direct stores and the whole stores of a prefix whose source holds an offending kind (A5). A definite
 * contribution that does not fit is an error at the store, which is rejected: its rejection takes effect in the next
 * pass, and the passes repeat until the rejected set is stable (A6, `analyseCore`). The consumers check each candidate
 * against the decided type (C1); here: the decision, the rejections, a literal's elements of one type (A8, ADR 1.3) and
 * where each boundary check of external data stands (C9: one per ingress store at its ingress expression, against the
 * destination's own admitted type; host data no store brought is checked at the consumer that reads it).
 */

/** What admission asks of the consumers it runs beside: their solver runs, with each read's accounting. */
export interface AdmissionHost {
  run<T>(work: Work<T>): T;
  /**
   * After a stop, a value's items at a node and a path as the finishing read answers them (the leaf's own kind, the
   * finished answer and contract, the retained type: TABLE r4.102, r4.106, r4.109), else `null`: admission's C1 and its
   * boundaries read as every consumer does (one derivation, TABLE r4.126).
   */
  read?(value: PlaceId, node: FlowNode, at: readonly string[]): readonly Item[] | null;
}

/**
 * A public method whose body lives in `admission/` delegates to the function of its name there; the members those
 * functions read are public for them, and internal to admission.
 */
export class Admission {
  /** The decider's kinds per key (§5). */
  readonly decided = new Map<Key, readonly ItemTag[]>();
  /** The stores rejected in this pass, by their definitions' order, with the places and paths they are rejected at (A6). */
  readonly newlyRejected = new Map<number, Set<Key>>();
  /** The boundary checks of the ingress stores, by the key each enters (C9), published after the consumers ran. */
  readonly boundaries = new Map<Key, Obligation[]>();
  /** The boundary checks no store into a place owes: host data read where it is consumed, an ingress read (C9, F18). */
  readonly readChecks: Obligation[] = [];
  readonly rejectedKeys = new Set<Key>();
  /** The previous pass's rejected stores by the place and path each was rejected at (A6). */
  readonly retaken = new Map<Key, Definition[]>();
  readonly a4Keys = new Set<Key>();
  /** The places `a4Keys` lands copies in, each with `openAbove`'s walk down its paths from its root. */
  readonly a4Places = new Map<PlaceId, OpenStep | null>();
  /** The parameters with a default (ADR 0021 1.5). */
  readonly #defaulted = new Set<PlaceId>();
  readonly a4Copies: {
    readonly place: PlaceId;
    readonly path: readonly string[];
    readonly term: TypeTerm;
  }[] = [];
  /** Whether each decision admits `null` (a copy of a written type without one does not, A4). */
  readonly nullable = new Map<Key, boolean>();
  /**
   * The decisions a copy of a written type with `null` made: they admit it whatever the stored kinds hold (A4, F17b; ADR
   * 0021 1.3: the kinds present never narrow a written domain, the lead's ruling on external round 7 B1).
   */
  readonly permitsNull = new Set<Key>();
  /** The paths a copy of a written type decides, not the place's own (A4 through copies, r4.75 (1)). */
  readonly inheritsWrittenKeys = new Set<Key>();
  /** The paths a written type, or a copy of one, leaves unrestricted (`permittedAt`): no decision, every kind fits. */
  readonly unrestricted = new Set<Key>();
  /** The site of the contribution each decision took (S3 §1's admitted answer), `null` for a written type. */
  readonly deciderSites = new Map<Key, SourceSite | null>();
  readonly copies = new Map<
    PlaceId,
    readonly {
      readonly path: readonly string[];
      readonly binding: PlaceId;
      readonly strip: readonly string[];
      readonly cellsLive: boolean;
    }[]
  >();
  /** The copies of places that may inherit a written type (`inheriting`), where they land. */
  readonly a4Inherits: InheritedCopy[] = [];
  /** A4 through copies (`copyGraph`): the unwritten places a copy of a written binding reaches, copy by copy. */
  readonly inheriting = new Set<PlaceId>();
  /** Per unwritten place and path, the written type its own decision copies there (`inheritedAt`), or none. */
  readonly inherited = new Map<Key, TypeTerm | null>();
  /** The places and paths whose decisions wait on each other through copies, by cycle (`cut`): a union-find. */
  readonly cycles = new Map<Key, Key>();
  /** Each cycle's size, by its root (`cycleOf`). */
  readonly cycleSizes = new Map<Key, number>();
  /**
   * The deepest path a written type can reach through copies (`inheritedAt`): the written copies' landing paths with
   * their types' element levels, and every copy of an inheriting place's own landing path beside them.
   */
  reach = 0;
  /** Per written type, its element levels (`levelsOf`). */
  readonly termLevels = new Map<TypeTerm, readonly TypeTerm[]>();
  resolving = false;
  readonly whole = new Map<string, Definition[]>();
  readonly #fields = new WeakMap<TypeTerm, Map<string, TypeTerm>>();
  readonly stops = new Map<PlaceId, Stops>();
  /** G3 3a: per place and path id, where it lands past wrappers (`landedFrontier`); per place and step, its wrapper's. */
  readonly landedFrontiers = new Map<string, { readonly place: PlaceId; readonly rest: number }>();
  readonly landingHops = new Map<string, PlaceId | null>();
  /** G3 3a: per place and path id, its frontier past wrappers (`wrappedFrontier`); per place and step, its wrapper's step. */
  readonly frontiers = new Map<string, Frontier>();
  readonly scanHops = new Map<
    string,
    { readonly binding: PlaceId; readonly read: PlaceId; readonly decl: Definition } | null
  >();
  readonly everyStop = new Map<PlaceId, Stops>();
  /**
   * A representative store's later equivalent ones (`grouped`), each recorded once per pass with its representative
   * (`representative`), and the bindings defined by one whole store.
   */
  readonly members = new Map<Definition, Definition[]>();
  /** An alias's source path and the node it is read at (`aliasKey`). */
  readonly aliases = new Map<Definition, Alias>();
  /** Per written type and path into it, the name of its spelling in the alias keys (`writtenDomainKey`). */
  readonly writtenNames = new Map<TypeTerm, Map<string, string>>();
  /** The name of each written spelling the alias keys hold, by the spelling: equal spellings one name. */
  readonly spellings = new Map<string, string>();
  /** Per read (its source and node), its chain's end (`chainEnd`), `null` where it is its own. */
  readonly chains = new Map<string, ChainEnd | null>();
  /** Per class (its representative), its eligible member at each tested key of its demanded paths (§4.3). */
  readonly eligible = new Map<Definition, Map<string, Definition | null>>();
  /** Per key with stores, the rests below it of the paths the pass decides (`groups()`), once. */
  demands: Map<Key, (readonly string[])[]> | null = null;
  readonly representative = new Map<Definition, Definition>();
  /** The expected types of typed ingresses by identity, and the contract-side classes, for `conflictClass`. */
  readonly termIds = new Map<TypeTerm, string>();
  readonly classIds = new Map<string, number>();
  /** The own structure of each stored value (`v`) and source key (`k`), and each source key's element depth, F2. */
  readonly structures = new Map<string, Structure>();
  readonly depths = new Map<Key, number>();
  keyBound: number | null = null;
  below: Map<Key, (readonly string[])[]> | null = null;
  readonly takeables = new WeakMap<
    ReadonlySet<Definition | null>,
    { readonly wholes: readonly Definition[]; readonly adds: readonly Definition[] }[]
  >();
  /** `wholeBelow`'s values per stored value and path prefix. */
  readonly levels = new Map<string, Level>();
  readonly pending = new Map<number, Definition>();
  readonly readSeen = new Set<PlaceId>();
  readonly hostSeen = new Set<string>();
  /** The key each read check took in `readSeen` or `hostSeen`, in `readChecks`' order (`null`: F18's, none). */
  readonly readCheckKeys: (PlaceId | string | null)[] = [];
  /** Per provenance node, the ingresses its leaves name, and whether one of them no walk reached (`resolve`). */
  readonly nodeIngresses = new Map<IngressNode, ReadonlySet<PlaceId>>();
  /** Per store, the ingresses that reach its value through an operation's own read (`ownLeaves`). */
  readonly ownReads = new Map<string, ReadonlySet<PlaceId>>();
  /** Per store and path, the ingresses of named data it brings beside its inline data (`namedBeside`). */
  readonly beside = new Map<string, ReadonlySet<PlaceId>>();
  /** Per store and key, its stops there (`keyStops`). */
  readonly keyed = new Map<string, KeyStops>();
  /**
   * Per store and provenance node (`perNode`): `ownReadItem`'s answer, whether an item carries an own read's data
   * (`ingressSiteOf`), `ownIngress`'s whole test, `firstStop`.
   */
  readonly ownItems = new Map<number, Map<IngressNode, boolean>>();
  readonly someOwn = new Map<number, Map<IngressNode, boolean>>();
  readonly wholeItems = new Map<number, Map<IngressNode, boolean>>();
  readonly firstStops = new Map<number, Map<IngressNode, IngressStop | null>>();
  /** Per chain of a walk's operations, its signature (`viaSignature`), and per signature's parts, its name. */
  readonly viaSignatures = new WeakMap<ViaChain, string>();
  readonly viaNames = new Map<string, string>();
  /** Per chain of operations, its name by its values' classes (`viaClasses`), and those names by their parts. */
  readonly viaClassNames = new WeakMap<ViaChain, string>();
  readonly viaClassParts = new Map<string, string>();
  /** Per chain, whether its operations give the operand the walk took (`chosen`), and surely give it. */
  readonly chosenLinks = [new WeakMap<ViaChain, boolean>(), new WeakMap<ViaChain, boolean>()];
  /** Per set of a store's inline ingresses, per chain, whether one of its operations' values is one (`named`). */
  readonly inlineLinks = new WeakMap<ReadonlySet<PlaceId>, WeakMap<ViaChain, boolean>>();
  /** Per store, its landing stops by ingress (`storeIngresses`). */
  readonly byIngress = new Map<number, StoreIngresses>();
  /**
   * Per list of a walk's stops, the decider's snapshots of it, all and the unselected ones, each also with the first of a
   * class alone (`snapshots`).
   */
  readonly snapshotLists = new WeakMap<readonly Stop[], (readonly Stop[] | undefined)[]>();
  readonly resolved = new Map<IngressNode, boolean>();
  readonly f18 = new Map<
    PlaceId,
    { readonly label: string; readonly tags: readonly ItemTag[] } | null
  >();
  groupList: { readonly root: PlaceId; readonly path: readonly string[] }[] | null = null;
  /** A4 through copies' landings (`inheritance`), and per place and path whether its copies land it (`landed`). */
  inherits: Inheritance | null = null;
  readonly landedPaths = new Map<string, boolean>();
  /** Per place copies land in, the landed paths whose contents may not fit (`hotSets`). */
  hots: ReadonlyMap<PlaceId, readonly (readonly string[])[]> | null = null;
  /** The copies places answer through (`passThrough`), once per pass. */
  forest: CopyForest | null = null;
  /** Per class, its eligible member per tested key asked while the groups are made (`eligibleAt`). */
  readonly eligibleWhileGrouping = new Map<Definition, Map<string, Definition | null>>();
  readonly owns = new Map<PlaceId, OwnStructure | null>();
  readonly copyIndexes = new Map<
    PlaceId,
    { readonly list: readonly InheritedCopy[]; readonly index: ByPath<number> }
  >();
  readonly cycleLandings = new WeakMap<ReadonlySet<string>, ByPath<readonly string[]>>();
  cycleMembers: Map<number, PlaceId[]> | null = null;
  /** Per place, its seeds' paths at or below each prefix (`seedsUnder`), and its stores taken again (`#retakenOf`). */
  readonly seedIndex = new Map<PlaceId, Map<string, string[]>>();
  /** Per key, its decision before it is recorded (`decided`); the keys `decide` took (`lazily`). */
  readonly decisions = new Map<Key, Decided | null>();
  readonly attempted = new Set<Key>();
  landings: LandingIndex | null = null;
  /** The touch tries of the pass (`Touches`, #1188), per place its trie and the paths its contributions meet at. */
  touches: Touches | null = null;
  readonly touchPlaces = new Map<PlaceId, TouchPlace>();
  readonly touching = new Set<PlaceId>();
  /** The copies a live store makes, by place, path, source and strip (Astra's B2). */
  readonly liveCopies = new Set<string>();
  /** Each place's own contributions from its live stores (Astra's B2). */
  readonly liveOwns = new Map<PlaceId, HeldOwn | null>();
  /** Per place, what its live stores definitely hold (`heldOf`, A2). */
  readonly helds = new Map<PlaceId, Touch | null>();
  /** The keys where what a place's stores definitely hold meets (`groups`, A2): checked where the copy meets it. */
  readonly atCopies = new Set<Key>();
  /** The keys a member of a live group owes where the group's contributions meet (`finishHeld`, read by `groups`). */
  readonly groupMeetings: Key[] = [];
  /** Each place's live stores, each with its own points and reads (`liveOwn`), for a live group's members. */
  readonly liveStores = new Map<PlaceId, readonly HeldOwn[]>();
  /** The places with definitions, every one of them dead in this pass (`liveOwn`). */
  readonly deadOnly = new Set<PlaceId>();
  readonly touchLandings = new Map<PlaceId, Touch | null>();
  readonly landingNow = new Set<PlaceId>();
  /** Per member of a cycle of whole copies, the members its live copies join (`liveGroup`). */
  readonly liveGroups = new Map<PlaceId, LiveGroup>();

  public constructor(
    readonly pass: CorePass,
    readonly host: AdmissionHost,
    /**
     * The stores rejected by the previous pass, each with the places and paths it was rejected at, and those a rejection
     * cycle changes (A6).
     */
    readonly rejected: ReadonlyMap<number, ReadonlySet<Key>>,
    readonly cycling: ReadonlySet<number>,
  ) {
    const { definitions, program } = pass;
    for (const list of definitions.byKey.values()) {
      program.work.charge("indexSteps", list.length);
      for (const d of list) {
        const keys = rejected.get(d.uid);
        if (keys === undefined) continue;
        this.rejectedKeys.add(d.key);
        for (const key of keys) {
          const retaken = this.retaken.get(key);
          if (retaken === undefined) this.retaken.set(key, [d]);
          else retaken.push(d);
        }
      }
    }
    for (const d of definitions.transferDefs)
      if (d.how === "parameter default") this.#defaulted.add(d.place);
    // A4: the copies of written bindings the stores, adds, returns, parameter defaults and single-site arguments bring
    // (a multi-site argument decides nothing, F21), where they land; and the copies of the unwritten places that may
    // inherit a written type through them, at any chain length (r4.75 (1)), each decided by the type that place's own
    // decision copies at the path (`inheritedAt`)
    copyGraph(this);
    for (const d of [...definitions.storeDefs, ...definitions.transferDefs])
      if (
        (d.kind === "whole" || d.kind === "add") &&
        d.value !== undefined &&
        (d.how !== "argument" || pass.lists.singleSite(d.fn)) &&
        !this.besideDefault(d)
      ) {
        // (one landing path and key per copied path, its copies' shared one, charged before it is made)
        const landed = new Map<readonly string[], readonly string[]>();
        for (const { path, binding, strip, cellsLive } of copySources(this, d.value)) {
          const written = writtenOf(program.place(binding).kind);
          const term = written === null ? null : permittedAt(written, strip);
          if (term === null && (written !== null || !this.inheriting.has(binding))) continue;
          let at = landed.get(path);
          if (at === undefined) {
            at = keptSteps(
              this.work,
              d.path,
              d.kind === "add" && d.how !== "elements" ? ["element"] : [],
              path,
            );
            landed.set(path, at);
            this.a4Keys.add(keptKey(this.work, d.place, at));
            this.a4Places.set(d.place, null);
          }
          if (term !== null) this.a4Copies.push({ place: d.place, path: at, term });
          else
            this.a4Inherits.push({
              place: d.place,
              path: at,
              from: binding,
              strip,
              store: d,
              cellsLive,
            });
        }
      }
    for (const { path, term } of this.a4Copies)
      this.reach = Math.max(this.reach, path.length + levelsOf(this, term).length - 1);
    for (const { path } of this.a4Inherits) this.reach += path.length;
  }

  /** The analysis's ledger, which the paths and keys built here are charged to (`keptKey`, `keptText`). */
  public get work(): WorkLedger {
    return this.pass.program.work;
  }

  public run<T>(work: Work<T>): T {
    return this.host.run(work);
  }

  /**
   * A6: a definite contribution that does not fit at a place's path is rejected, a return against its own result's
   * decision too (F23), so it leaves the result's contract (an argument stays: the parameter is its callee's); in the
   * next pass it is decided again there.
   */
  /** The rejections made in this pass, counted (C1 asks whether a candidate left one). */
  public rejections = 0;

  public reject(d: Definition, root: PlaceId, path: readonly string[]): void {
    this.rejections += 1;
    if (d.how === "argument") return;
    let keys = this.newlyRejected.get(d.uid);
    if (keys === undefined) this.newlyRejected.set(d.uid, (keys = new Set()));
    keys.add(keptKey(this.work, root, path));
  }

  /**
   * ADR 0021 1.6: source order, in which a declaration's start value comes before every other store into its place; a
   * single-site parameter's is its argument (F21).
   */
  public sourceOrder(d: Definition): number {
    return d.how === "initializer" || (d.how === "argument" && this.pass.lists.singleSite(d.fn))
      ? -1
      : d.site.file * 1e9 + d.site.start;
  }

  /**
   * F21, ADR 0021 1.5: an argument for an unannotated parameter with a default. Each call types such a parameter from
   * its argument, and the default is the parameter's start value, checked once at the function against the body: the
   * argument decides nothing and is no candidate, so the two never constrain each other. Without a default a single-site
   * argument is the start value (F21); a written parameter checks every argument (A9, C7).
   */
  public besideDefault(d: Definition): boolean {
    return (
      d.how === "argument" &&
      this.#defaulted.has(d.place) &&
      writtenOf(this.pass.program.place(d.place).kind) === null
    );
  }

  public atCopy(root: PlaceId, path: readonly string[]): boolean {
    return atCopy(this, root, path);
  }

  /** A store's value at the path below its destination, by §3 at its node. */
  public valueAt(d: Definition, at: readonly string[]): Item[] {
    this.pass.program.work.charge("checks");
    if (d.kind === "const") return at.length === 0 ? [...(d.items ?? [])] : [];
    return this.items(d.value!, d.node, at);
  }

  /** A value's items at a node and a path: the finishing read's after a stop (`AdmissionHost.read`), else the solver's. */
  public items(value: PlaceId, node: FlowNode, at: readonly string[]): Item[] {
    const finished = this.host.read?.(value, node, at) ?? null;
    return withoutEmpty(finished ?? this.run(this.pass.values.valueItems(value, node, at)));
  }

  /**
   * A place's path in the contract's vocabulary: an element step below a dict is its `entry`, the collection above it as
   * the contract holds it or, where the place's written type `written` reaches it (the finishing path before admission
   * settled, TABLE r4.122), as the written type has it, final at every stop and asking no solver.
   */
  public pathLabel(
    place: PlaceId,
    path: readonly string[],
    written: TypeTerm | null = null,
  ): string {
    const { program, contract } = this.pass;
    let label = program.place(place).label;
    // (the written type at each prefix one step below the one before, never walked again from its root, #1194)
    let term = written;
    path.forEach((step, index) => {
      if (step !== "element") label = stepText(label, step);
      else {
        const tags =
          term !== null
            ? typeTags(term)
            : withoutEmpty(this.run(contract.contractOf(keyOf(place, path.slice(0, index))))).map(
                (item) => item.tag,
              );
        label = stepText(label, elementStep(tags));
      }
      if (term !== null) term = termAt(term, [step]);
    });
    return label;
  }

  public stores(): readonly Definition[] {
    return stores(this);
  }

  storeList: readonly Definition[] | null = null;

  public groups(): readonly { readonly root: PlaceId; readonly path: readonly string[] }[] {
    return groups(this);
  }

  public compareLanded(): void {
    compareLanded(this);
  }

  public stopDecision(root: PlaceId, path: readonly string[]): void {
    stopDecision(this, root, path);
  }

  public decisionStopped(place: PlaceId, path: readonly string[]): boolean {
    return decisionStopped(this, place, path);
  }

  public decide(root: PlaceId, path: readonly string[], lazily?: boolean): Decision | null {
    return decide(this, root, path, lazily);
  }

  public admitted(place: PlaceId, path: readonly string[]): ItemTag[] {
    return admitted(this, place, path);
  }

  public retained(place: PlaceId, path: readonly string[]): ItemTag[] | null {
    return retained(this, place, path);
  }

  public inheritsWritten(place: PlaceId, path: readonly string[]): boolean {
    return inheritsWritten(this, place, path);
  }

  public deciderAt(place: PlaceId, path: readonly string[]): SourceSite | null {
    return deciderAt(this, place, path);
  }

  /** §3.3: a value's contract kinds, `null` with an unknown. */
  public quietKinds(value: PlaceId | undefined): ItemTag[] | null {
    if (value === undefined) return null;
    const items = withoutEmpty(this.run(this.pass.contract.contractOfValueAt(value, [])));
    return items.length === 0 || items.some((item) => item.tag === "unknown")
      ? null
      : items.map((item) => item.tag);
  }

  /** The value side's decisions the carrier table asks before it carries (`carriers.ts`). */
  readonly #dispatch: Dispatch = {
    kinds: (of) =>
      new Set(this.run(this.pass.contract.contractOfValue(of)).map((item) => item.tag)),
    reference: (receiver) => heldReference(this.run(this.pass.contract.valueReceiver(receiver))),
  };

  /** The values a value carries, with the path into each its value is read at: the carrier table's (`carried`). */
  public carriersOf(
    value: PlaceId,
    strip: readonly string[],
  ): readonly (readonly [PlaceId, readonly string[], CarrierRole, number])[] {
    return carried(this.pass.program, value, strip, this.#dispatch);
  }

  /** Whether the receiver's or the key's decision leaves a value's operation its own value (F19a, F19: `keepsOwn`). */
  public keepsOwn(value: PlaceId): boolean {
    return keepsOwn(this.pass.program, value, this.#dispatch);
  }

  /** A literal's term at one step: an object's property by its step, a collection's element; built once per literal. */
  public termAt(term: TypeTerm, step: string): TypeTerm | undefined {
    const { work } = this.pass.program;
    work.charge("checks");
    if (term.kind === "list" || term.kind === "set" || term.kind === "dict")
      return step === "element" ? term.element : undefined;
    if (term.kind !== "object") return undefined;
    let fields = this.#fields.get(term);
    if (fields === undefined) {
      fields = new Map();
      for (const property of term.properties ?? []) {
        work.charge("indexSteps");
        const at = propertyStep(property.name);
        if (!fields.has(at)) fields.set(at, property.type);
      }
      this.#fields.set(term, fields);
    }
    // V30 §19: a choice object's selected value, its `value` where it has one, else its `text`
    if (step === SELECTED_VALUE) return fields.get("value");
    if (step === SELECTED_TEXT) return fields.has("value") ? undefined : fields.get("text");
    return fields.get(step);
  }

  public literalChildren(value: PlaceId, step: string): Definition[] {
    return literalChildren(this, value, step);
  }

  public offendingAt(
    d: Definition,
    at: readonly string[],
    leaf: (items: readonly Item[]) => boolean,
  ): Definition | null {
    return offendingAt(this, d, at, leaf);
  }

  public siteAt(
    d: Definition,
    at: readonly string[],
    leaf: (items: readonly Item[]) => boolean,
  ): SourceSite {
    return siteAt(this, d, at, leaf);
  }

  public storesAt(value: PlaceId, step: string): readonly Definition[] {
    return storesAt(this, value, step);
  }

  public ingressSiteOf(d: Definition, at: readonly string[], item?: Item): SourceSite {
    return ingressSiteOf(this, d, at, item);
  }

  public namedExternalSite(d: Definition, at: readonly string[]): SourceSite | null {
    return namedExternalSite(this, d, at);
  }

  public ownReadItem(item: Item, d: Definition): boolean {
    return ownReadItem(this, item, d);
  }

  public wholeBelow(value: PlaceId, at: readonly string[]): PlaceId | null {
    return wholeBelow(this, value, at);
  }

  public literalElements(
    order: <T>(list: readonly T[]) => T[],
    error: (
      site: SourceSite,
      found: {
        readonly d: Definition;
        readonly cell: PlaceId;
        readonly path: readonly string[];
        readonly decided: readonly ItemTag[];
        readonly earliest: readonly ItemTag[];
        readonly kinds: readonly ItemTag[];
        readonly atCopy: boolean;
      },
    ) => void,
    undecided?: (cell: PlaceId) => void,
  ): void {
    literalElements(this, order, error, undecided);
  }

  public typedByDefault(value: PlaceId): boolean {
    return typedByDefault(this, value);
  }

  /** A store's destination: the stored value's path; an added value's the collection's element (C9 r4.6). */
  public destPath(d: Definition): readonly string[] {
    return d.kind === "add" ? joinSteps(d.path, ["element"]) : d.path;
  }

  public ownIngress(item: Item, d: Definition, at: readonly string[]): boolean {
    return ownIngress(this, item, d, at);
  }

  public cellSited(site: SourceSite, item: Item, d: Definition): SourceSite {
    return cellSited(this, site, item, d);
  }

  public contributionSited(site: SourceSite, item: Item, d: Definition): SourceSite {
    return contributionSited(this, site, item, d);
  }

  public boundaryAt(d: Definition): void {
    boundaryAt(this, d);
  }

  public boundaryFor(item: Item, here: Obligation | null): void {
    boundaryFor(this, item, here);
  }

  public takeBackReadChecks(length: number): void {
    takeBackReadChecks(this, length);
  }

  public boundariesAt(items: readonly Item[], here: Obligation | null): void {
    boundariesAt(this, items, here);
  }

  /** The typed calls whose expected type the finishing read left open after a stop (`f18Kinds`). */
  readonly f18Open = new Set<PlaceId>();

  public ingressStores(
    skip?: (site: SourceSite) => boolean,
  ): readonly { readonly site: SourceSite; readonly label: string }[] {
    return ingressStores(this, skip);
  }

  public publish(written?: boolean): void {
    publish(this, written);
  }
}
