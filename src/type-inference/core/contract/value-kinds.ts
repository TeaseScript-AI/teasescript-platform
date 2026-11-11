import type { PlaceId, TypeTerm } from "../../graph.js";
import type { CorePass } from "../answers.js";
import { joinParts, joinSteps, keepText } from "../budget.js";
import type { Contract } from "../contract.js";
import { heldAsIs, type FlowSink } from "./contributions.js";
import { keyOf } from "../definitions.js";
import { belowSelected, withoutEmpty } from "../exact-path.js";
import { marked } from "../indexes/guards.js";
import { EMPTY, makeItem, mergeItems, REASON, spelledBy, STOPPED, type Item } from "../items.js";
import {
  declaredProperty,
  dictList,
  interactionCategory,
  kindElement,
  measuresLength,
  selectsElement,
} from "../method-categories.js";
import { stepName, type ValueConstraint } from "../program.js";
import { inline, type Demand, type Work } from "../solver.js";
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
  memberStepOf,
  restPart,
  restRef,
  restSteps,
  stepsArray,
  stepsFrom,
  stepsJoin,
  stepsRest,
  stepsTo,
  type PathRef,
  type Rest,
  type Steps,
} from "./key-ids.js";
import { contractOfOp } from "./operations.js";
import { projected } from "./positions.js";
import { defaultOf, termAt, typeKinds, writtenDefault, writtenOf } from "./terms.js";

// The kinds a value can have, by its kind and at a path, mirroring the value side's dispatch.

const NESTING = 256;

/** The kinds at a path of a value: a literal's field, a copied record's field. */
export function contractOfValueAt(
  contract: Contract,
  value: PlaceId,
  rest: Rest,
  flow: FlowSink | null = null,
): Work<readonly Item[]> {
  return through(contract, value, rest, 0, flow);
}

/**
 * A value's kinds along a path through a member a built-in value answers by itself, from the step `from` on, where
 * the path ends: at a literal or an operation (a projection passes its step to its owner, and a variable or a call its
 * key to `keyThrough`). A dict's `values` is a new list of its values and its `keys` one of text,
 * either may hold none (no count proof, no `null`); a temporal field or a calendar duration's part gives its declared
 * result (V30 §35); an object's own property of the name is read as any property (F11), and a receiver that may be a
 * reference has the runtime's members (F19a).
 */
function through(
  contract: Contract,
  value: PlaceId,
  rest: Rest,
  from: number,
  flow: Flow = null,
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
    return valueAt(contract, value, rest, flow);
  // (a span's member step from its path's steps, made once per path and kept, `memberStepIn`)
  const ref = restRef(contract, rest);
  const at =
    ref.kind === "span"
      ? spanMemberStep(contract, ref, from)
      : memberStepOf(contract, restSteps(rest), from);
  if (at < 0) return valueAt(contract, value, rest, flow);
  return listsAt(contract, value, restSteps(rest), at, from, flow);
}

/** `memberStepOf` for a span: its first member step from `from` on, from its path's kept steps (`memberStepIn`). */
function spanMemberStep(contract: Contract, ref: PathRef, from: number): number {
  const id = keyIdAt(0, ref.id());
  return memberStepIn(contract, id, from);
}

/** `through` at the step `at`, the first of `rest` from `from` on that is a dict's `values` or `keys`. */
function* listsAt(
  contract: Contract,
  value: PlaceId,
  rest: Steps,
  at: number,
  from: number,
  given: Flow = null,
): Work<readonly Item[]> {
  const flow = runFlow(contract, given);
  // (#1668: the receiver read to decide its members, its unknowns included where the answer holds them as they are)
  const kinds = flow?.child() ?? null;
  const receiver = yield* through(contract, value, stepsRest(stepsTo(rest, at)), from, kinds);
  // F19a, (docs/specifications/type-inference-accepted-record/solver-and-work.md#r4-44): a receiver that may be a
  // reference has the runtime's members, decided once for a whole value
  // #1668: R, a receiver decision
  const decided = at === 0 ? yield* contract.valueReceiver(value) : receiver;
  if (heldReference(decided) || decided.some((item) => REFERENCE.has(item.tag)))
    return yield* through(contract, value, stepsRest(rest), at + 1, flow);
  let unknowns = false;
  // #1668: I, each member read it makes takes the flow (`through`)
  const items = yield* members(
    contract,
    rest,
    at,
    receiver,
    (path, start, sink) => through(contract, value, stepsRest(path), start, sink),
    () => (unknowns = true),
    flow,
  );
  if (kinds !== null && unknowns) flow!.attach(kinds, "unknown");
  return items;
}

