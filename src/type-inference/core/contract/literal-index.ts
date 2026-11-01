import type { PlaceId, TypeTerm } from "../../graph.js";
import type { Contract } from "../contract.js";
import { sortCost, type Definition } from "../definitions.js";
import { withoutEmpty, withWriter } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import { firstWriter, mergeItems, type Item, type ItemTag, type Writer } from "../items.js";
import { memberStep } from "../method-categories.js";
import { propertyStep } from "../program.js";
import { sharing } from "../sharing.js";
import type { Work } from "../solver.js";
import { ingressLeafOf } from "./ingress.js";
import type { Rest } from "./key-ids.js";
import { emptyAt, propertyOnly, REFERENCE } from "./kinds.js";
import type {
  IdentityWork,
  IndexNode,
  LevelGroup,
  LiteralIndex,
  NodeBelow,
  OtherGroup,
  PrefixEntry,
  PropertyIndex,
  PropertyLack,
  PropertySource,
  ReadEntry,
  Selected,
  ValueEntry,
  WalkRank,
} from "./model.js";
import { typeTags } from "./terms.js";

// The literal index (§8): one index of a literal's structure per literal value or cell, its paths and signature.

/** An object of a literal at a path (`IndexNode.objects`). */
export interface IndexObject {
  readonly names: Set<string>;
  readonly token: Writer;
  readonly term: Extract<TypeTerm, { readonly kind: "object" }>;
  /** V30 §19: the property its button value reads, its `value`, else its `text`, or `null`. */
  readonly selected: Selected;
}

/** Whether a node of a literal's index holds a read a mark rests on (`collectMarks`). */
function marksOwn(node: IndexNode): boolean {
  return node.reads.some((entry) => entry.guarded || entry.holder !== null);
}

/** A node of a literal's index holding nothing yet. */
function indexNode(): IndexNode {
  return {
    terms: new Map(),
    reads: [],
    exact: [],
    others: [],
    objects: null,
    reference: false,
    empty: false,
    children: new Map(),
    seen: new Set(),
    readIds: new Map(),
    firstRead: null,
    firstOther: null,
    via: new Map(),
  };
}

/** Two places in a literal's one walk by their places at each depth (`Contract.standsAlong`): the earlier first. */
function walkOrder(a: readonly number[], b: readonly number[]): number {
  for (let at = 0; at < a.length && at < b.length; at += 1)
    if (a[at] !== b[at]) return a[at]! - b[at]!;
  return a.length - b.length;
}

/** Whether a node of a literal's index holds anything of its own. */
function ownsAny(node: IndexNode): boolean {
  return (
    node.terms.size > 0 ||
    node.reads.length > 0 ||
    node.exact.length > 0 ||
    node.others.length > 0 ||
    node.objects !== null ||
    node.reference ||
    node.empty
  );
}

/** The id of the path one `step` below the path `parent` (`pathAt`): a position's path (`positions.ts`). */
export function pathStep(contract: Contract, parent: number, step: string): number {
  return pathAt(contract, parent, step);
}

/** A path id's last step (the empty path's: none). */
export function pathLast(contract: Contract, id: number): string {
  return contract.pathLastSteps[id]!;
}

/** A path id's depth: its steps' count. */
export function pathDepth(contract: Contract, id: number): number {
  return contract.pathDepths[id]!;
}

/** The id of a path's parent, one step up (the empty path's: -1). */
export function pathParent(contract: Contract, id: number): number {
  return contract.pathParents[id]!;
}

/** A path id's steps, made fresh and charged (`stepsOf`). */
export function pathSteps(contract: Contract, id: number): string[] {
  const steps = stepsOf(contract, id);
  contract.keep(steps.length);
  return steps;
}

