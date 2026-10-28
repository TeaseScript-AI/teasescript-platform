import { NULL_TYPE, UNKNOWN_TYPE, isScalarKind, type StaticType } from "../../static-types.js";
import { VALUE_KINDS, type PlainKind, type ValueKind } from "../../value-kinds.js";
import type { OperandView } from "../adapters/relation.js";
import type { DynamicWhy, PlaceId, SourceSite, TypeTerm } from "../graph.js";
import {
  BudgetExhausted,
  checkNesting,
  joinParts,
  joinSteps,
  splitPath,
  type BudgetLimit,
  type WorkCounter,
} from "./budget.js";
import { Consumers } from "./consumers.js";
import { propertyNames, type PropertyNamesTask } from "./property-names.js";
import { Contract, typeTags, termAt, writtenOf, type ContractFacts } from "./contract.js";
import {
  DefinitionIndex,
  DefinitionLists,
  keyOf,
  type Definition,
  type Key,
} from "./definitions.js";
import type { Dominators } from "./dominators.js";
import { ExactPath, withoutEmpty } from "./exact-path.js";
import type { Callable, FlowGraph, FlowNode } from "./flow-graph.js";
import { GuardIndex } from "./guards.js";
import { HandlerIndex } from "./handlers.js";
import { REASON, type Item, type ItemTag } from "./items.js";
import {
  CoreProgram,
  propertyStep,
  siteKey,
  stepName,
  type CoreAnalysisRequest,
} from "./program.js";
import {
  checksBySite,
  outcomeOf,
  type CoreDiagnostic,
  type CoreOutcome,
  type CoreResult,
  type Obligation,
  type WrittenTypeError,
} from "./result.js";
import { Solver, type DemandWork, type Work } from "./solver.js";
import { narrowingKey, Values } from "./values.js";
import { writtenTypeErrors } from "./written.js";

/*
 * The answer contract of the coarse core (checkpoint 9; the port plan's S3 note §1): `analyseCore` runs once per
 * compile and publishes, after its last pass, the frozen surface the consumer, the extracted checks, storage and the
 * backend read: per source occurrence its items, route, place and obligations; per place its admitted type, contract,
 * ingresses and definitions; the projections and properties of a value; the bridge to the adapters' operand views;
 * and the whole program's diagnostics, checks, graph, budget counters and deferred bindings. The analysis runs in
 * admission's passes (A6): each pass is a fresh analysis with the stores the previous pass rejected left out, until the
 * rejected set is stable; a set that repeats is a cycle, whose changing stores stay possibilities. Narrowing (§13) joins
 * in its step, and the field it owns says so.
 */

/** The parts of one pass of the analysis: each reads the others through it. */
export interface CorePass {
  readonly program: CoreProgram;
  readonly definitions: DefinitionIndex;
  readonly lists: DefinitionLists;
  readonly handlers: HandlerIndex;
  readonly guards: GuardIndex;
  readonly exact: ExactPath;
  readonly contract: Contract;
  readonly values: Values;
  readonly solver: Solver;
}

/** One pass over an indexed program, the stores of `rejected` (by their definitions' order) left out (A6). */
function createPass(
  program: CoreProgram,
  rejected: ReadonlyMap<number, unknown> = new Map(),
): CorePass {
  const definitions = new DefinitionIndex(program);
  const parts: {
    program: CoreProgram;
    definitions: DefinitionIndex;
    lists: DefinitionLists;
    handlers: HandlerIndex;
    guards: GuardIndex;
    solver: Solver;
  } = {
    program,
    definitions,
    // admission's rejections take effect in the next pass (A6)
    lists: new DefinitionLists(definitions, (d) => !rejected.has(d.uid)),
    handlers: new HandlerIndex(program, definitions),
    guards: new GuardIndex(program),
    solver: new Solver(program.scope),
  };
  const pass: CorePass = {
    ...parts,
    get exact() {
      return exact;
    },
    get contract() {
      return contract;
    },
    get values() {
      return values;
    },
  };
  const exact = new ExactPath(pass);
  const contract = new Contract(pass);
  const values = new Values(pass);
  return pass;
}

