import type { PlaceId, TypeTerm } from "../../graph.js";
import { concrete, isExternal } from "../admission.js";
import { expand, partOf } from "../admission/walk.js";
import type { Expansion, Part } from "../admission/model.js";
import type { CorePass } from "../answers.js";
import { joinSteps, keptParts, keptSlice, keptSteps, NESTING_LIMIT } from "../budget.js";
import type { Consumers } from "../consumers.js";
import { defaultOf, termAt, typedDefault, typeTags, unknownItem, writtenOf } from "../contract.js";
import { keptPath, keyPath, keyPlace, type Definition, type Key } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import {
  EMPTY,
  makeItem,
  REASON,
  STOPPED,
  type IngressNode,
  type Item,
  type ItemTag,
} from "../items.js";
import { conversionCategory } from "../method-categories.js";
import { stepName } from "../program.js";
import type { Work } from "../solver.js";
import { stands } from "./fresh.js";
import { LITERALS, unsettledItem } from "./kinds.js";
import { readKey } from "./names.js";
import { syntaxRead } from "./syntax.js";

// The finishing read after a stop (D4 a′): a value's items, a key's, a typed parse's or load's, from what remains.

/** The collection literals and their own kinds; their elements (a dict's entries) are their children. */
const COLLECTION_LITERALS: ReadonlyMap<string, "list" | "set" | "dict"> = new Map([
  ["listLiteral", "list"],
  ["setLiteral", "set"],
  ["dictLiteral", "dict"],
]);

/** A typed parse or load (F18), with its default where it has one; `null` for any other value. */
export function typedCall(
  program: CorePass["program"],
  value: PlaceId,
): { readonly fallback: PlaceId | undefined } | null {
  const c = program.opOf.get(value);
  if (c?.kind === "load") return { fallback: c.fallback ?? undefined };
  if (
    c?.kind === "operation" &&
    c.contract.family === "conversion" &&
    conversionCategory(c.contract.name)?.kind === "parses"
  )
    return { fallback: defaultOf(c) ?? undefined };
  return null;
}

/**
 * After a stop, a value's items at a node and a path as the finishing read answers them (`finishingRead`), for the
 * route's questions: one derivation with the consumers' (TABLE r4.138).
 */
export function finishedItems(
  walk: Consumers,
  value: PlaceId,
  node: FlowNode | null,
  rest: readonly string[],
): readonly Item[] {
  return finishingRead(walk, value, node, rest);
}

/**
 * A read in the finishing path (D4 a′, TABLE r4.90, r4.99; S3 §5 revision 14, r4.102), answered from the retained
 * state only, the first source that decides it winning: a leaf's own kind (`leafKind`), which no proof decides (an
 * error found there stands, a host read's boundary check forms); the read itself, then its key's contract, as the analysis had finished them before the stop (`run`:
 * the solver answers only from what had finished); the admitted type admission retained at its key's path (written,
 * decided, or a copy's through the copy forest, `Admission.retained`); what the stores' syntax decides there
 * at a settled stop (`cheapDecided`, source 4: TABLE r4.100, r4.135); `STOPPED` (`unknown` with the reason `budget`) only where
 * none of these decides it, so its consumer owes its check when the script runs. Only a leaf's kind and the
 * read's own answer are the value at the read; the key's contract, the written and the retained type are domains,
 * what the key may hold over all its stores (revisions 15, 16; r4.105, r4.106): read as the value for a fixed need,
 * possibly empty at an element; for a `requirement` that follows from the value's kinds (C10's family) only through
 * `required`.
 */
export function finishingRead(
  walk: Consumers,
  value: PlaceId,
  node: FlowNode | null,
  rest: readonly string[],
  requirement = false,
): readonly Item[] {
  // (below a literal, its children's own reads, each through every source: a child no leaf kind decides keeps what the
  // later sources give and a host read's ingress, as unstopped each child is its own value, TABLE r4.126)
  const { program } = walk.pass;
  if (rest.length > 0 && program.places[value]?.kind.kind === "value" && program.hasOf.has(value)) {
    const items: Item[] = [];
    for (const child of walk.admission.literalChildren(value, rest[0]!))
      if (child.value !== undefined && stands(walk, child))
        items.push(
          ...finishingRead(
            walk,
            child.value,
            child.node ?? node,
            keptSlice(program.work, rest, 1),
            requirement,
          ),
        );
    if (items.length > 0) return items;
  }
  const own = leafKind(walk, value, rest);
  if (own !== null) return own;
  const items = laterSources(walk, value, node, rest, requirement);
  // (a host read's ingress is structural whatever the script stores into its global: its C9 boundary forms from it,
  // beside the kinds the later sources give, TABLE r4.113)
  const ingress = requirement ? null : hostIngress(walk, value);
  return ingress === null || items.some((item) => item.ingress !== undefined)
    ? items
    : [...items, ...ingress];
}

/**
 * After a stop, a typed parse's or load's expected type at a path (F18): its written destination's (`landsIn`), else its
 * default's own kinds as a typed default reads it (`typedDefault`: a `null` there leaves its level open), through a
 * chain of typed defaults, as the route's stopped answers read it (`CoreAnswers.#stoppedShape`); `null` for any other
 * value and where none gives a type. Each link of a chain and path once.
 */
function typedRead(
  walk: Consumers,
  value: PlaceId,
  path: readonly string[],
): readonly Item[] | null {
  const { program, contract } = walk.pass;
  if (typedCall(program, value) === null) return null;
  const memo = keptParts(program.work, value, path);
  const known = walk.typedReads.get(memo);
  if (known !== undefined) return known;
  const chain = [memo];
  let found: readonly Item[] | null | undefined;
  for (let at = value, call = typedCall(program, at); found === undefined;) {
    program.work.charge("checks");
    const written = contract.landsIn(at, []);
    if (written !== null) {
      const term = termAt(written, path);
      const tags = term === null ? [] : typeTags(term).filter((tag) => tag !== "unknown");
      found = tags.length === 0 ? null : tags.map((tag) => makeItem(tag, null, { cert: "def" }));
    } else if (call?.fallback === undefined) found = null;
    else {
      at = call.fallback;
      call = typedCall(program, at);
      const link = keptParts(program.work, at, path);
      if (call !== null) {
        found = walk.typedReads.get(link);
        chain.push(link);
      } else {
        // the default itself: its own kinds as a typed default reads them; a default no literal gives (a named one, a
        // call's result) by its read's finished answer, else by its domain (its written, contract or retained type,
        // TABLE r4.144) only where one kind no narrower kind refines decides it: a domain is not the value (an
        // `integer?` may hold null alone, which leaves the level open; a `number` an integer), so elsewhere the type
        // stays open, `STOPPED`, and the call is marked (Codex r22 B1)
        const decision = typedDefault(path, false);
        let own = leafKind(walk, at, path);
        if (own === null && !literalSyntax(walk, at)) {
          own = finishedAnswer(walk, at, null, path);
          if (own === null) {
            const domain = finishingRead(walk, at, null, path);
            own =
              domain.length === 1 && concrete(domain[0]!) && domain[0]!.tag !== "number"
                ? domain
                : STOPPED;
          }
        }
        found =
          own === null
            ? null
            : own === STOPPED
              ? STOPPED
              : decision.answer(decision.choose(own), own);
      }
    }
  }
  for (const link of chain) walk.typedReads.set(link, found);
  return found;
}

