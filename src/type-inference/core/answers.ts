import { NULL_TYPE, UNKNOWN_TYPE, isScalarKind, type StaticType } from "../../static-types.js";
import { VALUE_KINDS, type PlainKind, type ValueKind } from "../../value-kinds.js";
import type { OperandView } from "../adapters/relation.js";
import type { DynamicWhy, PlaceId } from "../graph.js";
import { BudgetExhausted, checkNesting, type BudgetLimit, type WorkCounter } from "./budget.js";
import { Consumers } from "./consumers.js";
import { Contract, typeTags, termAt, writtenOf, type ContractFacts } from "./contract.js";
import {
  DefinitionIndex,
  DefinitionLists,
  keyOf,
  keyPath,
  keyPlace,
  type Definition,
  type Key,
} from "./definitions.js";
import type { Dominators } from "./dominators.js";
import { ExactPath, withoutEmpty } from "./exact-path.js";
import type { FlowGraph, FlowNode } from "./flow-graph.js";
import { GuardIndex } from "./guards.js";
import { HandlerIndex } from "./handlers.js";
import { REASON, type Item, type ItemTag } from "./items.js";
import { CoreProgram, siteKey, stepName, type CoreAnalysisRequest } from "./program.js";
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
  at(node: FlowNode): OccurrenceAnswer | null;
  place(id: PlaceId, path?: readonly string[]): PlaceAnswer;
  /** The occurrence answer at a path step below a value: a collection's `element`, a dict's `entry`, a property. */
  project(
    node: FlowNode,
    step: "element" | "entry" | { readonly property: string },
  ): readonly Item[];
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
    // the nesting limit stops the analysis before any of it (TABLE §8; S3 §5's third stop)
    checkNesting(pass.program.nesting);
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
  return keys.map((key) => {
    pass.solver.run(demandWork(pass, key));
    // the demand's own answer, not what its reader makes of it (a value's contract as it enters its store)
    const answer = pass.solver.answer(key);
    if (answer === undefined) throw new Error(`The demand '${key}' did not finish.`);
    return answer;
  });
}