/** Which path answered a read (§3.3, §3.1, §3.2); a value that is no read: `value`. */
export type Route = "quiet" | "exact" | "contract" | "value";

export interface OccurrenceAnswer {
  readonly items: readonly Item[];
  readonly route: Route;
  /** The place the occurrence reads, with its path: the collector's place and the steps below it. */
  readonly place: { readonly id: PlaceId; readonly path: readonly string[] } | null;
  /** The obligations this occurrence owes as a consumer, one per offending kind (§4). */
  readonly obligations: readonly Obligation[];
  /** The narrowing that answered the read (§13 N1–N2): `null` until stage 3b joins. */
  readonly narrowing: null;
}

/**
 * A place's admitted type (A1–A9): its written type; else the kinds admission decided it by, or its contract's kinds
 * where admission found nothing to check (one family, A3), with the site of the contribution that decided (S3 §1: A2's
 * earliest definite one, A4's copy; `null` where no store decides), `null` among the kinds where a `null` contribution
 * is admitted (C9 r4.12): the type its boundary checks are against; `undecided` where it has no kind (an unknown only,
 * or no store).
 */
export type AdmittedType =
  | { readonly by: "written"; readonly kinds: readonly ItemTag[] }
  | {
      readonly by: "decided";
      readonly kinds: readonly ItemTag[];
      readonly decider: SourceSite | null;
      /** Whether a copy of a written type decides it (A4 through copies, r4.75 (1)): a written domain, not its own. */
      readonly inherited: boolean;
    }
  | { readonly by: "undecided" };

export interface PlaceAnswer {
  readonly admitted: AdmittedType;
  /** K: the kinds, `null` among them for a nullable place; E: the elements' kinds; M: whether it holds an element. */
  readonly contract: {
    readonly kinds: readonly Item[];
    readonly elements: readonly Item[];
    readonly emptiness: "held" | "open";
  };
  /** The boundary checks of the ingress stores into the place (C9), against its admitted type. */
  readonly ingresses: readonly Obligation[];
  /**
   * The definitions the exact path uses (X2–X7): the live list in region order, F5a's loop-exit adds among them; the
   * activation that owns the place (`null`: a global's); whether another callable stores the key, a prefix or a key
   * below it; and the key's own events by position in the dominator walk.
   */
  readonly definitions: {
    readonly list: readonly Definition[];
    readonly owner: Callable | null;
    readonly ownedAway: boolean;
    readonly events: { readonly stores: readonly number[]; readonly calls: readonly number[] };
  };
}

/** An operand view for the kept adapters, with the certainty of its items (every item definite). */
export interface CoreView extends OperandView {
  readonly certain: boolean;
}

export interface BudgetAnswer {
  readonly total: number;
  readonly allowance: number;
  readonly counts: ReadonlyMap<WorkCounter, number>;
  /** The limit the analysis reached, or `null`. */
  readonly exhausted: BudgetLimit | null;
  /** Each consumer read's demand: the work it was the first to compute, against its demand allowance (S3 §5). */
  readonly demands: readonly ReadWork[];
  /** The finished demands with their work. */
  readonly finished: readonly DemandWork[];
  /** Facts of the indexes for the identity and mark controls (not work). */
  readonly facts: ContractFacts;
}

export interface ReadWork {
  readonly node: number;
  readonly units: number;
  readonly allowance: number;
}

/** A value's answer at a path below it (`Answers.valueAt`). */
export interface ValueAnswer {
  readonly items: readonly Item[];
  readonly properties: ReadonlySet<string>;
}

