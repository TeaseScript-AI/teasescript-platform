import { dictMethod } from "../../../dict-operations.js";
import { lazyDefaultOperation } from "../../../lazy-defaults.js";
import type { ValueKind } from "../../../value-kinds.js";
import type { Constraint, SourceSite } from "../../graph.js";
import { isExternal, isOpaque } from "../admission.js";
import { joinParts, joinSteps } from "../budget.js";
import type { Consumers } from "../consumers.js";
import { defaultOf, termAt, typeTags } from "../contract.js";
import { operatorOf } from "../contract.js";
import { withoutEmpty } from "../exact-path.js";
import type { FlowNode } from "../flow-graph.js";
import { makeItem, type Item, type ItemTag } from "../items.js";
import { builtinResult, conversionCategory } from "../method-categories.js";
import { OPERATOR_ROWS, operatorRow, type Operator } from "../operator-table.js";
import type { ValueConstraint } from "../program.js";
import type { DiagnosticRule, RequiredKind } from "../result.js";
import { choiceValues } from "../checks/interactions.js";
import { error } from "./diagnostics.js";
import { jsonArgument, methodArguments, methodElements } from "./signatures.js";
import { fallbackFits } from "./fallbacks.js";
import { BOOLEAN, hasMethod, operandDomain, SHOWN, TEXT } from "./kinds.js";
import { keyLabel, kindsOf, ownSpan, quietKinds } from "./names.js";
import { consume, indexUse, integerOnly } from "./operands.js";
import { projection, selection } from "./projections.js";
import { methodReceiver } from "./receivers.js";
import { obligation, shownProperty, warning } from "./warnings.js";

/**
 * C1 with C9 r4.29 and r4.43: where external data a store brings enters, for its warning and check: the external
 * value's own expression, found by applying to the stored value, step by step, what the store reads of it, the way the
 * value transfer composes it: a literal's child for a path step, a projection's owner with the projection's step
 * before the rest, a choice's options (a list's or a set's elements, else the argument itself; a labelled option gives
 * its label) each selected (V30 §19: a choice object's `value`, or its `text` without one, else the option itself)
 * before the rest, also where a choice is another choice's option or projected, and an external value's own site
 * whatever remains. A variable read stops it: the store, as for a copy of a variable (r4.43's bound options). The first
 * in source order.
 */
/** The consumers that operations and projections are: C2–C6, C11, C12, C13's iterable, ADR 1.5. */
export function operations(walk: Consumers): void {
  const { program } = walk.pass;
  const { contract } = walk.pass;
  const finals = walk.order(
    program.constraints.filter(
      (c) =>
        c.kind === "operation" ||
        c.kind === "project" ||
        c.kind === "get" ||
        c.kind === "fallback" ||
        c.kind === "load",
    ),
  );
  walk.enter(0);
  for (const c of finals) {
    if (!walk.runs(c.site)) continue;
    // (a compound assignment's operation is its statement's, which has no expression of its own: Astra's G2)
    const node = program.exprAt(c.site) ?? compoundNode(walk, c);
    if (node === null) continue;
    walk.reading = node;
    if (c.kind === "get") {
      // as any method's receiver
      methodReceiver(walk, c.site, node, c.receiver, "get");
      if (c.key !== null) indexUse(walk, c.receiver, c.key, node, c.site, "the index of get", true);
      fallbackFits(
        walk,
        c,
        node,
        (rest) =>
          withoutEmpty(walk.valueItems(c.receiver, node, joinSteps(["element"], rest), true)),
        c.fallback,
      );
      continue;
    }
    if (c.kind === "fallback") {
      fallbackFits(
        walk,
        c,
        node,
        (rest) => withoutEmpty(walk.valueItems(c.left, node, rest, true)),
        c.right,
      );
      continue;
    }
    const parses =
      c.kind === "operation" &&
      c.contract.family === "conversion" &&
      conversionCategory(c.contract.name)?.kind === "parses";
    if (c.kind === "load" || parses) {
      // C10: the default against the expected type (V30 §12)
      const written = (c.kind === "load" ? c.receiver : null) ?? contract.landsIn(c.result, []);
      const fallback = c.kind === "load" ? c.fallback : defaultOf(c);
      if (written !== null && fallback !== null && fallback !== undefined)
        fallbackFits(
          walk,
          c,
          node,
          (rest) => {
            const term = termAt(written, rest);
            return term === null
              ? []
              : typeTags(term)
                  .filter((tag) => tag !== "unknown")
                  .map((tag) => makeItem(tag));
          },
          fallback,
          true,
        );
      if (c.kind === "load") continue;
    }
    if (c.kind === "operation" && c.contract.family === "conversion") {
      // C10: a conversion's default against its result
      const category = conversionCategory(c.contract.name);
      const fallback = defaultOf(c);
      if (category?.kind === "converts" && fallback !== undefined)
        fallbackFits(
          walk,
          c,
          node,
          (rest) => (rest.length === 0 ? [makeItem(category.result)] : []),
          fallback,
        );
    }
    if (
      c.kind === "operation" &&
      c.contract.family === "builtin" &&
      lazyDefaultOperation(c.contract.name, false) !== null
    ) {
      // C10: the default `fileFromBase64`, `decryptText` and `decryptFile` select (ADR 0021 7.2) against their result
      const fallback = defaultOf(c);
      const result = builtinResult(c.contract.name);
      if (fallback !== undefined)
        fallbackFits(
          walk,
          c,
          node,
          (rest) => (rest.length === 0 ? [makeItem(result)] : []),
          fallback,
        );
    }
    if (c.kind === "operation") {
      operation(walk, c, node);
      continue;
    }
    if (c.kind === "project") projection(walk, c, node);
  }
}

