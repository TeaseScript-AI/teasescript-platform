import { NULL_TYPE, UNKNOWN_TYPE, isScalarKind, type StaticType } from "../../static-types.js";
import { VALUE_KINDS, type PlainKind, type ValueKind } from "../../value-kinds.js";
import type { OperandView } from "../adapters/relation.js";
import type { DynamicWhy, PlaceId } from "../graph.js";
import { BudgetExhausted, type BudgetLimit, type WorkCounter } from "./budget.js";
import { Consumers } from "./consumers.js";
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
import type { FlowGraph, FlowNode } from "./flow-graph.js";
import { GuardIndex } from "./guards.js";
import { HandlerIndex } from "./handlers.js";
import { REASON, type Item, type ItemTag } from "./items.js";
import { CoreProgram, siteKey, type CoreAnalysisRequest } from "./program.js";
import {
  outcomeOf,
  type CoreDiagnostic,
  type CoreOutcome,
  type CoreResult,
  type Obligation,
} from "./result.js";
import { Solver, type DemandWork, type Work } from "./solver.js";
import { Values } from "./values.js";

/*
 * The answer contract of the coarse core (checkpoint 9; the port plan's S3 note §1): `analyseCore` runs once per
 * compile and publishes, after its last pass, the frozen surface the consumer, the extracted checks, storage and the
 * backend read: per source occurrence its items, route, place and obligations; per place its admitted type, contract,
 * ingresses and definitions; the projections and properties of a value; the bridge to the adapters' operand views;
 * and the whole program's diagnostics, checks, graph, budget counters and deferred bindings. Here admission is one
 * pass: decided types, the boundary checks of external data (C9) and narrowing (§13) join in their steps, and the
 * fields they own say so.
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

function createPass(request: CoreAnalysisRequest): CorePass {
  const program = new CoreProgram(request);
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
    // admission's rejections take effect in a later pass (A6); one pass rejects nothing
    lists: new DefinitionLists(definitions, () => true),
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

/** A place's admitted type (A1–A9): its written type here; decided types are admission's (S6). */
export type AdmittedType =
  { readonly by: "written"; readonly kinds: readonly ItemTag[] } | { readonly by: "undecided" };