/** The id of the path one `step` below the path `parent`, made (and charged, its step and slot) when first asked. */
export function pathAt(contract: Contract, parent: number, step: string): number {
  let steps = contract.pathChildren[parent];
  if (steps === undefined) contract.pathChildren[parent] = steps = new Map();
  const known = steps.get(step);
  if (known !== undefined) return known;
  contract.keepText(step.length);
  contract.keep(1);
  const id = contract.pathParents.length;
  contract.pathParents.push(parent);
  contract.pathDepths.push(contract.pathDepths[parent]! + 1);
  contract.pathLastSteps.push(step);
  // (G3 stage 1's metadata, each from its parent's and the step alone: `key-ids.ts`)
  contract.pathFirstSteps.push(parent === 0 ? step : contract.pathFirstSteps[parent]!);
  contract.pathMembers.push(memberStep([step], 0) === 0 ? id : contract.pathMembers[parent]!);
  contract.pathProperties.push(contract.pathProperties[parent]! && propertyOnly(step));
  steps.set(step, id);
  return id;
}

/** The id of a path one `step` below the path `parent` if one has been made, else -1 (no index holds it). */
export function pathBelow(contract: Contract, parent: number, step: string): number {
  return parent < 0 ? -1 : (contract.pathChildren[parent]?.get(step) ?? -1);
}

/** A path's steps, made fresh (the caller charges what it keeps). */
export function stepsOf(contract: Contract, id: number): string[] {
  const steps: string[] = [];
  for (let at = id; at > 0; at = contract.pathParents[at]!) steps.push(contract.pathLastSteps[at]!);
  return steps.reverse();
}

/**
 * The reads (`reads`) or computed values (`others`) of a literal's index standing at each prefix of `path` its index
 * holds, by depth, in the order a property query reads them (`propertyNames`): with more such paths in the literal
 * than the path's prefixes, by depth; else in the order the literal's one walk first stood an entry at each
 * (`WalkRank`), a path's tasks in turn and a task's steps below it before the next.
 */
export function standsAlong(
  contract: Contract,
  literal: PlaceId,
  path: readonly string[],
  kind: "reads" | "others",
): readonly { readonly depth: number; readonly entries: readonly ValueEntry[] }[] {
  const nodes: IndexNode[] = [contract.literalIndex(literal).root];
  for (const step of path) {
    contract.pass.program.work.charge("invSteps");
    const below = nodes.at(-1)!.children.get(step);
    if (below === undefined) break;
    nodes.push(below);
  }
  const stands = nodes.flatMap((node, depth) =>
    node[kind].length === 0 ? [] : [{ depth, entries: node[kind] }],
  );
  const all = heldBelow(contract, nodes[0]!);
  if ((kind === "reads" ? all.readStands : all.otherStands) > path.length + 1) return stands;
  // (each stand's first entry by its place at each depth down to it, `#walkOrder`)
  const ranks = stands.map(({ depth }) => {
    contract.pass.program.work.charge("invSteps", depth + 1);
    const first = kind === "reads" ? nodes[depth]!.firstRead! : nodes[depth]!.firstOther!;
    const at: number[] = [first.at];
    for (let level = depth - 1, top = first.top; level >= 0; level -= 1) {
      const from = nodes[level]!.via.get(path[level]!)![top]!;
      at.push(from.at);
      top = from.top;
    }
    return at.reverse();
  });
  const order = stands.map((_, index) => index);
  contract.pass.program.work.charge("invSteps", sortCost(order.length));
  order.sort((a, b) => walkOrder(ranks[a]!, ranks[b]!));
  return order.map((index) => stands[index]!);
}

/**
 * The one read a literal's index holds, where it holds no computed value and no reference kind, one read entry and one
 * exact one in all, no term, object or empty collection at or below the read's path, and on the way to it no object
 * without its next step (an alias's literal, `Admission.#aliasKey`); its path's steps made for it alone, else `null`.
 */
export function loneRead(
  contract: Contract,
  literal: PlaceId,
): { readonly steps: readonly string[]; readonly value: PlaceId } | null {
  const { program } = contract.pass;
  let node = contract.literalIndex(literal).root;
  const all = heldBelow(contract, node);
  if (all.others || all.reference || all.reads !== 1 || all.exact !== 1) return null;
  const steps: string[] = [];
  while (node.reads.length === 0) {
    program.work.charge("aliasSteps");
    let next: readonly [string, IndexNode] | undefined;
    for (const child of node.children) if (heldBelow(contract, child[1]).reads > 0) next = child;
    const objects = node.objects;
    if (
      next === undefined ||
      (objects !== null && (objects.count.get(next[0]) ?? 0) < objects.list.length)
    )
      return null;
    contract.keep(1);
    steps.push(next[0]);
    node = next[1];
  }
  return heldBelow(contract, node).beside ? null : { steps, value: node.reads[0]!.value };
}

