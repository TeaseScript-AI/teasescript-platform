import type { PlaceId, TypeTerm } from "../../graph.js";
import type { CorePass } from "../answers.js";
import { joinParts, joinSteps, keepText } from "../budget.js";
import type { Contract } from "../contract.js";
import { keyOf } from "../definitions.js";
import { belowSelected, withoutEmpty } from "../exact-path.js";
import { marked } from "../guards.js";
import { EMPTY, makeItem, mergeItems, REASON, STOPPED, type Item } from "../items.js";
import {
  declaredProperty,
  dictList,
  interactionCategory,
  kindElement,
  memberStep,
  measuresLength,
  selectsElement,
} from "../method-categories.js";
import { stepName, type ValueConstraint } from "../program.js";
import type { Demand, Work } from "../solver.js";
import {
  carried,
  emptyAt,
  heldReference,
  ONLY_NULL,
  OWN_SELECTION,
  REFERENCE,
  typedDefault,
  unknownItem,
} from "./kinds.js";
import {
  canonicalRest,
  keyAtRef,
  keyIdAt,
  memberStepIn,
  restPart,
  restRef,
  restSteps,
  type PathRef,
  type Rest,
} from "./key-ids.js";
import { contractOfOp } from "./operations.js";
import { projected } from "./positions.js";
import { defaultOf, termAt, typeKinds, writtenOf } from "./terms.js";

// The kinds a value can have, by its kind and at a path, mirroring the value side's dispatch.

const NESTING = 256;

/**
 * `memberStep`: the first step of `path` from `from` on that a built-in value answers, its scan charged by the text it
 * reads, a unit per eight code units (TABLE r4.58; it keeps nothing, so no text's header), so a long member chain of
 * long names reaches the allowance by its own work.
 */
export function memberStepOf(contract: Contract, path: readonly string[], from: number): number {
  const at = memberStep(path, from);
  let length = 0;
  for (let index = from, end = at < 0 ? path.length : at + 1; index < end; index += 1)
    length += path[index]!.length + 1;
  contract.pass.program.work.charge("invSteps", length >> 3);
  return at;
}

/** The kinds at a path of a value: a literal's field, a copied record's field. */
export function contractOfValueAt(
  contract: Contract,
  value: PlaceId,
  rest: Rest,
): Work<readonly Item[]> {
  return through(contract, value, rest, 0);
}

/**
 * A value's kinds along a path through a member a built-in value answers by itself, from the step `from` on, where
 * the path ends: at a literal or an operation (a projection passes its step to its owner, and a variable or a call its
 * key to `keyThrough`). A dict's `values` is a new list of its values and its `keys` one of text (TABLE r4.46 (2)),
 * either may hold none (no count proof, no `null`); a temporal field or a calendar duration's part gives its declared
 * result (V30 §35); an object's own property of the name is read as any property (F11), and a receiver that may be a
 * reference has the runtime's members (F19a).
 */
function through(
  contract: Contract,
  value: PlaceId,
  rest: Rest,
  from: number,
): Work<readonly Item[]> {
  const { program } = contract.pass;
  // (a read, a projection or a call passes the path on whole, so its member steps are scanned where it ends: a chain of
  // k projections scans its path once, never once per link, S6c)
  if (
    program.occurrenceOf.has(value) ||
    program.projOf.has(value) ||
    program.speakerPlaces.has(value) ||
    program.callOutOf.has(value)
  )
    return valueAt(contract, value, rest);
  // (a span's member step from the arena's nearest member, `memberStepIn`, its span's offset taken off)
  const ref = restRef(contract, rest);
  const at =
    ref.kind === "span"
      ? spanMemberStep(contract, ref, from)
      : memberStepOf(contract, restSteps(rest), from);
  if (at < 0) return valueAt(contract, value, rest);
  return listsAt(contract, value, restSteps(rest), at, from);
}

/** `memberStepOf` for a span: its first member step from `from` on, from the arena (`memberStepIn`), by index. */
function spanMemberStep(contract: Contract, ref: PathRef, from: number): number {
  const id = keyIdAt(0, ref.id());
  return memberStepIn(contract, id, from);
}

/** `through` at the step `at`, the first of `rest` from `from` on that is a dict's `values` or `keys`. */
function* listsAt(
  contract: Contract,
  value: PlaceId,
  rest: readonly string[],
  at: number,
  from: number,
): Work<readonly Item[]> {
  const receiver = yield* through(contract, value, rest.slice(0, at), from);
  // F19a, r4.44: a receiver that may be a reference has the runtime's members, decided once for a whole value
  const decided = at === 0 ? yield* contract.valueReceiver(value) : receiver;
  if (heldReference(decided) || decided.some((item) => REFERENCE.has(item.tag)))
    return yield* through(contract, value, rest, at + 1);
  return yield* members(contract, rest, at, receiver, (path, start) =>
    through(contract, value, path, start),
  );
}