/**
 * The kinds along `path` whose step `at` is a member a built-in value answers by itself, given the receiver's kinds
 * before it, by `read` (a path through such steps from a step on): a dict's lists, a temporal field's or a calendar
 * duration's part's declared result, and an object's own property of the name read as any property.
 */
export function* members(
  contract: Contract,
  path: Steps,
  at: number,
  receiver: readonly Item[],
  read: (path: Steps, from: number, flow: FlowSink | null) => Work<readonly Item[]>,
  // (#1668: told where the answer holds a receiver's unknown as it is)
  onUnknown?: () => void,
  // (#1668: the flow each read takes, a dict's values staged, kept where their items survive its filter)
  flow: FlowSink | null = null,
): Work<readonly Item[]> {
  // (the steps after the member read by position; the path without it made only where a dict's values ask: a
  // record's joined, `stepsJoin`)
  const after = path.length - at - 1;
  const out: Item[] = [];
  let own = false;
  const step = path.at(at)!;
  for (const item of withoutEmpty(receiver)) {
    const declared = declaredProperty(item.tag, step);
    if (item.tag === "dict" && dictList(step) !== undefined) {
      if (after === 0) out.push(carried(makeItem("list", item.writer), [item]));
      else if (path.at(at + 1) === "element") {
        // the list's own selection takes its own emptiness (open); a deeper selection's marker is that selection's
        if (dictList(step) === "values") {
          const values = flow?.child() ?? null;
          const below = yield* read(
            stepsJoin(stepsTo(path, at), stepsFrom(path, at + 1)),
            at,
            values,
          );
          const kept = after === 1 ? withoutEmpty(below) : below;
          if (values !== null)
            flow!.attach(values, ...(after === 1 ? (["withoutEmpty"] as const) : []));
          out.push(...kept);
        } else if (after === 1)
          // a key is text, possible: no literal holds a derived list's element (P3)
          out.push(carried(makeItem("string", item.writer, { cert: "pos" }), [item]));
        if (after === 1) out.push(EMPTY);
      }
    } else if (declared !== undefined) {
      // a temporal field or a calendar duration's part: its declared result (V30 §35)
      if (after === 0) out.push(carried(makeItem(declared, item.writer), [item]));
    } else if (item.tag === "object") own = true;
    else if (heldAsIs(item)) {
      onUnknown?.();
      out.push(item);
    }
  }
  if (own) out.push(...(yield* read(path, at + 1, flow)));
  return mergeItems(out, contract.pass.program.scope);
}

/**
 * How a read of a value at a path is routed (`valueAt`), one classification shared with the objects query
 * (`objects.ts`, #1747), so the two never route a value differently: a speaker's handle, a binding's read, a projection,
 * a call's result, a literal, a choice, a fallback or `get` (its operands' answers composed), any other operation, or
 * none of them (opaque).
 */
export type ValueRoute =
  | "speaker"
  | "binding"
  | "projection"
  | "call"
  | "literal"
  | "choice"
  | "composite"
  | "operation"
  | "opaque";

/** `ValueRoute`'s classification of a value (`valueAt`'s order). */
export function valueRoute(program: CorePass["program"], value: PlaceId): ValueRoute {
  if (program.speakerPlaces.has(value)) return "speaker";
  if (program.occurrenceOf.has(value)) return "binding";
  if (program.projOf.has(value)) return "projection";
  if (program.callOutOf.has(value)) return "call";
  if (program.hasOf.has(value) || program.cellOwner.has(value)) return "literal";
  const operation = program.opOf.get(value);
  if (operation === undefined) return "opaque";
  if (
    operation.kind === "operation" &&
    operation.contract.family === "interaction" &&
    interactionCategory(operation.contract.name)?.kind === "options"
  )
    return "choice";
  return operation.kind === "fallback" || operation.kind === "get" ? "composite" : "operation";
}

