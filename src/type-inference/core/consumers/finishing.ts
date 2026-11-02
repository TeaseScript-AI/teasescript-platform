import type { PlaceId, TypeTerm } from "../../graph.js";
import { concrete, isExternal } from "../admission.js";
import { expand, partOf } from "../admission/walk.js";
import type { Expansion, Part } from "../admission/model.js";
import type { CorePass } from "../answers.js";
import { joinSteps, keptParts, keptSlice, keptSteps, type WorkLedger } from "../budget.js";
import type { Consumers } from "../consumers.js";
import { defaultOf, termAt, typedDefault, typeTags, unknownItem, writtenOf } from "../contract.js";
import { keptPath, keyPath, keyPlace, type Definition, type Key } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import {
  EMPTY,
  inItsOrder,
  makeItem,
  ingressLeaves,
  REASON,
  spelledBy,
  spellingOf,
  STOPPED,
  type IngressNode,
  type Item,
  type ItemTag,
  type Spelling,
} from "../items.js";
import { conversionCategory, dictList } from "../method-categories.js";
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
  // later sources give and a host read's ingress, as unstopped each child is its own value, TABLE r4.126; together in
  // their one order, #1398)
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
    if (items.length > 0) return inItsOrder(items);
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
      // (its kinds with the written type's spelling, #1398)
      const spelled = spelledBy(tags);
      found =
        tags.length === 0
          ? null
          : tags.map((tag) => makeItem(tag, null, { cert: "def", ...spelled }));
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
              : inItsOrder(decision.answer(decision.choose(own), own));
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
  const { contract, program } = walk.pass;
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
  // (a domain that admits every kind, one whose nearest written prefix does, directly, through copies or a dictionary's
  // values list, holds the host data its key's stores hold, as an admitted or a syntax domain does below, #1450; a
  // restricted one holds its kinds, its stores' boundaries checking them): a contract by an `unknown` no reason but the
  // opaque one explains (a written open domain's carries it, #1501)
  if (held !== null) {
    if (requirement)
      return required(
        withoutEmpty(held).map((item) => item.tag),
        spellingOf(held),
      );
    const domain = markDomain(walk, value, held);
    return held.some((item) => item.tag === "unknown" && (item.reasons & ~REASON.opaque) === 0)
      ? [...domain, ...heldIngress(walk, value, rest)]
      : domain;
  }
  // the admitted type as admission retained it (revision 14): a written type by its syntax in any finishing pass; a
  // decision or a copy's only where admission settled
  const read = typedTags === null ? writtenRead(walk, value) : null;
  const written = read === null ? null : termAt(read, rest);
  const retained =
    written !== null
      ? { kinds: writtenTags(program.work, written), written: true }
      : walk.settled
        ? (retainedRead(walk, value, rest) ?? NONE_RETAINED)
        : NONE_RETAINED;
  // else, at a settled stop, the stores' syntax (source 4, TABLE r4.100, r4.135): every store's syntax decides the key
  // together
  const syntax =
    typedTags === null && retained.kinds.length === 0 ? syntaxRead(walk, value, rest) : null;
  const tags = typedTags ?? (retained.kinds.length > 0 ? retained.kinds : (syntax?.kinds ?? []));
  // (the domain's spelling where a written type, a copy of one or the stores' syntax by one gives it, #1398)
  const spelling: Spelling | undefined =
    typed !== null
      ? spellingOf(typed)
      : retained.kinds.length > 0
        ? retained.written
          ? spelledBy(retained.kinds).spelling
          : undefined
        : syntax?.spelling;
  // (a requirement follows from the concrete kinds alone, as unstopped, where external data decides none)
  if (requirement) return required(tags, spelling);
  // (an admitted or a syntax domain holds the host data its key's stores hold there, as the unstopped read does: its
  // consumer owes its check for that data, and its boundaries form from it, #1432, #1415; so does a written domain whose
  // nearest written prefix admits every kind, above)
  const prefix = read === null ? null : prefixAt(program.work, read, rest);
  const host =
    typedTags === null && (prefix === null || openness(program.work, prefix).open)
      ? heldIngress(walk, value, rest)
      : [];
  if (tags.length === 0 || tags.includes("unknown")) return [...STOPPED, ...host];
  const spelled = spelling === undefined ? {} : { spelling };
  const items = [...tags.map((tag) => makeItem(tag, null, { cert: "pos", ...spelled })), ...host];
  // (read as the value for a fixed need, a domain says nothing of emptiness: its collection may be empty, C6)
  const step = rest.at(-1) ?? walk.pass.program.projOf.get(value)?.step;
  return step !== undefined && stepName(step) === "element" ? [...items, EMPTY] : items;
}

/**
 * A domain's external items as a read's (#1448): what its key's stores hold, so a consumer's boundary requests for them
 * are the content of the warning that owns them (`Consumers.boundariesAt`). Each is a copy kept in `domainOwned`; a solver
 * item, which other reads share, stays as it is. A host read's stay unmarked: its own host ingress is in them, and that
 * boundary forms whatever its stores hold (TABLE r4.113).
 */
function markDomain(walk: Consumers, value: PlaceId, items: readonly Item[]): readonly Item[] {
  // (each item looked at once, charged)
  walk.pass.program.work.charge("checks", items.length);
  if (!items.some(isExternal) || hostIngress(walk, value) !== null) return items;
  return items.map((item) => {
    if (!isExternal(item)) return item;
    const own = { ...item };
    walk.domainOwned.add(own);
    return own;
  });
}