/** The id of the path of `steps`, each made as asked (`pathAt`): a path a key or a question names by its steps. */
export function pathIdOf(contract: Contract, steps: readonly string[]): number {
  let id = 0;
  for (const step of steps) id = pathAt(contract, id, step);
  return id;
}

/** A literal's index node at a path, `null` where none stands: down from the nearest ancestor already found. */
export function nodeAt(contract: Contract, index: LiteralIndex, id: number): IndexNode | null {
  if (id < 0 || id >= contract.pathParents.length) return null;
  const known = index.byId.get(id);
  if (known !== undefined) return known;
  const way: number[] = [];
  for (let at = id; !index.byId.has(at); at = contract.pathParents[at]!) way.push(at);
  let node: IndexNode | null = index.byId.get(contract.pathParents[way.at(-1)!]!)!;
  for (let at = way.length - 1; at >= 0; at -= 1) {
    contract.pass.program.work.charge("invSteps");
    contract.keep(1);
    node = node?.children.get(contract.pathLastSteps[way[at]!]!) ?? null;
    index.byId.set(way[at]!, node);
  }
  return node;
}

/**
 * An index's nodes that hold something of their own (`wanted`: or a read a mark rests on), each with its path's id, in a
 * walk of the index from its root (each id made as the walk reaches it, `pathAt`); a subtree holding none of it is
 * not entered (`heldBelow`).
 */
export function indexPaths(
  contract: Contract,
  index: LiteralIndex,
  wanted: "holds" | "marks" = "holds",
): readonly (readonly [number, IndexNode])[] {
  const out: (readonly [number, IndexNode])[] = [];
  const pending: (readonly [number, IndexNode])[] = [[0, index.root]];
  while (pending.length > 0) {
    const [id, node] = pending.pop()!;
    contract.pass.program.work.charge("invSteps");
    if (wanted === "holds" ? ownsAny(node) : marksOwn(node)) {
      contract.keep(1);
      out.push([id, node]);
    }
    const below = [...node.children].filter(([, child]) => heldBelow(contract, child)[wanted]);
    for (let at = below.length - 1; at >= 0; at -= 1)
      pending.push([pathAt(contract, id, below[at]![0]), below[at]![1]]);
  }
  return out;
}

/**
 * What a node and the nodes below it hold, once per node (an explicit walk, deepest first): anything, a reference
 * kind, a computed value, a read a mark rests on.
 */
export function heldBelow(contract: Contract, node: IndexNode): NodeBelow {
  if (node.below !== undefined) return node.below;
  const pending: { readonly node: IndexNode; readonly children: IndexNode[]; at: number }[] = [
    { node, children: [...node.children.values()], at: 0 },
  ];
  while (pending.length > 0) {
    const top = pending.at(-1)!;
    if (top.at < top.children.length) {
      const child = top.children[top.at++]!;
      contract.pass.program.work.charge("invSteps");
      if (child.below === undefined)
        pending.push({ node: child, children: [...child.children.values()], at: 0 });
      continue;
    }
    pending.pop();
    contract.keep(1);
    const own = top.node;
    const sum = (count: (below: NodeBelow) => number): number =>
      top.children.reduce((total, child) => total + count(child.below!), 0);
    top.node.below = {
      holds: ownsAny(own) || top.children.some((child) => child.below!.holds),
      reference: own.reference || top.children.some((child) => child.below!.reference),
      others: own.others.length > 0 || top.children.some((child) => child.below!.others),
      marks: marksOwn(own) || top.children.some((child) => child.below!.marks),
      reads: own.reads.length + sum((below) => below.reads),
      exact: own.exact.length + sum((below) => below.exact),
      readStands: (own.reads.length > 0 ? 1 : 0) + sum((below) => below.readStands),
      otherStands: (own.others.length > 0 ? 1 : 0) + sum((below) => below.otherStands),
      beside:
        own.terms.size > 0 ||
        own.objects !== null ||
        own.empty ||
        top.children.some((child) => child.below!.beside),
    };
  }
  return node.below!;
}