/** The kinds at a path of a value, by the value's kind. */
function* valueAt(
  contract: Contract,
  value: PlaceId,
  rest: Rest,
  given: Flow = null,
): Work<readonly Item[]> {
  const flow = runFlow(contract, given);
  if (!contract.pass.solver.enterRead()) {
    flow?.opaque("stopped");
    return STOPPED;
  }
  try {
    // (a cursor's span read by its path's id, its key a cursor and a literal's demand named by it: G3 stage 1)
    const ref = restRef(contract, rest);
    if (ref.length === 0) return yield* contract.contractOfValue(value, flow);
    const { program, guards } = contract.pass;
    program.work.charge("invSteps");
    // (one classification with the objects query's, `valueRoute`)
    const route = valueRoute(program, value);
    if (route === "speaker") return [unknownItem(REASON.opaque)];
    if (route === "binding") {
      const binding = program.occurrenceOf.get(value)!;
      // (#1668: a binding read, the edge a copy of it makes, entered and marked as its value is)
      const read = flow?.child() ?? null;
      const items = contract.entered(
        value,
        yield* contract.contractOf(keyAtRef(contract, binding, ref), read),
      );
      // §3.2: the mark travels with the value: none of a binding no test names
      const marks = !guards.untested(binding) && guards.guardedReadAt(value, ref.text(ref.length));
      if (read !== null) flow!.attach(read, "entered", ...(marks ? (["marked"] as const) : []));
      return marks ? marked(items) : items;
    }
    if (route === "projection") {
      const projection = program.projOf.get(value)!;
      if (projection.step === "iteration")
        // (an iteration's and a length's walk read arrays: a span's steps copied out, `stepsArray`)
        return yield* contractIteration(contract, projection.owner, stepsArray(ref.steps()), flow);
      if (measuresLength(projection.step))
        return yield* contractLength(
          contract,
          projection.owner,
          projection.step,
          stepsArray(ref.steps()),
          flow,
        );
      const selects = selectsElement(projection.step);
      const read = flow?.child() ?? null;
      const elements = yield* contract.contractOfValueAt(
        projection.owner,
        ref.after([stepName(projection.step)]),
        read,
      );
      if (!selects) {
        if (read !== null) flow!.attach(read);
        return elements;
      }
      // (#1668: the owner read whole for its selection alone: no flow)
      // #1668: S, the owner read for its selection
      const owners = withoutEmpty(yield* contract.contractOfValue(projection.owner));
      if (read !== null && keepsElements(owners)) flow!.attach(read, "selected");
      return withOwnSelection(elements, owners, contract.pass);
    }
    if (route === "call")
      return yield* contract.contractOf(keyAtRef(contract, resultOf(contract, value), ref), flow);
    // a literal's contract at a path once per literal and path, whatever asks: a selection nested k deep reads each
    // level's literal once, its answer composed from the level inside's, never again per level above (#1426)
    if (route === "literal") {
      const site = program.places[value]?.site ?? null;
      // (the rest in its identity: a wrapper's own literal asked by an array, at its cursor's span, G3 stage 1)
      const at = canonicalRest(contract, value, rest);
      const slot = joinParts("cl", value, restPart(at));
      flow?.include(slot, "literal");
      const demand: Demand = {
        key: slot,
        kind: "contract",
        file: site?.file ?? -1,
        offset: site?.start ?? -1,
        // #1668: the literal demand's run takes its own flow as it starts
        make: () => contract.contractOfLiteral(value, at),
      };
      return yield demand;
    }
    if (route === "opaque") return [unknownItem(REASON.opaque)];
    const operation = program.opOf.get(value)!;
    // a choice's answer at a path once per choice and path, whatever asks: the key's contract and A5's candidate test of
    // the choice's own entry read it alike (S6-CARRIERS §4.5, Astra r6 B2), as `contractOfValue` reads an operation
    if (route === "choice") {
      const site = program.places[value]?.site ?? operation.site;
      const slot = joinParts("cop", value, restPart(rest));
      flow?.include(slot, "operation");
      const demand: Demand = {
        key: slot,
        kind: "contract",
        file: site.file,
        offset: site.start,
        // (an operation's walk reads arrays: a span's steps copied out, `stepsArray`)
        // #1668: the demand's own run: its frame's flow, taken as it starts
        make: () => contractOfOp(contract, operation, stepsArray(ref.steps())),
      };
      return contract.entered(value, yield demand);
    }
    // a fallback's or a `get`'s answer at a path once per value and path, whatever asks, as its root's: each composes
    // its operands' answers at that path, so a chain of them read below its root by k consumers (C10 descending into a
    // nullable collection's element) walks each link once, never the chain before it again per reader (Astra r1, Codex
    // r4 and r5 on #1824)
    if (route === "composite") {
      const site = program.places[value]?.site ?? operation.site;
      const pathSlot = joinParts("cop", value, restPart(rest));
      flow?.include(pathSlot, "operation");
      const demand: Demand = {
        key: pathSlot,
        kind: "contract",
        file: site.file,
        offset: site.start,
        // #1668: the demand's own run: its frame's flow, taken as it starts
        make: () => contractOfOp(contract, operation, stepsArray(ref.steps())),
      };
      return contract.entered(value, yield demand);
    }
    // any other operation's on its frame's own stack, not the native one, its read chain new (`inline`): a chain of
    // operands (`o + o + …`, `a otherwise b otherwise …`) costs no native call per level (#1572)
    return contract.entered(
      value,
      yield* inline(contractOfOp(contract, operation, stepsArray(ref.steps()), flow)),
    );
  } finally {
    contract.pass.solver.leaveRead();
  }
}