/** A place's stored paths, as a trie of their steps: each node with the stores whose values stand at its path. */
interface StoreNode {
  readonly children: Map<string, StoreNode>;
  /** Each store there (an add's at its receiver's element), and whether its value's elements stand there (`addAll`). */
  readonly stores: { readonly d: Definition; readonly elements: boolean }[];
}

/** A copy standing at a path: the read it copies, and the steps below that read it stands at. */
interface CopyTask {
  readonly value: PlaceId;
  readonly strip: readonly string[];
}

/**
 * What stands at a frontier's path beside its own content, each followed as a copy: a copy task, or, at a `values` step,
 * the frontier one step above, a dictionary whose `values` list's element is its own (#1452).
 */
type Standing = CopyTask | { readonly values: HostFrontier };

/**
 * What stands at a path of a place by its own stores' structure, made once from its owner path's by one step (as the
 * syntax decision's frontier is, `cheapFrontier`): the literal cells of the values there by the step that enters them
 * (admission's store walk, `expand`), the node of the place's stored paths there, the copies standing there, and the
 * host data standing there or above it. What its copies hold is reached by a read's bounded walk (`explore`): the copies
 * standing at a frontier's path are its own and its owner path's, one step below. Where its place has a decision that
 * stopped, its place and path are kept, so a step below that decision reads the stop alone (r4.186).
 */
interface HostFrontier {
  readonly cells: Map<string, Part[]>;
  readonly node: StoreNode | null;
  /** Its place and path where the place has a decision that stopped, else `null`. */
  readonly at: { readonly place: PlaceId; readonly path: readonly string[] } | null;
  readonly copies: Standing[];
  host: IngressNode | undefined;
  /** Its owner path's frontier and the step below it, whose copies stand here one step below; `null` at a root. */
  readonly owner: { readonly frontier: HostFrontier; readonly step: string } | null;
  readonly steps: Map<string, HostFrontier>;
  /** What it stands for as far as followed (`sameOf`): itself, or the copy it holds alone, or one further down. */
  same: HostFrontier | undefined;
  /**
   * Whether it is a value's own frontier, one no place holds (`ownFrontier`), or a step below one: there an operand no
   * place holds is linked, never entered again (`enterValues`).
   */
  readonly own: boolean;
  /** The copies standing at levels above it (its owner path's, then further up), in that order: their number. */
  readonly above: number;
  /** Each of those, stepped down to its path (`inheritedAt`), made where it is first asked. */
  readonly inherited: HostFrontier[];
}

/** Per walk: the stored paths of each place, each place's frontier at its root, each read's and each copy's. */
interface HostFrontiers {
  readonly places: Map<PlaceId, StoreNode>;
  readonly roots: Map<PlaceId, HostFrontier>;
  /** The value each read's projections start from (`readRoot`), kept for every value on a chain it climbed. */
  readonly readRoots: Map<PlaceId, PlaceId>;
  readonly reads: Map<PlaceId, HostFrontier>;
  readonly copied: Map<Standing, HostFrontier>;
  /** The host data each place's component of the place-level copy graph reaches (`placeIngress`), `null` for none. */
  readonly unions: Map<PlaceId, IngressNode | null>;
  /** The host data each value no place holds brings through its expression (`ownIngress`), `null` for none. */
  readonly owned: Map<PlaceId, IngressNode | null>;
}

const hostFrontiers = new WeakMap<Consumers, HostFrontiers>();

/**
 * How deep in copies (`FRONTIER_DEPTH`) and how many copies met (`FRONTIER_COPIES`: each copy standing at a frontier's
 * path, each time it is met, and each single copy a frontier is followed through, `sameOf`) a read's host data is followed
 * before the read answers its place's component's (TABLE r4.208): each read's walk is then bounded by a constant, so the finishing reads' work stays linear
 * in the program by construction, whatever the copy graph's shape. Where the walk is cut, the read answers the host
 * data its place's component of the place-level copy graph reaches (`placeIngress`): every path, so a superset, never a
 * dropped check. Measured with this walk over the stop corpus (170 sources), the repository's scripts (19) and the held
 * family (480), at sampled settled stops in two orders: of 9,933 finishing reads, 9,722 end at their own frontier (depth
 * 0), 179 one copy deep and 32 two; no read meets more than 7 copies (2,096 none, 4,304 one, 2,162 two, 694 three, 677
 * four to seven). At 2 and 8, 15 reads are cut (the family's rings), each naming the same writers as its exact walk, so
 * the cut adds no mark, warning, runtime check or boundary there.
 */
export const FRONTIER_DEPTH = 2;
export const FRONTIER_COPIES = 8;

/** The limits a read's walk follows (`withFrontierBound` in tests). */
let frontierBound: { readonly depth: number; readonly copies: number } = {
  depth: FRONTIER_DEPTH,
  copies: FRONTIER_COPIES,
};

/** Test-only: each read's walk, by its value and path (`withFrontierBound`), or `null`. */
let frontierReads: Map<string, FrontierRead> | null = null;

/**
 * Test-only: records a read's walk where the seam records (`withFrontierBound`), never over a cut recorded for the same
 * value and path: a later read of it follows the chain its cut compressed (`sameOf`) and may not be cut, but the
 * analysis kept the cut's answer (#1509).
 */
function recordRead(value: PlaceId, rest: readonly string[], found: () => FrontierRead): void {
  if (frontierReads === null) return;
  const read = `${value}\u0000${rest.join("\u0000")}`;
  if (frontierReads.get(read)?.cut !== true) frontierReads.set(read, found());
}

