import type { OperationRelations } from "../adapters/relation.js";
import type {
  Constraint,
  ConstraintGraph,
  FunctionSignature,
  PlaceId,
  ProjectionStep,
  TypeTerm,
} from "../graph.js";
import {
  Cells,
  positionAt,
  type CellId,
  type Contribution,
  type Item,
  type Position,
  type Tag,
} from "./cells.js";
import { interpret, nonWorking, type CellView } from "./interpret.js";
import { lift, memberRelation, type LiftContext, type Operation } from "./lifting.js";
import { run, type RunReport } from "./schedule.js";
import { TypeTable } from "./types.js";

// The solver's driver (O4 stage 3a, work note §3; the executable reference model is the contract): the graph's
// places become cells, the written bounds, the host bindings and the literal parts empty by construction are seeded,
// and every constraint is a node of the schedule whose transfer adds evidence to cells. A transfer copies items
// (tags kept, a bound's member read as a member, the declaration mark set by the store that is the declaration and
// never inherited, the position stamped at a copy boundary and mirrored by a read or a projection), reaches a part in
// place, or lifts a relation. For the schedule, every transfer is an undirected edge between the cells it names,
// because a structural value's parts are shared in place by every cell that holds it; a change under a cell is
// reported as a change of the cell. After the fixpoint, interpretation runs once: the working kinds, and the
// operations that cannot succeed, counted without cascades.

export interface SolveOptions {
  readonly relations: OperationRelations;
  readonly table?: TypeTable | undefined;
  /** Evaluate every constraint once more after solving and fail if anything changes (tests). */
  readonly verify?: boolean | undefined;
  /** Hears every evaluation with the cells it changed (the measurement of work note §8, and debugging). */
  readonly trace?:
    ((node: number, constraint: Constraint, changed: readonly CellId[]) => void) | undefined;
}

export interface Solution {
  readonly graph: ConstraintGraph;
  readonly table: TypeTable;
  readonly cells: Cells;
  readonly report: RunReport;
  /** The number of relation asks while solving and interpreting. */
  readonly asks: number;
  /** The operations with an invalid counted combination: `<family>.<name>@<site>:none` or `:partial(i/n)`, sorted. */
  readonly statuses: readonly string[];
  view(cell: CellId): CellView;
}

const DECL_STORES: readonly string[] = [
  "initializer",
  "parameter default",
  "loop variable",
  "start value",
];

type DeclMode = "set" | "mirror" | "strip";

class Solver {
  readonly cells: Cells;
  readonly table: TypeTable;
  readonly #graph: ConstraintGraph;
  readonly #relations: OperationRelations;
  readonly #functions: ReadonlyMap<number, FunctionSignature>;
  readonly #returns: ReadonlySet<number>;
  readonly #context: LiftContext & { nonWorking: ReadonlySet<string> | null };
  /** The targets a store reaches: a projection into one is a store path, whose value flows back into the part. */
  readonly #stored: ReadonlySet<PlaceId>;
  readonly #views = new Map<CellId, CellView>();