/** Whether a value is a literal's own syntax: a scalar, collection or record literal. */
export function literalSyntax(walk: Consumers, value: PlaceId): boolean {
  const place = walk.pass.program.places[value]?.kind;
  return (
    place?.kind === "value" &&
    (LITERALS.has(place.node) ||
      COLLECTION_LITERALS.has(place.node) ||
      place.node === "objectLiteral")
  );
}

/** After a stop, a read's own finished answer (the solver answers only what had finished); `null` where it had not. */
function finishedAnswer(
  walk: Consumers,
  value: PlaceId,
  node: FlowNode | null,
  rest: readonly string[],
): readonly Item[] | null {
  if (walk.pass.program.work.stopped === null) return null;
  const items = walk.run(walk.pass.values.valueItems(value, node, rest));
  return items.some(unsettledItem) ? null : items;
}

/** `finishingRead`'s sources after a leaf's own kind: the read's finished answer, then the domains. */
function laterSources(
  walk: Consumers,
  value: PlaceId,
  node: FlowNode | null,
  rest: readonly string[],
  requirement: boolean,
): readonly Item[] {
  const { contract } = walk.pass;
  // (a read chain past the read depth is unsettled here as anywhere after a stop: the next source asked)
  const settled = (work: () => Work<readonly Item[]>): readonly Item[] | null => {
    const items = walk.run(work());
    return items.some(unsettledItem) ? null : items;
  };
  // the value at the read: its own finished answer
  const exact = finishedAnswer(walk, value, node, rest);
  if (exact !== null) return exact;
  // else its own syntax: a typed parse's or load's expected type (F18), as the route's stopped answers read it; a type,
  // so a domain like those below (a typed list may be empty: C6), but external data where no type reaches it
  const typed = typedRead(walk, value, rest);
  if (typed !== null && typed.some(isExternal)) return typed;
  const typedTags =
    typed === null ? null : [...new Set(withoutEmpty(typed).map((item) => item.tag))];
  // from here on a domain, what the key may hold over all its stores (S3 §5 revision 16): its finished contract
  const held = typedTags === null ? settled(() => contract.contractOfValueAt(value, rest)) : null;
  if (held !== null)
    return requirement ? required(withoutEmpty(held).map((item) => item.tag)) : held;
  // the admitted type as admission retained it (revision 14): a written type by its syntax in any finishing pass; a
  // decision or a copy's only where admission settled
  const written = typedTags === null ? writtenRead(walk, value) : null;
  const term = written === null ? null : termAt(written, rest);
  const retained =
    term !== null ? typeTags(term) : walk.settled ? (retainedRead(walk, value, rest) ?? []) : [];
  // else, at a settled stop, the stores' syntax (source 4, TABLE r4.100, r4.135): every store's syntax decides the key
  // together
  const tags =
    typedTags ?? (retained.length > 0 ? retained : (syntaxRead(walk, value, rest) ?? []));
  // (a requirement follows from the concrete kinds alone, as unstopped, where external data decides none)
  if (requirement) return required(tags);
  // (an admitted or a syntax domain holds the host data its key's stores hold there, as the unstopped read does: its
  // consumer owes its check for that data, and its boundaries form from it, #1432, #1415)
  const host = typedTags === null && term === null ? heldIngress(walk, value, rest) : [];
  if (tags.length === 0 || tags.includes("unknown")) return [...STOPPED, ...host];
  const items = [...tags.map((tag) => makeItem(tag, null, { cert: "pos" })), ...host];
  // (read as the value for a fixed need, a domain says nothing of emptiness: its collection may be empty, C6)
  const step = rest.at(-1) ?? walk.pass.program.projOf.get(value)?.step;
  return step !== undefined && stepName(step) === "element" ? [...items, EMPTY] : items;
}

/** A place's stored paths, as a trie of their steps: each node with the stores whose values stand at its path. */
interface StoreNode {
  readonly children: Map<string, StoreNode>;
  /** Each store there (an add's at its receiver's element), and whether its value's elements stand there (`addAll`). */
  readonly stores: { readonly d: Definition; readonly elements: boolean }[];
}

/**
 * What stands at a path of a place by its stores' structure, made from its owner path's by one step (as the syntax
 * decision's frontier is, `cheapFrontier`): the literal cells of the values there by the step that enters them
 * (admission's store walk, `expand`), the node of the place's stored paths there, the frontiers of what the copies
 * standing there copy, and the host data standing there or above it. A step enters by index only (`stepFrontier`): the
 * frontiers with something of their own at the step, through copies (`Below`), each by its own content there
 * (`ownStep`). One holding nothing but one copy's is that copy's, unless its place has a decision that stopped: then the
 * frontier keeps its place and path, so a step below that decision reads the stop alone (r4.186).
 */
interface HostFrontier {
  readonly cells: Map<string, Part[]>;
  readonly node: StoreNode | null;
  /** Its place and path where the place has a decision that stopped, else `null`. */
  readonly at: { readonly place: PlaceId; readonly path: readonly string[] } | null;
  readonly copies: HostFrontier[];
  host: IngressNode | undefined;
  readonly steps: Map<string, HostFrontier>;
  /** Its own content at each step (`ownStep`): its cells and stored paths there, not its copies'. */
  readonly own: Map<string, HostFrontier>;
}

/** The frontiers that hold something of their own at a step: a frontier, or two such groups (`holdersOf` lists them). */
type Holders = HostFrontier | { readonly union: readonly [Holders, Holders] };

/** A leaf of a `StepTrie`: a step's number (`stepId`) and its holders. */
interface TrieLeaf {
  readonly id: number;
  readonly holders: Holders;
}

/** A node of a `StepTrie`: the entries present at its five bits of a step's number, packed by a bitmap. */
interface TrieNode {
  readonly bitmap: number;
  readonly entries: readonly (TrieNode | TrieLeaf)[];
}

/**
 * Each step's holders below a component of the copy graph, a persistent hash array mapped trie by the step's number,
 * sharing every node it does not change (`Below`'s lineage says which trie it extends and by what).
 */