/** Test-only: what a read's walk found (`withFrontierBound`). */
export interface FrontierRead {
  /** Whether the read answered the stop alone (r4.186) before its walk. */
  readonly guarded: boolean;
  /** Whether its walk was cut, so it answered its place's component's host data. */
  readonly cut: boolean;
  /** The ingress writers its answer names, each by its site and kind. */
  readonly writers: ReadonlySet<string>;
  /** The copies its walk met and the deepest it went. */
  readonly copies: number;
  readonly depth: number;
}

/**
 * Test-only: runs `callback` with each read's walk bounded by `bound` (the exact reference: `Infinity` for both), and
 * records each read's walk (the bounded frontier's oracle, `tests/type-core-stop.test.ts`).
 */
export function withFrontierBound<T>(
  bound: { readonly depth: number; readonly copies: number },
  callback: () => T,
): { readonly result: T; readonly reads: ReadonlyMap<string, FrontierRead> } {
  if (frontierReads !== null) throw new Error("The frontier is already bounded.");
  const reads = new Map<string, FrontierRead>();
  const kept = frontierBound;
  [frontierBound, frontierReads] = [bound, reads];
  try {
    const result = callback();
    return { result, reads };
  } finally {
    [frontierBound, frontierReads] = [kept, null];
  }
}

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
  owner: null,
  steps: new Map(),
  same: undefined,
  above: 0,
  inherited: [],
  own: false,
};

function frontier(
  node: StoreNode | null,
  host: IngressNode | undefined,
  at: HostFrontier["at"],
  owner: HostFrontier["owner"],
  own = false,
): HostFrontier {
  // (an owner is entered whole before a step below it is made, so its copies are all there)
  const above = owner === null ? 0 : owner.frontier.copies.length + owner.frontier.above;
  return {
    cells: new Map(),
    node,
    at,
    copies: [],
    host,
    owner,
    steps: new Map(),
    same: undefined,
    above,
    inherited: [],
    own: owner === null ? own : owner.frontier.own,
  };
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
  found = {
    places,
    roots: new Map(),
    reads: new Map(),
    copied: new Map(),
    unions: new Map(),
    owned: new Map(),
    readRoots: new Map(),
  };
  hostFrontiers.set(walk, found);
  return found;
}

/**
 * Enters values standing at a frontier's path: each with the carriers' operands and own contributions at the same path
 * (`expand`'s parts without a step), a host read's ingress its host data, a copy as a copy task; those with cells a
 * step enters kept for the steps. In a value's own frontier (`own`) an operand no place holds is linked as a copy at its
 * strip, its own frontier made once, on every path that enters it: the value's root or a literal's cell (Astra r1's B1 on
 * #1559: nested defaults entered again below each literal cell made k levels k² tasks).
 */
function enterValues(walk: Consumers, at: HostFrontier, values: Expansion[]): void {
  const { program } = walk.pass;
  for (let task = values.pop(); task !== undefined; task = values.pop()) {
    program.work.charge("checks");
    if (task.stop !== null && copies(program.work, task.stop)) {
      const host = hostIngress(walk, task.value);
      if (host !== null) at.host = program.scope.ingress.union(at.host, host[0]?.ingress);
      else at.copies.push({ value: task.value, strip: task.strip });
    }
    const { cells, operands } = partsOf(walk, task);
    for (const part of operands) {
      program.work.charge("checks");
      if (at.own && ownOperand(walk, task.value, part))
        at.copies.push({ value: part.value, strip: part.strip });
      else values.push(partOf(walk.admission, part));
    }
    for (const [step, parts] of cells) addCells(walk, at, step, parts);
  }
}

/**
 * Whether a value standing in a store walk is a copy the frontier follows: a read of another value (`values`), or a copy
 * of a written place where the nearest written prefix of its path admits every kind at or below it, so it holds the host
 * data its stores hold there (#1450); a restricted one holds its kinds, its stores' boundaries checking them.
 */
