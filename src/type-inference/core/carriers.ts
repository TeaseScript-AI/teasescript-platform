import type { PlaceId } from "../graph.js";
import { choiceLabels, defaultOf, REFERENCE } from "./contract.js";
import { SELECTED_TEXT, SELECTED_VALUE } from "./definitions.js";
import type { ItemTag } from "./items.js";
import {
  conversionCategory,
  dictList,
  interactionCategory,
  methodCategory,
} from "./method-categories.js";
import { stepName, type CoreProgram } from "./program.js";

/*
 * The carriers (S6): the values that are, or hold, another value, their operand. One table, read by every walk over
 * them: admission's stops and structures, the written-copy index and the obligations they leave (`admission.ts`), the
 * ingress index (`definitions.ts`) and the property names (`answers.ts`). A literal is structure, no carrier: its cells
 * stand at its element or property step, read through the literal index.
 */

/** The carrier kinds, each a row of `operandsOf`. */
export const CARRIER_KINDS = [
  "projection",
  "iteration",
  "otherwise",
  "get",
  "load default",
  "parse default",
  "copy",
  "removal",
  "concatenation",
  "choice",
] as const;

export type CarrierKind = (typeof CARRIER_KINDS)[number];

/**
 * One operand of a carrier: the carrier's value stands at `below` inside it; `own` where it is the carrier's own read
 * (C10: a fallback or a default names its own read, an ingress there checked at it); `when`, the decision of the value
 * side it needs (`carried`): the operand a list or a set (F27), an object or a dict (r4.46 (2)), read at its elements
 * only (a copy of the elements, a list's `+`: F10), or a dict where a removal gives a list's possible element (F7).
 */
export interface Operand {
  readonly kind: CarrierKind;
  readonly operand: PlaceId;
  readonly below: readonly string[];
  readonly own: boolean;
  readonly when: "list or set" | "object" | "dict" | "elements" | null;
}

/** The table: a value's carrier operands by its syntax alone, before any decision (the ingress index reads it so). */
export function operandsOf(program: CoreProgram, value: PlaceId): readonly Operand[] {
  const operand = (
    kind: CarrierKind,
    of: PlaceId,
    below: readonly string[],
    own = false,
    when: Operand["when"] = null,
  ): Operand => ({ kind, operand: of, below, own, when });
  const projection = program.projOf.get(value);
  if (projection !== undefined) {
    const { owner, step } = projection;
    if (step === "iteration")
      return [operand("iteration", owner, ["element"], false, "list or set")];
    const list = dictList(step);
    if (list === undefined) return [operand("projection", owner, [stepName(step)])];
    // r4.46 (2): an object's own property of the name, or a dict's values (its keys hold text)
    return [
      operand("projection", owner, [step], false, "object"),
      ...(list === "values" ? [operand("projection", owner, [], false, "dict")] : []),
    ];
  }
  const c = program.opOf.get(value);
  if (c === undefined) return [];
  if (c.kind === "fallback")
    return [operand("otherwise", c.left, []), operand("otherwise", c.right, [], true)];
  if (c.kind === "get")
    return [operand("get", c.receiver, ["element"]), operand("get", c.fallback, [], true)];
  if (c.kind === "load")
    return c.fallback === null ? [] : [operand("load default", c.fallback, [], true)];
  if (c.kind !== "operation") return [];
  const { family, name } = c.contract;
  if (family === "conversion" && conversionCategory(name)?.kind === "parses") {
    const fallback = defaultOf(c);
    return fallback === undefined ? [] : [operand("parse default", fallback, [], true)];
  }
  if (family === "method" && c.receiver !== null) {
    const gives = methodCategory(name)?.gives;
    if (gives?.kind === "copy") return [operand("copy", c.receiver, [], false, "elements")];
    if (gives?.kind === "removed")
      return [
        operand(
          "removal",
          c.receiver,
          ["element"],
          false,
          gives.fromList === "element" ? null : "dict",
        ),
      ];
    return [];
  }
  if (family === "operator" && name === "+")
    return c.arguments.map((argument) => operand("concatenation", argument, [], false, "elements"));
  if (family === "interaction" && interactionCategory(name)?.kind === "options") {
    const labels = choiceLabels(c);
    // V30 §19: an unlabelled option's button value, a choice object's selected `value` or `text`, or each of a list's
    return c.arguments.flatMap((argument, index) =>
      labels[index] === undefined
        ? [
            operand("choice", argument, [SELECTED_VALUE]),
            operand("choice", argument, [SELECTED_TEXT]),
            operand("choice", argument, ["element", SELECTED_VALUE]),
            operand("choice", argument, ["element", SELECTED_TEXT]),
          ]
        : [],
    );
  }
  return [];
}