/** The paths an index holds kinds, reads, other values or objects at, by id in id order, with their nodes. */
export function pathOrder(
  contract: Contract,
  index: LiteralIndex,
): readonly (readonly [number, IndexNode])[] {
  const paths = indexPaths(contract, index).filter(
    ([, node]) =>
      node.terms.size > 0 ||
      node.reads.length > 0 ||
      node.others.length > 0 ||
      node.objects !== null,
  );
  contract.keep(paths.length);
  return paths.sort(([a], [b]) => a - b);
}

/** An index's empty collections' paths, as their ids in order. */
export function emptyIds(contract: Contract, index: LiteralIndex): string {
  const ids = indexPaths(contract, index)
    .filter(([, node]) => node.empty)
    .map(([id]) => id);
  contract.keep(ids.length);
  return contract.kept(ids.sort((a, b) => a - b).join(","));
}

/** An object's property names as a signature's part, charged. */
export function namesPart(contract: Contract, names: ReadonlySet<string>): string {
  contract.keep(names.size);
  return contract.kept(`{${[...names].sort().join(",")}}`);
}

/** A path's own kinds as a signature's part, charged. */
export function kindsPart(
  contract: Contract,
  at: number,
  kinds: ReadonlyMap<ItemTag, Writer> | undefined,
): string {
  const tags = [...(kinds?.keys() ?? [])];
  contract.keep(tags.length);
  return contract.kept(`${at}:${tags.sort().join(",")}`);
}

/**
 * One index of a literal's structure per literal value or cell, built once in the literal's size, through its nested
 * literals at every step. Per path: the kinds its own terms give (once per kind), the values standing there that are
 * no literal (a read once per source identity, once per exact identity for the value side; a call once per callee
 * result; every other value), the objects there with their properties (F11's missing), the references and the empty
 * collections. A query reads only the entries at its path and its prefixes.
 */
export function literalIndex(contract: Contract, literal: PlaceId): LiteralIndex {
  if (!contract.literals.has(literal)) contract.settle(indexWork(contract, literal));
  return contract.literals.get(literal)!;
}