function copies(work: WorkLedger, stop: NonNullable<Expansion["stop"]>): boolean {
  if (stop.list === "values") return true;
  if (stop.list !== "written" || stop.term === null) return false;
  const at = prefixAt(work, stop.term, stop.strip);
  return at !== null && openness(work, at).below;
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
function enterStores(walk: Consumers, at: HostFrontier): void {
  const { program } = walk.pass;
  for (const { d, elements } of at.node?.stores ?? []) {
    program.work.charge("checks");
    const value = [expand(walk.admission, d.value!, d.node, [])];
    if (!elements) enterValues(walk, at, value);
    else {
      // (each element whole: what the list's value holds at its element step, the copies standing there, and the copies
      // of the lists it copies at their element, so an element enters with its stored descendants)
      const list = frontier(null, undefined, null, null);
      enterValues(walk, list, value);
      const element = stepOwn(walk, list, "element");
      for (const [step, parts] of element.cells) addCells(walk, at, step, parts);
      for (const task of element.copies) {
        program.work.charge("checks");
        at.copies.push(task);
      }
      for (const task of list.copies) {
        program.work.charge("checks");
        // (the values entered there stand as copy tasks alone)
        if ("value" in task)
          at.copies.push({
            value: task.value,
            strip: keptSteps(program.work, task.strip, ["element"]),
          });
      }
      at.host = program.scope.ingress.union(at.host, element.host);
    }
  }
}

/** A place's frontier at a path, from its root's by its steps; nothing at a path whose decision stopped (r4.186). */
function locate(walk: Consumers, place: PlaceId, path: readonly string[]): HostFrontier {
  const { contract } = walk.pass;
  if (contract.anyStopped && walk.admission.decisionStopped(place, path)) return NOTHING;
  const frontiers = frontiersOf(walk);
  let at = frontiers.roots.get(place);
  if (at === undefined) {
    const stopped =
      contract.anyStopped && contract.stoppedKeys().some((key) => key.place === place);
    at = frontier(
      frontiers.places.get(place) ?? null,
      undefined,
      stopped ? { place, path: [] } : null,
      null,
    );
    frontiers.roots.set(place, at);
    enterStores(walk, at);
  }
  for (const step of path) at = stepOwn(walk, at, step);
  return at;
}

/**
 * A frontier's own content one step below, made once: its cells and its stored paths there, the copies standing there
 * and the host data standing at it; the stop alone below a decision of its place that stopped (r4.186). At a `values`
 * step, which reads a dictionary's values list where its receiver is one and an object's own property where it is an
 * object, both: its own content and the frontier above it, standing there as a copy whose element is the
 * dictionary's (#1452). A dictionary's `keys` list holds text no store's host data reaches (TABLE r4.47).
 */
function stepOwn(walk: Consumers, from: HostFrontier, step: string): HostFrontier {
  const { program } = walk.pass;
  program.work.charge("checks");
  if (from === NOTHING) return NOTHING;
  const known = from.steps.get(step);
  if (known !== undefined) return known;
  const stop =
    from.at === null
      ? null
      : { place: from.at.place, path: keptSteps(program.work, from.at.path, [step]) };
  if (stop !== null && walk.admission.decisionStopped(stop.place, stop.path)) {
    from.steps.set(step, NOTHING);
    return NOTHING;
  }
  const at = frontier(from.node?.children.get(step) ?? null, from.host, stop, {
    frontier: from,
    step,
  });
  from.steps.set(step, at);
  if (dictList(step) === "values") {
    program.work.charge("checks");
    at.copies.push({ values: from });
  }
  const cells: Expansion[] = [];
  for (const part of from.cells.get(step) ?? []) {
    program.work.charge("checks");
    cells.push(partOf(walk.admission, part));
  }
  enterValues(walk, at, cells);
  enterStores(walk, at);
  return at;
}

/**
 * The place a read reads: its binding's target root, a call's function's result place, a projection's owner's; `null`
 * else.
 */
function readPlace(walk: Consumers, value: PlaceId): PlaceId | null {
  const { program } = walk.pass;
  const at = readRoot(walk, value);
  const binding = program.occurrenceOf.get(at);
  const target = binding === undefined ? null : program.targetRoot(binding);
  return target?.root ?? walk.resultOfCall.get(at) ?? null;
}

/**
 * The value a read's projections start from: its outermost projection's owner, or the read itself. Kept for every value
 * on the chain it climbs (`readRoots`), so the reads along one chain climb it once (Astra r1's B2 on #1559: a cut read
 * found its root through `readPlace` and `readRoot` again, k reads 2k² steps).
 */
function readRoot(walk: Consumers, value: PlaceId): PlaceId {
  const { program } = walk.pass;
  const { readRoots } = frontiersOf(walk);
  const chain: PlaceId[] = [];
  let at = value;
  for (
    let projection = program.projOf.get(at);
    projection !== undefined && !readRoots.has(at);
    projection = program.projOf.get(at)
  ) {
    program.work.charge("checks");
    chain.push(at);
    at = projection.owner;
  }
  const root = readRoots.get(at) ?? at;
  for (const each of chain) readRoots.set(each, root);
  return root;
}

/** A value's node: its expression's, where its own content is read (`ownFrontier`); `null` for a value without one. */
function ownNode(walk: Consumers, value: PlaceId): FlowNode | null {
  const site = walk.pass.program.places[value]?.site ?? null;
  return site === null ? null : walk.pass.program.exprAt(site);
}

/**
 * A read's frontier: its binding's at its target path, a call's its function's result's, a projection's its owner's one
 * step below; else its own (`ownFrontier`).
 */
function readFrontier(walk: Consumers, value: PlaceId): HostFrontier {
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
        ? locate(walk, target.root, target.path)
        : result !== undefined
          ? locate(walk, result, [])
          : ownFrontier(walk, at, reads);
    reads.set(at, found);
  }
  for (const next of chain.reverse()) {
    program.work.charge("checks");
    const step = program.projOf.get(next)!.step;
    found = step === "iteration" ? NOTHING : stepOwn(walk, found, stepName(step));
    reads.set(next, found);
  }
  return found;
}

/**
 * The frontier of a value no place holds (a literal, a fallback, an operation), at its expression's node: what it holds
 * by its own structure, as a store of it brings (`enterValues`), so a read of a literal's projection or of a fallback
 * holds its host data as a read of a stored one does (#1491, #1502). It is `own`: an operand no place holds stands in it
 * and below it as a copy (`ownOperand`), its own frontier made once whatever reads it. Kept as the value's read before
 * it is entered: a carrier's own contribution is a copy of itself, which stands for nothing more.
 */
function ownFrontier(
  walk: Consumers,
  value: PlaceId,
  reads: Map<PlaceId, HostFrontier>,
): HostFrontier {
  const node = ownNode(walk, value);
  if (node === null) return NOTHING;
  const at = frontier(null, undefined, null, null, true);
  reads.set(value, at);
  enterValues(walk, at, [expand(walk.admission, value, node, [])]);
  return at;
}

