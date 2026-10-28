import type { Expression } from "../../ast.js";
import type { KnownValue } from "../../static-evaluation.js";
import { NULL_TYPE, UNKNOWN_TYPE, isScalarKind, type StaticType } from "../../static-types.js";
import { VALUE_KINDS, type PlainKind, type ValueKind } from "../../value-kinds.js";
import type { OperandView } from "../adapters/relation.js";
import type { DynamicWhy, PlaceId, SourceSite, TypeTerm } from "../graph.js";
import {
  BudgetExhausted,
  joinParts,
  joinSteps,
  keepText,
  splitPath,
  type BudgetLimit,
  type WorkCounter,
} from "./budget.js";
import { Consumers, STOP_RULE, typedCall } from "./consumers.js";
import { propertyNames, type PropertyNamesTask } from "./property-names.js";
import {
  Contract,
  typedDefault,
  typeTags,
  termAt,
  writtenOf,
  type ContractFacts,
  type GatherSite,
} from "./contract.js";
import {
  DefinitionIndex,
  DefinitionLists,
  keyOf,
  type Definition,
  type Key,
} from "./definitions.js";
import type { Dominators } from "./dominators.js";
import { ExactPath, withoutEmpty } from "./exact-path.js";
import type { Callable, FileRegion, FlowGraph, FlowNode, FunctionRegion } from "./flow-graph.js";
import { GuardIndex } from "./guards.js";
import { HandlerIndex } from "./handlers.js";
import { makeItem, REASON, STOPPED, type Item, type ItemTag } from "./items.js";
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
  type BudgetStop,
  type CoreDiagnostic,
  type CoreOutcome,
  type CoreResult,
  type NotChecked,
  type Obligation,
  type WorkPlace,
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
  /** The limit the analysis stopped proving at (D4 a′), or `null`. */
  readonly exhausted: BudgetLimit | null;
  /** The warnings of the checks the stop moved to the runtime, never shown one by one (`Consumers.deferred`). */
  readonly deferred: readonly Extract<CoreDiagnostic, { obligation: unknown }>[];
  /** The work after the stop: the finishing path's, apart from `total`. */
  readonly finishing: number;
  /**
   * The phase the stop came in (TABLE r4.90's lifecycle): the setup (a pass's own included), admission's walk, the
   * consumers' walk, the publication of boundaries, or the questions after a finished analysis; `null` without a stop.
   */
  readonly stoppedIn: StopPhase | null;
  /**
   * Whether what the analysis found before the stop stands: its pass's admission had settled (A6), or the analysis had
   * finished; else nothing of it stands and every unit was finished afresh. True without a stop.
   */
  readonly settled: boolean;
  /** Each consumer read's demand: the work it was the first to compute, against its demand allowance (S3 §5). */
  readonly demands: readonly ReadWork[];
  /** The finished demands with their work. */
  readonly finished: readonly DemandWork[];
  /** Facts of the indexes for the identity and mark controls (not work). */
  readonly facts: ContractFacts;
}

export type StopPhase = "setup" | "admission" | "walk" | "publication" | "questions";

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
  /**
   * These answers stopped at `limit` after the analysis ran to its end (a question after it spent the allowance): its
   * findings and decisions stand, its warning says so, and what is asked from then on answers `STOPPED` (D4 a′).
   */
  stoppedAt(limit: BudgetLimit): Answers;
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
  /**
   * Gives `view` its known values: the one constant service the consumer owns (S3 §1, TABLE r4.81 (3)), so the known
   * value a view reads and the consumer's own are one; until then a view knows none.
   */
  shareKnown(known: (expression: Expression) => KnownValue | undefined): void;
}

/**
 * The analysis of a project by the coarse core: its answers, published after its last pass. A stop is no compile
 * error (the owner's D4, option a′, TABLE r4.54, r4.55): past the work allowance or a read chain's depth the analysis
 * stops proving, and statements nested past the nesting limit are not proved at all; what it found stays, every check it
 * did not decide runs when the script runs, and one warning says so (`finished`). `stopped`: the analysis stops at
 * its start, as a question after an analysis that crossed the allowance stops it (the candidate route).
 */