interface StepTrie {
  readonly size: number;
  readonly root: TrieNode | null;
}

/**
 * What stands below a frontier through its copies (`belowOf`), made once per component of the copy graph. Where no stop
 * tracks the component, its members share it: each step's holders through copies no stop tracks (`holders`), the copies
 * of places with a stopped decision reached through them (`tracked`, stepped one by one for their stops, r4.186), the
 * host data standing at it and so at every path below it (`inherited`), and its step at each step, made once
 * (`stepped`). Where a stop tracks it (a member's place has a stopped decision), each member has its own, without its
 * own steps, and its copies inside the component are `tracked`.
 *
 * Its lineage: the reached summary its `holders` extend (`base`), and the entries it adds to them (`delta`), so that
 * `holders` is `base`'s with `delta` added, and a lineage root's `holders` its `delta`; `depth` and the jumps up the
 * lineage (`up`: its base, its base's base's ..., by powers of two) find the lowest summary two lineages share.
 */
interface Below {
  readonly holders: StepTrie;
  readonly base: Below | null;
  readonly delta: StepTrie;
  readonly depth: number;
  readonly up: readonly Below[];
  readonly tracked: Holders | undefined;
  readonly inherited: IngressNode | undefined;
  readonly stopped: boolean;
  readonly stepped: Map<string, HostFrontier>;
}

/** Per walk: the stored paths of each place, each place's frontier at its root, each read's, and each one's host data. */
interface HostFrontiers {
  readonly places: Map<PlaceId, StoreNode>;
  readonly roots: Map<PlaceId, HostFrontier>;
  readonly reads: Map<PlaceId, HostFrontier>;
  readonly held: Map<HostFrontier, IngressNode | null>;
  readonly below: Map<HostFrontier, Below>;
  /** Each step's number for the step tries (`stepId`). */
  readonly stepIds: Map<string, number>;
  /** The frontiers being made: what stands below one of them is not kept until it is made. */
  readonly making: Set<HostFrontier>;
  /** The places with a decision that stopped (`Contract.stop`). */
  readonly stopped: ReadonlySet<PlaceId>;
}

const hostFrontiers = new WeakMap<Consumers, HostFrontiers>();

/**
 * Whether a frontier holds nothing of its own beside its copies' frontiers: no value a step enters, no store below, no
 * decision of its place that stopped.
 */
function holdsOnlyCopies(at: HostFrontier): boolean {
  return (
    at.cells.size === 0 &&
    at.host === undefined &&
    (at.node?.children.size ?? 0) === 0 &&
    at.at === null
  );
}

const NOTHING: HostFrontier = {
  cells: new Map(),
  node: null,
  at: null,
  copies: [],
  host: undefined,
  steps: new Map(),
  own: new Map(),
};

function frontier(
  node: StoreNode | null,
  host: IngressNode | undefined,
  at: HostFrontier["at"] = null,
): HostFrontier {
  return { cells: new Map(), node, at, copies: [], host, steps: new Map(), own: new Map() };
}

/** The walk's frontiers, its places' stored paths made once from the definitions (each store, add and transfer). */
function frontiersOf(walk: Consumers): HostFrontiers {
  let found = hostFrontiers.get(walk);
  if (found !== undefined) return found;
  const { program, definitions, lists } = walk.pass;
  const places = new Map<PlaceId, StoreNode>();
  const nodeAt = (place: PlaceId, path: readonly string[]): StoreNode => {
    let node: StoreNode | undefined = places.get(place);
    if (node === undefined) places.set(place, (node = { children: new Map(), stores: [] }));
    for (const step of path) {
      program.work.charge("checks");
      let child: StoreNode | undefined = node.children.get(step);
      if (child === undefined)
        node.children.set(step, (child = { children: new Map(), stores: [] }));
      node = child;
    }
    return node;
  };
  for (const [key, list] of definitions.byKey) {
    program.work.charge("checks");
    for (const d of list) {
      program.work.charge("checks");
      if ((d.kind !== "whole" && d.kind !== "add") || d.value === undefined || !lists.live(d))
        continue;
      // (an add stores at its receiver's element; an `addAll`'s value is a list of the elements it adds there)
      const path = keptPath(program.work, key);
      nodeAt(
        keyPlace(key),
        d.kind === "add" ? keptSteps(program.work, path, ["element"]) : path,
      ).stores.push({ d, elements: d.kind === "add" && d.how === "elements" });
    }
  }
  const stopped = new Set(walk.pass.contract.stoppedKeys().map((key) => key.place));
  found = {
    places,
    roots: new Map(),
    reads: new Map(),
    held: new Map(),
    below: new Map(),
    stepIds: new Map(),
    making: new Set(),
    stopped,
  };
  hostFrontiers.set(walk, found);
  return found;
}

/**
 * Enters values standing at a frontier's path: each with the carriers' operands and own contributions at the same path
 * (`expand`'s parts without a step), a host read's ingress its host data, a copy the frontier of the read it copies at
 * its strip; those with cells a step enters kept for the steps.
 */
function enterValues(walk: Consumers, at: HostFrontier, values: Expansion[], depth: number): void {
  const { program } = walk.pass;
  for (let task = values.pop(); task !== undefined; task = values.pop()) {
    program.work.charge("checks");
    if (task.stop?.list === "values") {
      const host = hostIngress(walk, task.value);
      if (host !== null) at.host = program.scope.ingress.union(at.host, host[0]?.ingress);
      else {
        let copied = readFrontier(walk, task.value, depth + 1);
        for (const step of task.stop.strip) copied = stepFrontier(walk, copied, step, depth + 1);
        if (copied !== NOTHING) at.copies.push(copied);
      }
    }
    const { cells, operands } = partsOf(walk, task);
    for (const part of operands) {
      program.work.charge("checks");
      values.push(partOf(walk.admission, part));
    }
    for (const [step, parts] of cells) addCells(walk, at, step, parts);
  }
}

/** Adds cells a step enters to a frontier's, each charged once. */
function addCells(walk: Consumers, at: HostFrontier, step: string, parts: readonly Part[]): void {
  walk.pass.program.work.charge("checks", parts.length);
  const list = at.cells.get(step);
  if (list === undefined) at.cells.set(step, [...parts]);
  else list.push(...parts);
}

/** Each value's parts once (`partsOf`). */
const partsByValue = new WeakMap<
  Expansion,
  { readonly cells: Map<string, Part[]>; readonly operands: Part[] }
>();