/** Whether a part of a value's expansion is another value no place holds (`ownFrontier`, `ownIngress`). */
function ownOperand(walk: Consumers, value: PlaceId, part: Part): boolean {
  return part.value !== value && readPlace(walk, part.value) === null;
}

/** A copy task's frontier: its read's, at its strip; made once. A dictionary standing at its `values` list: its own. */
function copyFrontier(walk: Consumers, task: Standing): HostFrontier {
  if ("values" in task) return task.values;
  const { copied } = frontiersOf(walk);
  let found = copied.get(task);
  if (found === undefined) {
    found = readFrontier(walk, task.value);
    for (const step of task.strip) found = stepOwn(walk, found, step);
    copied.set(task, found);
  }
  return found;
}

/**
 * Visits the copies standing at a frontier's path, each by its frontier there: its own, then its owner path's one step
 * below, and so on up (`inheritedAt`), until `visit` answers `false`. Each copy met is charged, with its steps.
 */
function eachCopy(walk: Consumers, at: HostFrontier, visit: (copy: HostFrontier) => boolean): void {
  const { program } = walk.pass;
  program.work.charge("checks");
  for (const task of at.copies) {
    program.work.charge("checks");
    if (!visit(copyFrontier(walk, task))) return;
  }
  // (each charged in `inheritedAt`)
  for (let index = 0; index < at.above; index += 1)
    if (!visit(inheritedAt(walk, at, index))) return;
}

/**
 * A copy standing above a frontier, stepped down to its path: the `index`th of its owner's own copies and then of those
 * above its owner, each one step below the owner's. Each frontier's entry is made once, from its owner's, so the reads
 * along one path share every step of the climb and each read's is bounded by the copies it meets (Codex r1's B1 on
 * #1559: a copy at a deep path's root, climbed and replayed again for each read below it, made k reads k² steps).
 */
function inheritedAt(walk: Consumers, at: HostFrontier, index: number): HostFrontier {
  const { program } = walk.pass;
  const chain: [HostFrontier, number][] = [];
  let found: HostFrontier;
  for (let level = at, k = index; ;) {
    program.work.charge("checks");
    const known = level.inherited[k];
    if (known !== undefined) {
      found = known;
      break;
    }
    chain.push([level, k]);
    const owner = level.owner!.frontier;
    if (k < owner.copies.length) {
      found = copyFrontier(walk, owner.copies[k]!);
      break;
    }
    k -= owner.copies.length;
    level = owner;
  }
  for (let n = chain.length - 1; n >= 0; n -= 1) {
    const [level, k] = chain[n]!;
    found = stepOwn(walk, found, level.owner!.step);
    level.inherited[k] = found;
  }
  return found;
}

/**
 * The frontier one stands for: itself, or, where it holds nothing of its own beside one copy, what that copy's stands
 * for; nothing where it holds nothing (a cycle of such frontiers holds nothing either). Each link followed is one of the
 * copies its read's walk meets (`budget`), but no copy deep; past them `null`. Each frontier followed keeps the
 * furthest one found (`same`, itself where it stands for itself), so each copy is listed once and a later read jumps
 * where an earlier one stopped.
 */
function sameOf(
  walk: Consumers,
  start: HostFrontier,
  budget: { met: number },
): HostFrontier | null {
  const chain: HostFrontier[] = [];
  const met = new Set<HostFrontier>();
  let at = start;
  for (;;) {
    walk.pass.program.work.charge("checks");
    if (at === NOTHING || at.same === at) break;
    if (met.has(at)) {
      at = NOTHING;
      break;
    }
    met.add(at);
    let next = at.same;
    if (next === undefined) {
      if (!holdsOnlyCopies(at)) {
        at.same = at;
        break;
      }
      const copies: HostFrontier[] = [];
      eachCopy(walk, at, (copy) => copies.push(copy) < 2);
      if (copies.length > 1) {
        at.same = at;
        break;
      }
      next = copies[0] ?? NOTHING;
    }
    chain.push(at);
    if (++budget.met > frontierBound.copies) {
      for (const each of chain) {
        walk.pass.program.work.charge("checks");
        each.same = next;
      }
      return null;
    }
    at = next;
  }
  for (const each of chain) {
    walk.pass.program.work.charge("checks");
    each.same = at;
  }
  return at;
}

/**
 * A read's bounded walk (TABLE r4.208): the host data standing at its frontier and at the frontiers of the copies
 * standing there, breadth first, each frontier once, at most `frontierBound.depth` copies deep and `.copies` copies met.
 * Cut where a copy would lead deeper, or past the copies it may meet, to a frontier it has not met: then the read
 * answers its place's component's host data (`placeIngress`).
 */
function explore(
  walk: Consumers,
  start: HostFrontier,
): {
  readonly host: IngressNode | undefined;
  readonly cut: boolean;
  readonly copies: number;
  readonly depth: number;
} {
  const { program } = walk.pass;
  const budget = { met: 0 };
  const first = sameOf(walk, start, budget);
  let cut = first === null;
  const met = new Set<HostFrontier>(first === null ? [] : [first]);
  let layer = first === null || first === NOTHING ? [] : [first];
  let host: IngressNode | undefined;
  let depth = 0;
  for (; layer.length > 0 && !cut; depth += 1) {
    const next: HostFrontier[] = [];
    for (const at of layer) {
      program.work.charge("checks");
      host = program.scope.ingress.union(host, at.host);
      if (cut) continue;
      eachCopy(walk, at, (copy) => {
        if (++budget.met > frontierBound.copies) return !(cut = true);
        const same = sameOf(walk, copy, budget);
        if (same === null) return !(cut = true);
        if (same === NOTHING || met.has(same)) return true;
        if (depth >= frontierBound.depth) return !(cut = true);
        met.add(same);
        next.push(same);
        return true;
      });
    }
    layer = next;
  }
  return { host, cut, copies: budget.met, depth: Math.max(0, depth - 1) };
}