/**
 * The node of a compound assignment's operation (`x += y`, the collector's `compound` value): its statement's, where the
 * binary form's operation is its expression's, so both forms meet one operand consumer (C4, F16); `null` for any other.
 */
function compoundNode(walk: Consumers, c: Constraint): FlowNode | null {
  if (c.kind !== "operation") return null;
  const place = walk.pass.program.places[c.result]?.kind;
  if (place?.kind !== "value" || place.node !== "compound") return null;
  return walk.pass.program.flow.statementAt(c.site) ?? null;
}

function operation(
  walk: Consumers,
  c: Extract<ValueConstraint, { kind: "operation" }>,
  node: FlowNode,
): void {
  const { family, name } = c.contract;
  // TSV029: what a choice's buttons return
  if (family === "interaction" && c.evidence?.kind === "choice") choiceValues(walk, c, node);
  if (c.receiver !== null && family !== "operator") {
    // C2: a position or a count, where the receiver may have the method (any other's is its member check's, C5b)
    if (
      (name === "removeAt" || name === "take" || name === "takeLast") &&
      c.arguments.length > 0 &&
      kindsOf(walk, c.receiver, node).some(
        (item) => item.tag === "unknown" || hasMethod(item.tag, name),
      )
    )
      integerOnly(
        walk,
        c.arguments[0]!,
        node,
        c.site,
        name === "removeAt" ? "removeAt" : `the count of ${name}`,
        name,
      );
    if (c.arguments.length > 0 && dictMethod(name)?.parameters[0]?.name === "key") {
      // C12: a dict method's key is text (`contains`, `remove`; `get`'s is its own constraint's); where the receiver may
      // also be a list, a set or text (or unknown), whose method takes another value, only a check, as an index use
      // owes one
      const kinds = kindsOf(walk, c.receiver, node);
      if (kinds.some((item) => item.tag === "dict"))
        consume(
          walk,
          c.arguments[0],
          node,
          c.site,
          TEXT,
          `a dict key at ${name}`,
          { rule: "key" },
          ["string"],
          "operator",
          "operand",
          [],
          kinds.some((item) => item.tag !== "dict" && item.tag !== "null"),
        );
    }
    // F7a: an element selection
    if (name === "removeFirst" || name === "removeLast")
      selection(walk, c.receiver, node, c.site, `.${name}()`);
    methodReceiver(walk, c.site, node, c.receiver, name);
    // C13: what the method's contract takes of its arguments and its elements
    if (family === "method") {
      methodArguments(walk, c, node);
      methodElements(walk, c, node);
    }
    return;
  }
  // C3
  if (family === "logic") {
    for (const argument of c.arguments)
      consume(walk, argument, node, c.site, BOOLEAN, name, { rule: "boolean", operator: name }, [
        "boolean",
      ]);
    return;
  }
  if (family === "interpolation") {
    // C11, F26b: the value and every element of a list must be showable; a list is an element selection
    const value = c.arguments[0];
    if (value === undefined) return;
    const kinds = kindsOf(walk, value, node);
    // (an object's first property, which its sentence shows instead)
    const property = kinds.some((item) => item.tag === "object")
      ? shownProperty(walk, value)
      : null;
    // (a set's elements' and a dict's values' kinds, which a fix may join only where `${...}` shows each, #1268; an
    // empty one joins to empty text)
    const elements = kinds.some((item) => item.tag === "set" || item.tag === "dict")
      ? [
          ...new Set(
            [
              ...walk.run(walk.pass.values.valueItems(value, node, ["element"])),
              ...walk.run(walk.pass.values.valueItems(value, node, ["entry"])),
            ]
              .map((item) => item.tag)
              .filter((tag) => tag !== "empty"),
          ),
        ]
      : [];
    consume(
      walk,
      value,
      node,
      c.site,
      new Set([...SHOWN, "list"]),
      "${...}",
      { rule: "shown", element: false, property, elements },
      [...SHOWN, "list"],
    );
    if (kinds.some((item) => item.tag === "list")) {
      consume(
        walk,
        value,
        node,
        c.site,
        new Set(SHOWN),
        "an element in ${...}",
        { rule: "shown", element: true, property: null, elements: [] },
        SHOWN,
        "operator",
        "operand",
        ["element"],
      );
      selection(walk, value, node, c.site, "${...}");
    } else if (
      // an unknown under a written list type (host data): the type's own check covers its elements, not one's presence
      kinds.some((item) => item.tag === "unknown") &&
      walk.run(walk.pass.contract.contractOfValue(value)).some((item) => item.tag === "list")
    )
      selection(walk, value, node, c.site, "${...}");
    return;
  }
  // C13, Astra's G1: what `toJson` writes
  if (family === "conversion") jsonArgument(walk, c, node);
  const operator = operatorOf(c);
  if (operator !== null) operatorUse(walk, c, operator, node);
}