/** A value's parts: its cells by their steps, so a step enters them in one look-up, and the operands at its path. */
function partsOf(
  walk: Consumers,
  task: Expansion,
): { readonly cells: Map<string, Part[]>; readonly operands: Part[] } {
  let found = partsByValue.get(task);
  if (found !== undefined) return found;
  found = { cells: new Map(), operands: [] };
  for (const part of task.parts) {
    walk.pass.program.work.charge("checks");
    if (part.step === null) found.operands.push(part);
    else {
      const list = found.cells.get(part.step);
      if (list === undefined) found.cells.set(part.step, [part]);
      else list.push(part);
    }
  }
  partsByValue.set(task, found);
  return found;
}

/** Enters the stores at a frontier's node: each value there, an `addAll`'s elements. */
function enterStores(walk: Consumers, at: HostFrontier, depth: number): void {
  for (const { d, elements } of at.node?.stores ?? []) {
    walk.pass.program.work.charge("checks");
    const value = [expand(walk.admission, d.value!, d.node, [])];
    if (!elements) enterValues(walk, at, value, depth);
    else {
      const list = frontier(null, undefined);
      enterValues(walk, list, value, depth);
      const element = stepFrontier(walk, list, "element", depth);
      for (const [step, parts] of element.cells) addCells(walk, at, step, parts);
      at.copies.push(...element.copies);
      at.host = walk.pass.program.scope.ingress.union(at.host, element.host);
    }
  }
}

/** A place's frontier at a path, from its root's by its steps; nothing at a path whose decision stopped (r4.186). */
function locate(
  walk: Consumers,
  place: PlaceId,
  path: readonly string[],
  depth: number,
): HostFrontier {
  const { contract } = walk.pass;
  if (depth > NESTING_LIMIT || (contract.anyStopped && walk.admission.decisionStopped(place, path)))
    return NOTHING;
  const frontiers = frontiersOf(walk);
  let at = frontiers.roots.get(place);
  if (at === undefined) {
    at = frontier(
      frontiers.places.get(place) ?? null,
      undefined,
      frontiers.stopped.has(place) ? { place, path: [] } : null,
    );
    frontiers.roots.set(place, at);
    frontiers.making.add(at);
    enterStores(walk, at, depth);
    frontiers.making.delete(at);
    if (holdsOnlyCopies(at) && at.copies.length === 1) frontiers.roots.set(place, at.copies[0]!);
  }
  for (const step of path) at = stepFrontier(walk, at, step, depth);
  return at;
}

/**
 * A frontier one step below, made once (a frontier the step reaches again while it is made is its own): the host data
 * standing at `from`, and by index alone the own content there of each frontier holding something at the step through
 * copies, and the step of each copy a stop tracks. Where no stop tracks `from`'s component, its members share the step.
 */
function stepFrontier(
  walk: Consumers,
  from: HostFrontier,
  step: string,
  depth: number,
): HostFrontier {
  if (from === NOTHING || depth > NESTING_LIMIT) return NOTHING;
  const known = from.steps.get(step);
  if (known !== undefined) return known;
  const below = belowOf(walk, from);
  if (!below.stopped) {
    const shared = below.stepped.get(step) ?? componentStep(walk, below, step, depth);
    from.steps.set(step, shared);
    return shared;
  }
  // (below a decision of the place that stopped, the stop alone)
  const { program } = walk.pass;
  const stop =
    from.at === null
      ? null
      : { place: from.at.place, path: keptSteps(program.work, from.at.path, [step]) };
  if (stop !== null && walk.admission.decisionStopped(stop.place, stop.path)) {
    from.steps.set(step, NOTHING);
    return NOTHING;
  }
  const { making } = frontiersOf(walk);
  const at = frontier(from.node?.children.get(step) ?? null, below.inherited, stop);
  from.steps.set(step, at);
  making.add(at);
  const cells: Expansion[] = [];
  for (const part of from.cells.get(step) ?? []) {
    program.work.charge("checks");
    cells.push(partOf(walk.admission, part));
  }
  enterValues(walk, at, cells, depth);
  enterStores(walk, at, depth);
  enterHolders(walk, at, below, step, depth);
  making.delete(at);
  if (holdsOnlyCopies(at) && at.copies.length <= 1) {
    const same = at.copies[0] ?? NOTHING;
    from.steps.set(step, same);
    return same;
  }
  return at;
}

/** A component's step where no stop tracks it, made once for its members (`Below.stepped`). */
function componentStep(walk: Consumers, below: Below, step: string, depth: number): HostFrontier {
  const { making } = frontiersOf(walk);
  const at = frontier(null, below.inherited);
  below.stepped.set(step, at);
  making.add(at);
  enterHolders(walk, at, below, step, depth);
  making.delete(at);
  if (holdsOnlyCopies(at) && at.copies.length <= 1) {
    const same = at.copies[0] ?? NOTHING;
    below.stepped.set(step, same);
    return same;
  }
  return at;
}

/** Enters a step's holders below a component, each by its own content there, and steps the copies a stop tracks. */
function enterHolders(
  walk: Consumers,
  at: HostFrontier,
  below: Below,
  step: string,
  depth: number,
): void {
  const { program } = walk.pass;
  for (const holder of holdersOf(walk, trieGet(walk, below.holders, stepId(walk, step)))) {
    program.work.charge("checks");
    const own = ownStep(walk, holder, step, depth + 1);
    if (own !== NOTHING) at.copies.push(own);
  }
  for (const copy of holdersOf(walk, below.tracked)) {
    program.work.charge("checks");
    const copied = stepFrontier(walk, copy, step, depth + 1);
    if (copied !== NOTHING) at.copies.push(copied);
  }
}

/** A frontier's own content one step below, made once: its cells and its stored paths there, not its copies'. */
function ownStep(walk: Consumers, holder: HostFrontier, step: string, depth: number): HostFrontier {
  if (depth > NESTING_LIMIT) return NOTHING;
  const known = holder.own.get(step);
  if (known !== undefined) return known;
  const { program } = walk.pass;
  const { making } = frontiersOf(walk);
  const at = frontier(holder.node?.children.get(step) ?? null, undefined);
  holder.own.set(step, at);
  making.add(at);
  const cells: Expansion[] = [];
  for (const part of holder.cells.get(step) ?? []) {
    program.work.charge("checks");
    cells.push(partOf(walk.admission, part));
  }
  enterValues(walk, at, cells, depth);
  enterStores(walk, at, depth);
  making.delete(at);
  if (holdsOnlyCopies(at) && at.copies.length <= 1) {
    const same = at.copies[0] ?? NOTHING;
    holder.own.set(step, same);
    return same;
  }
  return at;
}

/**
 * A read's frontier: its binding's at its target path, a call's its function's result's, a projection's its owner's one
 * step below; `NOTHING` else.
 */
