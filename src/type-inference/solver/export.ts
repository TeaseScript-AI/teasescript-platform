import { PropertyTable, union, type StaticType } from "../../static-types.js";
import { typeKey } from "../../storage-types.js";
import type { FactSite, SolvedTypeFacts, TypeText } from "../backend.js";
import type { Place, PlaceId, SourceSite, TypeTerm } from "../graph.js";
import type { CellId } from "./cells.js";
import type { CellView, Member } from "./interpret.js";
import type { Solution } from "./solve.js";
import type { TypeId } from "./types.js";

// The export of a solution as the legacy's facts (O4 stage 3a, work note §6): every cell becomes a `StaticType` built
// through the table's `toStatic`, with shared structure, and a text as the legacy's `typeKey(type, true, true)` writes
// it; rendering to text happens here and nowhere in solving (work note §2). A known or conflicting view is the legacy's
// `union` of its working members, with null when optional; a bound view is the bound's members. A collection member is
// the collection over its element cell's export, an object member the object over its property cells' exports, so the
// export of a part cell is one object wherever the cell is held.
//
// The settled forms of work note §3.7 are cell facts, not types, so their texts are written here as the legacy writes
// its open slots (`typeKey` writes `?`, `?null` and `!` only for an `open` slot, which the export does not build): a
// null-only cell is `(?|null)` with the type `null` (the legacy's second form `?null` is the same form here), except
// as the fact of an expression's value or a function's result, which are not places that stores decide and which the
// legacy writes `null`; a cell of values the compiler cannot know only is `unknown`, a held cell is its text followed
// by `!` whatever its kind, a cell that holds nothing is `never`. A structural cycle (`a.add(a)`: the element cell
// holds a list over itself) is cut where the walk meets a cell it is still exporting, which exports as the legacy's
// undecided slot `?` with the type `unknown`, so `a.add(a)` exports `list<list<?>>` as the legacy does. The walk
// starts from the places in id order and follows the members in their order, so the cut, and with it every export, is
// the same whichever cell is asked for first.

/** What a cell exports: its type, whose parts are the exports of the cells that hold them, and its text. */
export interface ExportedType {
  readonly type: StaticType;
  readonly text: TypeText;
}

/** The export of every cell of a solution (see the module comment). */
export function exportTypes(solution: Solution): (cell: CellId) => ExportedType {
  const exporter = new Exporter(solution);
  return (cell) => exporter.place(cell);
}

/** The solution's facts in the legacy's shape (`legacy-facts.ts`), sorted as the legacy sorts them. */
export function exportFacts(solution: Solution): SolvedTypeFacts {
  const graph = solution.graph;
  const exporter = new Exporter(solution);
  const text = (place: PlaceId): TypeText => exporter.place(place).text;
  const bindings: SolvedTypeFacts["bindings"][number][] = [];
  const values: SolvedTypeFacts["values"][number][] = [];
  const properties = new Map<string, { readonly name: string; readonly type: TypeText }[]>();
  const keys = new Map<string, PlaceId>();
  const views: Place[] = [];
  for (const place of graph.places) {
    const kind = place.kind;
    if (kind.kind === "speakerProperty") {
      const list = properties.get(kind.speaker) ?? [];
      list.push({ name: kind.name, type: text(place.id) });
      properties.set(kind.speaker, list);
    } else if (kind.kind === "storageKey") keys.set(kind.key, place.id);
    else if (kind.kind === "loadView") views.push(place);
    // A place without a site (a media block's own handle) is not a fact.
    if (place.site === null) continue;
    const declaration = declarationOf(place, place.site);
    if (declaration !== null)
      bindings.push({ site: factSite(place.site), ...declaration, type: text(place.id) });
    if (kind.kind === "value")
      values.push({ site: factSite(place.site), kind: kind.node, type: text(place.id) });
  }
  const reads: SolvedTypeFacts["reads"][number][] = [];
  const loads = new Map<string, SolvedTypeFacts["storage"][number]["loads"][number][]>();
  const declaredViews = new Set<PlaceId>();
  const declaredKeys = new Set<string>();
  for (const c of graph.constraints) {
    if (c.kind === "read") {
      const binding = graph.places[c.binding]!;
      const kind = binding.kind;
      if (kind.kind !== "binding" && kind.kind !== "parameter")
        throw new Error(`A read reads a binding or a parameter, not ${binding.label}.`);
      reads.push({
        site: factSite(graph.places[c.occurrence]!.site ?? c.site),
        name: kind.name,
        binding: binding.site === null ? null : factSite(binding.site),
      });
    } else if (c.kind === "load" && c.receiver !== null) {
      declaredViews.add(c.view);
      if (c.key !== null) declaredKeys.add(c.key);
    }
  }
  // The storage as far as its places carry a view (stage 3c gives the keys and the views theirs).
  for (const view of views) {
    const key = view.kind.kind === "loadView" ? view.kind.key : null;
    if (key === null || view.site === null || solution.view(view.id).kind === "never") continue;
    const list = loads.get(key) ?? [];
    list.push({
      site: factSite(view.site),
      type: text(view.id),
      declared: declaredViews.has(view.id),
    });
    loads.set(key, list);
  }
  return {
    bindings: bindings.sort((left, right) => compareSites(left.site, right.site)),
    reads: reads.sort((left, right) => compareSites(left.site, right.site)),
    values: values.sort(
      (left, right) => compareSites(left.site, right.site) || compareText(left.kind, right.kind),
    ),
    functions: graph.functions
      .map((fn) => {
        const parameters = fn.parameters.map(text);
        // The body's view of a parameter is the parameter's cell (work note §5 summarizes bodies in 3c).
        return {
          site: factSite(fn.site),
          name: fn.name,
          parameters,
          accepted: parameters,
          result: text(fn.result),
        };
      })
      .sort((left, right) => compareSites(left.site, right.site)),
    speakers: [...properties]
      .map(([name, list]) => ({
        name,
        properties: list.sort((left, right) => compareText(left.name, right.name)),
      }))
      .sort((left, right) => compareText(left.name, right.name)),
    // Stage 3c decides which names no speaker keeps a type for.
    uncheckedProperties: [],
    storage: [...keys]
      .filter(([, place]) => solution.view(place).kind !== "never")
      .map(([key, place]) => ({
        key,
        type: text(place),
        declared: declaredKeys.has(key),
        loads: (loads.get(key) ?? []).sort((left, right) => compareSites(left.site, right.site)),
      }))
      .sort((left, right) => compareText(left.key, right.key)),
  };
}

