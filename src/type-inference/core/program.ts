import type { FileTarget, Program } from "../../ast.js";
import type { SourceSpan } from "../../source.js";
import type { TypeAnalysisFile, TypeAnalysisRequest } from "../backend.js";
import { collectGraph } from "../collector.js";
import type {
  Constraint,
  ConstraintGraph,
  FunctionSignature,
  Place,
  PlaceId,
  SourceSite,
} from "../graph.js";
import { ledgerFor, NESTING_LIMIT, type WorkLedger } from "./budget.js";
import { dominators, type Dominators } from "./dominators.js";
import {
  buildFlowGraph,
  type Callable,
  type FlowGraph,
  type FlowNode,
  type FlowRegion,
  type FunctionRegion,
  type HandlerRegion,
} from "./flow-graph.js";
import { IngressGraph, type ItemScope, type Writer } from "./items.js";
import { selectsElement } from "./method-categories.js";

/**
 * The input of the coarse core's analysis (checkpoint 9): the request's files with both fields the core reads beside
 * their programs. The name pass's picks are the files each glob target may start, which the flow graph takes as the
 * lowering does (TABLE G1(f)); the source text names the operands an obligation checks (§10.5: `x` in `x / 4`).
 */
export interface CoreFile extends TypeAnalysisFile {
  readonly source: string;
  readonly picks: ReadonlyMap<FileTarget, readonly string[]>;
}

export interface CoreAnalysisRequest extends TypeAnalysisRequest {
  readonly files: readonly CoreFile[];
}

/** A projection of an owner value into a place (`project`): its step as the core names it, and its node. */
export interface Projection {
  readonly owner: PlaceId;
  /**
   * `element`, `entry`, `index`, `iteration`, a selection (`first`, `last`, `random`), or a property's name: an
   * object's own `first`, `last` or `random` is read as the selection the collector makes of it (F11).
   */
  readonly step: string;
  readonly node: FlowNode | null;
}

/** A literal's own cell or property (`cell`, `property` places), by its owner. */
export interface CellOwner {
  readonly kind: "cell" | "property";
  readonly owner: PlaceId;
}

/** The constraints that compute a value: an operation, a `get`, a fallback, a call or a load. */
export type ValueConstraint = Extract<
  Constraint,
  { readonly kind: "operation" | "get" | "fallback" | "call" | "load" }
>;

export type HasConstraint = Extract<Constraint, { readonly kind: "has" }>;

/**
 * The steps a projection takes that are no property (`ProjectionStep`, graph.ts): a key's path keeps a property of one
 * of these names apart from them (Astra B1), so `box.iteration` is `box`'s property, not a loop's visit.
 */
const INTERNAL_STEPS: ReadonlySet<string> = new Set(["element", "entry", "index", "iteration"]);

/** A property as a key's step: its name, quoted where it is an internal step's name (no identifier has a quote). */
export function propertyStep(name: string): string {
  return INTERNAL_STEPS.has(name) ? `'${name}` : name;
}

/** A key's step as its author wrote it: a quoted property's name. */
export function propertyName(step: string): string {
  return step.startsWith("'") ? step.slice(1) : step;
}

/** The steps of an index or an entry; with the selections, `xs.element` in the contract's vocabulary (TABLE §10.5 r4.10). */
const ELEMENT_STEPS: ReadonlySet<string> = new Set(["index", "entry"]);

/** A projection's step as a key's step: every selection and index is `element` (TABLE §1, F12). */
export function stepName(step: string): string {
  return ELEMENT_STEPS.has(step) || selectsElement(step) ? "element" : step;
}

/** The key of a source site: its file and its span's offsets. */
export function siteKey(site: SourceSite): string {
  return `${site.file}:${site.start}:${site.end}`;
}

/**
 * The parsed nodes of the programs, every node with a kind, so formatting and comments do not count (TABLE §8); the
 * deepest nesting of their blocks: a function's body, a block's, a branch's or a loop's body and an `else if`, each
 * one level; and the outermost blocks nested past the nesting limit, whose code is checked when the script runs.
 */