  constructor(graph: ConstraintGraph, options: SolveOptions) {
    this.#graph = graph;
    this.#relations = options.relations;
    this.table = options.table ?? new TypeTable();
    this.#stored = new Set(graph.constraints.flatMap((c) => (c.kind === "store" ? [c.into] : [])));
    // every object carries a slot for every property name a store in the program gives any object
    const propertyNames = [
      ...new Set(
        graph.constraints.flatMap((c) =>
          c.kind === "project" && typeof c.step === "object" && this.#stored.has(c.into)
            ? [c.step.property]
            : [],
        ),
      ),
    ].sort();
    this.cells = new Cells(this.table, graph.places.length, propertyNames);
    this.#functions = new Map(graph.functions.map((fn) => [fn.id, fn]));
    this.#returns = new Set(graph.constraints.filter((c) => c.kind === "return").map((c) => c.fn));
    this.#context = { cells: this.cells, nonWorking: null, asks: 0 };
    for (const place of graph.places) {
      const site = place.site?.start ?? 0;
      if (place.kind.kind === "binding" && place.kind.declared === "host")
        this.cells.add(place.id, { tag: "d", why: "host", pos: positionAt(0) });
      const written =
        place.kind.kind === "binding" ||
        place.kind.kind === "parameter" ||
        place.kind.kind === "result"
          ? place.kind.written
          : null;
      if (written !== null)
        for (const item of this.termItems(
          written,
          "b",
          `written:${place.id}`,
          place.id,
          positionAt(site),
        ))
          this.cells.add(place.id, item);
    }
    // a literal's part cell that no store reaches is empty by construction
    for (const place of graph.places)
      if (place.kind.kind === "cell" && !this.#stored.has(place.id))
        this.cells.add(place.id, { tag: "e", pos: positionAt(place.site?.start ?? 0) });
    this.cells.drain(); // the seeds are the initial state, not a change of the first node evaluated
  }

  /** The literal a part place belongs to: a store into a literal's own cell or property changes the literal. */
  #ownerOf(place: PlaceId): readonly PlaceId[] {
    const kind = this.#graph.places[place]?.kind;
    return kind !== undefined && (kind.kind === "cell" || kind.kind === "property")
      ? [kind.owner]
      : [];
  }

  get asks(): number {
    return this.#context.asks;
  }