export interface PlaceAnswer {
  readonly admitted: AdmittedType;
  /** K: the kinds, `null` among them for a nullable place; E: the elements' kinds; M: whether it holds an element. */
  readonly contract: {
    readonly kinds: readonly Item[];
    readonly elements: readonly Item[];
    readonly emptiness: "held" | "open";
  };
  /** Every ingress store into the place (C9): admission's, with the boundary checks. */
  readonly ingresses: readonly Obligation[];
  /** The definition list in region order the exact path uses. */
  readonly definitions: readonly Definition[];
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

export interface Answers {
  readonly outcome: CoreOutcome;
  /** One per cell outcome: an error, or a warning with its one obligation (§4). */
  readonly diagnostics: readonly CoreDiagnostic[];
  /** Every obligation once, and the boundary checks. */
  readonly checks: readonly Obligation[];
  readonly graph: FlowGraph;
  readonly dominators: Dominators;
  readonly budget: BudgetAnswer;
  /** The parameters with several call sites and the results with several returns (for messages). */
  readonly deferred: {
    readonly parameters: readonly PlaceId[];
    readonly results: readonly PlaceId[];
  };
  at(node: FlowNode): OccurrenceAnswer | null;
  place(id: PlaceId, path?: readonly string[]): PlaceAnswer;
  /** The occurrence answer at a path step below a value: `element`, `entry`, a property. */
  project(node: FlowNode, step: string): readonly Item[];
  /** The known properties of an object value, with their answers. */
  properties(node: FlowNode): ReadonlyMap<string, readonly Item[]>;
  view(node: FlowNode): CoreView;
}

/** The analysis of a project by the coarse core: its answers, published after its last pass. */
export function analyseCore(request: CoreAnalysisRequest): Answers {
  const pass = createPass(request);
  const consumers = new Consumers(pass);
  let exhausted: BudgetLimit | null = null;
  try {
    consumers.check();
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error;
    exhausted = error.limit;
  }
  return new CoreAnswers(pass, consumers, exhausted);
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
  const pass = createPass(request);
  return keys.map((key) => pass.solver.run(demandWork(pass, key)));
}

/** The computation that demands `key` (`c|`, `def|`, `cop|`, `lit|`, `op|`, as the parts write them). */
function demandWork(pass: CorePass, key: string): Work<readonly Item[]> {
  const [kind, ...parts] = key.split("|");
  const { program, contract, values, exact } = pass;
  switch (kind) {
    case "c":
      return contract.contractOf(parts.join("|"));
    case "cop":
      return contract.contractOfValue(Number(parts[0]));
    case "def": {
      const uid = Number(parts[0]);
      const rest = parts[1] === "" || parts[1] === undefined ? [] : parts[1].split(".");
      const d = definitionByUid(pass, uid);
      return exact.defVal(d, rest);
    }
    case "lit": {
      const rest = parts[1] === "" || parts[1] === undefined ? [] : parts[1].split(".");
      const node = parts[2] === "-" ? null : (program.flow.nodes[Number(parts[2])] ?? null);
      return values.valueItems(Number(parts[0]), node, rest);
    }
    case "op": {
      const rest = parts[1] === "" || parts[1] === undefined ? [] : parts[1].split(".");
      return values.valueItems(Number(parts[0]), null, rest);
    }
    default:
      throw new Error(`No demand is written '${key}'.`);
  }
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
function closedType(tag: ItemTag): StaticType | null {
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
  readonly #pass: CorePass;
  readonly #consumers: Consumers;
  readonly #obligations = new Map<string, Obligation[]>();

  public constructor(pass: CorePass, consumers: Consumers, exhausted: BudgetLimit | null) {
    this.#pass = pass;
    this.#consumers = consumers;
    const program = pass.program;
    this.graph = program.flow;
    this.dominators = program.dom;
    this.diagnostics = exhausted === null ? [...consumers.diagnostics] : [];
    this.outcome = exhausted === null ? outcomeOf(this.diagnostics) : "budget-error";
    const checks = new Map<string, Obligation>();
    for (const diagnostic of this.diagnostics)
      if (diagnostic.class === "warning-runtime-check") {
        checks.set(JSON.stringify(diagnostic.obligation), diagnostic.obligation);
        const at = siteKey(diagnostic.obligation.site);
        const list = this.#obligations.get(at);
        if (list === undefined) this.#obligations.set(at, [diagnostic.obligation]);
        else list.push(diagnostic.obligation);
      }
    this.checks = [...checks.values()];
    const deferredParameters: PlaceId[] = [];
    const deferredResults: PlaceId[] = [];
    for (const fn of program.graph.functions) {
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
    const { program, values, exact } = this.#pass;
    const value = this.#valueOf(node);
    if (value === null || node.span === null) return null;
    const items = this.#run(values.valueItems(value, node, []));
    const binding = program.occurrenceOf.get(value);
    const target =
      program.projOf.has(value) || binding !== undefined
        ? program.targetRoot(binding ?? value)
        : null;
    let route: Route = "value";
    if (binding !== undefined) {
      const key = keyOf(binding, []);
      route = this.#consumers.quiet.has(value)
        ? "quiet"
        : "def" in exact.exactPath(key, program.occNode.get(value) ?? node)
          ? "exact"
          : "contract";
    }
    return {
      items,
      route,
      place: target === null ? null : { id: binding ?? target.root, path: target.path },
      obligations:
        this.#obligations.get(
          siteKey({ file: node.file, start: node.span.start.offset, end: node.span.end.offset }),
        ) ?? [],
      narrowing: null,
    };
  }

  public place(id: PlaceId, path: readonly string[] = []): PlaceAnswer {
    const { program, contract, definitions } = this.#pass;
    const key: Key = keyOf(id, path);
    const written = writtenOf(program.place(id).kind);
    const term = written === null ? null : termAt(written, path);
    const kinds = this.#run(contract.contractOf(key));
    const elements = kinds.some((item) => COLLECTION_TAGS.has(item.tag))
      ? this.#run(contract.contractOf(keyOf(id, [...path, "element"])))
      : [];
    return {
      admitted: term === null ? { by: "undecided" } : { by: "written", kinds: typeTags(term) },
      contract: {
        kinds: withoutEmpty(kinds),
        elements: withoutEmpty(elements),
        emptiness: elements.some((item) => item.tag === "empty") ? "open" : "held",
      },
      ingresses: [],
      definitions: definitions.byKey.get(key) ?? [],
    };
  }

  public project(node: FlowNode, step: string): readonly Item[] {
    const value = this.#valueOf(node);
    if (value === null) return [];
    return this.#run(this.#pass.values.valueItems(value, node, [step]));
  }

  public properties(node: FlowNode): ReadonlyMap<string, readonly Item[]> {
    const { program, contract, definitions } = this.#pass;
    const value = this.#valueOf(node);
    const out = new Map<string, readonly Item[]>();
    if (value === null) return out;
    const names = new Set<string>();
    const binding = program.occurrenceOf.get(value);
    if (binding !== undefined) {
      const key = keyOf(binding, []);
      for (const below of definitions.keysBelow(key)) {
        const step = below.slice(below.indexOf("|") + 1).split(".")[0];
        if (step !== undefined && step !== "element") names.add(step);
      }
      for (const entry of contract.prefixStores(key).list)
        if (
          entry.value !== undefined &&
          (entry.at ?? []).length === 0 &&
          program.hasOf.has(entry.value)
        )
          for (const object of contract.literalIndex(entry.value).objects.get("")?.list ?? [])
            for (const name of object.names) names.add(name);
    } else if (program.hasOf.has(value))
      for (const object of contract.literalIndex(value).objects.get("")?.list ?? [])
        for (const name of object.names) names.add(name);
    for (const name of [...names].sort())
      out.set(name, this.#run(this.#pass.values.valueItems(value, node, [name])));
    return out;
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