/** The computation that demands `key` (`c|`, `def|`, `cop|`, `lit|`, `op|`, `dk|`, `dn|`, `vdk|`, `vdn|`, as the parts write them). */
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
    case "dk": {
      const rest = parts[1] === "" || parts[1] === undefined ? [] : parts[1].split(".");
      return contract.defaultKinds(Number(parts[0]), rest);
    }
    case "dn":
      return contract.onlyNull(Number(parts[0]));
    case "vdk": {
      const rest = parts[1] === "" || parts[1] === undefined ? [] : parts[1].split(".");
      const node = parts[2] === "-" ? null : (program.flow.nodes[Number(parts[2])] ?? null);
      return values.defaultKinds(Number(parts[0]), node, rest);
    }
    case "vdn": {
      const node = parts[1] === "-" ? null : (program.flow.nodes[Number(parts[1])] ?? null);
      return values.onlyNull(Number(parts[0]), node);
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
  #stores: Map<FlowNode, Definition> | null = null;

  public constructor(pass: CorePass, consumers: Consumers, exhausted: BudgetLimit | null) {
    this.#pass = pass;
    this.#consumers = consumers;
    const program = pass.program;
    this.graph = program.flow;
    this.dominators = program.dom;
    this.diagnostics = exhausted === null ? [...consumers.diagnostics] : [];
    this.outcome = exhausted === null ? outcomeOf(this.diagnostics) : "budget-error";
    // each warning's obligation, one per warning (§4), then the boundary checks no warning owes
    const checks: Obligation[] = [];
    for (const diagnostic of this.diagnostics)
      if (diagnostic.class === "warning-runtime-check") {
        checks.push(diagnostic.obligation);
        const at = siteKey(diagnostic.obligation.site);
        const list = this.#obligations.get(at);
        if (list === undefined) this.#obligations.set(at, [diagnostic.obligation]);
        else list.push(diagnostic.obligation);
      }
    this.checks = checks;
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
    const target = program.occurrenceOf.has(base) ? program.targetRoot(value) : null;
    let route: Route = "value";
    if (target !== null)
      route = this.#consumers.quiet.has(value)
        ? "quiet"
        : "def" in
            exact.exactPath(
              keyOf(target.root, target.path),
              program.occNode.get(value) ?? program.projOf.get(value)?.node ?? node,
            )
          ? "exact"
          : "contract";
    return {
      items,
      route,
      place: target === null ? null : { id: target.root, path: target.path },
      obligations,
      narrowing: null,
    };
  }

  /** The store a statement makes, by its node: its first live store definition there. */
  #storeAt(node: FlowNode): Definition | null {
    if (this.#stores === null) {
      this.#stores = new Map();
      for (const d of this.#pass.definitions.storeDefs)
        if (!this.#stores.has(d.node) && this.#pass.lists.live(d)) this.#stores.set(d.node, d);
    }
    return this.#stores.get(node) ?? null;
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

  public project(
    node: FlowNode,
    step: "element" | "entry" | { readonly property: string },
  ): readonly Item[] {
    const value = this.#valueOf(node);
    if (value === null) return [];
    // a dict's entries are its element path (the collector's step names)
    const path = typeof step === "string" ? stepName(step) : step.property;
    return this.#run(this.#pass.values.valueItems(value, node, [path]));
  }

  public properties(node: FlowNode): ReadonlyMap<string, readonly Item[]> {
    const value = this.#valueOf(node);
    const out = new Map<string, readonly Item[]>();
    if (value === null) return out;
    for (const name of [...this.#propertyNames(value)].sort())
      out.set(name, this.#run(this.#pass.values.valueItems(value, node, [name])));
    return out;
  }

  /**
   * The names of a value's known properties (S3 §1): those the keys below its source store, and those the objects of
   * its literals have at its path. A source is a key, or a literal at a path: a value is followed through its
   * projections to a copied key, a call's result key or a literal; a key to its prefixes' stores and their sources'
   * own stores; a literal to the reads and calls standing at its path or above it. Each source once.
   */
  #propertyNames(value: PlaceId): ReadonlySet<string> {
    const { program, contract, definitions } = this.#pass;
    const names = new Set<string>();
    const pending: (
      { readonly key: Key } | { readonly literal: PlaceId; readonly path: readonly string[] }
    )[] = [];
    const seen = new Set<string>();
    // a value read further at a path: its key or its literal, through the projections that hold it
    const follow = (start: PlaceId, path: readonly string[]): void => {
      let base = start;
      const steps: string[] = [];
      for (;;) {
        const source = contract.copiedKey(base) ?? contract.resultKey(base);
        if (source !== null) {
          pending.push({ key: keyOf(keyPlace(source), [...keyPath(source), ...steps, ...path]) });
          return;
        }
        if (program.hasOf.has(base)) {
          pending.push({ literal: base, path: [...steps, ...path] });
          return;
        }
        const projection = program.projOf.get(base);
        if (
          projection === undefined ||
          projection.step === "iteration" ||
          projection.step === "length"
        )
          return;
        steps.unshift(stepName(projection.step));
        base = projection.owner;
      }
    };
    follow(value, []);
    while (pending.length > 0) {
      const source = pending.pop()!;
      if ("literal" in source) {
        const id = `l${source.literal}|${source.path.join(".")}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const index = contract.literalIndex(source.literal);
        for (const object of index.objects.get(source.path.join("."))?.list ?? [])
          for (const name of object.names) names.add(name);
        for (let length = 0; length <= source.path.length; length += 1) {
          const at = source.path.slice(0, length).join(".");
          const rest = source.path.slice(length);
          for (const entry of [...(index.reads.get(at) ?? []), ...(index.others.get(at) ?? [])])
            follow(entry.value, rest);
        }
        continue;
      }
      const key = source.key;
      if (seen.has(`k${key}`)) continue;
      seen.add(`k${key}`);
      const place = keyPlace(key);
      const path = keyPath(key);
      for (const below of definitions.keysBelow(key)) {
        const step = keyPath(below)[path.length];
        if (step !== undefined && step !== "element") names.add(step);
      }
      for (let length = 0; length <= path.length; length += 1) {
        const rest = path.slice(length);
        const stores = contract.prefixStores(keyOf(place, path.slice(0, length)));
        // the sources' own stores below their roots
        for (const sub of contract.subSources(stores))
          pending.push({ key: keyOf(keyPlace(sub), [...keyPath(sub), ...rest]) });
        for (const entry of stores.list) {
          const at = [...(entry.at ?? []), ...rest];
          if (entry.key !== undefined)
            pending.push({ key: keyOf(keyPlace(entry.key), [...keyPath(entry.key), ...at]) });
          else if (entry.value !== undefined) follow(entry.value, at);
        }
      }
    }
    return names;
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
