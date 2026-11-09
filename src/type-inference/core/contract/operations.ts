import type { CorePass } from "../answers.js";
import { joinSteps } from "../budget.js";
import type { Contract } from "../contract.js";
import { belowSelected, withoutEmpty } from "../exact-path.js";
import { EMPTY, inItsOrder, makeItem, mergeItems, REASON, weaken, type Item } from "../items.js";
import {
  builtinResult,
  clockResult,
  conversionCategory,
  declaredResult,
  declaredMethod,
  interactionCategory,
  kindElement,
  memberResult,
  methodCategory,
  shownResult,
} from "../method-categories.js";
import { operationItems, type Operator } from "../operator-table.js";
import { indexedPlus } from "../plus-index.js";
import type { ValueConstraint } from "../program.js";
import type { Work } from "../solver.js";
import { heldAsIs, otherwiseKeeps, type FlowSink } from "./contributions.js";
import { choiceItems } from "./choices.js";
import {
  carried,
  COLLECTIONS,
  emptyAt,
  heldReference,
  hostAt,
  ingressNull,
  unknownItem,
} from "./kinds.js";
import { conversionKind, defaultOf, unitKind } from "./terms.js";

// The kinds an operation's result can have, mirroring the value side's dispatch, and the operators' table.

/** F16: the operators the runtime's table has rows for, by the collector's operation names. */
const OPERATORS: ReadonlyMap<string, Operator> = new Map(
  (["+", "-", "*", "/", "%", "<", "<=", ">", ">="] as const).map((name) => [name, name]),
);

/** The collector's operation of an operator: unary minus is the table's `neg`. */
export function operatorOf(constraint: ValueConstraint): Operator | null {
  if (constraint.kind !== "operation") return null;
  const { family, name } = constraint.contract;
  if (family === "unary") return name === "-" ? "neg" : null;
  if (family !== "operator" && family !== "comparison") return null;
  return OPERATORS.get(name) ?? null;
}

