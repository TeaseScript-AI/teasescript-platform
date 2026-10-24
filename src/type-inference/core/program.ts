import type { FileTarget, Program } from "../../ast.js";
import type { TypeAnalysisRequest } from "../backend.js";
import { collectGraph } from "../collector.js";
import type {
  Constraint,
  ConstraintGraph,
  FunctionSignature,
  Place,
  PlaceId,
  SourceSite,
} from "../graph.js";
import { ledgerFor, type WorkLedger } from "./budget.js";
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

/**
 * The input of the coarse core's analysis (checkpoint 9): the project's files with what the analysis reads beside their
 * programs. The name pass's picks are the files each glob target may start, which the flow graph takes as the lowering
 * does (TABLE G1(f)); the source text names the operands an obligation checks (§10.5: `x` in `x / 4`).
 */
export interface CoreFile {
  readonly path: string;
  readonly program: Program;
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

/** The steps every selection or index is in the contract's vocabulary: `xs.element` (TABLE §10.5 r4.10). */
const ELEMENT_STEPS: ReadonlySet<string> = new Set(["first", "last", "random", "index", "entry"]);

/** A projection's step as a key's step: every selection and index is `element` (TABLE §1, F12). */
export function stepName(step: string): string {
  return ELEMENT_STEPS.has(step) ? "element" : step;
}

/** The key of a source site: its file and its span's offsets. */
export function siteKey(site: SourceSite): string {
  return `${site.file}:${site.start}:${site.end}`;
}

/**
 * The parsed nodes of the programs, every node with a kind, so formatting and comments do not count (TABLE §8), and
 * the deepest nesting of their blocks: a function's body, a block's, a branch's or a loop's body and an `else if`, each
 * one level.
 */
function measureSyntax(programs: readonly Program[]): {
  readonly nodes: number;
  readonly nesting: number;
} {
  let nodes = 0;
  let nesting = 0;
  const pending: { readonly value: unknown; readonly depth: number }[] = programs.map((value) => ({
    value,
    depth: 0,
  }));
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (value === null || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (const entry of value) pending.push({ value: entry, depth });
      continue;
    }
    // EVIDENCE: invariant: a non-array object of the parsed program, read by key.
    const fields = value as Readonly<Record<string, unknown>>;
    if (typeof fields["kind"] === "string") nodes += 1;
    const inner = fields["kind"] === "block" ? depth + 1 : depth;
    nesting = Math.max(nesting, inner);
    for (const key of Object.keys(fields)) {
      if (key === "span" || key === "site") continue;
      const field = fields[key];
      if (field === null || typeof field !== "object") continue;
      // an `else if` is an `if` nested in its predecessor's `else`: one level more
      const elseIf = key === "elseBlock" && "kind" in field && field.kind === "ifStatement";
      pending.push({ value: field, depth: elseIf ? inner + 1 : inner });
    }
  }
  return { nodes, nesting };
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

  public constructor(request: CoreAnalysisRequest) {
    const syntax = measureSyntax(request.files.map((file) => file.program));
    this.syntaxNodes = syntax.nodes;
    this.nesting = syntax.nesting;
    this.work = ledgerFor(this.syntaxNodes);
    this.work.charge("syntaxNodes", this.syntaxNodes);
    this.scope = { work: this.work, ingress: new IngressGraph() };
    this.#sources = request.files.map((file) => file.source);
    this.graph = collectGraph(request);
    this.flow = buildFlowGraph(request.files);
    this.dom = dominators(this.flow);
    // the graph and its dominators are setup work of the analysis (TABLE §8): their nodes, their edges, and a step per
    // node and edge of the dominator search
    const edges = this.flow.nodes.reduce((sum, node) => sum + node.successors.length, 0);
    this.work.charge("graphNodes", this.flow.nodes.length);
    this.work.charge("graphEdges", edges);
    this.work.charge("domSteps", this.flow.nodes.length + edges);
    this.places = this.graph.places;
    this.constraints = this.graph.constraints;
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
            step: typeof constraint.step === "object" ? constraint.step.property : constraint.step,
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
   * binding or literal at its root (`state.party.element.hp`).
   */
  public targetRoot(id: PlaceId): { readonly root: PlaceId; readonly path: readonly string[] } {
    const steps: string[] = [];
    let current = id;
    for (let projection = this.projOf.get(current); projection !== undefined;) {
      steps.push(stepName(projection.step));
      current = this.occurrenceOf.get(projection.owner) ?? projection.owner;
      projection = this.projOf.get(current);
    }
    return { root: current, path: steps.reverse() };
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