export function analyseCore(request: CoreAnalysisRequest, stopped?: BudgetLimit): Answers {
  const program = new CoreProgram(request);
  let analysed: { readonly pass: CorePass; readonly consumers: Consumers } | null = null;
  let rejected: ReadonlyMap<number, ReadonlySet<Key>> = new Map();
  if (stopped !== undefined) program.work.stop(stopped);
  else
    try {
      program.index();
      // A6: the passes repeat, every memo recomputed, until the rejected set is stable; a set that repeats is a cycle,
      // whose changing stores stay possibilities
      let cycling: ReadonlySet<number> = new Set();
      const sets: ReadonlyMap<number, ReadonlySet<Key>>[] = [rejected];
      for (let last = false; ;) {
        const pass = createPass(program, rejected);
        const consumers = new Consumers(pass, rejected, cycling, last);
        analysed = { pass, consumers };
        consumers.check();
        if (consumers.stopped !== null) break;
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
      // a stop in the setup or in a pass's own setup, outside the consumers' walk
      if (!(error instanceof BudgetExhausted)) throw error;
      program.work.stop(error.limit);
    }
  // the written types' own errors (V30 §13's union rule), from the declarations alone
  const written = writtenTypeErrors(request.files.map((file) => file.program));
  if (program.work.stopped !== null) return finished(program, analysed, rejected, written);
  // statements nested past the limit, the analysis run to its end: their checks run when the script runs
  const { pass, consumers } = analysed!;
  if (program.deep.length > 0) program.work.apart(() => consumers.finish(false));
  try {
    return new CoreAnswers(
      pass,
      consumers,
      written,
      consumers.deferred.length > 0 ? "nesting" : null,
    );
  } catch (error) {
    // (the answers' own setup after the finished analysis: a stop there is a question's, `stoppedAt`)
    if (!(error instanceof BudgetExhausted)) throw error;
    program.work.stop(error.limit);
    return new CoreAnswers(pass, consumers, written, error.limit, "questions");
  }
}

/**
 * The finishing path of an analysis that stopped at `limit` (D4 a′, S3 §5): only cheap work, no further proving. The
 * setup the stop cut is finished; a pass whose admission settled keeps what its walk found and walks the units the stop
 * left, and the units nested past the nesting limit; any other walks every unit from a fresh pass, none of its findings
 * standing (A6: a later pass could still change them). Each unit reads every value as `unknown` with the reason
 * `budget`, so it owes its check when the script runs.
 */
function finished(
  program: CoreProgram,
  analysed: { readonly pass: CorePass; readonly consumers: Consumers } | null,
  rejected: ReadonlyMap<number, ReadonlySet<Key>>,
  written: readonly WrittenTypeError[],
): Answers {
  const limit = program.work.stopped!;
  program.index();
  const standing = analysed !== null && analysed.consumers.settled ? analysed : null;
  const { pass, consumers } =
    standing ??
    (() => {
      const pass = createPass(program, rejected);
      return { pass, consumers: new Consumers(pass, rejected, new Set(), true, true) };
    })();
  const phase = analysed?.consumers.stopPhase() ?? "setup";
  consumers.finish(standing === null);
  return new CoreAnswers(pass, consumers, written, limit, phase);
}

/**
 * The core's result in S2's record shape, derived from its answers: the diagnostics, and the checks none owns (the
 * boundary checks, and those a stop moved to the runtime).
 */
export function coreResult(answers: Answers): CoreResult {
  return {
    outcome: answers.outcome,
    diagnostics: answers.diagnostics,
    checks: [
      ...answers.checks.filter((check) => check.boundary),
      ...answers.budget.deferred.map((diagnostic) => diagnostic.obligation),
    ],
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
 * `vdn|`, `lp|`, `cr|`, `ce|`, `vg|`, `gv|`, `n5|`, `n5-loop|`, as the parts write them).
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
    case "lp": {
      // (`Contract.gathered`: its kind, literal, range, node, flags, path and rest)
      const node = parts[4] === "-" ? null : (program.flow.nodes[Number(parts[4])] ?? null);
      const [kind, flags, path] = [parts[0]!, parts[5] ?? "", parts[6] ?? ""];
      const literal = Number(parts[1]);
      let site: GatherSite;
      if (kind === "selected")
        site = { kind, literal, path, byValue: flags.includes("v"), below: flags.includes("b") };
      else if (kind === "exact" || kind === "copies" || kind === "others")
        site = { kind, literal, path, deeper: flags === "d" };
      else throw new Error(`No gather is written '${key}'.`);
      return contract.gathered(
        site,
        node,
        splitPath(parts[7] ?? ""),
        Number(parts[2]),
        Number(parts[3]),
      );
    }
    case "cr": {
      // (`Values.choiceRange`: its choice's result, range, node and rest)
      const c = program.opOf.get(Number(parts[0]));
      if (c?.kind !== "operation") throw new Error(`No choice is written '${key}'.`);
      const node = parts[3] === "-" ? null : (program.flow.nodes[Number(parts[3])] ?? null);
      return values.choiceRange(
        c,
        node,
        splitPath(parts[4] ?? ""),
        Number(parts[1]),
        Number(parts[2]),
      );
    }
    case "ce": {
      // (`Values.choiceElements`: its choice's result, option, range, node and rest)
      const c = program.opOf.get(Number(parts[0]));
      if (c?.kind !== "operation") throw new Error(`No choice is written '${key}'.`);
      const node = parts[4] === "-" ? null : (program.flow.nodes[Number(parts[4])] ?? null);
      return values.choiceElements(
        c,
        node,
        splitPath(parts[5] ?? ""),
        Number(parts[1]),
        Number(parts[2]),
        Number(parts[3]),
      );
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

/**
 * The places work is counted to and the stop names (D4 a′): each file's top level and each function, by its region,
 * and the one a site stands in (functions stand at a file's top level, never nested: V30 §11).
 */
function workPlaces(program: CoreProgram): {
  readonly of: (site: SourceSite) => FileRegion | FunctionRegion;
  readonly place: (region: FileRegion | FunctionRegion) => WorkPlace;
  readonly site: (region: FileRegion | FunctionRegion) => SourceSite;
} {
  const files = new Map<number, FileRegion>();
  const functions = new Map<number, FunctionRegion[]>();
  for (const region of program.flow.regions)
    if (region.kind === "file") files.set(region.file, region);
    else if (region.kind === "function") {
      const list = functions.get(region.file);
      if (list === undefined) functions.set(region.file, [region]);
      else list.push(region);
    }
  for (const list of functions.values())
    list.sort((a, b) => a.declaration.span.start.offset - b.declaration.span.start.offset);
  const spanSite = (file: number, span: FunctionRegion["declaration"]["span"]): SourceSite => ({
    file,
    start: span.start.offset,
    end: span.end.offset,
  });
  return {
    of: (site) => {
      const list = functions.get(site.file) ?? [];
      let low = 0;
      let high = list.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (list[middle]!.declaration.span.start.offset <= site.start) low = middle + 1;
        else high = middle;
      }
      const found = list[low - 1];
      return found !== undefined && site.end <= found.declaration.span.end.offset
        ? found
        : files.get(site.file)!;
    },
    place: (region) =>
      region.kind === "function"
        ? {
            name: region.declaration.name.name,
            path: files.get(region.file)?.path ?? "",
            lines: spanSite(region.file, region.declaration.span),
          }
        : { name: null, path: region.path, lines: program.fileSite(region.file) },
    site: (region) =>
      region.kind === "function"
        ? spanSite(region.file, region.declaration.name.span)
        : { file: region.file, start: 0, end: 0 },
  };
}

/**
 * The stop's diagnostics (D4 a′, TABLE r4.54): one warning at the heaviest place, the function or top level whose work
 * was the most before the stop (the deepest nesting's for `nesting`), counting the checks moved to the runtime; and
 * "not checked (budget)", once per function or top level one of those checks stands in, at its name or at its first.
 */
function stopDiagnostics(
  program: CoreProgram,
  limit: BudgetLimit,
  deferred: readonly Extract<CoreDiagnostic, { obligation: unknown }>[],
): (BudgetStop | NotChecked)[] {
  const places = workPlaces(program);
  const unchecked = new Map<FileRegion | FunctionRegion, SourceSite>();
  for (const diagnostic of [...deferred].sort(
    // (in source order, the whole site: one order for every order of the walk)
    (a, b) => a.site.file - b.site.file || a.site.start - b.site.start || a.site.end - b.site.end,
  )) {
    const region = places.of(diagnostic.site);
    if (!unchecked.has(region))
      unchecked.set(region, region.kind === "function" ? places.site(region) : diagnostic.site);
  }
  let heaviest: FileRegion | FunctionRegion;
  if (limit === "nesting") heaviest = places.of(program.deep[0]!);
  else {
    // the most work counted to one place, the earliest region on a tie; setup's (0) names none, nor a block's creator
    const spent = program.work.spent();
    let best = 0;
    for (let spender = 1; spender < spent.length; spender += 1)
      if ((spent[spender] ?? 0) > (best === 0 ? 0 : (spent[best] ?? 0))) best = spender;
    const region = best === 0 ? undefined : program.flow.regions[best - 1];
    heaviest =
      region?.kind === "function" || region?.kind === "file"
        ? region
        : places.of({ file: 0, start: 0, end: 0 });
  }
  const stop: BudgetStop = {
    class: "warning-runtime-check",
    kind: "budget",
    code: "TSV076",
    site: unchecked.get(heaviest) ?? places.site(heaviest),
    limit,
    place: places.place(heaviest),
    deferred: deferred.length,
  };
  return [
    stop,
    ...[...unchecked].map(([region, site]): NotChecked => ({
      class: "not-checked-budget",
      kind: "budget",
      code: "TSV076",
      site,
      place: places.place(region),
    })),
  ];
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

/** The literals whose own syntax gives their kind after a stop: a scalar's (`atom`), or a collection's or an object's. */
const OWN_KINDS: ReadonlyMap<string, "atom" | "list" | "set" | "dict" | "object"> = new Map([
  ["numberLiteral", "atom"],
  ["booleanLiteral", "atom"],
  ["nullLiteral", "atom"],
  ["stringLiteral", "atom"],
  ["durationLiteral", "atom"],
  ["regexLiteral", "atom"],
  ["listLiteral", "list"],
  ["setLiteral", "set"],
  ["dictLiteral", "dict"],
  ["objectLiteral", "object"],
]);

/** What a value's own syntax gives at a path after a stop (`CoreAnswers.#stoppedShape`): items and property names. */
interface StoppedShape {
  readonly items: readonly Item[];
  readonly names: ReadonlySet<string>;
}

const NO_NAMES: ReadonlySet<string> = new Set();

/** Whether an item is the unknown a stop leaves (`STOPPED`'s). */
function isStopped(item: Item): boolean {
  return item.tag === "unknown" && (item.reasons & REASON.budget) !== 0;
}

/** The property names a type term gives, through its unions. */
function termProperties(term: TypeTerm): string[] {
  if (term.kind === "union") return term.members.flatMap(termProperties);
  return term.kind === "object" ? (term.properties ?? []).map((property) => property.name) : [];
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
  readonly #written: readonly WrittenTypeError[];
  readonly #obligations = new Map<string, Obligation[]>();
  #stores: Map<FlowNode, Definition> | null = null;
  #known: ((expression: Expression) => KnownValue | undefined) | null = null;
  /** The analysis stopped (D4 a′): no question asks the solver, every value read is `unknown` with `budget`. */
  readonly #stopped: boolean;

  public constructor(
    pass: CorePass,
    consumers: Consumers,
    written: readonly WrittenTypeError[],
    exhausted: BudgetLimit | null,
    stoppedIn: StopPhase | null = null,
  ) {
    this.#pass = pass;
    this.#consumers = consumers;
    this.#written = written;
    // (a stop, not statements nested too deep after an analysis that ran to its end: its answers stand)
    this.#stopped = pass.program.work.stopped !== null;
    const program = pass.program;
    this.graph = program.flow;
    this.dominators = program.dom;
    this.initializers = initializersOf(program);
    // published in source order of their sites, at one site the written types' errors first, then each consumer's in
    // the order they run (TABLE r4.86 (1)), the finishing path's as the walk's, then a stop's own warning and marks
    const ranked = (
      item: CoreDiagnostic,
    ): { readonly item: CoreDiagnostic; readonly rule: number } => ({
      item,
      rule: consumers.rules.get(item) ?? 0,
    });
    this.diagnostics = bySite([
      ...[...written, ...consumers.diagnostics].map(ranked),
      ...(exhausted === null ? [] : stopDiagnostics(program, exhausted, consumers.deferred)).map(
        (item) => ({ item, rule: STOP_RULE }),
      ),
    ]);
    this.outcome = outcomeOf(this.diagnostics);
    // each warning's obligation, one per warning (§4), then the boundary checks no warning owes: in source order of their
    // sites, at one site the warnings' obligations in the diagnostics' order (a stop's moved checks after the shown
    // ones'), then the others (`checksBySite`)
    const owned: Obligation[] = [];
    for (const diagnostic of this.diagnostics)
      if (diagnostic.class === "warning-runtime-check" && diagnostic.kind !== "budget") {
        owned.push(diagnostic.obligation);
        const at = siteKey(diagnostic.obligation.site);
        const list = this.#obligations.get(at);
        if (list === undefined) this.#obligations.set(at, [diagnostic.obligation]);
        else list.push(diagnostic.obligation);
      }
    for (const diagnostic of bySite(
      consumers.deferred.map((item) => ({ item, rule: consumers.rules.get(item) ?? 0 })),
    ))
      owned.push(diagnostic.obligation);
    const others: { readonly item: Obligation; readonly rule: number }[] = [];
    // (the boundaries are the walk's last step, finished after any stop: where admission had not settled, those into
    // written types, every other ingress store marked)
    if (consumers.published)
      for (const list of consumers.admission.boundaries.values())
        for (const item of list) others.push({ item, rule: 0 });
    for (const item of consumers.admission.readChecks) others.push({ item, rule: 1 });
    this.checks = checksBySite(owned, bySite(others));
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
      deferred: consumers.deferred,
      finishing: program.work.finishing,
      stoppedIn,
      settled: exhausted === null || consumers.settled,
      demands: consumers.reads,
      finished: pass.solver.demandWork(),
      facts: { ...pass.contract.facts },
    };
  }

  /**
   * A question of a value's items. After a stop the solver computes nothing and answers what it had finished (its
   * memo) or `STOPPED`; where admission had not settled even those may change, so every value is `STOPPED` (D4 a′).
   */
  #run(work: Work<readonly Item[]>): readonly Item[] {
    return this.#stopped && !this.#consumers.settled ? STOPPED : this.#pass.solver.run(work);
  }

  /**
   * A value's items at a node and a path. After a stop, the finishing read's sources in their order (TABLE r4.138): the
   * solver's finished answer where admission had settled; else what the value's own syntax gives (`#stoppedShape`: a
   * literal's own kinds, a typed call's expected type at every depth); else the domains the consumers' finishing read
   * holds, the key's finished contract and its written or retained admitted type (`Consumers.finishedItems`).
   */
  #items(value: PlaceId, node: FlowNode | null, path: readonly string[]): readonly Item[] {
    const answered = this.#run(this.#pass.values.valueItems(value, node, path));
    if (!this.#stopped || !answered.some(isStopped)) return answered;
    const own = this.#stoppedShape(value, path).items;
    return own !== STOPPED ? own : this.#consumers.finishedItems(value, node, path);
  }

  /**
   * After a stop, what a value's own syntax gives at a path, with no proof (D4 a′): its items and its objects' property
   * names. A literal gives its own kind, and its children's below it (`#literalShape`); a typed parse's or load's
   * expected type (F18) is its written destination's (`landsIn`), else its default's as a typed default reads it
   * (`typedDefault`: a `null` there leaves its level open), at every depth, a literal's child included; any other
   * value `STOPPED`. Each typed call and path once, every link of a chain of typed defaults sharing it; a literal's own
   * shape is kept apart from what a typed call makes of it.
   */
  #stoppedShape(value: PlaceId, path: readonly string[]): StoppedShape {
    const { program, contract } = this.#pass;
    if (typedCall(program, value) === null) return this.#literalShape(value, path);
    const known = this.#typedShapes.get(joinParts(value, path));
    if (known !== undefined) return known;
    const chain: PlaceId[] = [value];
    let at = value;
    let found: StoppedShape | null = null;
    for (let call = typedCall(program, at); found === null && call !== null;) {
      program.work.charge("checks");
      const written = contract.landsIn(at, []);
      if (written !== null) {
        const term = termAt(written, path);
        const tags = term === null ? [] : typeTags(term).filter((tag) => tag !== "unknown");
        found = {
          items:
            tags.length === 0 ? STOPPED : tags.map((tag) => makeItem(tag, null, { cert: "def" })),
          names: term === null ? NO_NAMES : new Set(termProperties(term)),
        };
      } else if (call.fallback === undefined) found = { items: STOPPED, names: NO_NAMES };
      else {
        at = call.fallback;
        call = typedCall(program, at);
        if (call !== null) {
          found = this.#typedShapes.get(joinParts(at, path)) ?? null;
          chain.push(at);
        } else {
          // the default itself: its own shape, as a typed default reads it
          const own = this.#literalShape(at, path);
          const decision = typedDefault(path, false);
          found = {
            items:
              own.items === STOPPED
                ? STOPPED
                : decision.answer(decision.choose(own.items), own.items),
            names: own.names,
          };
        }
      }
    }
    for (const link of chain) {
      const key = joinParts(link, path);
      keepText(program.work, key.length);
      this.#typedShapes.set(key, found!);
    }
    return found!;
  }

  readonly #typedShapes = new Map<string, StoppedShape>();

  /** A literal's own shape at a path: a scalar's kind, a collection's or an object's, and its children's below it. */
  #literalShape(value: PlaceId, path: readonly string[]): StoppedShape {
    const key = joinParts(value, path);
    let shape = this.#literalShapes.get(key);
    if (shape === undefined) {
      keepText(this.#pass.program.work, key.length);
      shape = this.#literalShapeOf(value, path);
      this.#literalShapes.set(key, shape);
    }
    return shape;
  }

  readonly #literalShapes = new Map<string, StoppedShape>();

  #literalShapeOf(value: PlaceId, path: readonly string[]): StoppedShape {
    const { program } = this.#pass;
    program.work.charge("checks");
    const kind = program.places[value]?.kind;
    const own = kind?.kind === "value" ? OWN_KINDS.get(kind.node) : undefined;
    if (own === undefined) return { items: STOPPED, names: NO_NAMES };
    if (own === "atom") {
      const has = program.hasOf.get(value);
      return path.length === 0 && has?.length === 1 && has[0]!.type.kind === "atom"
        ? { items: [makeItem(has[0]!.type.name, null, { cert: "def" })], names: NO_NAMES }
        : { items: STOPPED, names: NO_NAMES };
    }
    if (path.length === 0) {
      const names = new Set<string>();
      if (own === "object")
        for (const has of program.hasOf.get(value) ?? [])
          for (const name of termProperties(has.type)) names.add(name);
      return { items: [makeItem(own, null, { cert: "def" })], names };
    }
    // each child as its own syntax gives it, at the path's own step (`literalChildren` keys a collection's elements and
    // a dict's values alike)
    const items: Item[] = [];
    const names = new Set<string>();
    for (const child of this.#consumers.admission.literalChildren(value, path[0]!)) {
      if (child.value === undefined) continue;
      const shape = this.#stoppedShape(child.value, path.slice(1));
      for (const item of shape.items) items.push(item);
      for (const name of shape.names) names.add(name);
    }
    return { items: items.length === 0 ? STOPPED : items, names };
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

  public stoppedAt(limit: BudgetLimit): Answers {
    this.#pass.program.work.stop(limit);
    return new CoreAnswers(this.#pass, this.#consumers, this.#written, limit, "questions");
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
            items: d.value === undefined ? [] : this.#items(d.value, node, []),
            route: "value",
            place: { id: d.place, path: d.path },
            obligations,
            narrowing: null,
          };
    }
    const items = this.#items(value, node, []);
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
          : this.#stopped
            ? "contract"
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
    let defined: PlaceAnswer["definitions"] | null = null;
    return {
      admitted: this.#admitted(id, path, term),
      contract: {
        kinds: withoutEmpty(kinds),
        elements: withoutEmpty(elements),
        emptiness: elements.some((item) => item.tag === "empty") ? "open" : "held",
      },
      ingresses: this.#consumers.admission.boundaries.get(key) ?? [],
      // the exact service's list, not the raw stores (Astra B8), made where it is read: a key's events walk its
      // prefixes, and most askers want the place's types alone (the slice's facts ask one per expression)
      get definitions() {
        return (defined ??= {
          list: lists.definitionsOf(key).list,
          owner: definitions.declaringCallable(id),
          ownedAway: definitions.ownedAway(key),
          events: lists.ownEvents(key),
        });
      },
    };
  }

  #admitted(id: PlaceId, path: readonly string[], term: TypeTerm | null): AdmittedType {
    // (each kind once: `(null | string)?` admits `null` and `string`)
    if (term !== null) return { by: "written", kinds: [...new Set(typeTags(term))] };
    // (after a stop nothing is decided but what is written, unless admission had settled: its decisions stand)
    if (this.#stopped && !this.#consumers.settled) return { by: "undecided" };
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
    return this.#items(value, node, [path]);
  }

  public properties(node: FlowNode): ReadonlyMap<string, readonly Item[]> {
    const value = this.#valueOf(node);
    const out = new Map<string, readonly Item[]>();
    if (value === null) return out;
    for (const name of [...this.#propertyNames({ value, path: [] })].sort())
      out.set(name, this.#items(value, node, [propertyStep(name)]));
    return out;
  }

  public placeProperties(id: PlaceId, path: readonly string[] = []): ReadonlySet<string> {
    return this.#propertyNames({ key: keyOf(id, path) });
  }

  public valueAt(node: FlowNode, path: readonly string[]): ValueAnswer {
    const value = this.#valueOf(node);
    if (value === null) return { items: [], properties: new Set() };
    const items = this.#items(value, node, path);
    // only an object has properties to find
    return {
      items,
      properties: items.some((item) => item.tag === "object")
        ? this.#propertyNames({ value, path })
        : new Set(),
    };
  }

  #propertyNames(start: PropertyNamesTask): ReadonlySet<string> {
    // (after a stop before admission settled only what a value's own syntax names: a literal's or a written
    // destination's properties)
    if (this.#stopped && !this.#consumers.settled) {
      const names = new Set<string>();
      if ("value" in start)
        for (const name of this.#stoppedShape(start.value, start.path).names) names.add(name);
      return names;
    }
    return propertyNames(this.#pass, (work) => this.#pass.solver.run(work), start);
  }

  public view(node: FlowNode): CoreView {
    const value = this.#valueOf(node);
    const items = value === null ? [] : withoutEmpty(this.#items(value, node, []));
    const alternatives = items
      .map((item) => closedType(item.tag))
      .filter((type): type is StaticType => type !== null);
    const unknown = items.find((item) => item.tag === "unknown");
    return {
      alternatives: alternatives.length > 0 ? alternatives : null,
      dynamic: unknown === undefined ? null : dynamicWhy(unknown.reasons),
      // the constant service's value is the consumer's (S3 §2, group V)
      known: node.expression === undefined ? undefined : this.#known?.(node.expression),
      certain: items.length > 0 && items.every((item) => item.cert === "def"),
    };
  }

  public shareKnown(known: (expression: Expression) => KnownValue | undefined): void {
    this.#known = known;
  }
}