function measureSyntax(programs: readonly Program[]): {
  readonly nodes: number;
  readonly nesting: number;
  readonly deep: readonly SourceSite[];
} {
  let nodes = 0;
  let nesting = 0;
  const deep: SourceSite[] = [];
  const pending: {
    readonly value: unknown;
    readonly depth: number;
    readonly file: number;
    /** Inside a block already counted as too deep. */
    readonly inside: boolean;
  }[] = programs.map((value, file) => ({ value, depth: 0, file, inside: false }));
  while (pending.length > 0) {
    const { value, depth, file, inside } = pending.pop()!;
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const entry of value) pending.push({ value: entry, depth, file, inside });
      continue;
    }
    // EVIDENCE: invariant: a non-array object of the parsed program, read by key.
    const fields = value as Readonly<Record<string, unknown>>;
    const kinded = typeof fields["kind"] === "string";
    if (kinded) nodes += 1;
    const inner = fields["kind"] === "block" ? depth + 1 : depth;
    nesting = Math.max(nesting, inner);
    // the outermost node past the limit (a block, or an `else if` counted past it)
    const outermost = kinded && !inside && inner > NESTING_LIMIT;
    if (outermost) {
      // EVIDENCE: invariant: a parsed node with a kind has its span.
      const span = fields["span"] as SourceSpan;
      deep.push({ file, start: span.start.offset, end: span.end.offset });
    }
    for (const key of Object.keys(fields)) {
      if (key === "span" || key === "site") continue;
      const field = fields[key];
      if (field === null || typeof field !== "object") continue;
      // an `else if` is an `if` nested in its predecessor's `else`: one level more
      const elseIf = key === "elseBlock" && "kind" in field && field.kind === "ifStatement";
      pending.push({
        value: field,
        depth: elseIf ? inner + 1 : inner,
        file,
        inside: inside || outermost,
      });
    }
  }
  return { nodes, nesting, deep };
}

/**
 * The index of one analysis's input, built once: the collector's places and constraints by the ways the analysis looks
 * them up, the flow graph and its dominators, the work ledger, and the positions the dominator order gives nodes. The
 * collector's `PlaceId` and a path are a key's identity; a place's label is only how it is shown.
 */
export class CoreProgram {
  readonly graph: ConstraintGraph;
  readonly flow: FlowGraph;
  readonly dom: Dominators;
  readonly work: WorkLedger;
  readonly scope: ItemScope;
  readonly places: readonly Place[];
  readonly constraints: readonly Constraint[];
  readonly syntaxNodes: number;
  /** The deepest nesting of the programs' blocks. */
  readonly nesting: number;
  /** The outermost blocks nested past the nesting limit, by file and start: their code is checked when it runs. */
  readonly deep: readonly SourceSite[];

  /** A read's occurrence place, by the binding it reads. */
  readonly occurrenceOf = new Map<PlaceId, PlaceId>();
  /** A read's node: where the occurrence takes its value. */
  readonly occNode = new Map<PlaceId, FlowNode | null>();
  readonly projOf = new Map<PlaceId, Projection>();
  /** An expression's place by its span: its value, or the result of a property or element read. */
  readonly placeBySite = new Map<string, PlaceId>();
  readonly hasOf = new Map<PlaceId, HasConstraint[]>();
  readonly opOf = new Map<PlaceId, ValueConstraint>();
  readonly speakerPlaces = new Set<PlaceId>();
  readonly cellOwner = new Map<PlaceId, CellOwner>();
  /** A function call's result place, by its node. */
  readonly callOutOf = new Map<PlaceId, FlowNode | null>();
  readonly resultPlaces = new Set<PlaceId>();
  readonly #functions = new Map<number, FunctionSignature>();
  readonly #functionRegions = new Map<number, FunctionRegion>();
  readonly #parameterPlaces = new Map<string, PlaceId>();
  readonly #sources: readonly string[];

  /** The input's graphs, built uncharged; `index` charges them and indexes the rest, so a stop there keeps them. */
  public constructor(request: CoreAnalysisRequest) {
    const syntax = measureSyntax(request.files.map((file) => file.program));
    this.syntaxNodes = syntax.nodes;
    this.nesting = syntax.nesting;
    this.deep = [...syntax.deep].sort((a, b) => a.file - b.file || a.start - b.start);
    this.work = ledgerFor(this.syntaxNodes);
    this.scope = { work: this.work, ingress: new IngressGraph() };
    this.#sources = request.files.map((file) => file.source);
    this.graph = collectGraph(request);
    this.flow = buildFlowGraph(request.files);
    this.dom = dominators(this.flow);
    this.places = this.graph.places;
    this.constraints = this.graph.constraints;
  }

