import type { CorePass } from "../answers.js";
import { joinSteps } from "../budget.js";
import type { Contract } from "../contract.js";
import { belowSelected, withoutEmpty } from "../exact-path.js";
import { EMPTY, makeItem, mergeItems, REASON, weaken, type Item } from "../items.js";
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
import type { ValueConstraint } from "../program.js";
import type { Work } from "../solver.js";
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
): Work<readonly Item[]> {
  const { program } = contract.pass;
  const scope = program.scope;
  if (c.kind === "fallback") {
    const left = (yield* contract.contractOfValueAt(c.left, rest)).filter(
      (item) => rest.length > 0 || item.tag !== "null",
    );
    return mergeItems([...left, ...(yield* contract.contractOfValueAt(c.right, rest))], scope);
  }
  // F19a before F17b: a receiver that may be a reference has the runtime's `get`, no default merged beside it
  if (c.kind === "get" && heldReference(yield* contract.valueReceiver(c.receiver)))
    return [unknownItem(REASON.opaque)];
  if (c.kind === "get")
    return mergeItems(
      [
        ...belowSelected(
          yield* contract.contractOfValueAt(c.receiver, joinSteps(["element"], rest)),
          rest,
        ),
        ...(yield* contract.contractOfValueAt(c.fallback, rest)),
      ],
      scope,
    );
  if (c.kind === "load") {
    // F19: a computed key
    if (c.key === null) {
      const nullDefault =
        rest.length === 0 &&
        c.fallback !== null &&
        (yield* contract.onlyNull(c.fallback)).length > 0;
      return [...hostAt(rest), ...(nullDefault ? [ingressNull()] : [])];
    }
    const expected = yield* contract.expectedOf(c, rest);
    if (expected !== null) return expected;
    if (c.fallback !== null)
      return [...(yield* contract.defaultKinds(c.fallback, rest)), ...emptyAt(rest)];
  }
  if (c.kind !== "operation") return [unknownItem(REASON.external)];
  const { family, name } = c.contract;
  // F19a: a reference's method is opaque, a decision of its component (r4.44)
  if (
    family === "method" &&
    c.receiver !== null &&
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
        ...(fallback === undefined ? [] : yield* contract.contractOfValue(fallback)),
      ],
      scope,
    );
  }
  const method = family === "method" && c.receiver !== null ? methodCategory(name) : undefined;
  // F7a–c, F25: a declared result, or what a removal gives
  if (method !== undefined && c.receiver !== null && method.gives.kind !== "copy") {
    const gives = method.gives;
    const out: Item[] = [];
    for (const item of withoutEmpty(yield* contract.contractOfValue(c.receiver))) {
      if (gives.kind === "declared") {
        if (rest.length === 0)
          out.push(
            ...declaredResult(name, gives.kinds, item.tag).map((tag) =>
              carried(makeItem(tag), [item]),
            ),
          );
      } else if (item.tag === "unknown") {
        // a dict's removed value, or a list's or a set's `null` where it gives that
        out.push(item);
        if (gives.fromList === "null" && rest.length === 0)
          out.push(carried(makeItem("null"), [item]));
      } else if (gives.fromList === "null" && item.tag !== "dict") {
        if (rest.length === 0) out.push(carried(makeItem("null"), [item]));
      } else if (COLLECTIONS.has(item.tag))
        out.push(
          ...belowSelected(
            yield* contract.contractOfValueAt(c.receiver, joinSteps(["element"], rest)),
            rest,
          ),
        );
    }
    return mergeItems(out, scope);
  }
  // F10: a copy of the elements, which may hold none where it takes a count: a receiver's own elements, or those its
  // kind declares (a range's whole numbers)
  if (method !== undefined && c.receiver !== null && method.gives.kind === "copy") {
    const copy = method.gives;
    const receiver = yield* contract.contractOfValue(c.receiver);
    if (rest.length === 0) return [carried(makeItem(copy.into), receiver)];
    const kinds = withoutEmpty(receiver);
    const declared = kinds.some((item) => kindElement(item.tag) !== undefined);
    return [
      // a kind's declared elements may be none (a range's bounds decide): the copy's element step keeps that mark
      ...(declared && rest.length === 1 ? [EMPTY] : []),
      ...(rest.length === 1
        ? kinds.flatMap((item) => {
            const element = kindElement(item.tag);
            return element === undefined ? [] : [carried(makeItem(element, item.writer), [item])];
          })
        : []),
      ...(kinds.some((item) => kindElement(item.tag) === undefined)
        ? yield* contract.contractOfValueAt(c.receiver, joinSteps(["element"], rest.slice(1)))
        : []),
      ...(copy.mayHoldNone && rest.length === 1 ? [EMPTY] : []),
    ];
  }
  if (family === "operator" && name === "+" && rest.length > 0) {
    // TABLE r4.87: a `+` fourth or later in a run of terms answers below its root as the run's third
    const repeated = contract.plusRepeatOf(c.result, false);
    if (repeated !== c.result) return yield* contract.contractOfValueAt(repeated, rest);
    const operands: (readonly Item[])[] = [];
    // (an operand admission rejected from the join gives it nothing: A6, `joinElements`)
    for (const argument of c.arguments)
      if (contract.pass.lists.joined(argument))
        operands.push(yield* contract.contractOfValueAt(argument, rest));
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
          ? yield* contract.contractOfValue(fallback)
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
      (yield* contract.expectedOf(c, rest)) ?? [
        ...(fallback === undefined
          ? [unknownItem(REASON.external)]
          : yield* contract.defaultKinds(fallback, rest)),
        ...emptyAt(rest),
      ]
    );
  }
  const interaction = family === "interaction" ? interactionCategory(name) : undefined;
  if (interaction?.kind === "asks") return rest.length === 0 ? [makeItem(interaction.result)] : [];
  // r4.47 (5): a clock read gives its declared kind, as an ask does
  const clock = family === "clock" ? clockResult(name) : undefined;
  if (clock !== undefined) return rest.length === 0 ? [makeItem(clock)] : [];
  // V30 §19: askChoice's answer, per option its label, or each of its buttons' values
  if (interaction?.kind === "options")
    return mergeItems(
      yield* choiceItems(
        c,
        rest,
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
  // runtime's opaque answer on a known kind (r4.47 (1)); what the core cannot know keeps its own reasons. A receiver
  // without items yet is a provisional bottom: the result stays the bottom (S3 §1, r4.44)
  if (family === "method" && c.receiver !== null) {
    const receiver = withoutEmpty(yield* contract.contractOfValue(c.receiver));
    return mergeItems(
      receiver.flatMap((item) => {
        if (item.tag === "unknown") return [item];
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

/**
 * F10: the elements of `l + r`, held when either side holds one; no position is a fact (F8, F10, F12 r5): where both
 * sides contribute elements, which one an element read takes is unknown, so each kind is possible.
 */
export function plusElements(
  operands: readonly (readonly Item[])[],
  rest: readonly string[],
  pass: CorePass,
): readonly Item[] {
  const held =
    rest.length === 1 &&
    operands.some((items) => items.length > 0 && !items.some((item) => item.tag === "empty"));
  const items = mergeItems(
    held ? withoutEmpty(operands.flat()) : operands.flat(),
    pass.program.scope,
  );
  return operands.filter((items) => withoutEmpty(items).length > 0).length > 1
    ? weaken(items, "member")
    : items;
}