/**
 * The kinds along `path` whose step `at` is a member a built-in value answers by itself, given the receiver's kinds
 * before it, by `read` (a path through such steps from a step on): a dict's lists, a temporal field's or a calendar
 * duration's part's declared result, and an object's own property of the name read as any property.
 */
export function* members(
  contract: Contract,
  path: readonly string[],
  at: number,
  receiver: readonly Item[],
  read: (path: readonly string[], from: number) => Work<readonly Item[]>,
): Work<readonly Item[]> {
  const before = path.slice(0, at);
  const after = path.slice(at + 1);
  const out: Item[] = [];
  let own = false;
  const step = path[at]!;
  for (const item of withoutEmpty(receiver)) {
    const declared = declaredProperty(item.tag, step);
    if (item.tag === "dict" && dictList(step) !== undefined) {
      if (after.length === 0) out.push(carried(makeItem("list", item.writer), [item]));
      else if (after[0] === "element") {
        // the list's own selection takes its own emptiness (open); a deeper selection's marker is that selection's
        if (dictList(step) === "values") {
          const below = yield* read(joinSteps(before, after), at);
          out.push(...(after.length === 1 ? withoutEmpty(below) : below));
        } else if (after.length === 1)
          // a key is text, possible: no literal holds a derived list's element (r4.47, P3)
          out.push(carried(makeItem("string", item.writer, { cert: "pos" }), [item]));
        if (after.length === 1) out.push(EMPTY);
      }
    } else if (declared !== undefined) {
      // a temporal field or a calendar duration's part: its declared result (V30 §35)
      if (after.length === 0) out.push(carried(makeItem(declared, item.writer), [item]));
    } else if (item.tag === "object") own = true;
    else if (item.tag === "unknown") out.push(item);
  }
  if (own) out.push(...(yield* read(path, at + 1)));
  return mergeItems(out, contract.pass.program.scope);
}

/** The kinds at a path of a value, by the value's kind. */
function* valueAt(contract: Contract, value: PlaceId, rest: Rest): Work<readonly Item[]> {
  if (!contract.pass.solver.enterRead()) return STOPPED;
  try {
    // (a cursor's span read by its path's id, its key a cursor and a literal's demand named by it: G3 stage 1)
    const ref = restRef(contract, rest);
    if (ref.length === 0) return yield* contract.contractOfValue(value);
    const { program, guards } = contract.pass;
    program.work.charge("invSteps");
    if (program.speakerPlaces.has(value)) return [unknownItem(REASON.opaque)];
    const binding = program.occurrenceOf.get(value);
    if (binding !== undefined) {
      const items = contract.entered(
        value,
        yield* contract.contractOf(keyAtRef(contract, binding, ref)),
      );
      // §3.2: the mark travels with the value (r4.6): none of a binding no test names
      return !guards.untested(binding) && guards.guardedRead(value, ref.steps())
        ? marked(items)
        : items;
    }
    const projection = program.projOf.get(value);
    if (projection !== undefined) {
      if (projection.step === "iteration")
        return yield* contractIteration(contract, projection.owner, ref.steps());
      if (measuresLength(projection.step))
        return yield* contractLength(contract, projection.owner, projection.step, ref.steps());
      const elements = yield* contract.contractOfValueAt(
        projection.owner,
        ref.kind === "span"
          ? ref.after([stepName(projection.step)])
          : joinSteps([stepName(projection.step)], ref.steps()),
      );
      if (!selectsElement(projection.step)) return elements;
      const owners = withoutEmpty(yield* contract.contractOfValue(projection.owner));
      return withOwnSelection(elements, owners, contract.pass);
    }
    if (program.callOutOf.has(value))
      return yield* contract.contractOf(keyAtRef(contract, resultOf(contract, value), ref));
    // a literal's contract at a path once per literal and path, whatever asks: a selection nested k deep reads each
    // level's literal once, its answer composed from the level inside's, never again per level above (#1426)
    if (program.hasOf.has(value) || program.cellOwner.has(value)) {
      const site = program.places[value]?.site ?? null;
      // (the rest in its identity: a wrapper's own literal asked by an array, at its cursor's span, G3 stage 1)
      const at = canonicalRest(contract, value, rest);
      const demand: Demand = {
        key: joinParts("cl", value, restPart(at)),
        kind: "contract",
        file: site?.file ?? -1,
        offset: site?.start ?? -1,
        make: () => contract.contractOfLiteral(value, at),
      };
      return yield demand;
    }
    const operation = program.opOf.get(value);
    if (operation === undefined) return [unknownItem(REASON.opaque)];
    // a choice's answer at a path once per choice and path, whatever asks: the key's contract and A5's candidate test of
    // the choice's own entry read it alike (S6-CARRIERS §4.5, Astra r6 B2), as `contractOfValue` reads an operation
    if (
      operation.kind === "operation" &&
      operation.contract.family === "interaction" &&
      interactionCategory(operation.contract.name)?.kind === "options"
    ) {
      const site = program.places[value]?.site ?? operation.site;
      const demand: Demand = {
        key: joinParts("cop", value, restPart(rest)),
        kind: "contract",
        file: site.file,
        offset: site.start,
        make: () => contractOfOp(contract, operation, ref.steps()),
      };
      return contract.entered(value, yield demand);
    }
    return contract.entered(value, yield* contractOfOp(contract, operation, ref.steps()));
  } finally {
    contract.pass.solver.leaveRead();
  }
}

