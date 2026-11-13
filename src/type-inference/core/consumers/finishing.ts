import type { PlaceId, TypeTerm } from "../../graph.js";
import { concrete, isExternal } from "../admission.js";
import type { CorePass } from "../answers.js";
import { joinSteps, keptParts, keptSlice } from "../budget.js";
import type { Consumers } from "../consumers.js";
import { defaultOf, termAt, typedDefault, typeTags, unknownItem, writtenOf } from "../contract.js";
import { isKeyId, keyOfId } from "../contract/key-ids.js";
import { keyPath, keyPlace, type Definition, type Key } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import {
  EMPTY,
  inItsOrder,
  makeItem,
  REASON,
  spelledBy,
  spellingOf,
  STOPPED,
  type Item,
  type ItemTag,
  type Spelling,
} from "../items.js";
import { conversionCategory } from "../method-categories.js";
import { stepName } from "../program.js";
import type { Work } from "../solver.js";
import { stands } from "./stores/fresh.js";
import { LITERALS, unsettledItem } from "./kinds.js";
import { readKey } from "./names.js";
import { placelessCells, syntaxRead } from "./syntax.js";
import { heldIngress, hostIngress } from "./host-frontier.js";
import { openness, prefixAt, writtenTags } from "./written-openness.js";

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
 * route's questions: one derivation with the consumers'.
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
 * A read in the finishing path (D4 a′; S3 §5 revision 14), answered from the retained
 * state only, the first source that decides it winning: a leaf's own kind (`leafKind`), which no proof decides (an
 * error found there stands, a host read's boundary check forms); the read itself, then its key's contract, as the analysis had finished them before the stop (`run`:
 * the solver answers only from what had finished); the admitted type admission retained at its key's path (written,
 * decided, or a copy's through the copy forest, `Admission.retained`); what the stores' syntax decides there
 * at a settled stop (`cheapDecided`, source 4); `STOPPED` (`unknown` with the reason `budget`) only where
 * none of these decides it, so its consumer owes its check when the script runs. Only a leaf's kind and the
 * read's own answer are the value at the read; the key's contract, the written and the retained type are domains,
 * what the key may hold over all its stores (revisions 15, 16): read as the value for a fixed need,
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
  // later sources give and a host read's ingress, as unstopped each child is its own value; together in
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
  // (a projection of a literal no place holds, its own answer unfinished: the literal's cells along its steps, each its
  // own value as above, `placelessCells`, as the stores' syntax takes them, #1563; together in their one order, #1398)
  const cells = placelessCells(walk, value);
  const exact = cells === null ? null : finishedAnswer(walk, value, node, rest);
  const read: Item[] = [];
  for (const cell of exact === null ? (cells ?? []) : [])
    if (cell.value !== undefined && stands(walk, cell))
      read.push(...finishingRead(walk, cell.value, cell.node ?? node, rest, requirement));
  const items =
    exact ??
    (read.length > 0 ? inItsOrder(read) : laterSources(walk, value, node, rest, requirement));
  // (a host read's ingress is structural whatever the script stores into its global: its C9 boundary forms from it,
  // beside the kinds the later sources give)
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
      // (one item per kind the written type spells, with its spelling, #1398)
      const { spelling } = spelledBy(term === null ? [] : typeTags(term));
      found =
        spelling.length === 0
          ? null
          : spelling.map((tag) => makeItem(tag, null, { cert: "def", spelling }));
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
        // call's result) by its read's finished answer, else by its domain (its written, contract or retained type)
        // only where one kind no narrower kind refines decides it: a domain is not the value (an
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
  // (a requirement: from the first domain that decides it, each holding the value; the next asked where one holds
  // several families or `unknown`, #1563)
  const decided =
    held !== null && requirement
      ? required(
          withoutEmpty(held).map((item) => item.tag),
          spellingOf(held),
        )
      : STOPPED;
  if (decided !== STOPPED) return decided;
  if (held !== null && !requirement) {
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
  // (the typed or retained domain's spelling, where a written type or a copy of one gives it, #1398)
  const own: Spelling | undefined =
    typed !== null
      ? spellingOf(typed)
      : retained.written
        ? spelledBy(retained.kinds).spelling
        : undefined;
  // (a requirement follows from the concrete kinds alone, as unstopped, where external data decides none: the stores'
  // syntax asked where this domain leaves it undecided, as above)
  if (requirement) {
    const found = required(typedTags ?? retained.kinds, own);
    if (found !== STOPPED || typedTags !== null) return found;
    const syntax = syntaxRead(walk, value, rest);
    return required(syntax?.kinds ?? [], syntax?.spelling);
  }
  // else, at a settled stop, the stores' syntax (source 4,
  // docs/specifications/type-inference-accepted-record/stops-and-finishing.md#r4-135): every store's syntax decides the
  // key together
  const syntax =
    typedTags === null && retained.kinds.length === 0 ? syntaxRead(walk, value, rest) : null;
  const tags = typedTags ?? (retained.kinds.length > 0 ? retained.kinds : (syntax?.kinds ?? []));
  // (the domain's spelling where a written type, a copy of one or the stores' syntax by one gives it, #1398)
  const spelling: Spelling | undefined =
    typedTags !== null || retained.kinds.length > 0 ? own : syntax?.spelling;
  // (an admitted or a syntax domain holds the host data its key's stores hold there, as the unstopped read does: its
  // consumer owes its check for that data, and its boundaries form from it, #1432, #1415; so does a written domain whose
  // nearest written prefix admits every kind, above)
  const prefix = read === null ? null : prefixAt(program.work, read, rest);
  const host =
    typedTags === null && (prefix === null || openness(program.work, prefix).open)
      ? heldIngress(walk, value, rest)
      : [];
  if (tags.length === 0 || tags.includes("unknown")) return [...STOPPED, ...host];
  // (one item per kind, with the domain's spelling)
  const spelled = spelling === undefined ? {} : { spelling };
  const items = [
    ...[...new Set(tags)].map((tag) => makeItem(tag, null, { cert: "pos", ...spelled })),
    ...host,
  ];
  // (read as the value for a fixed need, a domain says nothing of emptiness: its collection may be empty, C6)
  const step = rest.at(-1) ?? walk.pass.program.projOf.get(value)?.step;
  return step !== undefined && stepName(step) === "element" ? [...items, EMPTY] : items;
}