export interface Answers {
  readonly outcome: CoreOutcome;
  /** One per cell outcome: an error, or a warning with its one obligation (§4). */
  readonly diagnostics: readonly CoreDiagnostic[];
  /** Every warning's obligation, one per warning, and the boundary checks. */
  readonly checks: readonly Obligation[];
  readonly graph: FlowGraph;
  readonly dominators: Dominators;
  readonly budget: BudgetAnswer;
  /** The parameters with several call sites and the results with several returns (for messages). */
  readonly deferred: {
    readonly parameters: readonly PlaceId[];
    readonly results: readonly PlaceId[];
  };
  /**
   * The input of the known values (S3 §2, group V): each read of an unwritten `let` or `global` that counts as its
   * initializer, by the read's site key, with the initializer's site (the collector's links; no type answer).
   */
  readonly initializers: ReadonlyMap<string, SourceSite>;
  at(node: FlowNode): OccurrenceAnswer | null;
  place(id: PlaceId, path?: readonly string[]): PlaceAnswer;
  /** The occurrence answer at a path step below a value: a collection's `element`, a dict's `entry`, a property. */
  project(
    node: FlowNode,
    step: "element" | "entry" | { readonly property: string },
  ): readonly Item[];
  /** The known properties of an object value, with their answers. */
  properties(node: FlowNode): ReadonlyMap<string, readonly Item[]>;
  /** The names of a place's known properties at a path, as `properties` finds a value's from its key. */
  placeProperties(id: PlaceId, path?: readonly string[]): ReadonlySet<string>;
  /**
   * The occurrence answer at a path below a value (`project` over several steps) with the names of the properties the
   * value is known to have there (`properties` at that path).
   */
  valueAt(node: FlowNode, path: readonly string[]): ValueAnswer;
  view(node: FlowNode): CoreView;
}

/** The analysis of a project by the coarse core: its answers, published after its last pass. */
export function analyseCore(request: CoreAnalysisRequest): Answers {
  const program = new CoreProgram(request);
  let analysed: { readonly pass: CorePass; readonly consumers: Consumers } | null = null;
  let exhausted: BudgetLimit | null = null;
  try {
    // the nesting limit stops the analysis before any of it (TABLE §8; S3 §5's third stop)
    checkNesting(program.nesting);
    program.index();
    // A6: the passes repeat, every memo recomputed, until the rejected set is stable; a set that repeats is a cycle,
    // whose changing stores stay possibilities
    let rejected: ReadonlyMap<number, ReadonlySet<Key>> = new Map();
    let cycling: ReadonlySet<number> = new Set();
    const sets: ReadonlyMap<number, ReadonlySet<Key>>[] = [rejected];
    for (let last = false; ;) {
      const pass = createPass(program, rejected);
      const consumers = new Consumers(pass, rejected, cycling);
      analysed = null;
      consumers.check();
      analysed = { pass, consumers };
      const now = consumers.admission.newlyRejected;
      if (last || sameSet(now, rejected)) break;
      program.work.charge("rejectPasses");
      const repeated = sets.findIndex((set) => sameSet(set, now));
      if (repeated >= 0) {
        // the stores every set of the cycle rejects stay rejected, the others are its possibilities
        const cycle = sets.slice(repeated);
        const every = new Map<number, ReadonlySet<Key>>();
        const some = new Set<number>();
        for (const set of cycle)
          for (const [uid, keys] of set)
            if (cycle.every((other) => other.has(uid))) every.set(uid, keys);
            else some.add(uid);
        rejected = every;
        cycling = some;
        last = true;
        continue;
      }
      rejected = now;
      sets.push(rejected);
    }
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    exhausted = error.limit;
  }
  // a stop in the setup leaves nothing to ask: the answers are the stop's
  if (analysed === null) return new StoppedAnswers(program, exhausted!);
  // the written types' own errors (V30 §13's union rule), from the declarations alone
  const written =
    exhausted === null ? writtenTypeErrors(request.files.map((file) => file.program)) : [];
  return new CoreAnswers(analysed.pass, analysed.consumers, exhausted, written);
}