/** The kinds a value can have at any point, mirroring the value side's dispatch. */
export function* contractOfValue(contract: Contract, value: PlaceId): Work<readonly Item[]> {
  if (!contract.pass.solver.enterRead()) return STOPPED;
  try {
    const { program, guards } = contract.pass;
    program.work.charge("invSteps");
    if (program.speakerPlaces.has(value)) return [unknownItem(REASON.opaque)];
    const binding = program.occurrenceOf.get(value);
    if (binding !== undefined) {
      const items = contract.entered(value, yield* contract.contractOf(keyOf(binding, [])));
      // §3.2: the mark travels with the value (r4.6)
      return guards.guardedRead(value) ? marked(items) : items;
    }
    const projection = program.projOf.get(value);
    if (projection !== undefined) {
      // a property read, a loop's visit, a length
      if (projection.step === "iteration")
        return yield* contractIteration(contract, projection.owner, []);
      if (measuresLength(projection.step))
        return yield* contractLength(contract, projection.owner, projection.step, []);
      if (!selectsElement(projection.step))
        // G3 (TABLE r4.164): a property or index read's contract once per occurrence, its owner's one step down,
        // whatever asks: a chain of k such reads of nested literals asks each link once, never once per read above
        // (and once per stop: `stop` forgets it)
        return yield projected(contract, value, projection);
      // S6c: a selection reads its owner twice, at its step and whole, so once per value, whatever asks: a chain of k
      // `.first` reads each link once whole, never each link 2^k times
      const site = program.places[value]?.site ?? null;
      const demand: Demand = {
        key: joinParts("cpj", value),
        kind: "contract",
        file: site?.file ?? -1,
        offset: site?.start ?? -1,
        make: () => selection(contract, projection),
      };
      return yield demand;
    }
    if (program.callOutOf.has(value))
      return yield* contract.contractOf(keyOf(resultOf(contract, value), []));
    const operation = program.opOf.get(value);
    // once per operation, whatever asks
    if (operation !== undefined) {
      const site = program.places[value]?.site ?? operation.site;
      const demand: Demand = {
        key: joinParts("cop", value),
        kind: "contract",
        file: site.file,
        offset: site.start,
        make: () => contractOfOp(contract, operation, []),
      };
      return contract.entered(value, yield demand);
    }
    if (program.hasOf.has(value) || program.cellOwner.has(value))
      return yield* contract.contractOfLiteral(value, []);
    if (program.isHost(value)) return [unknownItem(REASON.external)];
    return yield* contract.contractOf(keyOf(value, []));
  } finally {
    contract.pass.solver.leaveRead();
  }
}

/** An element selection's kinds (`contractOfValue`): its owner's at the step, with the owner's own selection. */
function* selection(
  contract: Contract,
  projection: { readonly owner: PlaceId; readonly step: string },
): Work<readonly Item[]> {
  const elements = yield* contract.contractOfValueAt(projection.owner, [stepName(projection.step)]);
  const owners = withoutEmpty(yield* contract.contractOfValue(projection.owner));
  return withOwnSelection(elements, owners, contract.pass);
}

/** The result place of a call's value (F20). */
export function resultOf(contract: Contract, value: PlaceId): PlaceId {
  const call = contract.pass.program.opOf.get(value);
  if (call?.kind !== "call") throw new Error(`The value ${value} is no call's result.`);
  return contract.pass.program.functionOf(call.fn).result;
}