/**
 * The host data a place's stores bring and the places their copies read (each store's value walked once), for the
 * place-level copy graph (`placeIngress`).
 */
function placeEdges(
  walk: Consumers,
  place: PlaceId,
): { readonly host: IngressNode | undefined; readonly places: PlaceId[] } {
  const { program } = walk.pass;
  const edges: Edges = { host: undefined, places: [] };
  const nodes = [frontiersOf(walk).places.get(place)].filter((node) => node !== undefined);
  for (let node = nodes.pop(); node !== undefined; node = nodes.pop()) {
    program.work.charge("checks");
    nodes.push(...node.children.values());
    for (const { d } of node.stores) {
      program.work.charge("checks");
      valueEdges(walk, expand(walk.admission, d.value!, d.node, []), edges);
    }
  }
  return edges;
}

/** The host data values bring and the places their copies read (`placeEdges`). */
interface Edges {
  host: IngressNode | undefined;
  readonly places: PlaceId[];
}

/**
 * Adds to `edges` the host data a value brings and the places its copies read, through its parts; with `owned`, a part
 * that is another value no place holds is listed there instead (`ownIngress`).
 */
function valueEdges(walk: Consumers, value: Expansion, edges: Edges, owned?: PlaceId[]): void {
  const { program } = walk.pass;
  const values = [value];
  for (let task = values.pop(); task !== undefined; task = values.pop()) {
    program.work.charge("checks");
    if (task.stop !== null && copies(program.work, task.stop)) {
      const ingress = hostIngress(walk, task.value);
      if (ingress !== null)
        edges.host = program.scope.ingress.union(edges.host, ingress[0]?.ingress);
      else {
        const read = readPlace(walk, task.value);
        if (read !== null) edges.places.push(read);
      }
    }
    for (const part of task.parts) {
      program.work.charge("checks");
      if (owned !== undefined && ownOperand(walk, task.value, part)) owned.push(part.value);
      else values.push(partOf(walk.admission, part));
    }
  }
}

/**
 * The host data a read whose walk is cut answers (TABLE r4.208): its place's component's (`placeIngress`), or, for a value
 * no place holds, what its expression brings (`ownIngress`). A superset of what its walk would name, never a dropped
 * check.
 */
function cutIngress(walk: Consumers, value: PlaceId): IngressNode | undefined {
  const place = readPlace(walk, value);
  return place !== null ? placeIngress(walk, place) : ownIngress(walk, readRoot(walk, value));
}

/**
 * The host data a value no place holds brings through its expression at every path: what its parts bring, the components
 * of the places they read (`placeIngress`) and each operand no place holds by its own, each value once (`owned`),
 * iteratively.
 */
function ownIngress(walk: Consumers, value: PlaceId): IngressNode | undefined {
  const { program } = walk.pass;
  const { owned } = frontiersOf(walk);
  const ingress = program.scope.ingress;
  const known = owned.get(value);
  if (known !== undefined) return known ?? undefined;
  const open = new Set<PlaceId>();
  const frames: {
    readonly value: PlaceId;
    readonly operands: PlaceId[];
    next: number;
    host: IngressNode | undefined;
  }[] = [];
  const enter = (at: PlaceId): void => {
    open.add(at);
    const node = ownNode(walk, at);
    const edges: Edges = { host: undefined, places: [] };
    const operands: PlaceId[] = [];
    if (node !== null) valueEdges(walk, expand(walk.admission, at, node, []), edges, operands);
    let host = edges.host;
    for (const read of edges.places) {
      program.work.charge("checks");
      host = ingress.union(host, placeIngress(walk, read));
    }
    frames.push({ value: at, operands, next: 0, host });
  };
  enter(value);
  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    program.work.charge("checks");
    if (frame.next < frame.operands.length) {
      const operand = frame.operands[frame.next++]!;
      const done = owned.get(operand);
      if (done !== undefined) frame.host = ingress.union(frame.host, done ?? undefined);
      else if (!open.has(operand)) enter(operand);
      continue;
    }
    frames.pop();
    owned.set(frame.value, frame.host ?? null);
    const parent = frames.at(-1);
    if (parent !== undefined) parent.host = ingress.union(parent.host, frame.host);
  }
  return owned.get(value) ?? undefined;
}

/**
 * The host data a place's component of the place-level copy graph reaches, at every path: its members' stores' and
 * every component's its copies read, each component once (Tarjan's, iteratively), shared as one ingress union by every
 * place that reaches it. A cut read answers its place's (`explore`), a superset of what its walk would name.
 */