/** The kinds a value can have at any point, mirroring the value side's dispatch. */
export function* contractOfValue(
  contract: Contract,
  value: PlaceId,
  flow: FlowSink | null = null,
): Work<readonly Item[]> {
  if (!contract.pass.solver.enterRead()) {
    flow?.opaque("stopped");
    return STOPPED;
  }
  try {
    const { program, guards } = contract.pass;
    program.work.charge("invSteps");
    if (program.speakerPlaces.has(value)) return [unknownItem(REASON.opaque)];
    const binding = program.occurrenceOf.get(value);
    if (binding !== undefined) {
      const read = flow?.child() ?? null;
      const items = contract.entered(value, yield* contract.contractOf(keyOf(binding, []), read));
      // §3.2: the mark travels with the value
      const marks = guards.guardedRead(value);
      if (read !== null) flow!.attach(read, "entered", ...(marks ? (["marked"] as const) : []));
      return marks ? marked(items) : items;
    }
    const projection = program.projOf.get(value);
    if (projection !== undefined) {
      // a property read, a loop's visit, a length
      if (projection.step === "iteration")
        return yield* contractIteration(contract, projection.owner, [], flow);
      if (measuresLength(projection.step))
        return yield* contractLength(contract, projection.owner, projection.step, [], flow);
      if (!selectsElement(projection.step)) {
        // G3: a property or index read's contract once per occurrence, its owner's one step down,
        // whatever asks: a chain of k such reads of nested literals asks each link once, never once per read above
        // (and once per stop: `stop` forgets it)
        const demand = projected(contract, value, projection);
        flow?.include(demand.key, "projection");
        return yield demand;
      }
      // S6c: a selection reads its owner twice, at its step and whole, so once per value, whatever asks: a chain of k
      // `.first` reads each link once whole, never each link 2^k times
      const site = program.places[value]?.site ?? null;
      const slot = joinParts("cpj", value);
      flow?.include(slot, "selection");
      const demand: Demand = {
        key: slot,
        kind: "contract",
        file: site?.file ?? -1,
        offset: site?.start ?? -1,
        // #1668: the demand's own run: its frame's flow, taken as it starts
        make: () => selection(contract, projection),
      };
      return yield demand;
    }
    if (program.callOutOf.has(value))
      return yield* contract.contractOf(keyOf(resultOf(contract, value), []), flow);
    const operation = program.opOf.get(value);
    // once per operation, whatever asks
    if (operation !== undefined) {
      const site = program.places[value]?.site ?? operation.site;
      const slot = joinParts("cop", value);
      flow?.include(slot, "operation");
      const demand: Demand = {
        key: slot,
        kind: "contract",
        file: site.file,
        offset: site.start,
        // #1668: the demand's own run: its frame's flow, taken as it starts
        make: () => contractOfOp(contract, operation, []),
      };
      return contract.entered(value, yield demand);
    }
    if (program.hasOf.has(value) || program.cellOwner.has(value))
      return yield* contract.contractOfLiteral(value, [], flow);
    if (program.isHost(value)) return [unknownItem(REASON.external)];
    return yield* contract.contractOf(keyOf(value, []), flow);
  } finally {
    contract.pass.solver.leaveRead();
  }
}