/** F27: a loop visits a list's or a set's elements, a dict's keys, a range's whole numbers. */
function* contractIteration(
  contract: Contract,
  owner: PlaceId,
  rest: readonly string[],
): Work<readonly Item[]> {
  const out: Item[] = [];
  for (const item of withoutEmpty(yield* contract.contractOfValue(owner))) {
    if (item.tag === "list" || item.tag === "set")
      out.push(
        ...belowSelected(
          yield* contract.contractOfValueAt(owner, joinSteps(["element"], rest)),
          rest,
        ),
      );
    else if ((item.tag === "dict" || kindElement(item.tag) !== undefined) && rest.length === 0)
      out.push(
        carried(makeItem(item.tag === "dict" ? "string" : kindElement(item.tag)!, item.writer), [
          item,
        ]),
      );
    // (an unknown's element: a collection below it may hold none)
    else if (item.tag === "unknown") out.push(item, ...emptyAt(rest));
  }
  return mergeItems(out, contract.pass.program.scope);
}

/** F14: a text's or a collection's length is a whole number; an object's own `length` is its property (F11). */
function* contractLength(
  contract: Contract,
  owner: PlaceId,
  step: string,
  rest: readonly string[],
): Work<readonly Item[]> {
  // F19a before F14: a receiver that may be a reference has the runtime's members, its `length` among them
  if (heldReference(yield* contract.valueReceiver(owner)))
    return yield* contract.contractOfValueAt(owner, joinSteps([step], rest));
  const out: Item[] = [];
  for (const item of withoutEmpty(yield* contract.contractOfValue(owner))) {
    if (item.tag === "string" || item.tag === "list" || item.tag === "set" || item.tag === "dict") {
      if (rest.length === 0) out.push(carried(makeItem("integer", item.writer), [item]));
    } else if (item.tag === "object" || REFERENCE.has(item.tag))
      // an object's own `length` (F11), a reference's member (F19a)
      out.push(...(yield* contract.contractOfValueAt(owner, joinSteps([step], rest))));
    else if (item.tag === "unknown") out.push(item);
  }
  return mergeItems(out, contract.pass.program.scope);
}

/**
 * F18: a load's or `fromJson`'s expected type, possible: the declared type, or the written type of the place its
 * value lands in directly (V30 §12); an untyped load's at a property its default lacks, stored data that may be absent,
 * and at one below a collection, its default's kinds beside `missing`; `null` without one.
 */
export function* expectedOf(
  contract: Contract,
  c: ValueConstraint,
  rest: readonly string[],
): Work<readonly Item[] | null> {
  const written = (c.kind === "load" ? c.receiver : null) ?? contract.landsIn(c.result, []);
  if (written === null && c.kind === "load" && c.fallback !== null && rest.length > 0) {
    const named = yield* contract.defaultKinds(c.fallback, rest);
    const kinds = withoutEmpty(named);
    // (a stored object keeps every property it holds, `matchesValueType`, one its default lacks too: stored data there,
    // which may be absent, ADR 0021 1.8, its own `missing` owing the check (#1459). `#`, the presence rule's property no
    // literal lists (`unlistedObject`), keeps the default's answer: the reader fills each property the default lists)
    if (
      rest.at(-1) !== "#" &&
      kinds.length > 0 &&
      kinds.every((item) => item.tag === "unknown" && item.reasons === REASON.missing)
    )
      return [unknownItem(REASON.external | REASON.missing), ...emptyAt(rest)];
    // (a stored value's reader keeps an element of a collection that fits as it is, `matchesValueType`, so it may lack
    // a property the default's element has; the root object and the objects nested in it take it from the default, and
    // JSON's reader every level: #1458, the lead's ruling on Codex r3's N2)
    if (rest.includes("element") && rest.at(-1) !== "element")
      return [...named, unknownItem(REASON.missing)];
  }
  if (written === null) return null;
  const term = termAt(written, rest);
  const fallback = c.kind === "load" ? (c.fallback ?? undefined) : defaultOf(c);
  // V30 §13 (JSON): below a written `object` the value keeps every key, and has each one its default names, of the
  // default's type, where its reader takes a missing or misfitting key from the default: JSON's at every level, a stored
  // value's in its root object and the objects nested in it, never in an element of a collection, which a stored value
  // keeps as it is when it fits (`matchesValueType`). There the default answers (#1436; the lead's ruling on r2's B1)
  if (
    term === null &&
    fallback !== undefined &&
    (c.kind !== "load" || !rest.includes("element")) &&
    belowObject(written, rest)
  ) {
    const named = withoutEmpty(yield* contract.defaultKinds(fallback, rest));
    if (
      named.length > 0 &&
      !named.some((item) => item.tag === "unknown" && (item.reasons & REASON.missing) !== 0)
    )
      return [...named, ...emptyAt(rest)];
  }
  const nullDefault =
    rest.length === 0 && fallback !== undefined && (yield* contract.onlyNull(fallback)).length > 0;
  return [
    ...(term === null ? ["unknown" as const] : typeKinds(term)).map((tag) =>
      tag === "unknown" ? unknownItem(REASON.external) : makeItem(tag, null, { cert: "pos" }),
    ),
    ...(nullDefault ? [makeItem("null", null, { cert: "pos" })] : []),
    ...emptyAt(rest),
  ];
}

