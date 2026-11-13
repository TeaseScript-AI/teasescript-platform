import type { Expression } from "../../ast.js";
import type { PlaceId, SourceSite, TypeTerm } from "../graph.js";
import { Admission } from "./admission.js";
import { admittedLevel } from "./admission/admitted.js";
import {
  closureCounts,
  LeftSlice,
  Unlisted,
  type Closure,
  type ClosureCounts,
} from "./admission/closure.js";
import { forgetDecision } from "./admission/decision.js";
import type { DecidedAt } from "./admission/model.js";
import {
  lostBy,
  receivingObligations,
  receivingRequirements,
  shapeOf,
  type ReceivingObligation,
  type ReceivingRequirement,
  type ReceivingResult,
} from "./admission/receiving.js";
import type { CorePass } from "./answers.js";
import type { DecisionWork, ReadWork } from "./answers.js";
import {
  BudgetExhausted,
  CapReached,
  DemandExhausted,
  demandAllowanceFor,
  joinParts,
  joinSteps,
  keptParts,
  keptSlice,
  type BudgetLimit,
} from "./budget.js";
import {
  isKeyId,
  keptKeyAt,
  keyDepthIn,
  keyIdPlace,
  restSteps,
  stepsArray,
  type CanonicalKey,
  type Rest,
} from "./contract/key-ids.js";
import type { Label } from "./contract/labels.js";
import { termAt, writtenOf } from "./contract.js";
import {
  captureContracts,
  captureDescriptors,
  epochOf,
  extractContract,
  levelProof,
  type CapturedContract,
  type ContractDescriptors,
  type ContractReader,
  type ContractRequest,
} from "./contract-descriptors.js";
import { withFacts } from "./consumers/reports/diagnostics.js";
import { enclosingStores, requiredStores } from "./consumers/stores/enclosing.js";
import { finishingRead, labelDomain } from "./consumers/finishing.js";
import { freshStores, ingressMark, markHolder, markValue } from "./consumers/stores/fresh.js";
import { mixed, mixedChoices, mixedJoin } from "./consumers/stores/mixed.js";
import type {
  CheapDecision,
  CheapFrontier,
  CheapShape,
  KeyReach,
  Landing,
  LandingQuestion,
  Reach,
} from "./consumers/model.js";
import { operations } from "./consumers/operations/operations.js";
import { receivers } from "./consumers/operations/receivers.js";
import { admittedStores, decide } from "./consumers/stores/stores.js";
import { cheapDecided } from "./consumers/syntax.js";
import { speakers, uses } from "./consumers/operations/uses.js";
import { keptKey, keyOf, keyPath, keyPlace, type Definition, type Key } from "./definitions.js";
import { withoutEmpty } from "./exact-path.js";
import type { FlowNode } from "./flow-graph.js";
import { REASON, STOPPED, type Item, type Writer } from "./items.js";
import { methodCategory } from "./method-categories.js";
import { Laminar } from "./narrowing/laminar.js";
import { siteKey, type CoreProgram } from "./program.js";
import { outsideSyntax } from "./slice-syntax.js";
import { propertyNames } from "./property-names.js";
import type { CoreDiagnostic, Obligation, SiteExpectation } from "./result.js";
import type { Work } from "./solver.js";
export { typedCall } from "./consumers/finishing.js";
export {
  leftOutCheck,
  leftOutCompletion,
  leftOutWarning,
  withoutRecords,
} from "./consumers/reports/left-out.js";
import { retainedModule } from "./retained/retained.js";
export type { Omission } from "./consumers/reports/left-out.js";

/*
 * The consumers of the type core: every use that needs a kind asks its operand's items. The quiet path answers first: a
 * consumer that every kind of the contract fits, with no `unknown`, asks nothing more. Otherwise: all items definite
 * and none fits is an error; some item does not fit, or an `unknown` is present, a warning with one obligation per
 * offending kind; all fit, quiet. Here: whole-number uses, conditions, operator operands, receivers and element
 * selections, shown values, dict keys, a `for`'s iterable, speaker field accesses, ADR 1.5's null default, stores and
 * arguments against their place's written or decided type (with admission's decisions and rejections), fallbacks and
 * defaults, and, where a consumer meets external data, the boundary check at its ingress. Saves are the storage
 * module's.
 */

/** Whether two passes reject the same stores: admission's passes repeat until they do. */
function sameStores(a: ReadonlyMap<number, unknown>, b: ReadonlyMap<number, unknown>): boolean {
  return a.size === b.size && [...a.keys()].every((uid) => b.has(uid));
}

let consumerOrder: (<T>(list: readonly T[]) => T[]) | null = null;

/** Test-only: runs `callback` with every analysis inside it visiting its consumers in `order` (ADR 0021 1.6). */
export function withConsumerOrder<T>(order: <U>(list: readonly U[]) => U[], callback: () => T): T {
  if (consumerOrder !== null) throw new Error("A consumer order is already active.");
  consumerOrder = order;
  try {
    return callback();
  } finally {
    consumerOrder = null;
  }
}

/** A stopped demand's answer: its key's contract, each item with the reason and the word `budget`. */
function withBudget(items: readonly Item[]): readonly Item[] {
  return items.map((item) =>
    item.tag === "empty"
      ? item
      : { ...item, reasons: item.reasons | REASON.budget, context: "budget" },
  );
}

/** Whether a program is outside the candidate slice's syntax (`slice-syntax.ts`), walked once per analysis. */
const OUTSIDE_SYNTAX = retainedModule<CoreProgram, boolean>("consumers.OUTSIDE_SYNTAX", "weakMap");
function outsideSliceSyntax(program: CoreProgram): boolean {
  let outside = OUTSIDE_SYNTAX().get(program);
  if (outside === undefined) {
    outside = outsideSyntax(program.files, program.globals) !== null;
    OUTSIDE_SYNTAX().set(program, outside);
  }
  return outside;
}

/** A store warning of the receiving completion's own check of its decisions' stores (`Consumers.completedWarnings`). */
export type CompletedWarning = Extract<CoreDiagnostic, { readonly obligation: Obligation }>;

/** A completion's results by their requirements' places and paths (`Consumers.#completeFor`). */
interface Completed {
  readonly index: ReadonlyMap<string, number>;
  readonly results: readonly (ReceivingResult | null | undefined)[];
}

/**
 * The selecting stores a completion's admission gives another target than the settled pass's (#1275, `retargeted` in
 * `answers.ts`): their receivers' keys, and whether any moved.
 */
export interface Retargeted {
  readonly receivers: readonly CanonicalKey[];
  readonly moved: boolean;
}

/** A receiving completion pass (#1526): the pass, made from a settled pass's inputs without its frozen keys. */
export interface CompletionPass {
  readonly pass: CorePass;
  readonly retargeted: (admission: Admission) => Retargeted;
}

/** A closure cell's name as the key it is (a decision's, a listing's: each named by its key). */
function keyed(name: string): CanonicalKey {
  // EVIDENCE: invariant: decisions and listings are named by their keys in their identities (`decidedOf`, `list`).
  return name as CanonicalKey;
}

/** A decided path in its identity, from its key (`keyed`): a cursor's by its key alone. */
function decidedAt(key: CanonicalKey): DecidedAt {
  return isKeyId(key)
    ? { root: keyIdPlace(key), key }
    : { root: keyPlace(key), path: keyPath(key) };
}

/** The walk's stages after admission's, in order (a stop keeps the findings of every unit before it). */
const STAGES = 4;