/** An element selection's kinds (`contractOfValue`): its owner's at the step, with the owner's own selection. */
function* selection(
  contract: Contract,
  projection: { readonly owner: PlaceId; readonly step: string },
): Work<readonly Item[]> {
  const flow = contract.pass.solver.sink();
  const read = flow?.child() ?? null;
  const elements = yield* contract.contractOfValueAt(
    projection.owner,
    [stepName(projection.step)],
    read,
  );
  // (#1668: the owner read whole for its selection alone: no flow)
  // #1668: S, the owner read for its selection
  const owners = withoutEmpty(yield* contract.contractOfValue(projection.owner));
  if (read !== null && keepsElements(owners)) flow!.attach(read, "selected");
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
  flow: FlowSink | null = null,
): Work<readonly Item[]> {
  const out: Item[] = [];
  // (#1668: the owner's kinds decide what a loop visits; its elements visited are included, and its unknowns, which
  // the answer holds as they are)
  const kinds = flow?.child() ?? null;
  let unknowns = false;
  for (const item of withoutEmpty(yield* contract.contractOfValue(owner, kinds))) {
    if (item.tag === "list" || item.tag === "set") {
      // (#1668: kept under its filter: the snapshot drops it where the filter removes its items whole)
      const element = flow?.child() ?? null;
      const selected = belowSelected(
        yield* contract.contractOfValueAt(owner, joinSteps(["element"], rest), element),
        rest,
      );
      if (element !== null)
        flow!.attach(element, ...(rest.length === 0 ? (["withoutEmpty"] as const) : []));
      out.push(...selected);
    } else if ((item.tag === "dict" || kindElement(item.tag) !== undefined) && rest.length === 0)
      out.push(
        carried(makeItem(item.tag === "dict" ? "string" : kindElement(item.tag)!, item.writer), [
          item,
        ]),
      );
    // (an unknown's element: a collection below it may hold none)
    else if (heldAsIs(item)) {
      unknowns = true;
      out.push(item, ...emptyAt(rest));
    }
  }
  if (kinds !== null && unknowns) flow!.attach(kinds, "unknown");
  return mergeItems(out, contract.pass.program.scope);
}

/** F14: a text's or a collection's length is a whole number; an object's own `length` is its property (F11). */
function* contractLength(
  contract: Contract,
  owner: PlaceId,
  step: string,
  rest: readonly string[],
  flow: FlowSink | null = null,
): Work<readonly Item[]> {
  // F19a before F14: a receiver that may be a reference has the runtime's members, its `length` among them
  // #1668: R, a receiver decision
  if (heldReference(yield* contract.valueReceiver(owner)))
    return yield* contract.contractOfValueAt(owner, joinSteps([step], rest), flow);
  const out: Item[] = [];
  // (#1668: the owner's kinds decide the length's kinds; an object's own member is included, and its unknowns, which
  // the answer holds as they are)
  const kinds = flow?.child() ?? null;
  let unknowns = false;
  for (const item of withoutEmpty(yield* contract.contractOfValue(owner, kinds))) {
    if (item.tag === "string" || item.tag === "list" || item.tag === "set" || item.tag === "dict") {
      if (rest.length === 0) out.push(carried(makeItem("integer", item.writer), [item]));
    } else if (item.tag === "object" || REFERENCE.has(item.tag))
      // an object's own `length` (F11), a reference's member (F19a)
      out.push(...(yield* contract.contractOfValueAt(owner, joinSteps([step], rest), flow)));
    else if (heldAsIs(item)) {
      unknowns = true;
      out.push(item);
    }
  }
  if (kinds !== null && unknowns) flow!.attach(kinds, "unknown");
  return mergeItems(out, contract.pass.program.scope);
}