/**
 * The name a place declares and the node kind the legacy's facts give its declaration (`legacy-facts.ts`), or `null`
 * for a place that is not a declaration of the source. A loop's first variable is declared by the `for` statement, a
 * pair loop's value variable by its own name, whose site is the name alone.
 */
function declarationOf(
  place: Place,
  site: SourceSite,
): { readonly kind: string; readonly name: string } | null {
  const kind = place.kind;
  if (kind.kind === "parameter") return { kind: "functionParameter", name: kind.name };
  if (kind.kind !== "binding") return null;
  switch (kind.declared) {
    case "let":
      return { kind: "letStatement", name: kind.name };
    case "global":
      return { kind: "globalStatement", name: kind.name };
    case "parameter":
      return { kind: "functionParameter", name: kind.name };
    case "loop":
      return {
        kind: site.end - site.start === kind.name.length ? "identifier" : "forStatement",
        name: kind.name,
      };
    case "host":
      return null;
  }
}

/** A cell whose export the walk is making, with the part cells it has not taken yet. */
interface Frame {
  readonly cell: CellId;
  readonly view: CellView;
  readonly parts: CellId[];
}

/** The export of the cells of one solution, each made once (see the module comment). */
class Exporter {
  readonly #solution: Solution;
  readonly #exports = new Map<CellId, ExportedType>();
  /** The cells whose export the walk is making, on the path from its root. */
  readonly #active = new Set<CellId>();
  readonly #types = new Map<TypeId, ExportedType>();
  readonly #collections = new Map<string, WeakMap<ExportedType, ExportedType>>();
  readonly #objects = new WeakMap<ReadonlyMap<string, CellId>, ExportedType>();
  readonly #never: ExportedType;
  readonly #unknown: ExportedType;
  readonly #null: ExportedType;
  readonly #nullOnly: ExportedType;
  /** A cell met again while its export is being made: the legacy's undecided slot. */
  readonly #cut: ExportedType;

  constructor(solution: Solution) {
    this.#solution = solution;
    const table = solution.table;
    const leaf = (term: TypeTerm): ExportedType =>
      this.#leaf(table.toStatic(table.internTerm(term)));
    this.#never = leaf({ kind: "never" });
    // Any reason is the table's `unknown`: the provenance is the cell's, not the type's.
    this.#unknown = leaf({ kind: "dynamic", why: "host" });
    this.#null = leaf({ kind: "atom", name: "null" });
    this.#nullOnly = { type: this.#null.type, text: "(?|null)" };
    this.#cut = { type: this.#unknown.type, text: "?" };
    for (const place of solution.graph.places) this.of(place.id);
  }

  /** The export of a cell, as the fact of its place for a place (see the module comment). */
  place(cell: CellId): ExportedType {
    const exported = this.of(cell);
    const kind = this.#solution.graph.places[cell]?.kind.kind;
    return exported === this.#nullOnly && (kind === "value" || kind === "result")
      ? this.#null
      : exported;
  }

  of(cell: CellId): ExportedType {
    let exported = this.#exports.get(cell);
    if (exported === undefined) {
      this.#walk(cell);
      // EVIDENCE: invariant: `#walk` exports its root.
      exported = this.#exports.get(cell)!;
    }
    return exported;
  }

