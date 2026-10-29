import type { Expression } from "../../ast.js";
import type { PlaceId, SourceSite, TypeTerm } from "../graph.js";
import { Admission } from "./admission.js";
import type { CorePass } from "./answers.js";
import type { DecisionWork, ReadWork } from "./answers.js";
import {
  BudgetExhausted,
  DemandExhausted,
  demandAllowanceFor,
  joinSteps,
  keptSlice,
  type BudgetLimit,
} from "./budget.js";
import { withFacts } from "./consumers/diagnostics.js";
import { finishedItems, finishingRead } from "./consumers/finishing.js";
import { freshStores, ingressMark, storeMark } from "./consumers/fresh.js";
import { mixed, mixedJoin } from "./consumers/mixed.js";
import type {
  CheapDecision,
  CheapFrontier,
  CheapShape,
  KeyReach,
  Landing,
  LandingQuestion,
  Reach,
} from "./consumers/model.js";
import { operations } from "./consumers/operations.js";
import { receivers } from "./consumers/receivers.js";
import { admittedStores, decide } from "./consumers/stores.js";
import { cheapDecided } from "./consumers/syntax.js";
import { speakers, uses } from "./consumers/uses.js";
import { keptKey, keyOf, type Definition, type Key } from "./definitions.js";
import type { FlowNode } from "./flow-graph.js";
import { REASON, STOPPED, type Item, type Writer } from "./items.js";
import { Laminar } from "./narrowing.js";
import type { CoreDiagnostic, SiteExpectation } from "./result.js";
import type { Work } from "./solver.js";
export { typedCall } from "./consumers/finishing.js";
export { leftOutCheck, leftOutWarning, withoutRecords } from "./consumers/left-out.js";
export type { Omission } from "./consumers/left-out.js";

/*
 * The consumers of the coarse core (checkpoint 9, TABLE §3.3, §4): every use that needs a kind asks its operand's
 * items. The quiet path answers first: a consumer that every kind of the contract fits, with no `unknown`, asks
 * nothing more (§3.3). Otherwise: all items definite and none fits is an error; some item does not fit, or an
 * `unknown` is present, a warning with one obligation per offending kind (§4); all fit, quiet. Here: C2 to C6, C11,
 * C12, the iterable of a `for`, F19a's speaker accesses, ADR 1.5's null default, C1 and C7 against a place's written or
 * decided type (A1–A9, with admission's decisions and rejections), C10's fallbacks and defaults, and where each consumer
 * meets external data, admission's boundary check of its ingress (C9). Saves (C8) are the storage module's.
 */

/** Whether two passes reject the same stores (A6): the pass's admission settled. */
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

/** A stopped demand's answer (S3 §5): its key's contract, each item with the reason and the word `budget`. */
function withBudget(items: readonly Item[]): readonly Item[] {
  return items.map((item) =>
    item.tag === "empty"
      ? item
      : { ...item, reasons: item.reasons | REASON.budget, context: "budget" },
  );
}

/** The walk's stages after admission's, in order (D4: a stop keeps every unit before it). */
const STAGES = 4;

/** The rank of a stop's own warning and marks among a site's diagnostics: after every consumer's (`Consumers.rules`). */
export const STOP_RULE = 5 + STAGES;

/**
 * A method whose body lives in `consumers/` is a function of its name there; the members those functions read are
 * public for them, and internal to the consumers.
 */