function placeIngress(walk: Consumers, start: PlaceId): IngressNode | undefined {
  const { program } = walk.pass;
  const { unions } = frontiersOf(walk);
  const known = unions.get(start);
  if (known !== undefined) return known ?? undefined;
  const ingress = program.scope.ingress;
  const order = new Map<PlaceId, { readonly index: number; low: number }>();
  const open: PlaceId[] = [];
  // (each member's host data and its closed successors', until its component closes)
  const pendingHost = new Map<PlaceId, IngressNode | undefined>();
  const frames: {
    readonly place: PlaceId;
    readonly edges: ReturnType<typeof placeEdges>;
    next: number;
    host: IngressNode | undefined;
  }[] = [];
  const enter = (place: PlaceId): void => {
    order.set(place, { index: order.size, low: order.size });
    open.push(place);
    const edges = placeEdges(walk, place);
    frames.push({ place, edges, next: 0, host: edges.host });
  };
  enter(start);
  while (frames.length > 0) {
    const frame = frames.at(-1)!;
    program.work.charge("checks");
    const own = order.get(frame.place)!;
    if (frame.next < frame.edges.places.length) {
      const to = frame.edges.places[frame.next++]!;
      const done = unions.get(to);
      if (done !== undefined) frame.host = ingress.union(frame.host, done ?? undefined);
      else if (!order.has(to)) enter(to);
      else own.low = Math.min(own.low, order.get(to)!.index);
      continue;
    }
    frames.pop();
    const parent = frames.at(-1);
    if (own.low === own.index) {
      // (a component: its members' host data and the components they reach, one union for all of them)
      const members: PlaceId[] = [];
      for (let member = open.pop(); member !== undefined; member = open.pop()) {
        program.work.charge("checks");
        members.push(member);
        if (member === frame.place) break;
      }
      let host = frame.host;
      for (const member of members) {
        program.work.charge("checks");
        host = ingress.union(host, pendingHost.get(member));
      }
      for (const member of members) {
        program.work.charge("checks");
        unions.set(member, host ?? null);
        pendingHost.delete(member);
      }
      if (parent !== undefined) parent.host = ingress.union(parent.host, host);
    } else {
      // (inside a component not yet closed: its host data waits for the component's root)
      pendingHost.set(frame.place, frame.host);
      if (parent !== undefined) {
        const above = order.get(parent.place)!;
        above.low = Math.min(above.low, own.low);
      }
    }
  }
  return unions.get(start) ?? undefined;
}

/**
 * The host data a domain read holds after a settled stop (#1432, #1415): its own host ingress and what its bounded walk
 * meets (`explore`), and where the walk is cut its place's component's or its own value's (`cutIngress`), as one
 * external item naming those reads. Nothing below a key whose decision stopped (r4.186).
 */
function heldIngress(walk: Consumers, value: PlaceId, rest: readonly string[]): readonly Item[] {
  const { program, contract, definitions } = walk.pass;
  if (!walk.settled || program.work.stopped === null || definitions.ingress.size === 0) return [];
  if (contract.anyStopped) {
    const key = readKey(walk, value);
    if (
      key === null ||
      walk.admission.decisionStopped(keyPlace(key), joinSteps(keyPath(key), rest))
    ) {
      recordRead(value, rest, () => ({
        guarded: true,
        cut: false,
        writers: new Set(),
        copies: 0,
        depth: 0,
      }));
      return [];
    }
  }
  let at = readFrontier(walk, value);
  for (const step of rest) at = stepOwn(walk, at, step);
  const found = explore(walk, at);
  // (cut, its place's component's host data, or its own value's, holds all its walk met: that one union, shared by
  // every read of the component or the value, so a consumer resolves it once)
  const structural = hostIngress(walk, value)?.[0] ?? null;
  const domain = found.cut ? cutIngress(walk, value) : found.host;
  const node = program.scope.ingress.union(structural?.ingress, domain);
  recordRead(value, rest, () => ({
    guarded: false,
    cut: found.cut,
    writers: new Set(
      node === undefined ? [] : ingressLeaves(node).map((writer) => JSON.stringify(writer)),
    ),
    copies: found.copies,
    depth: found.depth,
  }));
  if (node === undefined) return [];
  const item: Item = { ...unknownItem(REASON.external), ingress: node };
  // (what the stores bring is its mark's content, `Consumers.boundariesAt`, #1448; a host read's own ingress, in it too,
  // forms whatever they hold, TABLE r4.113)
  if (domain !== undefined && structural === null) {
    program.work.charge("checks");
    walk.domainOwned.add(item);
  }
  return [item];
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
  const retained = term === null && walk.settled ? walk.admission.retained(place, path) : null;
  const tags = term !== null ? typeTags(term) : (retained?.tags ?? []);
  // (a written type, or a copy's, keeps its spelling, #1398)
  const spelled = term !== null || retained?.inherited === true ? spelledBy(tags) : {};
  return tags.length === 0 || tags.includes("unknown")
    ? STOPPED
    : tags.map((tag) => makeItem(tag, null, { cert: "pos", ...spelled }));
}

/**
 * A domain read for a requirement that follows from the value's kinds (C10's family; S3 §5 revisions 15, 16): every
 * value in it must give the same requirement. One family without `null` gives it, as possible kinds (a domain proves
 * nothing); `null` only gives none; any other domain leaves it undecided (`STOPPED`: r4.100's mark).
 */
function required(tags: readonly ItemTag[], spelling: Spelling | undefined): readonly Item[] {
  if (tags.length === 0 || tags.includes("unknown")) return STOPPED;
  const families = new Set(
    tags.filter((tag) => tag !== "null").map((tag) => (tag === "integer" ? "number" : tag)),
  );
  if (families.size === 0) return [makeItem("null", null, { cert: "pos" })];
  // (the domain's spelling kept, #1398)
  const spelled = spelling === undefined ? {} : { spelling };
  return families.size === 1 && !tags.includes("null")
    ? tags.map((tag) => makeItem(tag, null, { cert: "pos", ...spelled }))
    : STOPPED;
}