export function* indexWork(contract: Contract, literal: PlaceId): IdentityWork {
  if (contract.literals.has(literal)) return;
  contract.indexing.add(literal);
  const { program, definitions } = contract.pass;
  // (TABLE r4.58: each object, collection, array element and map entry it keeps charged one unit as it is made, each
  // kept text its `textUnits`; here the index's own ten)
  contract.keep(10);
  // (an entry in its node's list)
  const put = <T>(list: T[], entry: T): void => {
    contract.keep(list.length === 0 ? 3 : 2);
    list.push(entry);
  };
  // what stands at a node, in the order the walk of the literal reaches it: a value (with the cell that holds it), or
  // a term of a literal's type
  type Task = (
    | { readonly kind: "value"; readonly g: Definition | null; readonly value: PlaceId }
    | { readonly kind: "term"; readonly site: Writer; readonly term: TypeTerm }
  ) & { readonly top?: number };
  // (a cell's definitions copied, and a task scheduled for each)
  const cells = (place: PlaceId): Definition[] => {
    const defs = definitions.cellDefs.get(place) ?? [];
    contract.keep(2 * defs.length);
    return [...defs].reverse();
  };
  // a node to fill from its tasks; below it, per step, the tasks standing there and whether a collection's element
  // without a cell stands there
  const root = indexNode();
  const nodes: { readonly node: IndexNode; readonly tasks: Task[] }[] = [];
  if (program.hasOf.has(literal))
    nodes.push({ node: root, tasks: [{ kind: "value", g: null, value: literal }] });
  else {
    const tasks: Task[] = [];
    for (const d of cells(literal).reverse())
      // a literal's element that admission rejected is ignored (A6, ADR 0021 1.3)
      if (contract.pass.lists.live(d)) tasks.push({ kind: "value", g: d, value: d.value! });
    nodes.push({ node: root, tasks });
  }
  while (nodes.length > 0) {
    const { node, tasks } = nodes.pop()!;
    const below = new Map<string, { tasks: Task[]; empty: boolean; via: WalkRank[] }>();
    const step = (name: string): { tasks: Task[]; empty: boolean; via: WalkRank[] } => {
      let at = below.get(name);
      if (at === undefined) below.set(name, (at = { tasks: [], empty: false, via: [] }));
      return at;
    };
    // (each task with the node's first task it descends from, `top`, and its place in the node's walk, `WalkRank`)
    const pending: Task[] = tasks.map((task, top) => ({ ...task, top })).reverse();
    let position = 0;
    while (pending.length > 0) {
      const task = pending.pop()!;
      program.work.charge("invSteps");
      const rank: WalkRank = { top: task.top!, at: position++ };
      const own = (next: Task): Task => ({ ...next, top: rank.top });
      if (task.kind === "value") {
        const { g, value } = task;
        const literals = program.hasOf.get(value) ?? [];
        if (literals.length > 0) {
          contract.keep(2 * literals.length);
          for (const has of [...literals].reverse())
            pending.push(
              own({ kind: "term", site: program.writer("literal", has.site), term: has.type }),
            );
          continue;
        }
        // §8 r4.13, r4.15: a call is a read of its callee's result key (F20) and a read its source: k calls of one
        // function, k copies of one source, are one entry at the path, their guards and ingress its annotations
        const source = yield* contract.needValue(value);
        if (contract.copiedKey(value) === null) {
          if (source.key === null) {
            node.firstOther ??= rank;
            put(node.others, { g, value });
            continue;
          }
          const key = contract.kept(`o${source.id}`);
          if (node.seen.has(key)) continue;
          contract.keep(1);
          node.seen.add(key);
          contract.facts.literalEntries += 1;
          node.firstOther ??= rank;
          put(node.others, { g, value });
          continue;
        }
        // one snapshot: one key read here, where nothing between the reads changes what they read (r4.68 (1))
        const snapshot = contract.readSnapshot(value)!;
        // (k reads of one host global, or of one projection of it, are one entry as well, by their snapshot, their
        // leaves unioned: an occurrence stays fresh as its own leaf, never as an entry each path reads again,
        // S6-CARRIERS §3.1, Codex r23 F1, #1210)
        const leaf = ingressLeafOf(contract, value);
        const id = contract.kept(
          !sharing() ? `v${value}` : leaf === undefined ? source.id : snapshot,
        );
        // (the value side reads an exact entry by its first read alone, so an ingress occurrence keeps its own: its
        // items carry its own leaf, which one shared entry would drop; the read entry above unions them, TABLE r4.72)
        const exactId = contract.kept(
          !sharing() || leaf !== undefined ? `xv${value}` : `x${snapshot}`,
        );
        const read = node.readIds.get(id);
        if (read === undefined) {
          contract.facts.literalEntries += 1;
          contract.keep(2);
          const entry: ReadEntry = {
            g,
            value,
            guarded: source.guarded,
            holder: source.holder,
            ingress: leaf,
          };
          node.readIds.set(id, entry);
          node.firstRead ??= rank;
          put(node.reads, entry);
        } else {
          program.work.charge("invSteps");
          if (source.guarded) read.guarded = true;
          if (leaf !== undefined) read.ingress = program.scope.ingress.union(read.ingress, leaf);
        }
        if (!node.seen.has(exactId)) {
          contract.keep(1);
          node.seen.add(exactId);
          put(node.exact, { g, value });
        }
        continue;
      }
      // a term of a literal's type standing at the node
      const { site, term } = task;
      if (term.kind === "ref") {
        const live = cells(term.place).filter((d) => contract.pass.lists.live(d));
        for (const d of live) pending.push(own({ kind: "value", g: d, value: d.value! }));
        continue;
      }
      for (const tag of typeTags(term))
        if (!node.terms.has(tag)) {
          contract.keep(node.terms.size === 0 ? 3 : 1);
          node.terms.set(tag, site);
        }
      if (term.kind === "atom" && REFERENCE.has(term.name) && !node.reference) {
        contract.keep(1);
        node.reference = true;
      }
      if (term.kind === "object") {
        if (node.objects === null) {
          contract.keep(4);
          node.objects = { list: [], count: new Map() };
        }
        // its property names, and the property its button value reads, decided once per record (V30 §19)
        const names = new Set<string>();
        let value: Selected = null;
        let text: Selected = null;
        // (its names and their entry, its counts, its properties copied, a task per property)
        contract.keep(2 + 4 * (term.properties?.length ?? 0));
        for (const property of term.properties ?? []) {
          contract.facts.selectionVisits += 1;
          names.add(contract.kept(propertyStep(property.name)));
          if (property.name === "value") value ??= property;
          else if (property.name === "text") text ??= property;
        }
        node.objects.list.push({ names, token: site, term, selected: value ?? text });
        for (const name of names)
          node.objects.count.set(name, (node.objects.count.get(name) ?? 0) + 1);
        for (const property of term.properties ?? []) {
          const at = step(propertyStep(property.name));
          at.tasks.push({ kind: "term", site, term: property.type });
          at.via.push(rank);
        }
      } else if (term.kind === "list" || term.kind === "set" || term.kind === "dict") {
        const element = term.element;
        contract.keep(1);
        const at = step("element");
        if (element.kind === "ref" && (definitions.cellDefs.get(element.place) ?? []).length === 0)
          at.empty = true;
        at.tasks.push({ kind: "term", site, term: element });
        at.via.push(rank);
      }
    }
    // below the node: a nested literal that alone stands at a step is its own index's root there, shared (its
    // tasks are its value's own terms, which its index walks as this walk would); any other step a node of its own
    const fill: { readonly node: IndexNode; readonly tasks: Task[] }[] = [];
    for (const [name, at] of below) {
      contract.keep(2 + at.via.length);
      node.via.set(name, at.via);
      const alone = at.empty ? null : aloneLiteral(contract, at.tasks);
      if (alone !== null) {
        node.children.set(name, (yield* contract.needIndex(alone)).root);
        continue;
      }
      const child = indexNode();
      if (at.empty) child.empty = true;
      node.children.set(name, child);
      fill.push({ node: child, tasks: at.tasks });
    }
    for (let at = fill.length - 1; at >= 0; at -= 1) nodes.push(fill[at]!);
  }
  contract.indexing.delete(literal);
  contract.literals.set(literal, { root, byId: new Map([[0, root]]), lacking: new Map() });
}