  /**
   * The setup work of the analysis (TABLE §8), charged, and the indexes: once, before anything reads them. A stop in it
   * leaves it to run again to its end, uncharged, for the finishing path (D4 a′).
   */
  public index(): void {
    if (this.#indexed) return;
    this.hasOf.clear();
    this.work.charge("syntaxNodes", this.syntaxNodes);
    // the graph and its dominators are setup work too: their nodes, their edges, and a step per node and edge of the
    // dominator search
    const edges = this.flow.nodes.reduce((sum, node) => sum + node.successors.length, 0);
    this.work.charge("graphNodes", this.flow.nodes.length);
    this.work.charge("graphEdges", edges);
    this.work.charge("domSteps", this.flow.nodes.length + edges);
    const regions = new Map<string, FunctionRegion>();
    for (const region of this.flow.regions)
      if (region.kind === "function")
        regions.set(`${region.file}:${region.declaration.name.name}`, region);
    for (const signature of this.graph.functions) {
      this.work.charge("indexSteps");
      this.#functions.set(signature.id, signature);
      const region = regions.get(`${signature.site.file}:${signature.name}`);
      if (region !== undefined) this.#functionRegions.set(signature.id, region);
      this.resultPlaces.add(signature.result);
      for (const parameter of signature.parameters) {
        const place = this.places[parameter]!;
        if (place.kind.kind === "parameter")
          this.#parameterPlaces.set(`${signature.id}:${place.kind.name}`, parameter);
      }
    }
    this.work.charge("indexSteps", 6 * this.constraints.length + this.places.length);
    for (const constraint of this.constraints) {
      switch (constraint.kind) {
        case "read":
          this.occurrenceOf.set(constraint.occurrence, constraint.binding);
          this.occNode.set(constraint.occurrence, this.exprAt(constraint.point.site));
          break;
        case "project":
          this.projOf.set(constraint.into, {
            owner: constraint.owner,
            step:
              typeof constraint.step === "object"
                ? propertyStep(constraint.step.property)
                : constraint.step,
            node: this.exprAt(constraint.site),
          });
          break;
        case "has": {
          const list = this.hasOf.get(constraint.place);
          if (list === undefined) this.hasOf.set(constraint.place, [constraint]);
          else list.push(constraint);
          break;
        }
        case "operation":
        case "get":
        case "fallback":
        case "load":
          this.opOf.set(constraint.result, constraint);
          break;
        case "call":
          this.opOf.set(constraint.result, constraint);
          this.callOutOf.set(constraint.result, this.exprAt(constraint.site));
          break;
        case "speakerRead":
          this.speakerPlaces.add(constraint.occurrence);
          break;
        default:
          break;
      }
    }
    for (const place of this.places) {
      this.work.charge("indexSteps");
      const kind = place.kind;
      if (kind.kind === "cell") this.cellOwner.set(place.id, { kind: "cell", owner: kind.owner });
      else if (kind.kind === "property")
        this.cellOwner.set(place.id, { kind: "property", owner: kind.owner });
      if (
        place.site !== null &&
        (kind.kind === "value" || (kind.kind === "target" && this.projOf.has(place.id)))
      ) {
        const key = siteKey(place.site);
        if (kind.kind === "value" || !this.placeBySite.has(key))
          this.placeBySite.set(key, place.id);
      }
    }
    // a speaker's field read is a consumer's operand
    for (const constraint of this.constraints)
      if (constraint.kind === "speakerRead" && !this.placeBySite.has(siteKey(constraint.site)))
        this.placeBySite.set(siteKey(constraint.site), constraint.occurrence);
    this.#indexed = true;
  }

  #indexed = false;

  /** Whether a site lies in code nested past the nesting limit (`deep`), by a binary search. */
  public isDeep(site: SourceSite): boolean {
    let low = 0;
    let high = this.deep.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      const block = this.deep[middle]!;
      if (block.file < site.file || (block.file === site.file && block.start <= site.start))
        low = middle + 1;
      else high = middle;
    }
    const block = this.deep[low - 1];
    return (
      block !== undefined &&
      block.file === site.file &&
      block.start <= site.start &&
      site.end <= block.end
    );
  }

  /** The number a callable's work is counted to (`WorkLedger.spender`): its region's, past setup's 0. */
  public spenderOf(node: FlowNode): number {
    const callable = this.flow.callableOf(node.region);
    return callable === null ? 0 : callable.id + 1;
  }

  public place(id: PlaceId): Place {
    const place = this.places[id];
    if (place === undefined) throw new RangeError(`The analysis has no place ${id}.`);
    return place;
  }