export class Consumers {
  readonly diagnostics: CoreDiagnostic[] = [];
  /**
   * The finishing path's warnings (D4 a′): the checks the stop or the nesting limit moved to the runtime, never shown
   * one by one; the stop's one warning counts them, and each function they stand in is marked not checked.
   */
  readonly deferred: Extract<CoreDiagnostic, { obligation: unknown }>[] = [];
  /**
   * Each diagnostic's rank, `diagnostics`' and `deferred`'s alike: its consumer's place in the order the consumers run,
   * from 1 (the published order's rules, TABLE r4.86 (1)); the finishing path ranks its findings as the walk does.
   */
  readonly rules = new Map<CoreDiagnostic, number>();
  /** The rank of the consumer running now (`rules`): admission's three, the walk's four stages, the publication. */
  rule = 0;
  /** The limit the walk stopped at, or `null`. */
  stopped: BudgetLimit | null = null;
  /**
   * Whether admission settled in this pass: its rejections and its store targets are the pass's own (A6, #1275), so its
   * findings stand.
   */
  settled = false;
  /** Whether admission's boundary checks were published (`Admission.publish`), the walk's last step. */
  published = false;
  /** The walk's place: its stage (-1 admission, `STAGES` publication) and the next unit in it. */
  #stage = -1;
  #unit = 0;
  /** Where the walk stopped, the stage and the unit it was in; `null` before a stop, or to finish every unit. */
  #stoppedAt: { readonly stage: number; readonly unit: number } | null = null;
  /** What the walk had found before the running unit: a stop takes its partial findings back. */
  #mark = { diagnostics: 0, readChecks: 0 };
  finishing = false;
  readonly #last: boolean;
  readonly #rejected: ReadonlyMap<number, ReadonlySet<Key>>;
  /**
   * Whether the store targets the pass keys by are its admission's own (#1275), asked before the walk: each receiver's
   * decision a lazy one of this pass's own (`decide`), bounded by the demand allowance as every decision is.
   */
  readonly #ownTargets: (
    admission: Admission,
    decide: (root: PlaceId, path: readonly string[]) => void,
  ) => boolean;
  /** Admission's decisions, rejections and boundary checks (§5, C9). */
  readonly admission: Admission;
  /** The values a consumer answered by the quiet path (§3.3). */
  readonly quiet = new Set<PlaceId>();
  /** The class sides whose members' values a quiet proof has already marked quiet (§4.4). */
  readonly quietSides = new Set<string>();
  /** Each consumer read's demand and the work it was the first to compute (S3 §5: a counter only here). */
  readonly reads: ReadWork[] = [];
  /** The consumer reads whose demand stopped at its allowance (S3 §5). */
  demandStops = 0;
  /** Each admission decision's demand (S3 §5): its work, its allowance, whether it stopped. */
  readonly decisions: DecisionWork[] = [];
  /** The ledger's total past which the running admission decision stops (`decide`), or `null`. */
  deciding: number | null = null;
  /** Whether a decision stopped in this pass (`decide`): it is not settled (TABLE r4.180). */
  decisionStopped = false;
  /** Whether this pass restarted one whose decision stopped: a decision stopping here stops the analysis (TABLE r4.183). */
  readonly restarted: boolean;
  #readingNode: FlowNode | null = null;
  #callableNodes: Map<unknown, number> | null = null;
  readonly order: <T>(list: readonly T[]) => T[];
  readonly getOf = new Map<PlaceId, PlaceId>();
  readonly resultOfCall = new Map<PlaceId, PlaceId>();
  /**
   * What a label's walk up a projection chain asks, once per value (`keyLabel` asks it at every level of every label,
   * each a walk of up to 256 steps or a contract): the element step below each owner, and whether each chain passes a
   * derived list or starts at no place.
   */
  readonly elementSteps = new Map<PlaceId, string>();
  readonly derivedChains = new Map<PlaceId, boolean>();
  readonly anonymousChains = new Map<PlaceId, boolean>();
  /** Per value read in the finishing path, the written type at its own path (`writtenRead`), `null` for none. */
  readonly writtenReads = new Map<PlaceId, TypeTerm | null>();
  /** Per value read in the finishing path, its key (`readKey`), `null` for none. */
  readonly readKeys = new Map<PlaceId, Key | null>();
  readonly presence = new Map<
    string,
    { readonly state: "none" | "some" | "all"; readonly literal: Writer | null }
  >();
  readonly defaults = new Map<string, { readonly key: Key; readonly at: FlowNode } | null>();
  /** The cheap deciders' shapes, one per key, and their decisions, one per key and path (`cheapDecided`). */
  readonly cheapShapes = new Map<Key, CheapShape>();
  readonly cheapFrontiers = new Map<Key, CheapFrontier>();
  readonly cheapDecisions = new Map<Key, CheapDecision | null>();
  /** The places the script stores into, at any path (`copySource`). */
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
  ) {
    this.#rejected = rejected;
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
        // (after a stop admission reads as every consumer does: the finishing read, TABLE r4.126)
        read: (value, node, at) => (this.finishing ? finishingRead(this, value, node, at) : null),
      },
      rejected,
      cycling,
    );
    const program = pass.program;
    for (const c of program.constraints) {
      if (c.kind === "get") this.getOf.set(c.result, c.receiver);
      if (c.kind === "call") this.resultOfCall.set(c.result, program.functionOf(c.fn).result);
    }
  }

  /** The node a consumer reads at, its callable the spender of the work that follows (the heaviest place, D4). */
  public get reading(): FlowNode | null {
    return this.#readingNode;
  }

  public set reading(node: FlowNode | null) {
    this.#readingNode = node;
    if (node !== null) this.pass.program.work.spender = this.pass.program.spenderOf(node);
  }

  /**
   * A value's items at a node and a path: every consumer's one read, unstopped or finishing, so a stop's obligations
   * come from the same consumers as an unstopped analysis's (TABLE r4.99). In the finishing path it reads what is
   * settled (`finishingRead`), `STOPPED` only where nothing is.
   */
  public valueItems(
    value: PlaceId,
    node: FlowNode | null,
    rest: readonly string[],
    requirement = false,
  ): readonly Item[] {
    return this.finishing
      ? finishingRead(this, value, node, rest, requirement)
      : this.valueRun(value, node, rest);
  }

  public finishedItems(
    value: PlaceId,
    node: FlowNode | null,
    rest: readonly string[],
  ): readonly Item[] {
    return finishedItems(this, value, node, rest);
  }

  readonly typedReads = new Map<string, readonly Item[] | null>();

  hostStores: Map<PlaceId, Definition[]> | null = null;

  /** Whether a finishing walk asks the solver nothing (`run`): nested past the limit, or after an unsettled stop. */
  public asksNothing(): boolean {
    return this.finishing && (this.pass.program.work.stopped === null || !this.settled);
  }

  /** A value's items at a node and a path, as a consumer's demand: past its allowance, its own key's contract. */
  public valueRun(value: PlaceId, node: FlowNode | null, rest: readonly string[]): readonly Item[] {
    return this.run(this.pass.values.valueItems(value, node, rest), () =>
      this.pass.contract.contractOfValueAt(value, rest),
    );
  }

  /**
   * A consumer's question of a value's items, one demand with the allowance of the read that asks it (S3 §5, TABLE
   * B1): a demand past it stops, and the read answers its own key's `contract` with the reason `budget` (a contract past
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
   * A demand of the solver, its work counted to the read that asked it (S3 §5), within `allowance` where one is given
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
   * The stores and transfers at a key whose decision stopped (S3 §5): the stop stands for their obligations, as a stop
   * before admission settled does for every store into an inferred place (TABLE r4.100, r4.111), so each is marked at its
   * site, its type undecided, its value checked when the script runs (C9); a key below it is asked on its own (Codex
   * r10's B1 on #1310: a key a restarted pass carried stopped kept no check of its stores). Each key once a pass (Codex
   * r11's N2: every receiver asking it again scanned its stores again).
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
    for (const list of lists)
      for (const d of list) {
        program.work.charge("checks");
        if (d.value === undefined || (d.kind !== "whole" && d.kind !== "add")) continue;
        const stored = d.kind === "add" ? joinSteps(d.path, ["element"]) : d.path;
        if (keyOf(d.place, stored) === at) storeMark(this, d, stored);
      }
  }

  readonly #stoppedKeys = new Set<Key>();

  /**
   * S3 §5: a demand's allowance, 256 × the nodes of the reading site's function, or of the whole program at a file's top
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

  /** A consumer answered by the quiet path (§3.3). */
  public skip(...values: readonly (PlaceId | undefined)[]): void {
    this.pass.program.work.charge("checksSkipped");
    for (const value of values) if (value !== undefined) this.quiet.add(value);
  }

  /** The phase of this pass the stop came in: admission's walk, the consumers' walk or the publication; else `null`. */
  public stopPhase(): "admission" | "walk" | "publication" | null {
    if (this.stopped === null || this.#stoppedAt === null) return null;
    const { stage } = this.#stoppedAt;
    return stage < 0 ? "admission" : stage === STAGES ? "publication" : "walk";
  }

  /**
   * Every consumer of the program, once. A stop (the work allowance, a read chain's depth) ends the walk: the units it
   * finished keep their findings, the running unit's are taken back (D4 a′, TABLE r4.54); whether they stand is
   * `settled`'s, since a later pass of admission may still change them (A6).
   */
  public check(): void {
    try {
      this.rule = 1;
      admittedStores(this);
      this.rule = 2;
      for (const { site, label } of this.admission.ingressStores()) ingressMark(this, site, label);
      this.rule = 3;
      this.admission.literalElements(this.order, (site, found) => mixed(this, site, found));
      this.admission.joinElements(this.order, (found) => mixedJoin(this, found));
      // (a pass whose admission gives the stores below a selection other targets starts the passes again, #1275; one in
      // which a decision stopped is not settled either: the next starts with its key stopped, TABLE r4.180)
      const own = this.#ownTargets(this.admission, (root, path) => {
        decide(this, root, path, true);
      });
      this.settled =
        own &&
        (this.#last || sameStores(this.admission.newlyRejected, this.#rejected)) &&
        !this.decisionStopped;
      // (admission's findings are the walk's before its first unit)
      this.#mark = {
        diagnostics: this.diagnostics.length,
        readChecks: this.admission.readChecks.length,
      };
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
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
      this.pass.program.work.stop(error.limit);
      this.stopped = error.limit;
      this.#stoppedAt = { stage: this.#stage, unit: this.#unit - 1 };
      this.diagnostics.length = this.#mark.diagnostics;
      this.admission.takeBackReadChecks(this.#mark.readChecks);
    }
  }

  /** The consumers that operations, uses, receivers and speakers are, in that order (the walk's stages). */
  #walk(): void {
    operations(this);
    uses(this);
    receivers(this);
    speakers(this);
  }

  /**
   * The finishing path (D4 a′, TABLE r4.54, r4.55): the units a stop left, or with `all` every one (admission did not
   * settle, so nothing before the stop stands), and the units nested past the nesting limit, each with no further
   * proving: every value they read is `unknown` with the reason `budget` (`STOPPED`), so each consumer owes its check,
   * its warning one of `deferred`. With `all`, also the stores' obligations admission's walk would have made, no
   * decision read (`freshStores`). Without `all`, admission settled: what it decided and what the walk found before the stop stand
   * (TABLE r4.90), and a publication the stop cut or never reached finishes against those decisions, the solver
   * answering only what it had finished. Bounded by the units, each a constant number of steps besides its own syntax.
   */
  public finish(all: boolean): void {
    this.finishing = true;
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
   */
  public runs(site: SourceSite): boolean {
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

  public cheapDecided(root: PlaceId, path: readonly string[]): CheapDecision | null {
    return cheapDecided(this, root, path);
  }

  readonly marked = new Set<number>();

  markedSpans: Map<number, Laminar<null>> | null = null;

  readonly markedLiterals = new Set<PlaceId>();

  readonly markedIngress = new Set<string>();

  heldIn: Map<PlaceId, PlaceId> | null = null;
  storesOf: Map<PlaceId, Definition[]> | null = null;

  public withFacts(diagnostic: CoreDiagnostic): CoreDiagnostic {
    return withFacts(this, diagnostic);
  }

  /** `readsAbsent`'s answer per expression. */
  readonly absentReads = new Map<Expression, boolean>();

  /** `expected`'s answer per site. */
  readonly expectations = new Map<string, SiteExpectation>();

  /** `readsTakeTask`'s answer per place. */
  readonly placeExpectations = new Map<PlaceId, SiteExpectation>();

  readonly names = new Map<Key | PlaceId, readonly string[]>();

  readonly shown = new Map<Key | PlaceId, string | null>();

  directSites: Map<string, SourceSite> | null = null;

  literalChildren: Map<PlaceId, Map<string, PlaceId[]>> | null = null;

  readonly valueReaches = new Map<PlaceId, Reach>();

  readonly keyReaches = new Map<PlaceId, KeyReach>();

  readonly landings = new Map<PlaceId, Landing | null>();
  landingCount = 0;

  readonly questions = new Map<string, LandingQuestion | null>();

  indexProjections: Map<string, PlaceId> | null = null;
}