function readFrontier(walk: Consumers, value: PlaceId, depth: number): HostFrontier {
  const { program } = walk.pass;
  const reads = frontiersOf(walk).reads;
  const chain: PlaceId[] = [];
  let at = value;
  for (
    let projection = program.projOf.get(at);
    projection !== undefined && !reads.has(at);
    projection = program.projOf.get(at)
  ) {
    chain.push(at);
    at = projection.owner;
  }
  let found = reads.get(at);
  if (found === undefined) {
    program.work.charge("checks");
    // (a binding's read at its target path; a call's result its function's result place)
    const binding = program.occurrenceOf.get(at);
    const target = binding === undefined ? null : program.targetRoot(binding);
    const result = walk.resultOfCall.get(at);
    found =
      target !== null
        ? locate(walk, target.root, target.path, depth)
        : result !== undefined
          ? locate(walk, result, [], depth)
          : NOTHING;
    reads.set(at, found);
  }
  for (const next of chain.reverse()) {
    program.work.charge("checks");
    const step = program.projOf.get(next)!.step;
    found = step === "iteration" ? NOTHING : stepFrontier(walk, found, stepName(step), depth);
    reads.set(next, found);
  }
  return found;
}

/** A step's number for the step tries, made once per walk. */
function stepId(walk: Consumers, step: string): number {
  const { stepIds } = frontiersOf(walk);
  let id = stepIds.get(step);
  if (id === undefined) {
    walk.pass.program.work.charge("checks");
    stepIds.set(step, (id = stepIds.size));
  }
  return id;
}

/** The bits set in a trie node's bitmap below an entry's: its place among the entries. */
function bitsBelow(bits: number): number {
  let count = 0;
  for (let rest = bits; rest !== 0; rest &= rest - 1) count += 1;
  return count;
}

/** Two groups of holders as one, kept as both (`holdersOf` lists them once). */
function joinHolders(a: Holders | undefined, b: Holders | undefined): Holders | undefined {
  if (a === undefined) return b;
  return b === undefined || a === b ? a : { union: [a, b] };
}

/** The frontiers a group of holders names, each group met once by identity, charged per group. */
function holdersOf(walk: Consumers, holders: Holders | undefined): HostFrontier[] {
  const out: HostFrontier[] = [];
  const seen = new Set<Holders>();
  const pending: Holders[] = [];
  const meet = (group: Holders): void => {
    if (seen.has(group)) return;
    seen.add(group);
    pending.push(group);
  };
  if (holders !== undefined) meet(holders);
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    walk.pass.program.work.charge("checks");
    if ("union" in at) {
      meet(at.union[1]);
      meet(at.union[0]);
    } else out.push(at);
  }
  return out;
}

const EMPTY_TRIE: StepTrie = { size: 0, root: null };

/** A step's holders in a trie, by the step's number; charged per level. */
function trieGet(walk: Consumers, trie: StepTrie, id: number): Holders | undefined {
  let node = trie.root;
  for (let shift = 0; node !== null; shift += 5) {
    walk.pass.program.work.charge("checks");
    const bit = 1 << ((id >>> shift) & 31);
    if ((node.bitmap & bit) === 0) return undefined;
    const entry = node.entries[bitsBelow(node.bitmap & (bit - 1))]!;
    if ("id" in entry) return entry.id === id ? entry.holders : undefined;
    node = entry;
  }
  return undefined;
}

/**
 * A trie node with a leaf added (its holders joined to a leaf of the same step), the nodes on its path copied and every
 * other shared; charged per level (a node holds at most 32 entries). Two different numbers part within the 32 bits, so
 * it ends.
 */
function trieWith(
  walk: Consumers,
  node: TrieNode | null,
  leaf: TrieLeaf,
  shift: number,
): { readonly node: TrieNode; readonly added: boolean } {
  const { work } = walk.pass.program;
  const bit = 1 << ((leaf.id >>> shift) & 31);
  if (node === null) {
    work.charge("checks");
    return { node: { bitmap: bit, entries: [leaf] }, added: true };
  }
  const at = bitsBelow(node.bitmap & (bit - 1));
  work.charge("checks");
  const entries = [...node.entries];
  if ((node.bitmap & bit) === 0) {
    entries.splice(at, 0, leaf);
    return { node: { bitmap: node.bitmap | bit, entries }, added: true };
  }
  const entry = node.entries[at]!;
  if ("id" in entry && entry.id === leaf.id) {
    entries[at] = { id: leaf.id, holders: joinHolders(entry.holders, leaf.holders)! };
    return { node: { bitmap: node.bitmap, entries }, added: false };
  }
  const deeper = trieWith(
    walk,
    "id" in entry ? trieWith(walk, null, entry, shift + 5).node : entry,
    leaf,
    shift + 5,
  );
  entries[at] = deeper.node;
  return { node: { bitmap: node.bitmap, entries }, added: deeper.added };
}

/** Two tries as one: the smaller's leaves added to the larger, charged per node and entry met. */
function trieUnion(walk: Consumers, a: StepTrie, b: StepTrie): StepTrie {
  if (a === b || b.root === null) return a;
  if (a.root === null) return b;
  const [large, small] = a.size >= b.size ? [a, b] : [b, a];
  let { size, root } = large;
  const pending: TrieNode[] = [small.root!];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    walk.pass.program.work.charge("checks");
    for (const entry of node.entries) {
      walk.pass.program.work.charge("checks");
      if (!("id" in entry)) {
        pending.push(entry);
        continue;
      }
      const added = trieWith(walk, root, entry, 0);
      root = added.node;
      if (added.added) size += 1;
    }
  }
  return { size, root };
}

/** A trie with a frontier added as a holder of each step it holds something of its own at (its cells, its stored paths). */
function withOwnSteps(walk: Consumers, trie: StepTrie, member: HostFrontier): StepTrie {
  let { size, root } = trie;
  const add = (step: string): void => {
    const added = trieWith(walk, root, { id: stepId(walk, step), holders: member }, 0);
    root = added.node;
    if (added.added) size += 1;
  };
  for (const step of member.cells.keys()) add(step);
  for (const step of member.node?.children.keys() ?? []) add(step);
  return { size, root };
}

/** What a component's members reach (`belowOf`): the reached untracked summaries, the tracked copies and the host data. */
interface Reached {
  readonly reached: Set<Below>;
  tracked: Holders | undefined;
  inherited: IngressNode | undefined;
}

/** The fields of a summary its holders and lineage make (`combine`). */
type Lineage = Pick<Below, "holders" | "base" | "delta" | "depth" | "up">;

/** Test-only: the check of each summary's lineage-merged holders (`withHolderCheck`). */
interface HolderCheck {
  readonly naive: boolean;
  readonly mismatches: string[];
  summaries: number;
}

/** The running holder check, or `null`. */
let holderCheck: HolderCheck | null = null;