  /** Exports a cell and every part cell under it not exported yet, depth first, parts before their holders. */
  #walk(root: CellId): void {
    const stack: Frame[] = [];
    const enter = (cell: CellId): void => {
      const view = this.#solution.view(cell);
      this.#active.add(cell);
      // Reversed, so the parts are taken from the end in member order.
      stack.push({ cell, view, parts: view.members.flatMap(partsOf).reverse() });
    };
    enter(root);
    while (stack.length > 0) {
      // EVIDENCE: invariant: the loop runs while the stack is not empty.
      const top = stack.at(-1)!;
      const part = top.parts.pop();
      if (part !== undefined) {
        if (!this.#exports.has(part) && !this.#active.has(part)) enter(part);
        continue;
      }
      stack.pop();
      this.#active.delete(top.cell);
      this.#exports.set(top.cell, this.#cell(top.view));
    }
  }

  /** The export of a cell whose parts are exported, or are on the walk's path and cut there. */
  #cell(view: CellView): ExportedType {
    switch (view.kind) {
      case "never":
        return this.#never;
      case "unknown":
        return this.#unknown;
      case "nullOnly":
        return this.#nullOnly;
      default: {
        const members = view.members.map((member) => this.#member(member));
        if (view.optional && view.kind !== "bound") members.push(this.#null);
        const type = union(members.map((member) => member.type));
        if (members.length === 1 && !view.held) return members[0]!;
        // `union` keeps the members it is given or merges scalars, which `typeKey` writes; two members of one type
        // whose texts differ (a held mark inside one of them) both keep their text.
        const texts = new Map<StaticType, Set<TypeText>>();
        for (const member of members) {
          const known = texts.get(member.type);
          if (known === undefined) texts.set(member.type, new Set([member.text]));
          else known.add(member.text);
        }
        const text = (member: StaticType): readonly TypeText[] => [
          ...(texts.get(member) ?? [typeKey(member, true, true)]),
        ];
        const all = [
          ...new Set((type.kind === "union" ? type.members : [type]).flatMap(text)),
        ].sort();
        const written = all.length === 1 ? all[0]! : `(${all.join("|")})`;
        return { type, text: view.held ? `${written}!` : written };
      }
    }
  }

  #member(member: Member): ExportedType {
    switch (member.kind) {
      case "type": {
        let exported = this.#types.get(member.type);
        if (exported === undefined) {
          exported = this.#leaf(this.#solution.table.toStatic(member.type));
          this.#types.set(member.type, exported);
        }
        return exported;
      }
      case "collection": {
        const element = this.#part(member.element);
        let byElement = this.#collections.get(member.ctor);
        if (byElement === undefined) {
          byElement = new WeakMap();
          this.#collections.set(member.ctor, byElement);
        }
        let exported = byElement.get(element);
        if (exported === undefined) {
          exported = {
            type: Object.freeze({ kind: member.ctor, element: element.type }),
            text: `${member.ctor}<${element.text}>`,
          };
          byElement.set(element, exported);
        }
        return exported;
      }
      case "object": {
        // the written bare `object`: a known kind whose properties are unknown
        if (member.open) return this.#leaf({ kind: "object", properties: null });
        const known = this.#objects.get(member.props);
        if (known !== undefined) return known;
        // a slot no store reached (empty by construction) is not a property of this object
        const entries = [...member.props]
          .filter(([, cell]) => !this.#solution.cells.items(cell).every((item) => item.tag === "e"))
          .map(([name, cell]): readonly [string, ExportedType] => [name, this.#part(cell)])
          .sort(([left], [right]) => compareText(left, right));
        const exported: ExportedType = {
          type: Object.freeze({
            kind: "object",
            properties: Object.freeze(
              new PropertyTable(entries.map(([name, part]) => [name, part.type])),
            ),
          }),
          text: `{${entries
            .map(([name, part]) => `${JSON.stringify(name)}:${part.text}`)
            .sort()
            .join(",")}}`,
        };
        // An object with a cut property is the export of the one cell being made, not of its properties.
        if (entries.every(([, part]) => part !== this.#cut))
          this.#objects.set(member.props, exported);
        return exported;
      }
    }
  }

  /** The export of a part cell: made already, or on the walk's path and cut. */
  #part(cell: CellId): ExportedType {
    return this.#exports.get(cell) ?? this.#cut;
  }

  #leaf(type: StaticType): ExportedType {
    return { type, text: typeKey(type, true, true) };
  }
}

function partsOf(member: Member): readonly CellId[] {
  switch (member.kind) {
    case "type":
      return [];
    case "collection":
      return [member.element];
    case "object":
      return [...member.props.values()];
  }
}

function factSite(site: SourceSite): FactSite {
  return { file: site.file, start: site.start, end: site.end };
}

function compareSites(left: FactSite, right: FactSite): number {
  return left.file - right.file || left.start - right.start || left.end - right.end;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