  public functionOf(id: number): FunctionSignature {
    const signature = this.#functions.get(id);
    if (signature === undefined) throw new RangeError(`The analysis has no function ${id}.`);
    return signature;
  }

  /** The flow graph's region of a function, when the graph has one (a function in a file it walked). */
  public functionRegion(id: number): FunctionRegion | undefined {
    return this.#functionRegions.get(id);
  }

  public parameterPlace(fn: number, name: string): PlaceId | undefined {
    return this.#parameterPlaces.get(`${fn}:${name}`);
  }

  /** The node of the expression at `site`, or `null`. */
  public exprAt(site: SourceSite): FlowNode | null {
    return this.flow.expressionAt(site) ?? null;
  }

  /** The node of the statement an expression at `site` belongs to: where a store takes effect. */
  public effectNode(site: SourceSite): FlowNode | null {
    const node = this.exprAt(site);
    return node === null ? null : (node.enclosing ?? node);
  }

  /** Whether a place is a host global: data the compiler knows nothing about (F19). */
  public isHost(id: PlaceId): boolean {
    const kind = this.places[id]?.kind;
    return kind?.kind === "binding" && kind.declared === "host";
  }

  /**
   * The place a value is stored into or read from, with the path of steps below it: through every projection to the
   * binding or literal at its root (`state.party.element.hp`). A store (`store`) through a property sets that property,
   * as the runtime assigns it, so the stored place's own `first`, `last` or `random` is an object's property there (V30
   * §15, ADR 0021 §1.4); only a read takes the name as the collector's element selection (F11).
   */
  public targetRoot(
    id: PlaceId,
    store = false,
  ): { readonly root: PlaceId; readonly path: readonly string[] } {
    const steps: string[] = [];
    let current = id;
    for (let projection = this.projOf.get(current); projection !== undefined;) {
      steps.push(
        store && current === id && selectsElement(projection.step)
          ? projection.step
          : stepName(projection.step),
      );
      current = this.occurrenceOf.get(projection.owner) ?? projection.owner;
      projection = this.projOf.get(current);
    }
    return { root: current, path: steps.reverse() };
  }

  /** A file's whole text as a site. */
  public fileSite(file: number): SourceSite {
    return { file, start: 0, end: (this.#sources[file] ?? "").length };
  }

  /** The source text at a site. */
  public textAt(site: SourceSite): string {
    return (this.#sources[site.file] ?? "").slice(site.start, site.end);
  }

  /** The writer token of a store or source (F28): its kind and its site. */
  public writer(kind: string, site: SourceSite): Writer {
    return { kind, file: site.file, start: site.start, end: site.end };
  }

  /** Whether a node lies in code the session can reach: the dominator search found it (X1 for dominance). */
  public reached(node: FlowNode): boolean {
    return this.dom.dfsIn(node) !== -1;
  }

  public live(node: FlowNode): boolean {
    return !node.dead && this.reached(node);
  }

  /** A node's position in the dominator tree's walk: where its interval starts. */
  public position(node: FlowNode): number {
    return this.dom.dfsIn(node);
  }

  /** Where a node's interval in the dominator tree's walk ends. */
  public positionEnd(node: FlowNode): number {
    return this.dom.dfsOut(node);
  }

  /** The block a node's code stands in, through the regions it is nested in, or `null`. */
  public handlerOf(node: FlowNode): HandlerRegion | null {
    for (let id: number | null = node.region; id !== null;) {
      this.work.charge("regionWalks");
      const region: FlowRegion = this.flow.regions[id]!;
      if (region.kind === "handler") return region;
      id = region.parent;
    }
    return null;
  }

  /** The function or file whose activation runs a node's code; a block's code is its creator's. */
  public callableAt(node: FlowNode): Callable | null {
    return this.flow.callableOf(node.region);
  }

  /** A block's own code, and the code of a callable a block may run (F24's handler stores, X7). */
  public inBlockCode(node: FlowNode): boolean {
    if (this.handlerOf(node) !== null) return true;
    const callable = this.flow.callableOf(node.region);
    return callable !== null && this.flow.blockCalled.has(callable);
  }

  /** Block code, and the code after a label that a `goto` in a block may reach (X7's handler-reachable code). */
  public blockReachable(node: FlowNode): boolean {
    return this.inBlockCode(node) || this.flow.blockReached.has(node);
  }
}