/**
 * Test-only: runs `callback` with every summary's lineage-merged holders compared with the naive union of its members'
 * own entries and its reached summaries' holders, step by step, each difference recorded, and the summaries counted;
 * with `naive`, the naive union is the summary's holders instead (the lineage's oracle, `tests/type-core-stop.test.ts`).
 */
export function withHolderCheck<T>(
  naive: boolean,
  callback: () => T,
): { readonly result: T; readonly mismatches: readonly string[]; readonly summaries: number } {
  if (holderCheck !== null) throw new Error("The holders are already checked.");
  const check: HolderCheck = { naive, mismatches: [], summaries: 0 };
  holderCheck = check;
  try {
    const result = callback();
    return { result, mismatches: check.mismatches, summaries: check.summaries };
  } finally {
    holderCheck = null;
  }
}

/** A trie's holders by step number, each step's holders as a set (`withHolderCheck`). */
function trieEntries(walk: Consumers, trie: StepTrie): Map<number, Set<HostFrontier>> {
  const out = new Map<number, Set<HostFrontier>>();
  const pending = trie.root === null ? [] : [trie.root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop())
    for (const entry of node.entries)
      if ("id" in entry) out.set(entry.id, new Set(holdersOf(walk, entry.holders)));
      else pending.push(entry);
  return out;
}

/** A summary's lineage checked against the naive union of what it combines (`withHolderCheck`), or used instead. */
function checked(
  walk: Consumers,
  lineage: Lineage,
  reached: ReadonlySet<Below>,
  own: StepTrie,
): Lineage {
  if (holderCheck === null) return lineage;
  holderCheck.summaries += 1;
  let naive = own;
  for (const below of reached) naive = trieUnion(walk, naive, below.holders);
  const [merged, union] = [trieEntries(walk, lineage.holders), trieEntries(walk, naive)];
  for (const id of new Set([...merged.keys(), ...union.keys()])) {
    const [a, b] = [merged.get(id) ?? new Set(), union.get(id) ?? new Set()];
    if (a.size !== b.size || [...a].some((holder) => !b.has(holder)))
      holderCheck.mismatches.push(`step ${id}: ${a.size} merged, ${b.size} in the union`);
  }
  return holderCheck.naive ? { ...lineage, holders: naive } : lineage;
}

/**
 * Whether summary `x` is `of` or an ancestor of it in their lineage (its `holders` then within `of`'s): `of` lifted to
 * `x`'s depth by its jumps, charged per hop.
 */
function lineageHolds(walk: Consumers, x: Below, of: Below): boolean {
  if (x.depth > of.depth) return false;
  let at = of;
  for (let gap = of.depth - x.depth, level = 0; gap > 0; gap >>= 1, level += 1) {
    walk.pass.program.work.charge("checks");
    if ((gap & 1) !== 0) at = at.up[level]!;
  }
  return at === x;
}

/**
 * A summary's holders from its members' own entries and the distinct summaries it reaches, by lineage: none reached, its
 * own entries; else the largest reached is its base, and from every other reached summary only the entries its lineage
 * adds above the lowest summary it shares with the base, so a base many branches share is never enumerated again (a
 * summary sharing none is added whole, smaller into larger). Charged per lineage hop and per trie entry and level.
 */
function combine(walk: Consumers, reached: ReadonlySet<Below>, own: StepTrie): Lineage {
  const { program } = walk.pass;
  let base: Below | null = null;
  for (const below of reached) {
    program.work.charge("checks");
    if (base === null || below.holders.size > base.holders.size) base = below;
  }
  if (base === null) return { holders: own, base: null, delta: own, depth: 0, up: [] };
  let delta = own;
  for (const below of reached) {
    if (below === base) continue;
    for (let at: Below | null = below; at !== null && !lineageHolds(walk, at, base); at = at.base) {
      program.work.charge("checks");
      delta = trieUnion(walk, delta, at.delta);
    }
  }
  const up: Below[] = [base];
  for (let level = 0; up[level]!.up[level] !== undefined; level += 1) {
    program.work.charge("checks");
    up.push(up[level]!.up[level]!);
  }
  return { holders: trieUnion(walk, base.holders, delta), base, delta, depth: base.depth + 1, up };
}

/**
 * What stands below a frontier through its copies (`Below`), each component of the copy graph once (Tarjan's,
 * iteratively), from its members and the components their copies reach, all made before it. Charged per frame, per copy
 * and per trie entry. A component with a member being made is not kept.
 */
function belowOf(walk: Consumers, start: HostFrontier): Below {
  const { program } = walk.pass;
  const frontiers = frontiersOf(walk);
  const known = frontiers.below.get(start);
  if (known !== undefined) return known;
  const ingress = program.scope.ingress;
  const made = new Map<HostFrontier, Below>();
  const doneOf = (at: HostFrontier): Below | undefined => frontiers.below.get(at) ?? made.get(at);
  const order = new Map<HostFrontier, { readonly index: number; low: number }>();
  const open: HostFrontier[] = [];
  const onOpen = new Set<HostFrontier>();
  const frames: { readonly at: HostFrontier; next: number }[] = [];
  const enter = (at: HostFrontier): void => {
    order.set(at, { index: order.size, low: order.size });
    open.push(at);
    onOpen.add(at);
    frames.push({ at, next: 0 });
  };
  enter(start);
  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    const own = order.get(frame.at)!;
    program.work.charge("checks");
    if (frame.next < frame.at.copies.length) {
      const copy = frame.at.copies[frame.next++]!;
      if (doneOf(copy) !== undefined) continue;
      const met = order.get(copy);
      if (met === undefined) enter(copy);
      else if (onOpen.has(copy)) own.low = Math.min(own.low, met.index);
      continue;
    }
    frames.pop();
    const parent = frames.at(-1);
    if (parent !== undefined) {
      const above = order.get(parent.at)!;
      above.low = Math.min(above.low, own.low);
    }
    if (own.low !== own.index) continue;
    const members: HostFrontier[] = [];
    for (let member = open.pop(); member !== undefined; member = open.pop()) {
      program.work.charge("checks");
      onOpen.delete(member);
      members.push(member);
      if (member === frame.at) break;
    }
    const inside = new Set(members);
    const stopped = members.some((member) => member.at !== null);
    // (what a member's copies outside the component bring: an untracked component's holders, tracked copies and host
    // data; a tracked component's copy, to step; inside a tracked component, the copy itself, to step)
    const reach = (member: HostFrontier, into: Reached): void => {
      for (const copy of member.copies) {
        program.work.charge("checks");
        if (inside.has(copy)) {
          if (stopped && copy !== member) into.tracked = joinHolders(into.tracked, copy);
          continue;
        }
        const below = doneOf(copy)!;
        if (below.stopped) into.tracked = joinHolders(into.tracked, copy);
        else {
          into.reached.add(below);
          into.tracked = joinHolders(into.tracked, below.tracked);
          into.inherited = ingress.union(into.inherited, below.inherited);
        }
      }
    };
    const keep = !members.some((member) => frontiers.making.has(member));
    const record = (member: HostFrontier, below: Below): void => {
      made.set(member, below);
      if (keep) frontiers.below.set(member, below);
    };
    if (!stopped) {
      const into: Reached = { reached: new Set(), tracked: undefined, inherited: undefined };
      let own = EMPTY_TRIE;
      for (const member of members) {
        program.work.charge("checks");
        reach(member, into);
        own = withOwnSteps(walk, own, member);
        into.inherited = ingress.union(into.inherited, member.host);
      }
      const below: Below = {
        ...checked(walk, combine(walk, into.reached, own), into.reached, own),
        tracked: into.tracked,
        inherited: into.inherited,
        stopped,
        stepped: new Map(),
      };
      for (const member of members) {
        program.work.charge("checks");
        record(member, below);
      }
    } else
      for (const member of members) {
        program.work.charge("checks");
        const into: Reached = { reached: new Set(), tracked: undefined, inherited: member.host };
        reach(member, into);
        record(member, {
          ...checked(walk, combine(walk, into.reached, EMPTY_TRIE), into.reached, EMPTY_TRIE),
          tracked: into.tracked,
          inherited: into.inherited,
          stopped,
          stepped: new Map(),
        });
      }
  }
  return doneOf(start)!;
}