/**
 * The literal value a step's tasks are alone, where they are a term of a cell place whose one live definition stores
 * a literal (its index then stands for the step whole), else `null`.
 */
function aloneLiteral(
  contract: Contract,
  tasks: readonly { readonly kind: string; readonly term?: TypeTerm }[],
): PlaceId | null {
  if (tasks.length !== 1) return null;
  const term = tasks[0]!.term;
  if (term?.kind !== "ref") return null;
  const live = (contract.pass.definitions.cellDefs.get(term.place) ?? []).filter((d) =>
    contract.pass.lists.live(d),
  );
  if (live.length !== 1 || !contract.pass.program.hasOf.has(live[0]!.value!)) return null;
  return contract.indexing.has(live[0]!.value!) ? null : live[0]!.value!;
}

/**
 * §8 r4.15: a literal's identity is its structure when no reference and no ingress stands in it (the kinds of its own
 * terms, the sources of its reads and calls, its objects' properties at every path), else the literal itself; the
 * marks of its reads are never identity (r4.17).
 */
export function literalSignature(contract: Contract, literal: PlaceId): string {
  if (!contract.signatures.has(literal)) {
    if (contract.indexing.has(literal)) return `v${literal}`;
    contract.settle(signatureWork(contract, literal));
  }
  return contract.signatures.get(literal)!;
}

export function* signatureWork(contract: Contract, literal: PlaceId): IdentityWork {
  if (contract.signatures.has(literal)) return;
  const index = yield* contract.needIndex(literal);
  const shape = yield* contract.nodeShape(index.root, "sig");
  // (interned: a literal names its inputs by their own short identities, never by their expansions, and the nodes
  // below it by their own shapes, which nested literals share)
  let signature = `v${literal}`;
  if (shape.plain) {
    signature = contract.literalIds.get(shape.name) ?? `l${contract.literalIds.size}`;
    contract.literalIds.set(shape.name, signature);
  }
  contract.signatures.set(literal, signature);
}