/**
 * F18: a load's or `fromJson`'s expected type, possible: the declared type, or the written type of the place its
 * value lands in directly (V30 §12); at a property its default lacks, where its reader fills the default's and keeps the
 * others (an untyped load, or below a written `object`), data that may be absent; an untyped load's at one below a
 * collection, its default's kinds beside `missing`; `null` without one.
 */
export function* expectedOf(
  contract: Contract,
  c: ValueConstraint,
  rest: readonly string[],
  flow: FlowSink | null = null,
): Work<readonly Item[] | null> {
  const written = (c.kind === "load" ? c.receiver : null) ?? contract.landsIn(c.result, []);
  // (#1668: a default's kinds included where the answer holds them, staged where a branch may not)
  if (written === null && c.kind === "load" && c.fallback !== null && rest.length > 0) {
    const staged = flow?.child() ?? null;
    const named = yield* contract.defaultKinds(c.fallback, rest, staged);
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
    if (rest.includes("element") && rest.at(-1) !== "element") {
      if (staged !== null) flow!.attach(staged);
      return [...named, unknownItem(REASON.missing)];
    }
  }
  if (written === null) return null;
  const term = termAt(written, rest);
  const fallback = c.kind === "load" ? (c.fallback ?? undefined) : defaultOf(c);
  // V30 §13 (JSON): below a written `object` the value keeps every key, and has each one its default names, of the
  // default's type, where its reader takes a missing or misfitting key from the default: JSON's at every level, a stored
  // value's in its root object and the objects nested in it, never in an element of a collection, which a stored value
  // keeps as it is when it fits (`matchesValueType`). There the default answers (#1436; the lead's ruling on r2's B1).
  // `#`, the presence rule's property no literal lists (`unlistedObject`), keeps the default's answer too: the reader
  // fills each property the default names, `null` ones included, so only a property the default may lack owes a check,
  // carried by its own answer: data that may be absent, ADR 0021 1.8 (#1470, as #1459's untyped load)
  if (
    term === null &&
    fallback !== undefined &&
    (c.kind !== "load" || !rest.includes("element")) &&
    belowObject(written, rest)
  ) {
    const staged = flow?.child() ?? null;
    const named = withoutEmpty(yield* contract.defaultKinds(fallback, rest, staged));
    if (rest.at(-1) === "#") {
      if (staged !== null) flow!.attach(staged, "withoutEmpty");
      return named;
    }
    if (named.some((item) => item.tag === "unknown" && (item.reasons & REASON.missing) !== 0))
      return [unknownItem(REASON.external | REASON.missing), ...emptyAt(rest)];
    if (named.length > 0) {
      if (staged !== null) flow!.attach(staged, "withoutEmpty");
      return [...named, ...emptyAt(rest)];
    }
  }
  const nullDefault =
    // #1668: D, a predicate on the default
    rest.length === 0 && fallback !== undefined && (yield* contract.onlyNull(fallback)).length > 0;
  // (the written type's kinds carry its spelling, #1398)
  const kinds = term === null ? ["unknown" as const] : typeKinds(term);
  const spelled = spelledBy(kinds);
  return [
    ...kinds.map((tag) =>
      tag === "unknown"
        ? unknownItem(REASON.external)
        : makeItem(tag, null, { cert: "pos", ...spelled }),
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

/**
 * The kinds a `load` or `fromJson` takes from its default at `rest` (`typedDefault`): the default's value at its call's
 * snapshot (F18), as the value side reads it there (`Values.defaultKinds`), never the settled type of
 * a place it reads, so the call's contract and its answer agree.
 */
export function* defaultKinds(
  contract: Contract,
  fallback: PlaceId,
  rest: readonly string[],
  flow: FlowSink | null = null,
): Work<readonly Item[]> {
  const site = contract.pass.program.places[fallback]?.site ?? null;
  const slot = joinParts("dk", fallback, rest);
  flow?.include(slot, "default");
  return yield {
    key: slot,
    kind: "contract",
    file: site?.file ?? -1,
    offset: site?.start ?? -1,
    // #1668: D, the typed default's run: literal data passes the run's flow, a read the value side's (opaque)
    make: () => snapshotKinds(contract, fallback, rest),
    decision: typedDefault(rest, false),
  };
}

/**
 * `defaultKinds`' run (F18): the default's written type where its syntax gives one (`writtenDefault`, as the value
 * side's `Values.defaultKinds` reads it first); else literal data by its contract; a default that reads a variable
 * or computes as the value side reads it at its call's snapshot (`FlowGraph.snapshotOf`), its marks, narrowing, copies
 * and stops included, never the settled type of a place it reads, so the call's contract and its answer agree.
 */
function* snapshotKinds(
  contract: Contract,
  fallback: PlaceId,
  rest: readonly string[],
): Work<readonly Item[]> {
  const { program, values, solver } = contract.pass;
  const written = writtenDefault(contract.pass, fallback, rest);
  if (written !== null) {
    // (#1668: an answer of syntax alone, its slot's edges unavailable as the value side's read leaves them)
    solver.sink()?.opaque("exact");
    return written;
  }
  const site = program.places[fallback]?.site;
  const expression = site === undefined || site === null ? null : program.exprAt(site);
  if (expression !== null && !program.flow.snapshotNeedsValue(expression))
    return yield* through(contract, fallback, rest, 0, "run");
  const node = expression === null ? null : program.flow.snapshotOf(expression);
  // (#1668: the value side's walk records no contribution flow, so the slot's edges are unavailable, never empty, as
  // an exact gather's are)
  solver.sink()?.opaque("exact");
  // #1668: D, the value side's read at the snapshot, its slot opaque above
  return yield* values.valueItems(fallback, node, rest);
}

/** F19: whether a default holds only `null` (or nothing), by its contract (`ONLY_NULL`). */
/** A default's run (`defaultKinds`): its fallback's kinds at the path, its run's flow taken as it starts. */
/**
 * #1668: a flow given to the value side's walk: a caller's, none, or the running demand's own (`"run"`), taken as the
 * walk's code starts, so a demand whose run is this walk (`defaultKinds`) makes it as it did, with nothing moved
 * before its run starts (its demand's units unchanged).
 */
type Flow = FlowSink | null | "run";

/** A walk's flow (`Flow`) once its code runs. */
function runFlow(contract: Contract, flow: Flow): FlowSink | null {
  return flow === "run" ? contract.pass.solver.sink() : flow;
}

export function* onlyNull(contract: Contract, fallback: PlaceId): Work<readonly Item[]> {
  const site = contract.pass.program.places[fallback]?.site ?? null;
  // #1668: D, the null-only predicate's demand: its answer is made anew (`ONLY_NULL.flow`)
  return yield {
    key: joinParts("dn", fallback),
    kind: "contract",
    file: site?.file ?? -1,
    offset: site?.start ?? -1,
    // #1668: D, the null-only demand's run: its answer is made anew (`ONLY_NULL.flow`)
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

/** #1668: whether `withOwnSelection` keeps the elements: not where every owner is an object (only its own selection). */
function keepsElements(owners: readonly Item[]): boolean {
  return (
    !owners.some((item) => item.tag === "object") || !owners.every((item) => item.tag === "object")
  );
}

/**
 * F11: the collector reads an object's own `first`, `last` or `random` as an element selection; the core makes it
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