  /** The cells a constraint names: its reads and its writes, undirected (see the module comment). */
  cellsOf(c: Constraint): readonly CellId[] {
    switch (c.kind) {
      case "has":
        return [c.place];
      case "store":
        return [c.value, c.into, ...this.#ownerOf(c.into)];
      case "assign":
        return [c.value, c.binding];
      case "read":
        return [c.binding, c.occurrence];
      case "project":
        return [c.owner, c.into, ...this.#storesInto(c.into).map((s) => s.value)];
      case "operation":
        return [
          ...(c.receiver === null ? [] : [c.receiver]),
          ...c.arguments,
          ...c.named.map((n) => n.value),
          c.result,
        ];
      case "get":
        return [c.receiver, ...(c.key === null ? [] : [c.key]), c.fallback, c.result];
      case "fallback":
        return [c.left, c.right, c.result];
      case "call": {
        const fn = this.#functions.get(c.fn)!;
        return [...c.arguments, ...fn.parameters, fn.result, c.result];
      }
      case "return":
        return [...(c.value === null ? [] : [c.value]), this.#functions.get(c.fn)!.result];
      case "exit":
        return [this.#functions.get(c.fn)!.result];
      case "load":
        return [...(c.fallback === null ? [] : [c.fallback]), c.result];
      case "speakerRead":
        return [c.occurrence];
      default:
        return [];
    }
  }

  reads(c: Constraint): readonly CellId[] {
    return c.kind === "has" || c.kind === "exit" || c.kind === "speakerRead" ? [] : this.cellsOf(c);
  }

  /** The items a term contributes: a written union's members as bound members, a literal's part as its own cell. */
  termItems(
    term: TypeTerm,
    tag: Tag,
    group: string,
    owner: CellId,
    pos: Position,
  ): readonly Contribution[] {
    switch (term.kind) {
      case "atom":
      case "restricted":
        return [{ tag, type: this.table.internTerm(term), group, pos }];
      case "never":
        return [];
      case "dynamic":
        return [{ tag: "d", why: term.why, pos }];
      case "list":
      case "set":
      case "dict": {
        const element =
          term.element.kind === "ref" ? term.element.place : this.cells.derived(owner, "element");
        if (term.element.kind !== "ref")
          for (const item of this.termItems(term.element, tag, group, element, pos))
            this.cells.add(element, item);
        return [{ tag, ctor: term.kind, parts: { element }, group, pos }];
      }
      case "object": {
        if (term.properties === null)
          return [
            {
              tag,
              ctor: "object",
              parts: { props: this.cells.objectParts(new Map(), owner, pos), open: true },
              group,
              pos,
            },
          ];
        const props = new Map<string, CellId>();
        for (const property of term.properties) {
          const part =
            property.type.kind === "ref"
              ? property.type.place
              : this.cells.derived(owner, property.name);
          if (property.type.kind !== "ref")
            for (const item of this.termItems(property.type, tag, group, part, pos))
              this.cells.add(part, item);
          props.set(property.name, part);
        }
        return [
          {
            tag,
            ctor: "object",
            parts: { props: this.cells.objectParts(props, owner, pos), open: false },
            group,
            pos,
          },
        ];
      }
      case "union":
        return term.members.flatMap((member) =>
          this.termItems(member, tag === "b" ? "b" : "m", group, owner, pos),
        );
      case "ref":
        return this.cells.items(term.place).map((item) => ({ ...item, from: [...item.from] }));
    }
  }

  /**
   * Copies the items of one cell into another: tags kept (a bound's member is read as a member), the declaration mark
   * per mode (`set`: this copy is the declaration; `mirror`: the source's mark; `strip`: none), the position stamped
   * at a copy boundary (the site here, the source's first site) or mirrored, and with `retag` every known item a
   * member of the permitted union it names. The empty mark is never copied.
   */
  copy(
    from: CellId,
    to: CellId,
    decl: DeclMode,
    stamp: number | null = null,
    retag: string | null = null,
    keep: (item: Item) => boolean = () => true,
  ): boolean {
    let changed = false;
    for (const item of this.cells.items(from)) {
      if (item.tag === "e" || !keep(item)) continue;
      const known = item.tag === "w" || item.tag === "m" || item.tag === "b";
      const tag: Tag = known ? (retag !== null || item.tag === "b" ? "m" : item.tag) : item.tag;
      const contribution: Contribution = {
        tag,
        type: item.type,
        ctor: item.ctor,
        parts: item.parts,
        group: known ? (retag ?? item.group) : undefined,
        why: item.why,
        decl: decl === "set" ? true : decl === "mirror" ? item.decl : false,
        pos: stamp === null ? item.pos : [stamp, item.pos[0]],
        from: [from],
      };
      if (this.cells.add(to, contribution)) changed = true;
    }
    return changed;
  }

  #storesInto(target: PlaceId): Extract<Constraint, { kind: "store" }>[] {
    return this.#graph.constraints.flatMap((s) =>
      s.kind === "store" && s.into === target ? [s] : [],
    );
  }

  /** A store's value into a cell: the parts' items for a store of elements (`addAll`), else the value's items. */
  #storeInto(s: Extract<Constraint, { kind: "store" }>, into: CellId, decl: boolean): boolean {
    const site = s.site.start;
    if (s.how === "elements") {
      let changed = false;
      for (const item of this.cells.items(s.value)) {
        if (item.tag === "d" || item.tag === "p") {
          if (this.cells.add(into, { tag: "d", why: item.why, pos: positionAt(site) }))
            changed = true;
        } else if (
          item.parts?.element !== undefined &&
          this.copy(item.parts.element, into, decl ? "set" : "strip", site)
        )
          changed = true;
      }
      return changed;
    }
    return this.copy(s.value, into, decl ? "set" : "strip", site);
  }

  /** The part of a structural item a step reaches: a cell, a dict's key type for its iteration, or nothing. */
  part(
    item: Item,
    step: ProjectionStep,
  ): { readonly cell: CellId } | { readonly text: true } | undefined {
    if (item.parts === undefined) return undefined;
    if (item.parts.props !== undefined) {
      if (typeof step !== "object") return undefined;
      const cell = item.parts.props.get(step.property);
      return cell === undefined ? undefined : { cell };
    }
    if (typeof step === "object") return undefined;
    if (item.ctor === "dict" && step === "iteration") return { text: true };
    return { cell: item.parts.element };
  }

  evaluate(c: Constraint): boolean {
    const site = c.site.start;
    const pos = positionAt(site);
    switch (c.kind) {
      case "has": {
        // a literal, a fixed built-in result, a union a built-in defines (its members with this site as identity)
        let changed = false;
        for (const item of this.termItems(c.type, "w", `has@${site}`, c.place, pos))
          if (this.cells.add(c.place, item)) changed = true;
        return changed;
      }
      case "store":
      case "assign": {
        // The declaration's evidence (Q3.1r): a let/global initializer, a parameter default, a loop variable's
        // iterable, a start value, and the members of a literal stored into the literal's own cells. The mark is the
        // store's own: a value copied from a declared variable does not carry that variable's mark (R7-B10).
        const into = c.kind === "store" ? c.into : c.binding;
        const intoKind = this.#graph.places[into]?.kind.kind;
        const decl =
          c.kind === "store" &&
          (DECL_STORES.includes(c.how) || intoKind === "cell" || intoKind === "property");
        if (c.kind === "store") return this.#storeInto(c, into, decl);
        return this.copy(c.value, into, "strip", site);
      }
      case "read":
        return this.copy(c.binding, c.occurrence, "mirror");
      case "project": {
        let changed = false;
        // on a store path the stored values reach the part in place: the stores' own values, never what the target
        // read from a sibling alternative's part
        const stores = this.#storesInto(c.into);
        for (const item of this.cells.items(c.owner)) {
          if (item.tag === "d") {
            if (this.cells.add(c.into, { tag: "d", why: item.why, pos: item.pos })) changed = true;
            continue;
          }
          if (item.tag === "p" || item.tag === "e" || item.ctor === undefined) continue;
          const part = this.part(item, c.step);
          if (part === undefined) continue;
          if ("text" in part) {
            if (
              this.cells.add(c.into, {
                tag: item.tag === "b" ? "m" : item.tag,
                type: this.table.intern({ kind: "scalar", name: "string" }),
                group: item.group,
                pos: item.pos,
                decl: item.decl,
                from: [c.owner],
              })
            )
              changed = true;
            continue;
          }
          if (part.cell === c.into) continue;
          if (this.copy(part.cell, c.into, "mirror")) changed = true;
          for (const s of stores) if (this.#storeInto(s, part.cell, false)) changed = true;
        }
        if (typeof c.step === "object") {
          const read = this.memberRead(c.owner, c.step.property, c.into, site);
          if (lift(this.#context, read, memberRelation(c.step.property)).changed) changed = true;
        }
        return changed;
      }
      case "get": {
        // strict in its receiver and key; the element and the fallback are the members of the union it defines
        if (!this.cells.has(c.receiver) || (c.key !== null && !this.cells.has(c.key))) return false;
        const union = `get@${site}`;
        let changed = false;
        for (const item of this.cells.items(c.receiver)) {
          if (item.tag === "d" || item.tag === "p") {
            if (this.cells.add(c.result, { tag: "d", why: item.why, pos })) changed = true;
            continue;
          }
          if (
            item.parts?.element !== undefined &&
            this.copy(item.parts.element, c.result, "strip", site, union)
          )
            changed = true;
        }
        if (this.copy(c.fallback, c.result, "strip", site, union)) changed = true;
        return changed;
      }
      case "fallback": {
        if (!this.cells.has(c.left)) return false;
        const union = `fallback@${site}`;
        let changed = this.copy(
          c.left,
          c.result,
          "strip",
          site,
          union,
          (item) =>
            item.tag !== "n" &&
            !(item.type !== undefined && this.table.node(item.type).kind === "null"),
        );
        if (this.copy(c.right, c.result, "strip", site, union)) changed = true;
        return changed;
      }
      case "call": {
        const fn = this.#functions.get(c.fn)!;
        let changed = false;
        c.arguments.forEach((argument, index) => {
          const parameter = fn.parameters[index];
          if (parameter !== undefined && this.copy(argument, parameter, "strip", site))
            changed = true;
        });
        if (this.copy(fn.result, c.result, "mirror")) changed = true; // the call's value mirrors the result
        return changed;
      }
      case "return": {
        const result = this.#functions.get(c.fn)!.result;
        return c.value === null
          ? this.cells.add(result, {
              tag: "n",
              type: this.table.internTerm({ kind: "atom", name: "null" }),
              pos,
            })
          : this.copy(c.value, result, "strip", site);
      }
      case "exit":
        return this.#returns.has(c.fn)
          ? false
          : this.cells.add(this.#functions.get(c.fn)!.result, {
              tag: "n",
              type: this.table.internTerm({ kind: "atom", name: "null" }),
              pos,
            });
      case "load": {
        let changed = this.cells.add(c.result, { tag: "d", why: "storage", pos });
        if (c.fallback !== null && this.copy(c.fallback, c.result, "strip", site)) changed = true;
        return changed;
      }
      case "speakerRead":
        return this.cells.add(c.occurrence, { tag: "d", why: "unknown member", pos });
      case "operation":
        return lift(this.#context, this.operation(c), this.#relations.relation(c.contract)).changed;
      default:
        return false;
    }
  }

  operation(c: Extract<Constraint, { kind: "operation" }>): Operation {
    return {
      contract: c.contract,
      receiver: c.receiver,
      arguments: c.arguments,
      named: c.named,
      result: c.result,
      site: c.site.start,
      evidence: c.evidence,
    };
  }

  memberRead(owner: PlaceId, name: string, into: PlaceId, site: number): Operation {
    return {
      contract: { family: "member", name },
      receiver: owner,
      arguments: [],
      named: [],
      result: into,
      site,
      evidence: undefined,
    };
  }

  /** The operations that cannot succeed or have an invalid counted combination, once over the final cells. */
  statuses(): readonly string[] {
    this.#context.nonWorking = nonWorking(this.cells);
    const out: string[] = [];
    for (const c of this.#graph.constraints) {
      let operation: Operation;
      if (c.kind === "operation") operation = this.operation(c);
      else if (c.kind === "project" && typeof c.step === "object")
        operation = this.memberRead(c.owner, c.step.property, c.into, c.site.start);
      else continue;
      const relation =
        operation.contract.family === "member"
          ? memberRelation(operation.contract.name)
          : this.#relations.relation(operation.contract);
      const { changed, tally } = lift(this.#context, operation, relation);
      if (changed || this.cells.dirty)
        throw new Error(
          `not a fixpoint at interpretation: ${operation.contract.family}.${operation.contract.name}@${operation.site}`,
        );
      if (tally === null || tally.asked === 0) continue;
      const label = `${operation.contract.family}.${operation.contract.name}@${operation.site}`;
      if (tally.invalid === tally.asked) out.push(`${label}:none`);
      else if (tally.invalid > 0) out.push(`${label}:partial(${tally.invalid}/${tally.asked})`);
    }
    return out.sort();
  }

  view(cell: CellId): CellView {
    let view = this.#views.get(cell);
    if (view === undefined) {
      view = interpret(this.cells, cell);
      this.#views.set(cell, view);
    }
    return view;
  }
}

export function solve(graph: ConstraintGraph, options: SolveOptions): Solution {
  const solver = new Solver(graph, options);
  const constraints = graph.constraints;
  const report = run({
    nodes: constraints.length,
    reads: (node) => solver.reads(constraints[node]!),
    writes: (node) => solver.cellsOf(constraints[node]!),
    evaluate: (node) => {
      solver.evaluate(constraints[node]!);
      const changed = solver.cells.drain();
      options.trace?.(node, constraints[node]!, changed);
      return changed;
    },
  });
  if (options.verify === true)
    for (const c of constraints) {
      solver.evaluate(c);
      const changed = solver.cells.drain();
      if (changed.length > 0)
        throw new Error(`not a fixpoint after solving: ${c.kind}@${c.site.start}`);
    }
  const statuses = solver.statuses();
  return {
    graph,
    table: solver.table,
    cells: solver.cells,
    report,
    asks: solver.asks,
    statuses,
    view: (cell) => solver.view(cell),
  };
}