/**
 * The host data a frontier and the copies it holds hold: its component's (`Below.inherited`, through untracked copies),
 * and that of each component reached through tracked ones, each once, charged per component met; kept per frontier.
 */
function heldHost(walk: Consumers, start: HostFrontier): IngressNode | undefined {
  const { program } = walk.pass;
  const { held } = frontiersOf(walk);
  const known = held.get(start);
  if (known !== undefined) return known ?? undefined;
  const ingress = program.scope.ingress;
  let node: IngressNode | undefined;
  const seen = new Set<Below>();
  const pending = [start];
  for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
    program.work.charge("checks");
    const below = belowOf(walk, at);
    if (seen.has(below)) continue;
    seen.add(below);
    node = ingress.union(node, below.inherited);
    pending.push(...holdersOf(walk, below.tracked));
  }
  held.set(start, node ?? null);
  return node;
}

/**
 * At a settled program stop, the host data a read's key may hold over all its stores (S3 §5 revision 16: a domain is
 * what the key may hold over all its stores; TABLE r4.113: ingress is structural): the read's own host ingress, and each
 * host read that a store into the key or a key above it holds at the read's path, through the literals and carriers
 * that hold it and the copies of other places (`HostFrontier`), as one external item naming those reads; none where no
 * store holds host data there, nor below a key whose decision stopped (r4.186); past the nesting limit of copies within
 * copies, none.
 */
function heldIngress(walk: Consumers, value: PlaceId, rest: readonly string[]): readonly Item[] {
  const { program, contract, definitions } = walk.pass;
  if (!walk.settled || program.work.stopped === null || definitions.ingress.size === 0) return [];
  if (contract.anyStopped) {
    const key = readKey(walk, value);
    if (
      key === null ||
      walk.admission.decisionStopped(keyPlace(key), joinSteps(keyPath(key), rest))
    )
      return [];
  }
  let at = readFrontier(walk, value, 0);
  for (const step of rest) at = stepFrontier(walk, at, step, 0);
  const node = program.scope.ingress.union(
    hostIngress(walk, value)?.[0]?.ingress,
    heldHost(walk, at),
  );
  return node === undefined ? [] : [{ ...unknownItem(REASON.external), ingress: node }];
}

/**
 * A key's read in the finishing path (a store's receiver), from the same retained state as `finishingRead`: its own
 * finished answer at the node; else, domains, its finished contract and its written or retained admitted type (S3 §5
 * revisions 14, 16); `STOPPED` where none decides it. A receiver the retained state decides keeps its shape, so a store
 * into a property no source has keeps its error at the literal (TABLE r4.108).
 */
export function finishingKeyRead(walk: Consumers, key: Key, node: FlowNode): readonly Item[] {
  const { program } = walk.pass;
  // (a host global holds its own external data where the script stores at no path at or above the key, as its reads
  // do: `leafKind`; that data is there whatever it stores, so its C9 boundary forms, TABLE r4.113)
  const host = program.isHost(keyPlace(key));
  if (host && !storedAbove(walk, keyPlace(key), keyPath(key)))
    return [unknownItem(REASON.external)];
  const items = laterKeySources(walk, key, node);
  return host && !items.some((item) => isExternal(item))
    ? [...items, unknownItem(REASON.external)]
    : items;
}

/** `finishingKeyRead`'s sources after a host global's own data: the key's finished answer, then the domains. */
function laterKeySources(walk: Consumers, key: Key, node: FlowNode): readonly Item[] {
  const { contract, values, program } = walk.pass;
  const settled = (work: () => Work<readonly Item[]>): readonly Item[] | null => {
    const items = walk.run(work());
    return items.some(unsettledItem) ? null : items;
  };
  const found =
    (program.work.stopped === null ? null : settled(() => values.keyItems(key, node))) ??
    settled(() => contract.contractOf(key));
  if (found !== null) return found;
  const [place, path] = [keyPlace(key), keyPath(key)];
  const written = writtenOf(program.place(place).kind);
  const term = written === null ? null : termAt(written, path);
  const tags =
    term !== null
      ? typeTags(term)
      : walk.settled
        ? (walk.admission.retained(place, path) ?? [])
        : [];
  return tags.length === 0 || tags.includes("unknown")
    ? STOPPED
    : tags.map((tag) => makeItem(tag, null, { cert: "pos" }));
}

/**
 * A domain read for a requirement that follows from the value's kinds (C10's family; S3 §5 revisions 15, 16): every
 * value in it must give the same requirement. One family without `null` gives it, as possible kinds (a domain proves
 * nothing); `null` only gives none; any other domain leaves it undecided (`STOPPED`: r4.100's mark).
 */
function required(tags: readonly ItemTag[]): readonly Item[] {
  if (tags.length === 0 || tags.includes("unknown")) return STOPPED;
  const families = new Set(
    tags.filter((tag) => tag !== "null").map((tag) => (tag === "integer" ? "number" : tag)),
  );
  if (families.size === 0) return [makeItem("null", null, { cert: "pos" })];
  return families.size === 1 && !tags.includes("null")
    ? tags.map((tag) => makeItem(tag, null, { cert: "pos" }))
    : STOPPED;
}