/** The stages before the walk's: admission's, and the capture of the stores' contracts once it settled (#1526). */
const ADMISSION = -2;
const EXTRACTION = -1;

/** The rank of a stop's own warning and marks among a site's diagnostics: after every consumer's (`Consumers.rules`). */
export const STOP_RULE = 5 + STAGES;

/**
 * A method whose body lives in `consumers/` is a function of its name there; the members those functions read are
 * public for them, and internal to the consumers.
 */
export class Consumers {
  readonly diagnostics: CoreDiagnostic[] = [];
  /**
   * The finishing path's warnings: the checks the stop or the nesting limit moved to the runtime, never shown
   * one by one; the stop's one warning counts them, and each function they stand in is marked not checked.
   */
  readonly deferred: Extract<CoreDiagnostic, { obligation: unknown }>[] = [];
  /**
   * Each diagnostic's rank, `diagnostics`' and `deferred`'s alike: its consumer's place in the order the consumers run,
   * from 1 (the published order's rules); the finishing path ranks its findings as the walk does.
   */
  readonly rules = new Map<CoreDiagnostic, number>();
  /** The rank of the consumer running now (`rules`): admission's three, the walk's four stages, the publication. */
  rule = 0;
  /** The limit the walk stopped at, or `null`. */
  stopped: BudgetLimit | null = null;
  /**
   * Whether admission settled in this pass: it rejects the stores the pass started with rejected (or it is the last
   * pass), its store targets are its own (#1275) and no decision stopped, so its findings stand.
   */
  settled = false;
  /** Whether admission's boundary checks were published (`Admission.publish`), the walk's last step. */
  published = false;
  /** The walk's place: its stage (`ADMISSION`, `EXTRACTION`, the walk's, `STAGES` publication) and its next unit. */
  #stage = ADMISSION;
  #unit = 0;
  /** Where the walk stopped, the stage and the unit it was in; `null` before a stop, or to finish every unit. */
  #stoppedAt: { readonly stage: number; readonly unit: number } | null = null;
  /** What the walk had found before the running unit: a stop takes its partial findings back. */
  #mark = { diagnostics: 0, readChecks: 0 };
  finishing = false;
  readonly #last: boolean;
  readonly #rejected: ReadonlyMap<number, ReadonlySet<Key>>;
  readonly #cycling: ReadonlySet<number>;
  /** A completion pass of this pass's inputs (`#completeFor`, #1526), `null` where none is made. */
  readonly #completion: (() => CompletionPass) | null;
  /**
   * Whether the store targets the pass keys by are its admission's own (#1275), asked before the walk: each receiver's
   * decision a lazy one of this pass's own (`decide`), bounded by the demand allowance as every decision is.
   */
  readonly #ownTargets: (
    admission: Admission,
    decide: (root: PlaceId, path: readonly string[]) => void,
  ) => boolean;
  /** Admission's decisions, rejections and boundary checks of external data at its ingress. */
  readonly admission: Admission;
  /** The values a consumer answered by the quiet path. */
  readonly quiet = new Set<PlaceId>();
  /** The class sides whose members' values a quiet proof has already marked quiet. */
  readonly quietSides = new Set<string>();
  /** Each consumer read's demand and the work it was the first to compute (counted here only). */
  readonly reads: ReadWork[] = [];
  /** The consumer reads whose demand stopped at its allowance. */
  demandStops = 0;
  /** Each admission decision's demand: its work, its allowance, whether it stopped. */
  readonly decisions: DecisionWork[] = [];
  /** The ledger's total past which the running admission decision stops (`decide`), or `null`. */
  deciding: number | null = null;
  /** Whether a decision stopped in this pass (`decide`): it is not settled. */
  decisionStopped = false;
  /**
   * Whether this pass restarted one whose decision stopped: a decision stopping here stops the analysis
   * (docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-183).
   */
  readonly restarted: boolean;
  #readingNode: FlowNode | null = null;
  #callableNodes: Map<unknown, number> | null = null;
  /** The order the consumers visit their lists in: source order, or a test's (`withConsumerOrder`). */
  readonly order: <T>(list: readonly T[]) => T[];
  // The per-pass memos below each name the module that reads them; this class holds them for the pass.
  /** Each `get` result's receiver, made in the constructor (names.ts). */
  readonly getOf = new Map<PlaceId, PlaceId>();
  /**
   * A removing method's result by its receiver, and whether it is always the element it removed (`removeFirst()`,
   * `removeAt(i)`); else (`remove`) a list's or set's gives `null` and a dict's its value, by the receiver; made in the
   * constructor (names.ts).
   */
  readonly removedOf = new Map<PlaceId, { readonly receiver: PlaceId; readonly always: boolean }>();
  /** Each call result's place of its function's result, made in the constructor (names.ts, host-frontier.ts). */
  readonly resultOfCall = new Map<PlaceId, PlaceId>();
  /** Each value's label's recipe (`keyLabel`, names.ts), made once from its owner's. */
  readonly labels = new Map<PlaceId, Label>();
  /**
   * What a label's walk up a projection chain asks, once per value (names.ts): the element step below each owner, and
   * whether each chain passes a derived list or starts at no place.
   */
  readonly elementSteps = new Map<PlaceId, string>();
  readonly derivedChains = new Map<PlaceId, boolean>();
  readonly anonymousChains = new Map<PlaceId, boolean>();
  /**
   * Per value read in the finishing path, the written type at its own path (`writtenRead`, finishing.ts), or `null`.
   */
  readonly writtenReads = new Map<PlaceId, TypeTerm | null>();
  /** Per value read, its key (`readKey`, names.ts), `null` for none. */
  readonly readKeys = new Map<PlaceId, Key | null>();
  /**
   * Per receiver key and property, whether its sources have the property (`propertyPresence`, operations/receivers.ts).
   */
  readonly presence = new Map<
    string,
    {
      readonly state: "none" | "some" | "all";
      readonly literal: Writer | null;
      readonly unknown: boolean;
    }
  >();
  /**
   * Per key and node, the unwritten parameter its read reaches through copies (`defaultSource`,
   * operations/fallbacks.ts).
   */
  readonly defaults = new Map<
    string,
    { readonly key: CanonicalKey; readonly at: FlowNode } | null
  >();
  /** The cheap deciders' shapes and frontiers, one per key, and their decisions, one per key and path (syntax.ts). */
  readonly cheapShapes = new Map<Key, CheapShape>();
  readonly cheapFrontiers = new Map<Key, CheapFrontier>();
  readonly cheapDecisions = new Map<Key, CheapDecision | null>();
  /** The places the script stores into, at any path (`copySource`, syntax.ts). */
  storedRoots: Set<PlaceId> | null = null;

  public constructor(
    readonly pass: CorePass,
    rejected: ReadonlyMap<number, ReadonlySet<Key>> = new Map(),
    cycling: ReadonlySet<number> = new Set(),
    last = false,
    finishing = false,
    restarted = false,
    ownTargets: (
      admission: Admission,
      decide: (root: PlaceId, path: readonly string[]) => void,
    ) => boolean = () => true,
    completion: (() => CompletionPass) | null = null,
  ) {
    this.#completion = completion;
    this.#rejected = rejected;
    this.#cycling = cycling;
    this.#last = last;
    this.restarted = restarted;
    this.#ownTargets = ownTargets;
    // (a walk made for the finishing path asks nothing from its start: admission's own setup asks values too)
    this.finishing = finishing;
    this.order = consumerOrder ?? ((list) => [...list]);
    this.admission = new Admission(
      pass,
      {
        run: (work) => this.solve(work),
        // (after a stop admission reads as every consumer does: the finishing read)
        read: (value, node, at) =>
          this.finishing ? finishingRead(this, value, node, stepsArray(restSteps(at))) : null,
        domain: (key) => this.stoppedDomain(key),
      },
      rejected,
      cycling,
    );
    const program = pass.program;
    for (const c of program.constraints) {
      if (c.kind === "get") this.getOf.set(c.result, c.receiver);
      if (c.kind === "operation" && c.receiver !== null) {
        const gives = methodCategory(c.contract.name)?.gives;
        if (gives?.kind === "removed")
          this.removedOf.set(c.result, {
            receiver: c.receiver,
            always: gives.fromList === "element",
          });
      }
      if (c.kind === "call") this.resultOfCall.set(c.result, program.functionOf(c.fn).result);
    }
  }

  /** The node a consumer reads at, its callable the spender of the work that follows (a stop's heaviest place). */
  public get reading(): FlowNode | null {
    return this.#readingNode;
  }

  public set reading(node: FlowNode | null) {
    this.#readingNode = node;
    // (a completion pass's work names no place: setup's, `#completeFor`)
    if (node !== null && !this.pass.closure)
      this.pass.program.work.spender = this.pass.program.spenderOf(node);
  }

  /**
   * A value's items at a node and a path: every consumer's one read, unstopped or finishing, so a stop's obligations
   * come from the same consumers as an unstopped analysis's. In the finishing path it reads what is
   * settled (`finishingRead`), `STOPPED` only where nothing is.
   */
  public valueItems(
    value: PlaceId,
    node: FlowNode | null,
    rest: readonly string[],
    requirement = false,
  ): readonly Item[] {
    if (this.finishing) return finishingRead(this, value, node, rest, requirement);
    const items = this.valueRun(value, node, rest);
    // (a stopped read of an ingress keeps its boundary check, structurally: the stop leaves its kinds unknown and its
    // reason `budget`, never its provenance, so its unknown is the ingress's external data, entering by it as an
    // unnarrowed read's, #1770; a projection's own read stays as it stopped, as its owner's read asks the occurrence's
    // check, which validates the whole value)
    const stopped = (item: Item) => (item.reasons & REASON.budget) !== 0;
    if (!items.some(stopped) || this.pass.contract.ingressOf(value) !== value) return items;
    return this.pass.contract.entered(
      value,
      items.map((item) => (stopped(item) ? { ...item, fromExternal: true } : item)),
    );
  }

  /**
   * After a stop, a value's items at a node and a path as the finishing read answers them (`finishingRead`), for the
   * route's questions (`CoreAnswers.#items`): one derivation with the consumers'.
   */
  public finishedItems(
    value: PlaceId,
    node: FlowNode | null,
    rest: readonly string[],
  ): readonly Item[] {
    return finishingRead(this, value, node, rest);
  }

  /** Per value and path, a typed parse's or load's expected type after a stop (`typedRead`, finishing.ts). */
  readonly typedReads = new Map<string, readonly Item[] | null>();

  /**
   * The external items a finishing read's domain brought (`heldIngress`, the finished contract's, `markDomain`): what its
   * key's stores hold, which the read's mark stands for (#1448).
   */
  readonly domainOwned = new WeakSet<Item>();

  /**
   * The boundary checks of external data at a consumer (`Admission.boundariesAt`): each item's boundary requests at
   * `here`, in order. A domain's item is the content of the warning that owns it there (#1448): where `leftOut`
   * says that warning was left out (`withoutRecords`), its requests are left out with it. An item no warning was asked
   * for keeps its requests. `here` may be its recipe, made only where a check is owed (`Admission.boundaryFor`).
   */
  public boundariesAt(
    items: readonly Item[],
    here: Obligation | (() => Obligation) | null,
    leftOut: (item: Item) => boolean = () => false,
  ): void {
    // (only a finishing read brings a domain item: an ordinary walk asks every item's boundary requests)
    if (!this.finishing) {
      for (const item of items) this.admission.boundaryFor(item, here);
      return;
    }
    // (each item looked up, charged: the finishing walk's charges never move a stop)
    this.pass.program.work.charge("checks", items.length);
    for (const item of items)
      if (!this.domainOwned.has(item) || !leftOut(item)) this.admission.boundaryFor(item, here);
  }

  /**
   * `boundariesAt` where the warnings owning a domain's items follow the requests: every other item's requests now, a
   * domain item's once those warnings were asked for (`send`), which the consumer always calls.
   */
  public boundariesBefore(
    items: readonly Item[],
    here: Obligation | (() => Obligation) | null,
  ): (leftOut?: (item: Item) => boolean) => void {
    if (!this.finishing) {
      for (const item of items) this.admission.boundaryFor(item, here);
      return () => {};
    }
    this.pass.program.work.charge("checks", items.length);
    const domain: Item[] = [];
    for (const item of items)
      if (this.domainOwned.has(item)) domain.push(item);
      else this.admission.boundaryFor(item, here);
    return (leftOut = () => false) => {
      // (each gone over again, charged)
      this.pass.program.work.charge("checks", domain.length);
      for (const item of domain) if (!leftOut(item)) this.admission.boundaryFor(item, here);
    };
  }

  /** Each host global's stores, made once (`storedAbove`, finishing.ts). */
  hostStores: Map<PlaceId, Definition[]> | null = null;

  /** Whether a finishing walk asks the solver nothing (`run`): nested past the limit, or after an unsettled stop. */
  public asksNothing(): boolean {
    return this.finishing && (this.pass.program.work.stopped === null || !this.settled);
  }

  /** A value's items at a node and a path, as a consumer's demand: past its allowance, its own key's contract. */
  public valueRun(value: PlaceId, node: FlowNode | null, rest: Rest): readonly Item[] {
    const items = this.run(this.pass.values.consumerItems(value, node, rest), () =>
      this.pass.contract.contractOfValueAt(value, rest),
    );
    // #1073: an item a type test narrowed from external data brings its ingress stores' boundary checks, whatever
    // its consumer then finds fitting, and host data no ingress store brought its check at the read's root (at
    // the site and with the target the consumers' own requests use, so one check); the test proves its kind, never its
    // ingress (a look at each of the read's items, at most one per kind, inside the read's own charged step)
    for (const item of items)
      if (item.fromExternal === true)
        this.admission.boundaryFor(item, () => this.#hostCheck(value));
    return items;
  }

  /** The boundary check of host data at a read's root occurrence (`valueRun`): its site, its text as the target. */
  #hostCheck(value: PlaceId): Obligation {
    const program = this.pass.program;
    let root = value;
    for (let projection = program.projOf.get(root); projection !== undefined;) {
      program.work.charge("checks");
      root = projection.owner;
      projection = program.projOf.get(root);
    }
    const site = program.places[root]?.site ?? program.places[value]!.site!;
    const label = program.textAt(site);
    return {
      kind: "copy-type",
      target: label,
      against: [],
      on: `validate external data ${label}`,
      site: { file: site.file, start: site.start, end: site.end },
      boundary: false,
    };
  }

  /**
   * A consumer's question of a value's items, one demand with the allowance of the read that asks it: a demand past it
   * stops, and the read answers its own key's `contract` with the reason `budget` (a contract past
   * its own allowance, or none, `STOPPED`). Nothing the stopped demand left unfinished is kept, so a later demand of the
   * same key, in either order, computes it again with its own allowance. In the finishing path after a stop the solver
   * answers only from what had finished, else `STOPPED`; it is not asked at all where nothing stopped (the units nested
   * past the nesting limit) nor where admission had not settled (a fresh pass, nothing finished: as the route's
   * questions, `CoreAnswers.#run`).
   */
  public run(work: Work<readonly Item[]>, contract?: () => Work<readonly Item[]>): readonly Item[] {
    if (this.finishing) return this.asksNothing() ? STOPPED : this.solve(work);
    const allowance = this.reading === null ? null : this.#demandAllowance(this.reading);
    try {
      return this.solve(work, allowance);
    } catch (error) {
      if (!(error instanceof DemandExhausted)) throw error;
      this.demandStops += 1;
      if (contract === undefined) return STOPPED;
      try {
        return withBudget(this.solve(contract(), allowance));
      } catch (again) {
        if (!(again instanceof DemandExhausted)) throw again;
        return STOPPED;
      }
    }
  }

  /**
   * After a program stop, the kinds a label's step reads of a key whose contract asked then is unsettled, from a proof
   * the stopped analysis holds (`labelDomain`: its finished contract, its written type, a retained decision), else
   * `null`: the label keeps its generic step (#1595).
   */
  public stoppedDomain(key: Key): readonly Item[] | null {
    return this.pass.program.work.stopped === null ? null : (labelDomain(this, key)?.kinds ?? null);
  }

  /**
   * A demand of the solver, its work counted to the read that asked it, within `allowance` where one is given
   * (a consumer's read; admission's decisions take the program's allowance alone).
   */
  public solve<T>(work: Work<T>, allowance: number | null = null): T {
    const ledger = this.pass.program.work;
    const before = ledger.own;
    let stopped = false;
    try {
      // (admission's own question inside a decision: what is left of the decision's allowance)
      const limit =
        allowance ?? (this.deciding === null ? null : Math.max(0, this.deciding - before));
      return limit === null ? this.pass.solver.run(work) : this.pass.solver.demand(work, limit);
    } catch (error) {
      stopped = error instanceof DemandExhausted;
      throw error;
    } finally {
      if (this.reading !== null && ledger.own > before)
        this.reads.push({
          node: this.reading.id,
          units: ledger.own - before,
          allowance: this.#demandAllowance(this.reading),
          bounded: allowance !== null,
          stopped,
        });
    }
  }

  /**
   * The stores and transfers at a key whose decision stopped: the stop stands for their obligations, so each owes its
   * check at its site when the script runs, against its destination's complete type where admission
   * proves it apart from the stopped decision (#1440: the written type, or the one the declaration's start value copies
   * there), else marked with its type undecided, as a stop before admission settled marks every store into an inferred
   * place: `requiredStores`, as for the stores above a stop. A key below it is asked on its own, so a key a restarted
   * pass carried stopped keeps its stores' checks (#1310); each key once a pass, so a receiver asking it again scans no
   * store again.
   */
  public stoppedStores(root: PlaceId, path: readonly string[]): void {
    const { program, definitions } = this.pass;
    const at = keptKey(program.work, root, path);
    if (this.#stoppedKeys.has(at)) return;
    this.#stoppedKeys.add(at);
    const lists = [definitions.byKey.get(at) ?? []];
    // (an add stores at its receiver's element)
    if (path.at(-1) === "element")
      lists.push(
        definitions.byKey.get(keyOf(root, keptSlice(program.work, path, 0, path.length - 1))) ?? [],
      );
    const stores: Definition[] = [];
    for (const list of lists)
      for (const d of list) {
        program.work.charge("checks");
        if (d.value === undefined || (d.kind !== "whole" && d.kind !== "add")) continue;
        const stored = d.kind === "add" ? joinSteps(d.path, ["element"]) : d.path;
        if (keyOf(d.place, stored) === at) stores.push(d);
      }
    requiredStores(this, root, path, true, stores);
  }

  readonly #stoppedKeys = new Set<Key>();

  /**
   * A demand's allowance: 256 × the nodes of the reading site's function, or of the whole program at a file's top
   * level (a top-level read reads the globals every file stores, so its file's nodes do not bound its work).
   */
  #demandAllowance(node: FlowNode): number {
    const { program } = this.pass;
    if (this.#callableNodes === null) {
      this.#callableNodes = new Map();
      for (const found of program.flow.nodes) {
        const callable = program.flow.callableOf(found.region);
        if (callable?.kind === "function")
          this.#callableNodes.set(callable, (this.#callableNodes.get(callable) ?? 0) + 1);
      }
    }
    const callable = program.flow.callableOf(node.region);
    return demandAllowanceFor(
      callable?.kind === "function"
        ? (this.#callableNodes.get(callable) ?? 0)
        : program.flow.nodes.length,
    );
  }

  /** A consumer answered by the quiet path. */
  public skip(...values: readonly (PlaceId | undefined)[]): void {
    this.pass.program.work.charge("checksSkipped");
    for (const value of values) if (value !== undefined) this.quiet.add(value);
  }

  /** The phase of this pass the stop came in: admission's walk, the consumers' walk or the publication; else `null`. */
  public stopPhase(): "admission" | "extraction" | "walk" | "publication" | null {
    if (this.stopped === null || this.#stoppedAt === null) return null;
    const { stage } = this.#stoppedAt;
    return stage === ADMISSION
      ? "admission"
      : stage === EXTRACTION
        ? "extraction"
        : stage === STAGES
          ? "publication"
          : "walk";
  }

  /**
   * Every consumer of the program, once. A stop (the work allowance, a read chain's depth) ends the walk: the units it
   * finished keep their findings, the running unit's are taken back; whether they stand is `settled`'s, since a later
   * admission pass, rejecting other stores, may still change them.
   */
  public check(): void {
    try {
      this.rule = 1;
      // (the decisions that can stop, before the first: what a stop forgets by is kept for their places alone, #1599)
      this.pass.contract.openDecisions(this.admission.groups());
      admittedStores(this);
      this.rule = 2;
      for (const { site, label } of this.admission.ingressStores()) {
        ingressMark(this, site, label);
        this.#ingressSites.push(site);
      }
      this.rule = 3;
      // (a literal or join a stop left undecided (#2289) is not compared: its holders' stores are marked)
      this.admission.literalElements(
        this.order,
        (site, found) => mixed(this, site, found),
        undefined,
        (cell) => markHolder(this, cell),
      );
      this.admission.joinElements(
        this.order,
        (found) => mixedJoin(this, found),
        undefined,
        (value) => markValue(this, value),
      );
      // (a pass whose admission gives the stores below a selection other targets starts the passes again, #1275; one in
      // which a decision stopped is not settled either: the next starts with its key stopped,
      // docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-180)
      const own = this.#ownTargets(this.admission, (root, path) => {
        decide(this, { root, path }, true);
      });
      // (no decision stops from here on, the targets' included: what a stop forgets by is dropped, #1599)
      this.pass.contract.closeDecisions();
      this.settled =
        own &&
        (this.#last || sameStores(this.admission.newlyRejected, this.#rejected)) &&
        !this.decisionStopped;
      // (admission's findings are the walk's before its first unit)
      this.#mark = {
        diagnostics: this.diagnostics.length,
        readChecks: this.admission.readChecks.length,
      };
      // (the contracts the stores' checks require, while the solver still runs: a later stop finds them retained)
      if (this.settled) {
        this.#stage = EXTRACTION;
        this.#capture();
      }
      this.#walk();
      // (the walk's findings stand whole before the publication: a stop in it takes none of them back)
      this.#stage = STAGES;
      this.rule = 4 + STAGES;
      this.#mark = {
        diagnostics: this.diagnostics.length,
        readChecks: this.admission.readChecks.length,
      };
      this.admission.publish();
      this.published = true;
      // (a mixed askChoice ranks as an operation, `enter(0)`'s rank, but runs after the publication, so its reads move
      // no other read's stop; after it only the facts are read, with no demand allowance, #1352, #1660)
      this.rule = 4;
      mixedChoices(this);
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      this.pass.program.work.stop(error.limit);
      this.stopped = error.limit;
      this.#stoppedAt = { stage: this.#stage, unit: this.#unit - 1 };
      this.diagnostics.length = this.#mark.diagnostics;
      this.admission.takeBackReadChecks(this.#mark.readChecks);
    }
  }

  /**
   * The capture (#1526): once admission settled, before the walk, the contract of each destination whose store
   * admission owes a check so far (its store warnings and its ingress stores), read level by level
   * through the answers' own level reader (`admittedLevel`), so each level's decision and contract are made and kept while
   * the solver still runs. Each request is an owing site and the place and path the `let` or assignment holding it stores
   * into (its statement's first live store, else its first, as `Answers.at` reads one), each destination once, in the
   * consumers' order; its result is kept (`captured`). A program outside the candidate slice's syntax (`slice-syntax.ts`,
   * the rule the candidate route declines by before its analysis) gets no store check, so the capture makes no request
   * and charges nothing there: its analysis is main's. In a pass that starts with frozen keys, its receiving
   * obligations are completed later, in a completion pass of their own after everything that can stop (`receive`, from
   * `asked`), so this pass publishes what it would without them.
   */
  #capture(): void {
    // (the receiving seed's store sites: admission's store warnings as they stand when the capture runs, #1526; saved
    // before the capture, which can stop, so a settled pass always has its seed and a stop's gate its obligations: an
    // absent seed is never read as an empty one)
    const storeSites: { site: SourceSite; stopped: boolean }[] = [];
    for (const d of this.#storeWarnings())
      storeSites.push({ site: d.site, stopped: d.provenance.context === "budget" });
    this.#storeSites = storeSites;
    this.#captureOwedContracts();
  }

  /** The store warnings among the diagnostics so far: each runtime-check of kind `written-target`, rule `store`. */
  #storeWarnings(): CompletedWarning[] {
    const found: CompletedWarning[] = [];
    for (const d of this.diagnostics)
      if (
        d.class === "warning-runtime-check" &&
        d.kind === "written-target" &&
        d.rule.rule === "store"
      )
        found.push(d);
    return found;
  }

  /** The receiving seed's store sites (`#capture`); `null` in a pass whose admission did not settle. */
  #storeSites: readonly { readonly site: SourceSite; readonly stopped: boolean }[] | null = null;

  /**
   * The receiving obligations of a pass whose admission settled, found once, without a completion (#1526): what a
   * published plan's gate reads after a stop where no receiving completion ran (`Answers.gated`); `null` where
   * admission did not settle. Every store and slot visited charged, as `receive` charges them.
   */
  public stopObligations(): readonly ReceivingObligation[] | null {
    if (this.#storeSites === null) return null;
    this.#stopObligations ??= receivingObligations(this.admission, {
      epoch: epochOf(this.pass),
      storeSites: this.#storeSites,
      ingressSites: this.#ingressSites,
      siteKey,
    });
    return this.#stopObligations;
  }

  #stopObligations: readonly ReceivingObligation[] | undefined;

  /** Whether the receiving completion was asked for (`receive`), once. */
  #received = false;

  /** The site of the request at which the capture ended where the program left the slice's depth (`captureContracts`). */
  #leftSlice: SourceSite | null = null;

  /** The capture of each owing destination's contract (`#capture`). */
  #captureOwedContracts(): void {
    const { program, definitions, lists } = this.pass;
    const sites = new Map<string, SourceSite>();
    // (a stopped decision's own marks, the reason `budget`, stand for their stores' checks: the stop owes them, and a
    // stopped key decides nothing to capture)
    for (const d of this.#storeWarnings())
      if (d.provenance.context !== "budget") sites.set(siteKey(d.site), d.site);
    for (const site of this.#ingressSites) sites.set(siteKey(site), site);
    // (a program outside the candidate slice's syntax has no store check to keep: the capture makes no request and
    // charges nothing there, the analysis exactly main's; the syntax walk is the candidate route's own, uncharged as the
    // route runs it before its analysis)
    if (sites.size === 0 || outsideSliceSyntax(program)) return;
    const destinations = new Map<FlowNode, Definition>();
    for (const d of definitions.storeDefs)
      if (!destinations.has(d.node) && lists.live(d)) destinations.set(d.node, d);
    for (const d of definitions.storeDefs)
      if (!destinations.has(d.node)) destinations.set(d.node, d);
    // (a site owes its check at the `let` or assignment whose stored value holds it, however deep inside: the statement
    // a store definition takes effect at (`effectNode`), as the lowering finds the store of an obligation's expression
    // (`SliceIndex.storeOf`) and reads its destination at that statement's node (`Answers.at`); host data in an object
    // literal's property is the whole store's)
    const requests: ContractRequest[] = [];
    const requested = new Set<Definition>();
    for (const site of sites.values()) {
      const node = program.effectNode(site);
      const kind = node?.statement?.kind;
      if (node === null || (kind !== "letStatement" && kind !== "assignmentStatement")) continue;
      // (each destination once, by its store: no key text made; the first owing site names it)
      const destination = destinations.get(node);
      if (destination === undefined || requested.has(destination)) continue;
      requested.add(destination);
      requests.push({ site, place: destination.place, path: destination.path });
    }
    const reader = this.#contractReader(null);
    // (its work is the capture's, no consumer read's)
    this.reading = null;
    const left = captureContracts(
      this.order(requests),
      reader,
      epochOf(this.pass),
      this.captured,
      (error) => error instanceof BudgetExhausted,
      () => program.work.charge("checks", definitions.storeDefs.length + sites.size),
    );
    if (left === null) return;
    this.#leftSlice = left.site;
    // (the candidate route ends here, at the refusal the capture established, before the walk: the lowering's check of
    // that store would leave the slice at it; every other client hears nothing and has the whole analysis)
    program.leftSlice?.(left.site);
  }

  /**
   * #1526: the pass's receiving obligations (`admission/receiving.ts`: the store checks the walk owes, a stopped
   * decision's stores among them, every live store that brings external data), each completed in the completion pass
   * (`#completeFor`) and kept with its result (`receiving`), in the stable source order, then `again` (the questions
   * asked again with the completed contracts, `asked`), whose result it returns. It runs after everything of the analysis
   * that can stop (#1637): once, on an analysis whose admission settled with a decision stopped and
   * whose questions ran to their end, inside the slice (the capture's gate). It never makes or moves a stop: its
   * allowance is the smaller of twice the work charged before it and what is left of the total, and reaching it (or a
   * read past the read-depth limit) ends it with no result kept (`capped`), every obligation without one and nothing
   * asked again, the capture's answers standing. Anywhere else it does nothing and returns `null`.
   */
  public receive<T>(again: () => T): T | null {
    const work = this.pass.program.work;
    if (
      this.#received ||
      this.#storeSites === null ||
      this.stopped !== null ||
      work.stopped !== null ||
      !this.pass.contract.anyStopped ||
      this.#completion === null ||
      outsideSliceSyntax(this.pass.program) ||
      this.#leftSlice !== null
    )
      return null;
    this.#received = true;
    // (all its work counted to setup's, which names no place: the heaviest place a stop's warning names stays this
    // pass's)
    const spender = work.spender;
    work.spender = 0;
    try {
      return this.#receiveCounted(again);
    } finally {
      work.spender = spender;
    }
  }

  /** `receive`, its work counted to setup's. */
  #receiveCounted<T>(again: () => T): T | null {
    const work = this.pass.program.work;
    const since = work.total;
    const storeSites = this.#storeSites!;
    this.reading = null;
    let obligations: readonly ReceivingObligation[] = [];
    let value: T | null = null;
    let ended = false;
    try {
      value = work.capped(Math.min(2 * since, work.allowance - since), () => {
        obligations = receivingObligations(this.admission, {
          epoch: epochOf(this.pass),
          storeSites,
          ingressSites: this.#ingressSites,
          siteKey,
        });
        const { index, results } = this.#completeFor(obligations, since);
        for (const obligation of obligations) {
          const at = index.get(joinParts(obligation.place, obligation.path));
          this.receiving.push({
            obligation,
            result: at === undefined ? null : (results[at] ?? null),
          });
        }
        // (nothing completed, nothing to ask again)
        return this.receiving.some(({ result }) => result !== null) ? again() : null;
      });
    } catch (error) {
      if (!(error instanceof CapReached) && !(error instanceof BudgetExhausted)) throw error;
      ended = true;
    }
    // (its units counted to its end: the decisions' records, the results' index and the questions asked again included)
    const units = work.total - since;
    if (!ended) {
      if (this.completion !== null) this.completion = { ...this.completion, units };
      return value;
    }
    // (past its allowance nothing of it is kept, wherever in it the allowance ended: every obligation without a result, no
    // decision's record, no check's site)
    this.receiving.length = 0;
    for (const obligation of obligations) this.receiving.push({ obligation, result: null });
    this.completedChecks.clear();
    this.completedWarnings.length = 0;
    this.completion = {
      units,
      counts: { ...(this.completion?.counts ?? closureCounts()), capped: 1, cappedAt: units },
      decisions: [],
      ran: null,
    };
    return null;
  }

  /**
   * #1526: the receiving closure's completion of `obligations` in a completion pass, made once from
   * this pass's inputs (its rejections, its store targets) without its frozen keys, and thrown away after. Every
   * obligation is extracted there through the same level reader; a decision a level asks for is made where it is first
   * asked, a scoped decision from what is left of the total, in that pass's own fresh `Admission`, so nothing
   * is unfrozen and no cache holds a frozen key's answer; each listing is a cell the frontier schedules, taken whole by a
   * search that reaches it (`Closure.run`). Nothing of it is this pass's: its answers, decisions and stops stand, and the
   * results are kept as each obligation's (`receive` keeps them in `receiving`). Its work is this
   * analysis's, charged where made; its allowance's end (`CapReached`, `receive`) ends it with no result kept.
   */
  #completeFor(obligations: readonly ReceivingObligation[], since: number): Completed {
    const { pass, retargeted } = this.#completion!();
    const closure = pass.closure!;
    // (#1599's records closed where the pass was made, `createPass`)
    const completer = new Consumers(pass, this.#rejected, this.#cycling, this.#last, false, true);
    const requirements = receivingRequirements(pass.program.work, obligations);
    const results: (ReceivingResult | null | undefined)[] = requirements.map(() => undefined);
    const work = pass.program.work;
    try {
      completer.#completeIn(closure, requirements, results, epochOf(this.pass), retargeted);
    } finally {
      // (its counters kept wherever it ended, its records only where it ran to its end: `receive` drops them past its
      // allowance)
      this.completion = {
        units: work.total - since,
        counts: { ...closure.counts },
        decisions: [],
        ran: null,
      };
      closure.close();
    }
    for (const site of completer.completedChecks) this.completedChecks.add(site);
    this.completedWarnings.push(...completer.completedWarnings);
    const local = demandAllowanceFor(pass.program.flow.nodes.length);
    const records = closure.decisions.map(({ key, units, allowance }) => ({
      key: keyed(key),
      work: {
        ...completer.admission.decisionWork(decidedAt(keyed(key)), units, allowance, false),
        completion: { local },
      },
    }));
    // (the decisions whose stores the completion's own store check ran at, bound to the epoch of the pass it completed:
    // none where it left the slice)
    this.completion = {
      ...this.completion,
      decisions: records.map(({ work }) => work),
      ran: {
        epoch: epochOf(this.pass),
        checked: records.filter(({ key }) => completer.#ran.has(key)).map(({ work }) => work),
      },
    };
    const index = new Map<string, number>();
    requirements.forEach((r, at) => index.set(keptParts(work, r.place, r.path), at));
    return { index, results };
  }

  /** The completion pass's own run of the frontier over its requirements (`#completeFor`). */
  #completeIn(
    closure: Closure,
    requirements: readonly ReceivingRequirement[],
    results: (ReceivingResult | null | undefined)[],
    epoch: number,
    retargeted: CompletionPass["retargeted"],
  ): void {
    this.reading = null;
    const { extract, dirty, descriptors, list } = this.#extraction(
      requirements,
      results,
      epoch,
      closure,
    );
    closure.handle("decision", (name) => forgetDecision(this.admission, keyed(name)));
    closure.handle("listing", (name) => this.propertySets.delete(keyed(name)));
    closure.handle("extent", (key) => descriptors.forget(key));
    closure.handle("request", (name) => dirty.add(Number(name)));
    // (a literal's element of another family is rejected outside every decision's check: the whole program's are
    // checked first, as the walk checks them, so each decision they make is made before a request reads it; a store
    // they reject that the settled pass did not is a rejection, below; a list join's check returns with joins to the
    // slice's syntax, which has none)
    this.admission.literalElements(this.order, () => {});
    // (the first request that reaches the slice's depth ends the completion, as it ends the capture: the program
    // has left the slice, where main's lowering requests nothing more, so no result of it is kept or published)
    try {
      closure.run({
        requests: requirements.length,
        extract,
        list,
        listed: (key) => this.propertySets.has(keyed(key)),
      });
    } catch (error) {
      if (!(error instanceof LeftSlice)) throw error;
      closure.counts.leftSlice = 1;
      results.fill(null);
      return;
    }
    // #1275: a completion decision that would reject a store or give a selecting store another target than the
    // settled pass's inputs leaves every obligation whose proof read it lost with that cause: never a refusal, a
    // widening or a changed settled answer. Each decision the completion made has its stores checked as the walk checks
    // them (`admittedStores`), its rejections heard against the stores the settled pass rejected there: the frontier's,
    // and each one made after them, as retargeting's reads pull a receiver's decision, to the fixed point (#2184). The
    // keys checked are the record `Answers.completionRan` reads (`#ran`, `completion.ran`).
    const { receivers, moved } = retargeted(this.admission);
    for (const key of receivers) closure.mark(key, "retarget");
    const rejected = new Set<number>();
    for (let at = 0; at < closure.decisions.length; at += 1) {
      const key = keyed(closure.decisions[at]!.key);
      if (this.#ran.has(key)) continue;
      this.#ran.add(key);
      rejected.clear();
      this.admission.hearingRejections(
        (d) => rejected.add(d.uid),
        () => admittedStores(this, false, decidedAt(key)),
      );
      const before = this.admission.retaken.get(key) ?? [];
      if (rejected.size !== before.length || before.some((d) => !rejected.has(d.uid)))
        closure.mark(key, "rejection");
    }
    // (the stores rejected, by the decisions' checks and the literals' and joins', against the settled pass's)
    let joined = false;
    for (const [uid, keys] of this.admission.newlyRejected) {
      const before = this.#rejected.get(uid);
      if (before === undefined || [...keys].some((key) => !before.has(key))) joined = true;
    }
    // (where that check owes a store's runtime check, the unstopped analysis owes it too)
    const warnings: CompletedWarning[] = [];
    for (const d of this.diagnostics)
      if (d.class === "warning-runtime-check" && d.kind === "written-target") {
        this.completedChecks.add(siteKey(d.site));
        warnings.push(d);
      }
    // (a rejected or retargeted store's value reaches other contracts through copies, projections and wrappers, which
    // no cell of the closure records: once any completion decision would reject or retarget a store, every obligation
    // is lost, with the cause of a marked decision its proof read, else the first mark's)
    const beside = moved ? "retarget" : joined ? "rejection" : null;
    const lost = closure.unsettled(requirements.length, beside);
    for (const [index, cause] of lost) {
      if (results[index]?.state === "complete") closure.counts.forgone += 1;
      results[index] = lostBy(requirements[index]!, cause);
    }
    // (#1682: the obligations that check owes, the natural walk's own on the settled pass's inputs, kept only where the
    // completion lost nothing: a part check below a store's destination reads them as it reads the unstopped ones)
    if (lost.size === 0) this.completedWarnings.push(...warnings);
  }

  /**
   * The extraction of `requirements` into `results` over this pass, through the answers' own level reader: a complete
   * extent's contract by the descriptor service, a shape by its level. With `closure` (a completion pass), each request,
   * assembly, decision and listing is its cell; a listing's search takes the made listings it reaches whole, follows one
   * the frontier has parked, and defers any other, so a request whose listing deferred a key waits on it (`Unlisted`).
   */
  #extraction(
    requirements: readonly ReceivingRequirement[],
    results: (ReceivingResult | null | undefined)[],
    epoch: number,
    closure: Closure | null,
  ): {
    readonly extract: (index: number) => void;
    readonly dirty: Set<number>;
    readonly descriptors: ContractDescriptors<null>;
    readonly list: (key: string) => ReadonlySet<string> | { readonly deferred: readonly string[] };
  } {
    const { program, contract } = this.pass;
    // (a listing's search in a completion pass: the made listings it reaches taken whole, a parked one followed, and so
    // is a key deeper than its own: that search's pump bound ends a chain that deepens forever, #1493's feedback copy
    // `w = r.z`, which listings deferring each deeper key to the next would never end; any other key deferred to its own
    // cell, so every listing is of a key no deeper than a request's, finitely many)
    const list = (
      asked: string,
    ): ReadonlySet<string> | { readonly deferred: readonly string[] } => {
      const key = keyed(asked);
      program.work.charge("checks");
      const depth = keyDepthIn(contract, key);
      const deferred = new Set<string>();
      const names = closure!.alone("listing", key, () =>
        propertyNames(
          this.pass,
          (work) => this.solve(work),
          { key },
          undefined,
          (below) => {
            const made = this.propertySets.get(below);
            if (made !== undefined) {
              closure!.took("listing", below);
              return made;
            }
            program.work.charge("checks");
            if (closure!.parked(below) || keyDepthIn(contract, below) > depth) return "follow";
            deferred.add(below);
            return "defer";
          },
        ),
      );
      if (deferred.size > 0) return { deferred: [...deferred] };
      this.propertySets.set(key, names);
      closure!.made("listing", key);
      return names;
    };
    const reader = this.#contractReader(closure === null ? null : { closure, list });
    const descriptors = captureDescriptors(reader, epoch, closure);
    const dirty = new Set<number>();
    const extract = (index: number): void => {
      if (results[index] !== undefined && !dirty.has(index)) return;
      dirty.delete(index);
      const { place, path, extent } = requirements[index]!;
      const make = (): ReceivingResult | null =>
        extent === "complete"
          ? extractContract(descriptors, place, path)
          : shapeOf(reader.level(place, path));
      results[index] =
        closure === null
          ? make()
          : closure.within("request", String(index), () => {
              // (a binding reads its pass's targets and rejections: another pass binds the slot anew)
              closure.took("fact", `targets@${epoch}`);
              closure.took("fact", `rejected@${epoch}`);
              return make();
            });
      // (a contract that reaches the slice's depth: the program has left the slice, the completion ends)
      if (closure !== null && extent === "complete" && results[index] === null)
        throw new LeftSlice();
    };
    return { extract, dirty, descriptors, list };
  }

  /**
   * The answers' own level reader over this pass (`admittedLevel`): a level's contract by its admitted type, else its
   * key's contract; a key's property names, kept (`propertySets`), none where its decision stopped. With `completion`
   * (a completion pass's closure and its listing search), a listing is its cell, made by `list`, and one not yet made
   * makes the request wait on it (`Unlisted`).
   */
  #contractReader(
    completion: {
      readonly closure: Closure;
      readonly list: (
        key: string,
      ) => ReadonlySet<string> | { readonly deferred: readonly string[] };
    } | null,
  ): ContractReader {
    const { program, contract } = this.pass;
    return {
      level: (place, path) => {
        const written = writtenOf(program.place(place).kind);
        const admitted = admittedLevel(
          this.admission,
          place,
          path,
          written === null ? null : termAt(written, path),
          { stopped: false, settled: true, cheap: () => null },
        );
        return levelProof(admitted, () =>
          withoutEmpty(this.solve(contract.contractOf(keyOf(place, path)))),
        );
      },
      // (as `Answers.placeProperties` finds them: a key whose decision stopped names nothing; in a completion pass a
      // listing is its cell, and one not yet made makes the request wait on it)
      properties: (place, path) => {
        // (kept with the names it finds: its text charged where it is text, `keptKeyAt`)
        const key = keptKeyAt(contract, place, path);
        const known = this.propertySets.get(key);
        if (known !== undefined) {
          completion?.closure.took("listing", key);
          return known;
        }
        if (completion === null) {
          const names: ReadonlySet<string> =
            contract.anyStopped && contract.keyStopped(key)
              ? new Set()
              : propertyNames(this.pass, (asked) => this.solve(asked), { key });
          this.propertySets.set(key, names);
          return names;
        }
        const found = completion.list(key);
        if ("deferred" in found) throw new Unlisted(key, found.deferred);
        completion.closure.took("listing", key);
        return found;
      },
    };
  }

  /**
   * The receiving closure's completion where one ran (`receive`): the units it charged to the total from its start (its
   * obligations found, its completion pass and the questions asked again), its counters and decisions, else `null`; and
   * `ran`, the decisions at which its own store check ran, with the epoch of the pass it completed, which the plan
   * reads to keep a stopped decision's mark with no check (`Answers.completionRan`, #2080, #2184): `null` where it
   * reached its allowance, wherever in it; none where it left the slice.
   */
  completion: {
    readonly units: number;
    readonly counts: ClosureCounts;
    readonly decisions: readonly DecisionWork[];
    readonly ran: { readonly epoch: number; readonly checked: readonly DecisionWork[] } | null;
  } | null = null;

  /** The keys at which the completion's own store check ran (`#completeIn`), each once. */
  readonly #ran = new Set<CanonicalKey>();

  /**
   * The sites at which the receiving completion's own check of its decisions' stores (`#completeIn`) owes a runtime
   * check, by `siteKey`: where the unstopped analysis checks a store, which a store's check there takes from the
   * completion (#1526).
   */
  readonly completedChecks = new Set<string>();

  /**
   * The store warnings the receiving completion's own check of its decisions' stores made (`#completeIn`), the
   * natural walk's obligations of those decisions on the settled pass's inputs (#1682): none where the completion lost a
   * result (the whole loss), reached its allowance or left the slice. Only a store's part checks read them.
   */
  readonly completedWarnings: CompletedWarning[] = [];

  /** Each receiving obligation with its result as the completion found it (`receive`), in the stable source order. */
  readonly receiving: {
    readonly obligation: ReceivingObligation;
    readonly result: ReceivingResult | null;
  }[] = [];

  /**
   * The property names the capture found for each decided object it filled, by the object's key in its identity: the
   * answers read them from here (`Answers.placeProperties`), so the search the capture made is not made again.
   */
  readonly propertySets = new Map<CanonicalKey, ReadonlySet<string>>();

  /** The stores' required contracts as the capture found them (`#capture`), in the order captured. */
  readonly captured: CapturedContract[] = [];

  /** The ingress stores' sites admission's walk marked, which the capture takes (`#capture`). */
  readonly #ingressSites: SourceSite[] = [];

  /** The consumers that operations, uses, receivers and speakers are, in that order (the walk's stages). */
  #walk(): void {
    operations(this);
    uses(this);
    receivers(this);
    speakers(this);
  }

  /**
   * The finishing path: the units a stop left, or with `all` every one (admission did not
   * settle, so nothing before the stop stands), and the units nested past the nesting limit, each with no further
   * proving: every value they read is `unknown` with the reason `budget` (`STOPPED`), so each consumer owes its check,
   * its warning one of `deferred`. With `all`, also the stores' obligations admission's walk would have made, no
   * decision read (`freshStores`). Without `all`, admission settled: what it decided and what the walk found before the stop stand,
   * and a publication the stop cut or never reached finishes against those decisions, the solver
   * answering only what it had finished. Bounded by the units, each a constant number of steps besides its own syntax.
   */
  public finish(all: boolean): void {
    this.finishing = true;
    // (after a program stop each label's recipe is made wholly after it, as its steps and derived lists are read then:
    // none straddles it, half from before and half from after, #1595, #1687; a finishing path without a stop, the units
    // nested past the nesting limit, keeps the recipes already made)
    if (this.pass.program.work.stopped !== null) {
      this.labels.clear();
      this.elementSteps.clear();
      this.derivedChains.clear();
      this.admission.keyLabels.clear();
    }
    // (after a stop no decision stops: what a stop forgets by is dropped, #1599)
    this.pass.contract.closeDecisions();
    this.#stoppedAt = all ? null : (this.#stoppedAt ?? { stage: STAGES, unit: 0 });
    this.#walk();
    // (the stores' obligations rank as admission's do)
    this.rule = all ? 1 : 4 + STAGES;
    if (all) freshStores(this);
    else if (!this.published) {
      // (from its start: what the cut publication had made is made again)
      this.admission.boundaries.clear();
      this.admission.publish();
      this.published = true;
    }
  }

  /**
   * Whether the walk runs its next unit at `site`: in the analysis, every unit but those nested past the limit (checked
   * when the script runs); in the finishing path, those and the units the stop left. Marks what was found before it.
   * Call it once per unit, in the walk's order: it advances the unit a stop resumes from.
   */
  public startUnit(site: SourceSite): boolean {
    const unit = this.#unit;
    this.#unit += 1;
    this.#mark = {
      diagnostics: this.diagnostics.length,
      readChecks: this.admission.readChecks.length,
    };
    const deep = this.pass.program.isDeep(site);
    if (!this.finishing) return !deep;
    const at = this.#stoppedAt;
    return (
      deep || at === null || this.#stage > at.stage || (this.#stage === at.stage && unit >= at.unit)
    );
  }

  /** The walk enters its stage `stage` (`#walk`'s order). */
  public enter(stage: number): void {
    this.#stage = stage;
    this.#unit = 0;
    this.rule = 4 + stage;
  }

  /** What the stores' syntax decides at `path` of `root` after a stop (syntax.ts), for the answers' level reader. */
  public cheapDecided(root: PlaceId, path: readonly string[]): CheapDecision | null {
    return cheapDecided(this, root, path);
  }

  /**
   * The stores above a stopped decision: each checked against its destination's complete type, or marked (#1416).
   * `admittedStores` calls it through here: stores/enclosing.ts imports stores/fresh.ts, which imports
   * stores/stores.ts, so a direct import would close a cycle.
   */
  public enclosingStores(): void {
    enclosingStores(this);
  }

  // stores/enclosing.ts:
  /** The destinations `enclosingStores` resolved this pass, a whole store's key and an add's receiver's apart. */
  readonly enclosed = new Set<Key>();
  readonly enclosedAdds = new Set<Key>();
  /** Their stores checked against the complete type, by uid, once (`enclosingStores`). */
  readonly required = new Set<number>();
  /** Each such destination's complete type, which its stores' checks carry into the plan whole (`Answers.requirement`). */
  readonly requirements = new Map<Key, TypeTerm>();

  // stores/fresh.ts: the stores and transfers it marked (`storeMark`), their values' spans by file (`inMarkedValue`),
  // the values and typed calls marked at their own sites (`literalMark`, `ingressMark`), and each held value's cell and
  // each value's stores (`markValue`).
  readonly marked = new Set<number>();
  markedSpans: Map<number, Laminar<null>> | null = null;
  readonly markedLiterals = new Set<PlaceId>();
  readonly markedIngress = new Set<string>();
  heldIn: Map<PlaceId, PlaceId> | null = null;
  storesOf: Map<PlaceId, Definition[]> | null = null;

  public withFacts(diagnostic: CoreDiagnostic): CoreDiagnostic {
    return withFacts(this, diagnostic);
  }

  /** `readsAbsent`'s answer per expression (reports/diagnostics.ts). */
  readonly absentReads = new Map<Expression, boolean>();

  /** `expected`'s answer per site (reports/expected.ts). */
  readonly expectations = new Map<string, SiteExpectation>();

  /** `readsTakeTask`'s answer per place (reports/expected.ts). */
  readonly placeExpectations = new Map<PlaceId, SiteExpectation>();

  // reports/warnings.ts: per place, its objects' property names (`propertiesOf`) and the property `${...}` shows of
  // them (`shownProperty`).
  readonly names = new Map<CanonicalKey | PlaceId, readonly string[]>();
  readonly shown = new Map<CanonicalKey | PlaceId, string | null>();

  // stores/reach.ts: each path's first direct read or store (`firstDirect`), each literal's child values by step
  // (`childrenOf`), and what reaches each value's and each place's levels (`valueReach`, `copiesOnly`).
  directSites: Map<string, SourceSite> | null = null;
  childValuesByLiteral: Map<PlaceId, Map<string, PlaceId[]>> | null = null;
  readonly valueReaches = new Map<PlaceId, Reach>();
  readonly keyReaches = new Map<PlaceId, KeyReach>();

  // stores/mixed.ts: each literal's landing (`landingOf`), the number of landings made, each landing's question
  // (`landingQuestion`).
  readonly landings = new Map<PlaceId, Landing | null>();
  landingCount = 0;
  readonly questions = new Map<string, LandingQuestion | null>();

  /** Each index projection's owner by its site (`indexOwner`, names.ts). */
  indexProjections: Map<string, PlaceId> | null = null;
}