/** The kinds an operation's result can have, mirroring the value side's dispatch. */
export function* contractOfOp(
  contract: Contract,
  c: ValueConstraint,
  rest: readonly string[],
  given?: FlowSink | null,
): Work<readonly Item[]> {
  const { program } = contract.pass;
  const scope = program.scope;
  // (#1668: read inline, its caller's flow; as its own demand (`cop|`), its run's, taken as the run starts. Its
  // operands whose items its answer unions are included; those it reads to make a new result, not)
  const flow = given === undefined ? contract.pass.solver.sink() : given;
  if (c.kind === "fallback") {
    const kept = flow?.child() ?? null;
    const left = (yield* contract.contractOfValueAt(c.left, rest, kept)).filter(
      (item) => rest.length > 0 || otherwiseKeeps(item),
    );
    // (#1668: kept under its filter: the snapshot drops it where the filter removes its items whole)
    if (kept !== null)
      flow!.attach(kept, ...(rest.length === 0 ? (["operandFilter"] as const) : []));
    return mergeItems(
      [...left, ...(yield* contract.contractOfValueAt(c.right, rest, flow))],
      scope,
    );
  }
  // F19a before F17b: a receiver that may be a reference has the runtime's `get`, no default merged beside it
  // #1668: R, a receiver decision
  if (c.kind === "get" && heldReference(yield* contract.valueReceiver(c.receiver)))
    return [unknownItem(REASON.opaque)];
  if (c.kind === "get") {
    const element = flow?.child() ?? null;
    const fallback = flow?.child() ?? null;
    const selected = belowSelected(
      yield* contract.contractOfValueAt(c.receiver, joinSteps(["element"], rest), element),
      rest,
    );
    const items = mergeItems(
      [...selected, ...(yield* contract.contractOfValueAt(c.fallback, rest, fallback))],
      scope,
    );
    // (#1668: kept under its filter: the snapshot drops it where the filter removes its items whole)
    if (element !== null)
      flow!.attach(element, "selected", ...(rest.length === 0 ? (["withoutEmpty"] as const) : []));
    if (fallback !== null) flow!.attach(fallback, "default");
    return items;
  }
  if (c.kind === "load") {
    // F19: a computed key
    if (c.key === null) {
      const nullDefault =
        rest.length === 0 &&
        c.fallback !== null &&
        // #1668: D, a predicate on the default
        (yield* contract.onlyNull(c.fallback)).length > 0;
      return [...hostAt(rest), ...(nullDefault ? [ingressNull()] : [])];
    }
    const expected = yield* contract.expectedOf(c, rest, flow);
    if (expected !== null) return expected;
    if (c.fallback !== null)
      return [...(yield* contract.defaultKinds(c.fallback, rest, flow)), ...emptyAt(rest)];
  }
  if (c.kind !== "operation") return [unknownItem(REASON.external)];
  const { family, name } = c.contract;
  // F19a: a reference's method is opaque, a decision of its component
  if (
    family === "method" &&
    c.receiver !== null &&
    // #1668: R, a receiver decision
    heldReference(yield* contract.valueReceiver(c.receiver))
  )
    return [unknownItem(REASON.opaque)];
  // F26b (r5): always text
  if (family === "interpolation") return rest.length === 0 ? [makeItem("string")] : [];
  // a message's handle (F19a)
  if (family === "say")
    return rest.length > 0 ? [unknownItem(REASON.opaque)] : [makeItem("messageHandle")];
  // `2 s`, `1 calendar day`, `20 deg`
  if (family === "unit" || family === "angle")
    return rest.length > 0 ? [] : [makeItem(unitKind(family, name))];
  // the builtins' declared results
  if (family === "builtin") {
    if (rest.length > 0) return [];
    const fallback = defaultOf(c);
    return mergeItems(
      [
        makeItem(builtinResult(name)),
        ...(fallback === undefined ? [] : yield* contract.contractOfValue(fallback, flow)),
      ],
      scope,
    );
  }
  const method = family === "method" && c.receiver !== null ? methodCategory(name) : undefined;
  // F7a–c, F25: a declared result, or what a removal gives
  if (method !== undefined && c.receiver !== null && method.gives.kind !== "copy") {
    const gives = method.gives;
    const out: Item[] = [];
    // (#1668: a declared result per receiver kind is made anew; the receiver's unknowns the answer holds as they are)
    const kinds = flow?.child() ?? null;
    let unknowns = false;
    for (const item of withoutEmpty(yield* contract.contractOfValue(c.receiver, kinds))) {
      if (gives.kind === "declared") {
        if (rest.length === 0)
          out.push(
            ...declaredResult(name, gives.kinds, item.tag).map((tag) =>
              carried(makeItem(tag), [item]),
            ),
          );
      } else if (heldAsIs(item)) {
        // a dict's removed value, or a list's or a set's `null` where it gives that
        unknowns = true;
        out.push(item);
        if (gives.fromList === "null" && rest.length === 0)
          out.push(carried(makeItem("null"), [item]));
      } else if (gives.fromList === "null" && item.tag !== "dict") {
        if (rest.length === 0) out.push(carried(makeItem("null"), [item]));
      } else if (COLLECTIONS.has(item.tag)) {
        // (#1668: kept under its filter: the snapshot drops it where the filter removes its items whole)
        const element = flow?.child() ?? null;
        const selected = belowSelected(
          yield* contract.contractOfValueAt(c.receiver, joinSteps(["element"], rest), element),
          rest,
        );
        if (element !== null)
          flow!.attach(element, ...(rest.length === 0 ? (["withoutEmpty"] as const) : []));
        out.push(...selected);
      }
    }
    if (kinds !== null && unknowns) flow!.attach(kinds, "unknown");
    return mergeItems(out, scope);
  }
  // F10: a copy of the elements, which may hold none where it takes a count: a receiver's own elements, or those its
  // kind declares (a range's whole numbers)
  if (method !== undefined && c.receiver !== null && method.gives.kind === "copy") {
    const copy = method.gives;
    // #1668: D, the receiver's kinds decide the copy's
    const receiver = yield* contract.contractOfValue(c.receiver);
    if (rest.length === 0) return [carried(makeItem(copy.into), receiver)];
    const kinds = withoutEmpty(receiver);
    const declared = kinds.some((item) => kindElement(item.tag) !== undefined);
    // (the elements of each kind together, in their one order, #1398)
    return inItsOrder([
      // a kind's declared elements may be none (a range's bounds decide): the copy's element step keeps that mark
      ...(declared && rest.length === 1 ? [EMPTY] : []),
      ...(rest.length === 1
        ? kinds.flatMap((item) => {
            const element = kindElement(item.tag);
            return element === undefined ? [] : [carried(makeItem(element, item.writer), [item])];
          })
        : []),
      ...(kinds.some((item) => kindElement(item.tag) === undefined)
        ? yield* contract.contractOfValueAt(c.receiver, joinSteps(["element"], rest.slice(1)), flow)
        : []),
      ...(copy.mayHoldNone && rest.length === 1 ? [EMPTY] : []),
    ]);
  }
  if (family === "operator" && name === "+" && rest.length > 0) {
    // #1384: an indexed run's terms holding the property, and those between them
    // #1668: I, each term's read takes the flow
    const indexed = yield* indexedPlus(contract.pass, c.result, rest, false, (term) =>
      contract.contractOfValueAt(term, rest, flow),
    );
    if (indexed !== null) return indexed;
    // (docs/specifications/type-inference-accepted-record.md#r4-87): a `+` fourth or later in a run of terms answers
    // below its root as the run's third
    const repeated = contract.plusRepeatOf(c.result, false);
    if (repeated !== c.result) return yield* contract.contractOfValueAt(repeated, rest, flow);
    const operands: (readonly Item[])[] = [];
    // (#1668: each operand staged, kept under the join's filter where it drops `empty`, `plusDropsEmpty`)
    const sides: FlowSink[] = [];
    // (an operand admission rejected from the join gives it nothing: A6, `joinElements`)
    for (const argument of c.arguments)
      if (contract.pass.lists.joined(argument)) {
        const side = flow?.child() ?? null;
        operands.push(yield* contract.contractOfValueAt(argument, rest, side));
        if (side !== null) sides.push(side);
      }
    const drops = plusDropsEmpty(operands, rest);
    for (const side of sides) flow!.attach(side, ...(drops ? (["withoutEmpty"] as const) : []));
    return plusElements(operands, rest, contract.pass);
  }
  const conversion = family === "conversion" ? conversionCategory(name) : undefined;
  if (conversion?.kind === "converts") {
    if (rest.length > 0) return [];
    const fallback = defaultOf(c);
    return mergeItems(
      [
        makeItem(conversionKind(conversion.result)),
        ...(fallback !== undefined
          ? yield* contract.contractOfValue(fallback, flow)
          : conversion.optional
            ? [makeItem("null")]
            : []),
      ],
      scope,
    );
  }
  if (conversion?.kind === "parses") {
    const fallback = defaultOf(c);
    return (
      (yield* contract.expectedOf(c, rest, flow)) ?? [
        ...(fallback === undefined
          ? [unknownItem(REASON.external)]
          : yield* contract.defaultKinds(fallback, rest, flow)),
        ...emptyAt(rest),
      ]
    );
  }
  const interaction = family === "interaction" ? interactionCategory(name) : undefined;
  if (interaction?.kind === "asks") return rest.length === 0 ? [makeItem(interaction.result)] : [];
  // a clock read gives its declared kind, as an ask does
  const clock = family === "clock" ? clockResult(name) : undefined;
  if (clock !== undefined) return rest.length === 0 ? [makeItem(clock)] : [];
  // V30 §19: askChoice's answer, per option its label, or each of its buttons' values
  // (#1668: a choice's reads decide presence as well as supply items: no flow of its own yet)
  if (interaction?.kind === "options") flow?.opaque("choice");
  if (interaction?.kind === "options")
    return mergeItems(
      // #1668: a choice's options: its includer records `opaque`
      yield* choiceItems(
        c,
        rest,
        // #1668: a choice's reads: its includer records `opaque`
        (value, path) => contract.contractOfValueAt(value, path),
        contract.choiceKeysStored(),
        contract.choiceOptions(c, false),
      ),
      scope,
    );
  if (rest.length > 0) return [unknownItem(REASON.opaque)];
  // F16: the runtime's operator table
  const operator = operatorOf(c);
  if (operator !== null) {
    const operands: (readonly Item[])[] = [];
    for (const argument of c.arguments)
      // #1668: D, the operator table makes a new result
      operands.push(withoutEmpty(yield* contract.contractOfValue(argument)));
    return operationItems(operator, operands, scope, c.site);
  }
  if (family === "logic" || family === "comparison" || family === "typeTest")
    return [makeItem("boolean")];
  const member = family === "member" ? memberResult(name) : undefined;
  if (member !== undefined) return member.map((kind) => makeItem(kind));
  // F19a: a handle's member is opaque
  if (family === "timer" || family === "media") return [makeItem(family)];
  // F25: a button's, a popup's or a camera's fixed result
  const shown = shownResult(name);
  if (shown !== undefined) return [makeItem(shown)];
  if (family === "range") return [makeItem("range")];
  // a method without a category, per receiver alternative: its declared result per receiver kind (F25), else the
  // runtime's opaque answer on a known kind; what the core cannot know keeps its own reasons. A receiver without items
  // yet is a provisional bottom: the result stays the bottom (S3 §1,
  // docs/specifications/type-inference-accepted-record.md#r4-44)
  if (family === "method" && c.receiver !== null) {
    // (#1668: a declared result per receiver kind is made anew; the receiver's unknowns the answer holds as they are)
    const kinds = flow?.child() ?? null;
    const receiver = withoutEmpty(yield* contract.contractOfValue(c.receiver, kinds));
    if (kinds !== null && receiver.some(heldAsIs)) flow!.attach(kinds, "unknown");
    return mergeItems(
      receiver.flatMap((item) => {
        if (heldAsIs(item)) return [item];
        const declared = declaredMethod(item.tag, name);
        return declared === undefined
          ? [unknownItem(REASON.opaque)]
          : declared.map((tag) => carried(makeItem(tag, item.writer), [item]));
      }),
      scope,
    );
  }
  return [unknownItem(REASON.external)];
}

/** F10: whether `l + r`'s element drops its operands' `empty`: where one of them holds an element for certain. */
function plusDropsEmpty(operands: readonly (readonly Item[])[], rest: readonly string[]): boolean {
  return (
    rest.length === 1 &&
    operands.some((items) => items.length > 0 && !items.some((item) => item.tag === "empty"))
  );
}

/**
 * F10: the elements of `l + r`, held when either side holds one; no position is a fact (F8, F10, F12 r5): where both
 * sides contribute elements, which one an element read takes is unknown, so each kind is possible.
 */
export function plusElements(
  operands: readonly (readonly Item[])[],
  rest: readonly string[],
  pass: CorePass,
): readonly Item[] {
  const items = mergeItems(
    plusDropsEmpty(operands, rest) ? withoutEmpty(operands.flat()) : operands.flat(),
    pass.program.scope,
  );
  return operands.filter((items) => withoutEmpty(items).length > 0).length > 1
    ? weaken(items, "member")
    : items;
}