/** The admitted type admission retained at a read's key path and `rest` (`Admission.retained`), else `null`. */
function retainedRead(
  walk: Consumers,
  value: PlaceId,
  rest: readonly string[],
): readonly ItemTag[] | null {
  const key = readKey(walk, value);
  return key === null
    ? null
    : walk.admission.retained(keyPlace(key), joinSteps(keyPath(key), rest));
}

/**
 * A leaf's own kind (S3 §5 revision 18, TABLE r4.109 (1)): a literal's own kind at the read (a scalar's, a collection
 * literal's: what its syntax is, as the stopped shapes read it), and below it its children's, or a host
 * read's own ingress, directly or through projections (`Contract.ingressOf`), where the script stores into its host
 * global at no path at or above the read's own: what the value is, known from the program's structure without solving;
 * else `null`.
 */
function leafKind(
  walk: Consumers,
  value: PlaceId,
  rest: readonly string[],
): readonly Item[] | null {
  const { program } = walk.pass;
  const own = rest.length === 0 ? (literalKind(walk, value) ?? ownLiteralKind(walk, value)) : null;
  if (own !== null) return own;
  // (below a collection or record literal, its own children's, each a leaf: `[hostValue]` at its element)
  const place = program.places[value]?.kind;
  if (rest.length > 0 && place?.kind === "value" && program.hasOf.has(value)) {
    const items: Item[] = [];
    for (const child of walk.admission.literalChildren(value, rest[0]!)) {
      const found = child.value === undefined ? null : leafKind(walk, child.value, rest.slice(1));
      if (found === null) return null;
      items.push(...found);
    }
    return items.length === 0 ? null : items;
  }
  // (a host read: its kinds only where the script stores at no path at or above the read's own, TABLE r4.113)
  const ingress = hostIngress(walk, value);
  const key = ingress === null ? null : readKey(walk, value);
  return key !== null && !storedAbove(walk, keyPlace(key), joinSteps(keyPath(key), rest))
    ? ingress
    : null;
}

/**
 * A host read's ingress, directly or through projections (`Contract.ingressOf`): its external data named by its leaf,
 * known from the program's structure whatever the script stores into the global (TABLE r4.113); else `null`.
 */
function hostIngress(walk: Consumers, value: PlaceId): readonly Item[] | null {
  const { contract, program } = walk.pass;
  const ingress = contract.ingressOf(value);
  const binding = ingress === null ? undefined : program.occurrenceOf.get(ingress);
  return binding !== undefined && program.isHost(binding)
    ? contract.entered(value, [unknownItem(REASON.external)])
    : null;
}

/**
 * The host data a value holds at every element depth of its own literals (`[hostValue]`, `[[hostValue]]`): each host
 * read's own ingress there (`leafKind`), the literals walked once by their own structure. A mark at a default stands in
 * for its check at every depth, so its host data meets its boundaries with it (TABLE r4.110 (a)).
 */
export function heldHostData(walk: Consumers, value: PlaceId): Item[] {
  const { program } = walk.pass;
  const out: Item[] = [];
  const pending = [value];
  while (pending.length > 0) {
    const at = pending.pop()!;
    program.work.charge("checks");
    const place = program.places[at]?.kind;
    if (place?.kind === "value" && COLLECTION_LITERALS.has(place.node)) {
      for (const child of walk.admission.literalChildren(at, "element"))
        if (child.value !== undefined) pending.push(child.value);
    } else out.push(...(leafKind(walk, at, []) ?? []));
  }
  return out;
}

/**
 * Whether the script stores into the host global `place` at `path` or at a path above it (a store below or beside it
 * does not replace the value read there), each global's stored paths found once (`leafKind`, TABLE r4.113).
 */
function storedAbove(walk: Consumers, place: PlaceId, path: readonly string[]): boolean {
  if (walk.hostStores === null) {
    const { program, definitions } = walk.pass;
    const stored = new Map<PlaceId, Definition[]>();
    for (const d of definitions.storeDefs) {
      program.work.charge("checks");
      if (!program.isHost(d.place)) continue;
      const list = stored.get(d.place);
      if (list === undefined) stored.set(d.place, [d]);
      else list.push(d);
    }
    walk.hostStores = stored;
  }
  // (an add stores at its path's element)
  return (walk.hostStores.get(place) ?? []).some((d) => {
    const length = d.path.length + (d.kind === "add" ? 1 : 0);
    return (
      length <= path.length &&
      d.path.every((step, index) => path[index] === step) &&
      (d.kind !== "add" || path[d.path.length] === "element")
    );
  });
}

/** A collection or record literal's own kind, its syntax (as the stopped shapes read it); `null` for any other value. */
function ownLiteralKind(walk: Consumers, value: PlaceId): readonly Item[] | null {
  const place = walk.pass.program.places[value]?.kind;
  if (place?.kind !== "value") return null;
  const own = place.node === "objectLiteral" ? "object" : COLLECTION_LITERALS.get(place.node);
  return own === undefined ? null : [makeItem(own, null, { cert: "def" })];
}

/** A scalar literal's own kind, which no proof decides (an error found there stands, D4 a′); `null` for any other value. */
function literalKind(walk: Consumers, value: PlaceId): readonly Item[] | null {
  const { program } = walk.pass;
  const place = program.places[value]?.kind;
  const has = program.hasOf.get(value);
  return place?.kind === "value" &&
    LITERALS.has(place.node) &&
    has?.length === 1 &&
    has[0]!.type.kind === "atom"
    ? [makeItem(has[0]!.type.name, null, { cert: "def" })]
    : null;
}

/**
 * The written type a value's read holds at its own path: its binding's written type at the path its projections
 * read; each value's made from its owner's by its step, so a chain of k projections takes k steps.
 */
function writtenRead(walk: Consumers, value: PlaceId): TypeTerm | null {
  const { program } = walk.pass;
  const chain: PlaceId[] = [];
  let at = value;
  for (
    let projection = program.projOf.get(at);
    projection !== undefined && !walk.writtenReads.has(at);
    projection = program.projOf.get(at)
  ) {
    chain.push(at);
    at = projection.owner;
  }
  let term = walk.writtenReads.get(at);
  if (term === undefined) {
    program.work.charge("checks");
    const binding = program.occurrenceOf.get(at);
    const target = binding === undefined ? null : program.targetRoot(binding);
    const written = target === null ? null : writtenOf(program.place(target.root).kind);
    term = written === null ? null : termAt(written, target!.path);
    walk.writtenReads.set(at, term);
  }
  for (const next of chain.reverse()) {
    program.work.charge("checks");
    const step = program.projOf.get(next)!.step;
    // (a loop's element read is the loop's own binding, read by its own occurrences)
    term = term === null || step === "iteration" ? null : termAt(term, [stepName(step)]);
    walk.writtenReads.set(next, term);
  }
  return term ?? null;
}