/** What admission retained at a read's key path and `rest`: no kinds, no written type. */
const NONE_RETAINED = { kinds: [], written: false } as const;

/**
 * The admitted type admission retained at a read's key path and `rest`, and whether it is a written type its copies
 * borrow, which keeps its spelling (`Admission.retained`, #1398); else `null`.
 */
function retainedRead(
  walk: Consumers,
  value: PlaceId,
  rest: readonly string[],
): { readonly kinds: readonly ItemTag[]; readonly written: boolean } | null {
  const key = readKey(walk, value);
  const found =
    key === null ? null : walk.admission.retained(keyPlace(key), joinSteps(keyPath(key), rest));
  return found === null ? null : { kinds: found.tags, written: found.inherited };
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
    // (the children's kinds together in their one order, #1398)
    return items.length === 0 ? null : inItsOrder(items);
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

/** The part below a written part that admits every kind (`permittedAt`'s): every kind fits it too. */
const OPEN_PART: TypeTerm = { kind: "dynamic", why: "unwritten parts" };

/** A written type node's openness (#1450): whether it admits every kind, and whether it does at or anywhere below it. */
interface Openness {
  readonly open: boolean;
  readonly below: boolean;
}

const opennessByTerm = new WeakMap<TypeTerm, Openness>();

/** A written type node's parts one level down: a collection's element, an object's properties, a union's members. */
function partsOfTerm(term: TypeTerm): readonly TypeTerm[] {
  if (term.kind === "list" || term.kind === "set" || term.kind === "dict") return [term.element];
  if (term.kind === "object") return term.properties?.map((property) => property.type) ?? [];
  return term.kind === "union" ? term.members : [];
}

/**
 * A written type node's openness, made once per node from its parts' (Codex r2's B2 on #1487): `open` is admission's
 * `unrestricted` (`typeTags`' `unknown`: a part the core leaves open; a union's where one of its members is), `below` also
 * where any part is, or an `object`'s properties are unwritten. An explicit stack, parts first; each node charged once.
 */
function openness(work: WorkLedger, term: TypeTerm): Openness {
  const known = opennessByTerm.get(term);
  if (known !== undefined) return known;
  const pending = [term];
  while (pending.length > 0) {
    const at = pending.at(-1)!;
    if (opennessByTerm.has(at)) {
      pending.pop();
      continue;
    }
    const parts = partsOfTerm(at);
    const unmade = parts.filter((part) => !opennessByTerm.has(part));
    if (unmade.length > 0) {
      for (const part of unmade) pending.push(part);
      continue;
    }
    pending.pop();
    work.charge("checks", 1 + parts.length);
    const below = parts.map((part) => opennessByTerm.get(part)!);
    // (a scalar restricts to its kind; a collection or an object restricts at its own level)
    const open =
      at.kind === "union"
        ? below.some((part) => part.open)
        : !["atom", "list", "set", "dict", "object"].includes(at.kind);
    opennessByTerm.set(at, {
      open,
      below:
        open ||
        (at.kind === "object" && at.properties === null) ||
        below.some((part) => part.below),
    });
  }
  return opennessByTerm.get(term)!;
}

const prefixSteps = new WeakMap<TypeTerm, Map<string, TypeTerm | null>>();

/**
 * The nearest written prefix of a path (#1450): the written type's part at the path, or, below a part that admits every
 * kind (an unwritten element, an `object`'s properties, a union member's), the open part, as admission's `permittedAt`
 * reads it; `null` where the written type does not reach the path. Each step once per node, from the memoized openness.
 */
function prefixAt(work: WorkLedger, term: TypeTerm, path: readonly string[]): TypeTerm | null {
  let at: TypeTerm | null = term;
  for (const step of path) {
    if (at === null || openness(work, at).open) return at;
    at = prefixStep(work, at, step);
  }
  return at;
}

function prefixStep(work: WorkLedger, term: TypeTerm, step: string): TypeTerm | null {
  let steps = prefixSteps.get(term);
  if (steps === undefined) prefixSteps.set(term, (steps = new Map()));
  const known = steps.get(step);
  if (known !== undefined || steps.has(step)) return known ?? null;
  work.charge("checks");
  let below: TypeTerm | null;
  if (openness(work, term).open || (term.kind === "object" && term.properties === null))
    below = OPEN_PART;
  else if (term.kind === "union") {
    const parts = term.members.flatMap((member) => prefixStep(work, member, step) ?? []);
    below = parts.some((part) => openness(work, part).open)
      ? OPEN_PART
      : parts.length === 0
        ? null
        : parts.length === 1
          ? parts[0]!
          : { kind: "union", members: parts };
  } else below = termAt(term, [step]);
  steps.set(step, below);
  return below;
}

const tagsByTerm = new WeakMap<TypeTerm, readonly ItemTag[]>();

/** A written type's kinds (`typeTags`), made and charged once per type a read answers by. */
function writtenTags(work: WorkLedger, term: TypeTerm): readonly ItemTag[] {
  let tags = tagsByTerm.get(term);
  if (tags === undefined) {
    tags = typeTags(term);
    work.charge("checks", tags.length);
    tagsByTerm.set(term, tags);
  }
  return tags;
}