/** The core's result in S2's record shape, derived from its answers: the diagnostics, and the checks none owns. */
export function coreResult(answers: Answers): CoreResult {
  return {
    outcome: answers.outcome,
    diagnostics: answers.diagnostics,
    checks: answers.checks.filter((check) => check.boundary),
  };
}

/**
 * Test-only: the answers of these demands, by their keys, in a fresh analysis that runs nothing else: the first key is
 * the entry of whatever component it closes (the solver's component test, S3 §1).
 */
export function solveDemands(
  request: CoreAnalysisRequest,
  keys: readonly string[],
): (readonly Item[])[] {
  const program = new CoreProgram(request);
  program.index();
  const pass = createPass(program);
  return keys.map((key) => {
    pass.solver.run(demandWork(pass, key));
    // the demand's own answer, not what its reader makes of it (a value's contract as it enters its store)
    const answer = pass.solver.answer(key);
    if (answer === undefined) throw new Error(`The demand '${key}' did not finish.`);
    return answer;
  });
}

/**
 * The computation that demands `key` (`c|`, `s|`, `rc|`, `cv|`, `def|`, `cop|`, `lit|`, `op|`, `dk|`, `dn|`, `vdk|`,
 * `vdn|`, `vg|`, `gv|`, `n5|`, `n5-loop|`, as the parts write them).
 */
function demandWork(pass: CorePass, key: string): Work<readonly Item[]> {
  const [kind, ...parts] = key.split("|");
  const { program, contract, values, exact } = pass;
  switch (kind) {
    case "c":
      return contract.contractOf(parts.join("|"));
    case "s": {
      const rest = splitPath(parts[2] ?? "");
      return contract.subAt(joinParts(parts[0]!, parts[1] ?? ""), rest);
    }
    case "rc":
      return contract.receiverKinds(parts.join("|"));
    case "cv":
      return contract.valueReceiver(Number(parts[0]));
    case "cop":
      return contract.contractOfValue(Number(parts[0]));
    case "def": {
      const uid = Number(parts[0]);
      const rest = splitPath(parts[1] ?? "");
      const d = definitionByUid(pass, uid);
      return exact.defVal(d, rest);
    }
    case "lit": {
      const rest = splitPath(parts[1] ?? "");
      const node = parts[2] === "-" ? null : (program.flow.nodes[Number(parts[2])] ?? null);
      return values.valueItems(Number(parts[0]), node, rest);
    }
    case "op": {
      const rest = splitPath(parts[1] ?? "");
      return values.valueItems(Number(parts[0]), null, rest);
    }
    case "dk": {
      const rest = splitPath(parts[1] ?? "");
      return contract.defaultKinds(Number(parts[0]), rest);
    }
    case "dn":
      return contract.onlyNull(Number(parts[0]));
    case "vdk": {
      const rest = splitPath(parts[1] ?? "");
      const node = parts[2] === "-" ? null : (program.flow.nodes[Number(parts[2])] ?? null);
      return values.defaultKinds(Number(parts[0]), node, rest);
    }
    case "vdn": {
      const node = parts[1] === "-" ? null : (program.flow.nodes[Number(parts[1])] ?? null);
      return values.onlyNull(Number(parts[0]), node);
    }
    case "vg": {
      const node = parts[1] === "" ? null : (program.flow.nodes[Number(parts[1])] ?? null);
      return values.valueItems(Number(parts[0]), node, []);
    }
    case "gv": {
      const g = pass.guards.narrowing.all.find((each) => narrowingKey(each) === key);
      if (g === undefined) throw new Error(`No narrowing is written '${key}'.`);
      return values.narrowingValue(g);
    }
    // (the location last: a text key in it may hold the separator)
    case "n5":
      return pass.guards
        .narrowings(pass)
        .events.treeDemand(parts.slice(2).join("|"), Number(parts[0]), Number(parts[1]), null);
    case "n5-loop":
      return pass.guards
        .narrowings(pass)
        .events.treeDemand(parts.slice(1).join("|"), 0, 0, program.flow.nodes[Number(parts[0])]!);
    default:
      throw new Error(`No demand is written '${key}'.`);
  }
}