/** C4: a row of the runtime's operator table (F16). */
function operatorUse(
  walk: Consumers,
  c: Extract<ValueConstraint, { kind: "operation" }>,
  operator: Operator,
  node: FlowNode,
): void {
  const { program } = walk.pass;
  const rows = OPERATOR_ROWS.filter((row) => row.operator === operator);
  const fit = (kinds: readonly ItemTag[]): "row" | "value" | "none" => {
    const row = operatorRow(operator, kinds);
    return row === undefined ? "none" : row.byValue ? "value" : "row";
  };
  // §3.3
  const quiet = c.arguments.map((argument) => quietKinds(walk, argument));
  if (quiet.every((kinds) => kinds !== null)) {
    let combinations: ItemTag[][] = [[]];
    for (const kinds of quiet)
      combinations = combinations.flatMap((done) => kinds!.map((kind) => [...done, kind]));
    if (combinations.every((kinds) => fit(kinds) === "row")) {
      walk.skip(...c.arguments);
      return;
    }
  }
  const operands = c.arguments.map((argument) => withoutEmpty(walk.valueItems(argument, node, [])));
  const matches = (row: (typeof rows)[number], index: number, tag: ItemTag): boolean =>
    row.operands[index] === tag;
  const domain = (index: number): RequiredKind[] => operandDomain(rows, operands, index);
  // D1: an operand's rule names the kinds its place takes; the operation's, none
  // r4.10: an operand's diagnostic sits on its own span, its `operand` obligation names its text
  const operandSite = (index: number): SourceSite => ownSpan(walk, c.arguments[index]!, c.site);
  const rule = (
    index: number | null,
    pair: readonly ItemTag[] = [],
    elements?: readonly ItemTag[],
  ): DiagnosticRule => ({
    rule: "operator",
    operator: c.contract.name,
    operand: index !== null,
    domain:
      index === null
        ? []
        : domain(index).filter(
            (kind): kind is ValueKind => kind !== "unknown" && kind !== "non-null",
          ),
    operands: c.arguments.map((_, index) => operandSite(index)),
    pair,
    ...(elements === undefined ? {} : { elements }),
  });
  // an operand's items its domain takes; none for the operation
  const taken = (index: number | null): Item[] => {
    if (index === null) return [];
    const kinds = domain(index);
    return operands[index]!.filter((item) => kinds.some((kind) => kind === item.tag));
  };
  const operandText = (index: number): string => program.textAt(operandSite(index));
  // C9: external data at an operand is validated where it came in (host data at the operand)
  operands.forEach((items, index) =>
    walk.admission.boundariesAt(
      items,
      obligation("copy-type", operandSite(index), operandText(index), ["unknown"], ""),
    ),
  );
  let combinations: Item[][] = [[]];
  for (const items of operands)
    combinations = combinations.flatMap((done) =>
      items.filter((item) => item.tag !== "unknown").map((item) => [...done, item]),
    );
  const fitted = combinations.map((items) => fit(items.map((item) => item.tag)));
  const opaque = operands.flat().find((item) => isOpaque(item) || isExternal(item));
  if (
    combinations.length > 0 &&
    fitted.every((found) => found === "none") &&
    opaque === undefined &&
    operands.flat().every((item) => item.cert === "def")
  ) {
    const offending = operands.flatMap((items, index) =>
      items.every((item) => !rows.some((row) => matches(row, index, item.tag))) ? [index] : [],
    );
    // (`+` beside a list: the list's elements' type, which a fix's list must hold, TABLE r4.151)
    const list =
      operator === "+"
        ? operands.findIndex((items) => items.every((item) => item.tag === "list"))
        : -1;
    const elements =
      list < 0
        ? undefined
        : withoutEmpty(
            walk.run(walk.pass.contract.contractOfValueAt(c.arguments[list]!, ["element"])),
          ).map((item) => item.tag);
    if (offending.length === 0)
      error(
        walk,
        "operator",
        c.site,
        rule(
          null,
          operands.map((items) => items[0]!.tag),
          elements,
        ),
        operands.map((items) => items[0]!.tag),
      );
    else
      for (const index of offending)
        error(
          walk,
          "operator",
          operandSite(index),
          rule(index, [], elements),
          operands[index]!.map((item) => item.tag),
        );
    return;
  }
  const owe = (
    item: Item,
    site: SourceSite,
    target: string,
    against: readonly RequiredKind[],
    index: number | null,
    pair: readonly ItemTag[] = [],
  ): boolean =>
    warning(
      walk,
      "operator",
      site,
      item,
      obligation(
        "operand",
        site,
        target,
        against,
        `check the operand of ${c.contract.name} when it runs`,
      ),
      rule(index, pair),
      taken(index),
    );
  // the kind obligations (§4: one per offending kind of an operand; every operand that may be null owes its own
  // null-check below, S4). §3.4, §10.5 (r4.10): in each failing combination without a null, an operand whose kind no
  // row takes at its place, or else the one operand whose kind no row takes beside the other operands' kinds, owes
  // the obligation at its span; where no single operand offends (the pair has no row; a value predicate of the row
  // decides) the operation owes it once, at its span, its text the target. An unknown operand owes its own
  const fitsBeside = (index: number, tag: ItemTag): boolean =>
    rows.some(
      (row) =>
        matches(row, index, tag) &&
        operands.every(
          (items, other) =>
            other === index ||
            items.some((item) => item.tag === "unknown" || matches(row, other, item.tag)),
        ),
    );
  // (each offending operand with the kinds of the combination it offends in, which its sentence names)
  const offending = new Map<string, [number, Item, readonly ItemTag[]]>();
  const offend = (index: number, item: Item, pair: readonly ItemTag[] = []): void => {
    const key = joinParts(index, item.fan === undefined ? item.tag : `fan ${item.fan}`);
    if (!offending.has(key)) offending.set(key, [index, item, pair]);
  };
  // (the operation's offending item, what it owes, and its combination's kinds, which its fixes name)
  let operation: [Item, readonly RequiredKind[], readonly ItemTag[]] | null = null;
  for (const [at, items] of combinations.entries()) {
    if (fitted[at] === "row" || items.some((item) => item.tag === "null")) continue;
    if (fitted[at] === "value") {
      operation ??= [
        items.find((item) => item.cert === "pos") ?? items[0]!,
        ["calendarDuration"],
        items.map((item) => item.tag),
      ];
      continue;
    }
    let places = items
      .map((_, index) => index)
      .filter((index) => !rows.some((row) => matches(row, index, items[index]!.tag)));
    if (places.length === 0)
      places = items
        .map((_, index) => index)
        .filter((index) => !fitsBeside(index, items[index]!.tag));
    if (places.length === 1)
      offend(
        places[0]!,
        items[places[0]!]!,
        items.map((item) => item.tag),
      );
    else
      operation ??= [
        items.find((item) => item.cert === "pos") ?? items[0]!,
        domain(0),
        items.map((item) => item.tag),
      ];
  }
  operands.forEach((items, index) => {
    const unknown = items.find((item) => isOpaque(item) || isExternal(item));
    if (unknown !== undefined) offend(index, unknown);
  });
  for (const [index, item, pair] of offending.values())
    owe(item, operandSite(index), operandText(index), domain(index), index, pair);
  if (operation !== null) {
    const [item, against, pair] = operation;
    owe(item, c.site, program.textAt(c.site), against, null, pair);
  }
  operands.forEach((items, index) => {
    const nullItem = items.find((item) => item.tag === "null");
    if (nullItem === undefined) return;
    const label = keyLabel(walk, c.arguments[index]!);
    warning(
      walk,
      "operator",
      operandSite(index),
      nullItem,
      obligation(
        "null-check",
        operandSite(index),
        label,
        domain(index),
        `check that ${label} is not null before ${c.contract.name}`,
      ),
      rule(index),
      taken(index),
    );
  });
}