/** Whether a level of `written` above `rest`'s end admits any object (`object`, `object?`), which keeps every key. */
function belowObject(written: TypeTerm, rest: readonly string[]): boolean {
  let at: TypeTerm | null = written;
  for (const step of rest) {
    if (typeKinds(at).includes("object")) return true;
    at = termAt(at, [step]);
    if (at === null) return false;
  }
  return false;
}

/** The kinds a `load` or `fromJson` takes from its default at `rest` (`typedDefault`), on the default's contract. */
export function* defaultKinds(
  contract: Contract,
  fallback: PlaceId,
  rest: readonly string[],
): Work<readonly Item[]> {
  const site = contract.pass.program.places[fallback]?.site ?? null;
  return yield {
    key: joinParts("dk", fallback, rest),
    kind: "contract",
    file: site?.file ?? -1,
    offset: site?.start ?? -1,
    make: () => contract.contractOfValueAt(fallback, rest),
    decision: typedDefault(rest, false),
  };
}

/** F19 (r4.1): whether a default holds only `null` (or nothing), by its contract (`ONLY_NULL`). */
export function* onlyNull(contract: Contract, fallback: PlaceId): Work<readonly Item[]> {
  const site = contract.pass.program.places[fallback]?.site ?? null;
  return yield {
    key: joinParts("dn", fallback),
    kind: "contract",
    file: site?.file ?? -1,
    offset: site?.start ?? -1,
    make: () => contract.contractOfValue(fallback),
    decision: ONLY_NULL,
  };
}

/**
 * V30 §18: the written type a value lands in directly at a path, also as an element of literals or through a
 * fallback or default (A1, C10, F18); a lookup cut by the nesting limit is an unknown destination, never memoised.
 */
export function landsIn(
  contract: Contract,
  value: PlaceId,
  path: readonly string[],
  depth = 0,
): TypeTerm | null {
  if (depth >= NESTING) return CUT;
  const { program, definitions } = contract.pass;
  const memoKey = joinParts(value, path);
  if (contract.lands.has(memoKey)) return contract.lands.get(memoKey)!;
  keepText(contract.work, memoKey.length);
  contract.lands.set(memoKey, null);
  const keep = (found: TypeTerm | null): TypeTerm | null => {
    if (found === CUT) contract.lands.delete(memoKey);
    else contract.lands.set(memoKey, found);
    return found;
  };
  try {
    for (const d of definitions.byValue.get(value) ?? []) {
      program.work.charge("checks");
      const written = d.kind === "whole" ? writtenOf(program.place(d.place).kind) : null;
      const term = written === null ? null : termAt(written, joinSteps(d.path, path));
      if (term !== null) return keep(term);
      const owner = program.cellOwner.get(d.place);
      if (owner?.kind === "cell") {
        const found = contract.landsIn(owner.owner, joinSteps(["element"], path), depth + 1);
        if (found !== null) return keep(found);
      }
    }
    const operation = definitions.fallbackOf.get(value);
    return keep(operation === undefined ? null : contract.landsIn(operation, path, depth + 1));
  } catch (error) {
    // (a stop inside the lookup leaves no provisional answer behind for the finishing path to read)
    contract.lands.delete(memoKey);
    throw error;
  }
}

/** The lookup cut by the nesting limit: an unknown destination (V30 §18). */
const CUT: TypeTerm = { kind: "dynamic", why: "unknown member" };

/**
 * F11 (r4.4): the collector reads an object's own `first`, `last` or `random` as an element selection; the core makes it
 * opaque, beside the element where the owner may also be a collection.
 */
export function withOwnSelection(
  elements: readonly Item[],
  owners: readonly Item[],
  pass: CorePass,
): readonly Item[] {
  if (!owners.some((item) => item.tag === "object")) return elements;
  if (owners.every((item) => item.tag === "object")) return [OWN_SELECTION];
  return mergeItems([...elements, OWN_SELECTION], pass.program.scope);
}