/** Whether two passes reject the same stores. */
function sameSet(a: ReadonlyMap<number, unknown>, b: ReadonlyMap<number, unknown>): boolean {
  return a.size === b.size && [...a.keys()].every((uid) => b.has(uid));
}

function definitionByUid(pass: CorePass, uid: number): Definition {
  for (const list of [
    ...pass.definitions.byKey.values(),
    ...pass.definitions.cellDefs.values(),
    ...pass.definitions.loopAdds.values(),
  ])
    for (const d of list) if (d.uid === uid) return d;
  throw new Error(`The analysis has no definition ${uid}.`);
}

const COLLECTION_TAGS: ReadonlySet<ItemTag> = new Set(["list", "set", "dict"]);

function isPlain(kind: ValueKind): kind is PlainKind {
  return VALUE_KINDS[kind].type === "kind";
}

/** An item's kind as a closed type of the adapters (the structure below it is asked through `project`). */
export function closedType(tag: ItemTag): StaticType | null {
  if (tag === "unknown" || tag === "empty") return null;
  if (tag === "null") return NULL_TYPE;
  if (isScalarKind(tag)) return { kind: "scalar", name: tag };
  if (tag === "list" || tag === "set" || tag === "dict")
    return { kind: tag, element: UNKNOWN_TYPE };
  if (tag === "object") return { kind: "object", properties: null };
  if (isPlain(tag)) return { kind: tag };
  return UNKNOWN_TYPE;
}

/** Why an unknown is one, as the adapters name it (ADR 0021 rule 1.7). */
function dynamicWhy(reasons: number): DynamicWhy {
  return (reasons & REASON.external) !== 0 ? "host" : "unknown member";
}

/**
 * A published list in source order of its items' sites (file, start, end): at one site in the order the consumers run
 * (`rule`), and one consumer's by their own text, so the order is the same whichever order a consumer visits in and with
 * the sharing on or off (TABLE r4.86 (1)).
 */
function bySite<T extends { readonly site: SourceSite }>(
  list: readonly { readonly item: T; readonly rule: number }[],
): T[] {
  return list
    .map(({ item, rule }) => ({ item, rule, text: JSON.stringify(item) }))
    .sort(
      (a, b) =>
        a.item.site.file - b.item.site.file ||
        a.item.site.start - b.item.site.start ||
        a.item.site.end - b.item.site.end ||
        a.rule - b.rule ||
        (a.text < b.text ? -1 : a.text > b.text ? 1 : 0),
    )
    .map(({ item }) => item);
}

/** The collector's known-value links: each linked read's site key, with its initializer's site. */
function initializersOf(program: CoreProgram): Map<string, SourceSite> {
  const links = new Map<string, SourceSite>();
  for (const c of program.constraints)
    if (c.kind === "knownValue") {
      const site = program.places[c.occurrence]?.site;
      if (site !== null && site !== undefined) links.set(siteKey(site), c.initializer);
    }
  return links;
}

/**
 * The answers of an analysis stopped before its consumers ran (TABLE §8): `budget-error` with no diagnostics, the
 * graph and the ledger as far as they came; each question raises the stop again, as a question after any stop does.
 */
class StoppedAnswers implements Answers {
  readonly outcome: CoreOutcome = "budget-error";
  readonly diagnostics: readonly CoreDiagnostic[] = [];
  readonly checks: readonly Obligation[] = [];
  readonly graph: FlowGraph;
  readonly dominators: Dominators;
  readonly budget: BudgetAnswer;
  readonly deferred = { parameters: [], results: [] };
  readonly initializers: ReadonlyMap<string, SourceSite>;
  readonly #limit: BudgetLimit;