/**
 * A domain's external items as a read's (#1448): what its key's stores hold, so a consumer's boundary requests for them
 * are the content of the warning that owns them (`Consumers.boundariesAt`). Each is a copy kept in `domainOwned`; a solver
 * item, which other reads share, stays as it is. A host read's stay unmarked: its own host ingress is in them, and that
 * boundary forms whatever its stores hold.
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

/**
 * A key's read in the finishing path (a store's receiver), from the same retained state as `finishingRead`: its own
 * finished answer at the node; else, domains, its finished contract and its written or retained admitted type (S3 §5
 * revisions 14, 16); `STOPPED` where none decides it. A receiver the retained state decides keeps its shape, so a store
 * into a property no source has keeps its error at the literal.
 */
export function finishingKeyRead(walk: Consumers, key: Key, node: FlowNode): readonly Item[] {
  const { program } = walk.pass;
  // (a host global holds its own external data where the script stores at no path at or above the key, as its reads
  // do: `leafKind`; that data is there whatever it stores, so its C9 boundary forms)
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
  const { values, program } = walk.pass;
  const items = program.work.stopped === null ? null : walk.run(values.keyItems(key, node));
  return items === null || items.some(unsettledItem) ? keyDomain(walk, key) : items;
}

/**
 * A key's domain in the finishing path (S3 §5 revisions 14, 16): its finished contract, else its written or retained
 * admitted type, `STOPPED` where none decides it: a receiver's read (`finishingKeyRead`).
 */
function keyDomain(walk: Consumers, key: Key): readonly Item[] {
  const { contract, program } = walk.pass;
  const found = walk.run(contract.contractOf(key));
  if (!found.some(unsettledItem)) return found;
  const text = isKeyId(key) ? keyOfId(contract, key) : key;
  const [place, path] = [keyPlace(text), keyPath(text)];
  const written = writtenOf(program.place(place).kind);
  const term = written === null ? null : termAt(written, path);
  const retained = term === null && walk.settled ? walk.admission.retained(place, path) : null;
  const tags = term !== null ? typeTags(term) : (retained?.tags ?? []);
  // (a written type, or a copy's, keeps its spelling, #1398)
  const spelled = term !== null || retained?.inherited === true ? spelledBy(tags) : {};
  return tags.length === 0 || tags.includes("unknown")
    ? STOPPED
    : [...new Set(tags)].map((tag) => makeItem(tag, null, { cert: "pos", ...spelled }));
}

/**
 * After a program stop, the kinds a label's step is spelled from where the key's contract asked then is unsettled, and
 * the proof they rest on (#1595, the lead's ruling on its HEAD 0): the key's finished contract; else its
 * written type; else, at a settled stop, what admission retained where that is a decision or a written kind (A1, A2,
 * A4, a copy's source's among them), proved by the stopped analysis itself. Never an open answer (`unknown`, every kind
 * fitting) nor a path no decision retains (a stopped one's): `null` there, and the label keeps its generic step.
 */
export function labelDomain(
  walk: Consumers,
  key: Key,
): {
  readonly kinds: readonly Item[];
  readonly source: "contract" | "written" | "retained";
} | null {
  const { contract, program } = walk.pass;
  const found = walk.run(contract.contractOf(key));
  if (!found.some(unsettledItem)) return { kinds: found, source: "contract" };
  const text = isKeyId(key) ? keyOfId(contract, key) : key;
  const [place, path] = [keyPlace(text), keyPath(text)];
  const written = writtenOf(program.place(place).kind);
  const term = written === null ? null : termAt(written, path);
  const decided =
    term !== null
      ? { tags: typeTags(term), source: "written" as const }
      : walk.settled
        ? { tags: walk.admission.retained(place, path)?.tags ?? [], source: "retained" as const }
        : null;
  if (decided === null || decided.tags.length === 0 || decided.tags.includes("unknown"))
    return null;
  return {
    kinds: [...new Set(decided.tags)].map((tag) => makeItem(tag, null, { cert: "pos" })),
    source: decided.source,
  };
}

/**
 * A domain read for a requirement that follows from the value's kinds (C10's family; S3 §5 revisions 15, 16): every
 * value in it must give the same requirement. One family without `null` gives it, as possible kinds (a domain proves
 * nothing); `null` only gives none; any other domain leaves it undecided (`STOPPED`).
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
 * A leaf's own kind (S3 §5 revision 18): a literal's own kind at the read (a scalar's, a collection
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
  // (a host read: its kinds only where the script stores at no path at or above the read's own)
  const ingress = hostIngress(walk, value);
  const key = ingress === null ? null : readKey(walk, value);
  return key !== null && !storedAbove(walk, keyPlace(key), joinSteps(keyPath(key), rest))
    ? ingress
    : null;
}

/**
 * The host data a value holds at every element depth of its own literals (`[hostValue]`, `[[hostValue]]`): each host
 * read's own ingress there (`leafKind`), the literals walked once by their own structure. A mark at a default stands in
 * for its check at every depth, so its host data meets its boundaries with it.
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
 * does not replace the value read there), each global's stored paths found once (`leafKind`).
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