/**
 * Whether the runtime reads a member of the operand to give the carrier's value (F15, C5: a projection's owner, an
 * iteration's list or set, `get`'s receiver, a copying or removing method's receiver), not the operand as a whole value
 * (`otherwise`, a default, a list's `+`, a choice's option).
 */
export function memberAccess(operand: Operand): boolean {
  return (
    operand.kind === "projection" ||
    operand.kind === "iteration" ||
    operand.kind === "copy" ||
    operand.kind === "removal" ||
    (operand.kind === "get" && !operand.own)
  );
}

/** The value side's decisions a walk asks before it carries (F19a's RECEIVER decision, the contract's kinds). */
export interface Dispatch {
  kinds(of: PlaceId): ReadonlySet<ItemTag>;
  reference(receiver: PlaceId): boolean;
}

/**
 * F19a, F19: whether the receiver's or the key's decision leaves a value's operation its own value, before any operand
 * is selected or a written type carried: a projection, a `get` or a method of a receiver that may be a reference (the
 * runtime's member, opaque), a `load` of a computed key (external data, whatever its default).
 */
export function keepsOwn(program: CoreProgram, value: PlaceId, dispatch: Dispatch): boolean {
  const projection = program.projOf.get(value);
  if (projection !== undefined)
    return projection.step !== "iteration" && dispatch.reference(projection.owner);
  const c = program.opOf.get(value);
  if (c?.kind === "get") return dispatch.reference(c.receiver);
  if (c?.kind === "load") return c.key === null;
  return (
    c?.kind === "operation" &&
    c.contract.family === "method" &&
    c.receiver !== null &&
    dispatch.reference(c.receiver)
  );
}

/**
 * The values a value carries, each with the path into it its own value is read at (`strip`: the path below it still to
 * read) and its table row, after the value side's decisions: nothing where the operation keeps its own value (F19a,
 * F19), and each operand only where its decision allows it.
 */
export function carried(
  program: CoreProgram,
  value: PlaceId,
  strip: readonly string[],
  dispatch: Dispatch,
): readonly (readonly [PlaceId, readonly string[], Operand])[] {
  if (keepsOwn(program, value, dispatch)) return [];
  const elements = strip.length === 0 || strip[0] === "element";
  const out: (readonly [PlaceId, readonly string[], Operand])[] = [];
  let kinds: ReadonlySet<ItemTag> | null = null;
  for (const row of operandsOf(program, value)) {
    const { operand, below, when } = row;
    if (when === "elements" && !elements) continue;
    if (when === "list or set" || when === "object" || when === "dict") {
      kinds ??= dispatch.kinds(operand);
      if (when === "list or set" && !kinds.has("list") && !kinds.has("set")) continue;
      // (a receiver that may be a reference has the runtime's members, none known: F19a)
      if (when !== "list or set" && [...kinds].some((tag) => REFERENCE.has(tag))) continue;
      if (when === "object" && !kinds.has("object")) continue;
      if (when === "dict" && !kinds.has("dict")) continue;
      // (a dict's `values` are its elements: read at an element path only)
      if (when === "dict" && below.length === 0 && !elements) continue;
    }
    out.push([operand, [...below, ...strip], row]);
  }
  return out;
}