  public constructor(program: CoreProgram, limit: BudgetLimit) {
    this.graph = program.flow;
    this.dominators = program.dom;
    this.initializers = initializersOf(program);
    this.#limit = limit;
    this.budget = {
      total: program.work.total,
      allowance: program.work.allowance,
      counts: program.work.counts(),
      exhausted: limit,
      demands: [],
      finished: [],
      facts: {
        prefixEntries: 0,
        literalEntries: 0,
        markNodes: 0,
        markVisits: 0,
        selectionVisits: 0,
        decidedPaths: 0,
      },
    };
  }

  public at(): OccurrenceAnswer | null {
    throw new BudgetExhausted(this.#limit);
  }

  public place(): PlaceAnswer {
    throw new BudgetExhausted(this.#limit);
  }

  public project(): readonly Item[] {
    throw new BudgetExhausted(this.#limit);
  }

  public properties(): ReadonlyMap<string, readonly Item[]> {
    throw new BudgetExhausted(this.#limit);
  }

  public placeProperties(): ReadonlySet<string> {
    throw new BudgetExhausted(this.#limit);
  }

  public valueAt(): ValueAnswer {
    throw new BudgetExhausted(this.#limit);
  }

  public view(): CoreView {
    throw new BudgetExhausted(this.#limit);
  }
}

class CoreAnswers implements Answers {
  readonly outcome: CoreOutcome;
  readonly diagnostics: readonly CoreDiagnostic[];
  readonly checks: readonly Obligation[];
  readonly graph: FlowGraph;
  readonly dominators: Dominators;
  readonly budget: BudgetAnswer;
  readonly deferred: {
    readonly parameters: readonly PlaceId[];
    readonly results: readonly PlaceId[];
  };
  readonly initializers: ReadonlyMap<string, SourceSite>;
  readonly #pass: CorePass;
  readonly #consumers: Consumers;
  readonly #obligations = new Map<string, Obligation[]>();
  #stores: Map<FlowNode, Definition> | null = null;

  public constructor(
    pass: CorePass,
    consumers: Consumers,
    exhausted: BudgetLimit | null,
    written: readonly WrittenTypeError[],
  ) {
    this.#pass = pass;
    this.#consumers = consumers;
    const program = pass.program;
    this.graph = program.flow;
    this.dominators = program.dom;
    this.initializers = initializersOf(program);
    // published in source order of their sites, at one site the written types' errors first, then each consumer's in
    // the order they run (TABLE r4.86 (1))
    const rules = new Map<CoreDiagnostic, number>();
    let rule = 0;
    consumers.diagnostics.forEach((diagnostic, index) => {
      while (rule < consumers.rules.length && index >= consumers.rules[rule]!) rule += 1;
      rules.set(diagnostic, 1 + rule);
    });
    this.diagnostics =
      exhausted === null
        ? bySite(
            [...written, ...consumers.diagnostics].map((item) => ({
              item,
              rule: rules.get(item) ?? 0,
            })),
          )
        : [];
    this.outcome = exhausted === null ? outcomeOf(this.diagnostics) : "budget-error";
    // each warning's obligation, one per warning (§4), then the boundary checks no warning owes: in source order of their
    // sites, at one site the warnings' obligations in the diagnostics' order, then the others (`checksBySite`)
    const owned: Obligation[] = [];
    for (const diagnostic of this.diagnostics)
      if (diagnostic.class === "warning-runtime-check") {
        owned.push(diagnostic.obligation);
        const at = siteKey(diagnostic.obligation.site);
        const list = this.#obligations.get(at);
        if (list === undefined) this.#obligations.set(at, [diagnostic.obligation]);
        else list.push(diagnostic.obligation);
      }
    const others: { readonly item: Obligation; readonly rule: number }[] = [];
    if (exhausted === null) {
      for (const list of consumers.admission.boundaries.values())
        for (const item of list) others.push({ item, rule: 0 });
      for (const item of consumers.admission.readChecks) others.push({ item, rule: 1 });
    }
    this.checks = checksBySite(owned, bySite(others));
    const deferredParameters: PlaceId[] = [];
    const deferredResults: PlaceId[] = [];
    // after a stop the ledger is spent: nothing more is computed, so no binding is published as deferred
    for (const fn of exhausted === null ? program.graph.functions : []) {
      if (!pass.lists.singleSite(fn.id))
        for (const parameter of fn.parameters) {
          const kind = program.place(parameter).kind;
          if (kind.kind === "parameter" && kind.written === null)
            deferredParameters.push(parameter);
        }
      const returns = (pass.definitions.byKey.get(keyOf(fn.result, [])) ?? []).filter(
        (d) => d.how === "return" || d.how === "no-value",
      );
      if (returns.length > 1) deferredResults.push(fn.result);
    }
    this.deferred = { parameters: deferredParameters, results: deferredResults };
    this.budget = {
      total: program.work.total,
      allowance: program.work.allowance,
      counts: program.work.counts(),
      exhausted,
      demands: consumers.reads,
      finished: pass.solver.demandWork(),
      facts: { ...pass.contract.facts },
    };
  }

  #run<T>(work: Work<T>): T {
    return this.#pass.solver.run(work);
  }

  /** The value place of an expression node, the place a statement stores into, or `null`. */
  #valueOf(node: FlowNode): PlaceId | null {
    if (node.span === null) return null;
    return (
      this.#pass.program.placeBySite.get(
        siteKey({ file: node.file, start: node.span.start.offset, end: node.span.end.offset }),
      ) ?? null
    );
  }

  public at(node: FlowNode): OccurrenceAnswer | null {
    const { program, values } = this.#pass;
    if (node.span === null) return null;
    const obligations =
      this.#obligations.get(
        siteKey({ file: node.file, start: node.span.start.offset, end: node.span.end.offset }),
      ) ?? [];
    const value = this.#valueOf(node);
    if (value === null) {
      // a statement that stores: the place it stores into, with the stored value's items
      const d = this.#storeAt(node);
      return d === null
        ? null
        : {
            items: d.value === undefined ? [] : this.#run(values.valueItems(d.value, node, [])),
            route: "value",
            place: { id: d.place, path: d.path },
            obligations,
            narrowing: null,
          };
    }
    const items = this.#run(values.valueItems(value, node, []));
    // a read of a binding or of a path below one; a projection of a literal, a call or an operation is no place
    let base = value;
    for (
      let projection = program.projOf.get(base);
      projection !== undefined;
      projection = program.projOf.get(base)
    )
      base = projection.owner;
    // a bare read's place is its binding's, as a read below one is (S3 §1, Astra B7)
    const target = program.occurrenceOf.has(base)
      ? program.targetRoot(program.occurrenceOf.get(value) ?? value)
      : null;
    // the route the read's answer took, recorded as it was answered (Astra B5)
    const route: Route =
      target === null
        ? "value"
        : this.#consumers.quiet.has(value)
          ? "quiet"
          : values.valueRoute(value, node, []);
    return {
      items,
      route,
      place: target === null ? null : { id: target.root, path: target.path },
      obligations,
      narrowing: null,
    };
  }

  /** The store a statement makes, by its node: its first live store definition there, else its first rejected one (A6). */
  #storeAt(node: FlowNode): Definition | null {
    if (this.#stores === null) {
      this.#stores = new Map();
      const { definitions, lists } = this.#pass;
      for (const d of definitions.storeDefs)
        if (!this.#stores.has(d.node) && lists.live(d)) this.#stores.set(d.node, d);
      for (const d of definitions.storeDefs)
        if (!this.#stores.has(d.node)) this.#stores.set(d.node, d);
    }
    return this.#stores.get(node) ?? null;
  }

  public place(id: PlaceId, path: readonly string[] = []): PlaceAnswer {
    const { program, contract, definitions, lists } = this.#pass;
    const key: Key = keyOf(id, path);
    const written = writtenOf(program.place(id).kind);
    const term = written === null ? null : termAt(written, path);
    const kinds = this.#run(contract.contractOf(key));
    const elements = kinds.some((item) => COLLECTION_TAGS.has(item.tag))
      ? this.#run(contract.contractOf(keyOf(id, joinSteps(path, ["element"]))))
      : [];
    return {
      admitted: this.#admitted(id, path, term),
      contract: {
        kinds: withoutEmpty(kinds),
        elements: withoutEmpty(elements),
        emptiness: elements.some((item) => item.tag === "empty") ? "open" : "held",
      },
      ingresses: this.#consumers.admission.boundaries.get(key) ?? [],
      // the exact service's list, not the raw stores (Astra B8)
      definitions: {
        list: lists.definitionsOf(key).list,
        owner: definitions.declaringCallable(id),
        ownedAway: definitions.ownedAway(key),
        events: lists.ownEvents(key),
      },
    };
  }

  #admitted(id: PlaceId, path: readonly string[], term: TypeTerm | null): AdmittedType {
    // (each kind once: `(null | string)?` admits `null` and `string`)
    if (term !== null) return { by: "written", kinds: [...new Set(typeTags(term))] };
    const { admission } = this.#consumers;
    const kinds = admission.admitted(id, path);
    // (the decider's site is found where it is read: A3's settled paths have no scan to keep it from)
    return kinds.length === 0
      ? { by: "undecided" }
      : {
          by: "decided",
          kinds,
          get decider(): SourceSite | null {
            return admission.deciderAt(id, path);
          },
          inherited: admission.inheritsWritten(id, path),
        };
  }

  public project(
    node: FlowNode,
    step: "element" | "entry" | { readonly property: string },
  ): readonly Item[] {
    const value = this.#valueOf(node);
    if (value === null) return [];
    // a dict's entries are its element path (the collector's step names)
    const path = typeof step === "string" ? stepName(step) : propertyStep(step.property);
    return this.#run(this.#pass.values.valueItems(value, node, [path]));
  }

  public properties(node: FlowNode): ReadonlyMap<string, readonly Item[]> {
    const value = this.#valueOf(node);
    const out = new Map<string, readonly Item[]>();
    if (value === null) return out;
    for (const name of [...this.#propertyNames({ value, path: [] })].sort())
      out.set(name, this.#run(this.#pass.values.valueItems(value, node, [propertyStep(name)])));
    return out;
  }

  public placeProperties(id: PlaceId, path: readonly string[] = []): ReadonlySet<string> {
    return this.#propertyNames({ key: keyOf(id, path) });
  }

  public valueAt(node: FlowNode, path: readonly string[]): ValueAnswer {
    const value = this.#valueOf(node);
    if (value === null) return { items: [], properties: new Set() };
    const items = this.#run(this.#pass.values.valueItems(value, node, path));
    // only an object has properties to find
    return {
      items,
      properties: items.some((item) => item.tag === "object")
        ? this.#propertyNames({ value, path })
        : new Set(),
    };
  }

  #propertyNames(start: PropertyNamesTask): ReadonlySet<string> {
    return propertyNames(this.#pass, (work) => this.#run(work), start);
  }

  public view(node: FlowNode): CoreView {
    const value = this.#valueOf(node);
    const items =
      value === null ? [] : withoutEmpty(this.#run(this.#pass.values.valueItems(value, node, [])));
    const alternatives = items
      .map((item) => closedType(item.tag))
      .filter((type): type is StaticType => type !== null);
    const unknown = items.find((item) => item.tag === "unknown");
    return {
      alternatives: alternatives.length > 0 ? alternatives : null,
      dynamic: unknown === undefined ? null : dynamicWhy(unknown.reasons),
      // the constant service's value is the consumer's (S3 §2, group V)
      known: undefined,
      certain: items.length > 0 && items.every((item) => item.cert === "def"),
    };
  }
}