/**
 * #1203: below their root, a literal path's classes of computed-key loads (`OtherGroup.loads`) on either side, their
 * members' answers merged, made once per pass at their first read there and taken at every later one for a step. Each
 * load's value there is F19's host data whatever the path, the node and the default (on the value side its one demand
 * below the root, `Values.#operationItems`), naming its own ingress (C9), so the merge keeps every member's leaf, and
 * loads of different defaults answer together. The root, with a `null` default's `null`, is read member by member.
 */
export function* loadsBelow(
  contract: Contract,
  groups: readonly OtherGroup[],
  after: Rest,
  exact: boolean,
  node: FlowNode | null = null,
): Work<readonly Item[]> {
  const { program, values } = contract.pass;
  program.work.charge("invSteps");
  let merged = contract.loadsBelowOf.get(groups);
  if (merged === undefined) {
    const items: Item[] = [];
    for (const group of groups) {
      if (!group.loads) continue;
      for (const members of [group.read, group.rest])
        for (const entry of members) {
          const answer = exact
            ? yield* values.valueItems(entry.value, entry.g?.node ?? node, after)
            : withWriter(yield* contract.contractOfValueAt(entry.value, after), group.writer);
          for (const item of answer) items.push(item);
        }
    }
    merged = withoutEmpty(mergeItems(items, program.scope));
    contract.keep(1 + merged.length);
    contract.loadsBelowOf.set(groups, merged);
  }
  // (the one answer is every step's but for the mark of an element step there, `hostAt`)
  return [...merged, ...emptyAt(after)];
}

/**
 * #1456: a prefix's property index over its sources (`PropertyIndex`), each a closed object literal stored whole: its
 * entries (the sharing off) or its groups at the prefix (`groups`, on). Each source keeps its literal's one object's
 * property names and writer (`IndexObject`), each name its path below the prefix (`pathAt`) and the source a holder
 * there, each charged as it is made, and the writers' order charged as a sort.
 */
export function propertyIndex(
  contract: Contract,
  entries: readonly PrefixEntry[],
  groups: readonly LevelGroup[] | null,
): PropertyIndex {
  const { work } = contract.pass.program;
  const sources: PropertySource[] = [];
  const holders = new Map<number, PropertySource[]>();
  const add = (literal: PlaceId, entry: PrefixEntry | null, group: LevelGroup | null): void => {
    work.charge("structureSteps");
    const object = contract.literalIndex(literal).root.objects!.list[0]!;
    contract.keep(1);
    const source = { entry, group, names: object.names, writer: object.token, at: sources.length };
    sources.push(source);
    for (const name of object.names) {
      work.charge("structureSteps");
      const path = pathAt(contract, 0, name);
      let list = holders.get(path);
      if (list === undefined) {
        contract.keep(2);
        holders.set(path, (list = []));
      }
      contract.keep(1);
      list.push(source);
    }
  };
  if (groups === null) for (const entry of entries) add(entry.value!, entry, null);
  else for (const group of groups) add(group.literal, null, group);
  contract.keep(sources.length);
  work.charge("structureSteps", sortCost(sources.length));
  const byWriter = [...sources].sort((a, b) =>
    firstWriter(a.writer, b.writer) !== a.writer
      ? 1
      : firstWriter(b.writer, a.writer) !== b.writer
        ? -1
        : 0,
  );
  contract.keep(4);
  return { sources, byWriter, holders, lacking: new Map() };
}

/**
 * F11 at a property of a prefix's index (its path `path`, `step` its name), once per property: the earliest writer of
 * a source without it (F28), by a walk of the writers' order that passes only its holders, and the first such
 * source's position, by a walk of the sources' order, where its `missing` stands among the holders' answers.
 */
export function propertyLack(
  contract: Contract,
  index: PropertyIndex,
  path: number,
  step: string,
): PropertyLack {
  const known = index.lacking.get(path);
  if (known !== undefined) return known;
  const { work } = contract.pass.program;
  let writer: Writer | null = null;
  for (const source of index.byWriter) {
    work.charge("invSteps");
    if (!source.names.has(step)) {
      writer = source.writer;
      break;
    }
  }
  let at = -1;
  for (const source of index.sources) {
    work.charge("invSteps");
    if (!source.names.has(step)) {
      at = source.at;
      break;
    }
  }
  contract.keep(3);
  const lack = { writer, at };
  index.lacking.set(path, lack);
  return lack;
}
