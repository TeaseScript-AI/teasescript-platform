import type { PlaceId, TypeTerm } from "../../graph.js";
import { concrete, isExternal } from "../admission.js";
import { expand, partOf } from "../admission/walk.js";
import type { Expansion } from "../admission/model.js";
import type { CorePass } from "../answers.js";
import { joinSteps, keptParts, keptSlice, keptSteps, NESTING_LIMIT } from "../budget.js";
import type { Consumers } from "../consumers.js";
import { defaultOf, termAt, typedDefault, typeTags, unknownItem, writtenOf } from "../contract.js";
import {
  keptKey,
  keptKeyBelow,
  keptPath,
  keyPath,
  keyPlace,
  type Definition,
  type Key,
} from "../definitions.js";
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

/** Per walk, the host data each key holds by its stores' structure (`heldIngress`), `null` for none. */
const heldByKey = new WeakMap<Consumers, Map<Key, IngressNode | null>>();

/**
 * At a settled program stop, the host data a read's key may hold over all its stores (S3 §5 revision 16: a domain is
 * what the key may hold over all its stores; TABLE r4.113: ingress is structural): the read's own host ingress, and each
 * host read a store into the key or a key above it holds at the read's path, through the literals and carriers that
 * hold it (admission's store walk, `expand`) and the copies of other places, as one external item naming those reads;
 * none where no store holds host data there, nor at a key whose decision stopped. Each key once a walk, its copies'
 * keys first (a cycle of copies answered again where it is met, as `resolve` does); a path past the nesting limit is not
 * followed.
 */
function heldIngress(walk: Consumers, value: PlaceId, rest: readonly string[]): readonly Item[] {
  const { program } = walk.pass;
  if (!walk.settled || program.work.stopped === null) return [];
  const key = readKey(walk, value);
  if (key === null) return [];
  const top = keptKeyBelow(program.work, key, rest);
  const path = keptPath(program.work, top);
  // (a read of a key whose decision stopped answers that stop alone, as unstopped: S3 §5, r4.186)
  if (walk.admission.decisionStopped(keyPlace(top), path)) return [];
  let memo = heldByKey.get(walk);
  if (memo === undefined) heldByKey.set(walk, (memo = new Map()));
  const ingress = program.scope.ingress;
  const own = hostIngress(walk, value)?.[0]?.ingress;
  const frames: {
    readonly key: Key;
    readonly copies: readonly (readonly [PlaceId, readonly string[]])[];
    next: number;
    node: IngressNode | undefined;
    cyclic: boolean;
  }[] = [];
  const open = new Set<Key>();
  const enter = (at: Key, place: PlaceId, steps: readonly string[]): void => {
    open.add(at);
    const { node, copies } = heldBy(walk, place, steps);
    frames.push({ key: at, copies, next: 0, node, cyclic: false });
  };
  let found = memo.get(top);
  if (found === undefined) {
    enter(top, keyPlace(top), path);
    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      program.work.charge("checks");
      if (frame.next < frame.copies.length) {
        const [place, steps] = frame.copies[frame.next++]!;
        if (steps.length > NESTING_LIMIT) continue;
        const at = keptKey(program.work, place, steps);
        const done = memo.get(at);
        if (done !== undefined) frame.node = ingress.union(frame.node, done ?? undefined);
        else if (open.has(at)) frame.cyclic = true;
        else enter(at, place, steps);
        continue;
      }
      frames.pop();
      open.delete(frame.key);
      if (!frame.cyclic) memo.set(frame.key, frame.node ?? null);
      const parent = frames.at(-1);
      if (parent === undefined) found = frame.node ?? null;
      else {
        parent.node = ingress.union(parent.node, frame.node);
        parent.cyclic ||= frame.cyclic;
      }
    }
  }
  const node = ingress.union(own, found ?? undefined);
  return node === undefined ? [] : [{ ...unknownItem(REASON.external), ingress: node }];
}

/**
 * What the stores into a place at a path or above it hold there, by admission's own store walk along the path (a
 * literal's cell at its step, a carrier's operands and own contribution at the same path): the host reads' ingress, and
 * the copies of other places, each with the path read into it; nothing at a key whose decision stopped.
 */
function heldBy(
  walk: Consumers,
  place: PlaceId,
  path: readonly string[],
): {
  readonly node: IngressNode | undefined;
  readonly copies: readonly (readonly [PlaceId, readonly string[]])[];
} {
  const { program, definitions, lists } = walk.pass;
  let node: IngressNode | undefined;
  const copies: [PlaceId, readonly string[]][] = [];
  // (a copy of a key whose decision stopped reads that stop, as unstopped: S3 §5, r4.186)
  if (walk.admission.decisionStopped(place, path)) return { node, copies };
  for (const { key, depth } of definitions.stored.along(place, path, true))
    for (const d of definitions.byKey.get(key) ?? []) {
      program.work.charge("checks");
      if ((d.kind !== "whole" && d.kind !== "add") || d.value === undefined || !lists.live(d))
        continue;
      // (an add stores at its receiver's element; an `addAll`'s value is a list of the elements it adds)
      const from = depth + (d.kind === "add" && d.how !== "elements" ? 1 : 0);
      if (from > depth && path[depth] !== "element") continue;
      const below = keptSlice(program.work, path, from);
      const tasks: [Expansion, number][] = [[expand(walk.admission, d.value, d.node, []), 0]];
      while (tasks.length > 0) {
        const [task, at] = tasks.pop()!;
        program.work.charge("checks");
        if (task.stop?.list === "values") {
          const host = hostIngress(walk, task.value);
          const copied = host === null ? readKey(walk, task.value) : null;
          if (host !== null) node = program.scope.ingress.union(node, host[0]?.ingress);
          else if (copied !== null)
            copies.push([
              keyPlace(copied),
              keptSteps(
                program.work,
                keptPath(program.work, copied),
                task.stop.strip,
                keptSlice(program.work, below, at),
              ),
            ]);
        }
        for (const part of task.parts)
          if (part.step === null) tasks.push([partOf(walk.admission, part), at]);
          else if (at < below.length && part.step === below[at])
            tasks.push([partOf(walk.admission, part), at + 1]);
      }
    }
  return { node, copies };
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
