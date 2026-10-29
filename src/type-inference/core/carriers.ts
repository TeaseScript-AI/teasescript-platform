import type { PlaceId } from "../graph.js";
import { choiceLabels, defaultOf, REFERENCE } from "./contract.js";
import { keptSteps } from "./budget.js";
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
 * them: admission's stops and structures, its landing index, the written-copy index and the obligations they leave
 * (`admission.ts`), and the property names (`answers.ts`). A literal is structure, no carrier: its cells
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
 * The roles an operand plays for its carrier (S6-CARRIERS §1), each `kind/role`: a choice option's four rows read its
 * selected value or text, directly or at a list option's element (V30 §19).
 */
export const CARRIER_ROLES = [
  "projection/owner",
  "projection/record field",
  "projection/dict values",
  "iteration/collection",
  "otherwise/operand",
  "otherwise/fallback",
  "get/receiver",
  "get/default",
  "load default/default",
  "parse default/default",
  "copy/receiver",
  "removal/receiver",
  "concatenation/operand",
  "choice/option value",
  "choice/option text",
  "choice/option element value",
  "choice/option element text",
] as const;

export type CarrierRole = (typeof CARRIER_ROLES)[number];

/**
 * One operand of a carrier: its role, and its evaluation position among the carrier's operands (a `get`'s default is
 * 2, its key 1); the carrier's value stands at `below` inside it; `own` where it is the carrier's own read (C10: a
 * fallback or a default names its own read, an ingress there checked at it); `when`, the decision of the value side it
 * needs (`carried`): the operand a list or a set (F27), an object or a dict (r4.46 (2)), read at its elements only (a
 * copy of the elements, a list's `+`: F10), or a dict where a removal gives a list's possible element (F7).
 */
export interface Operand {
  readonly kind: CarrierKind;
  readonly role: CarrierRole;
  readonly position: number;
  readonly operand: PlaceId;
  readonly below: readonly string[];
  readonly own: boolean;
  readonly when: "list or set" | "object" | "dict" | "elements" | null;
}

/** The table: a value's carrier operands by its syntax alone, before any decision (the landing index reads it so). */
export function operandsOf(program: CoreProgram, value: PlaceId): readonly Operand[] {
  const operand = (
    role: CarrierRole,
    position: number,
    of: PlaceId,
    below: readonly string[],
    own = false,
    when: Operand["when"] = null,
  ): Operand => ({
    // EVIDENCE: invariant: every role of `CARRIER_ROLES` begins with its kind of `CARRIER_KINDS`, before the slash.
    kind: role.slice(0, role.indexOf("/")) as CarrierKind,
    role,
    position,
    operand: of,
    below,
    own,
    when,
  });
  const projection = program.projOf.get(value);
  if (projection !== undefined) {
    const { owner, step } = projection;
    if (step === "iteration")
      return [operand("iteration/collection", 0, owner, ["element"], false, "list or set")];
    const list = dictList(step);
    if (list === undefined) return [operand("projection/owner", 0, owner, [stepName(step)])];
    // r4.46 (2): an object's own property of the name, or a dict's values (its keys hold text)
    return [
      operand("projection/record field", 0, owner, [step], false, "object"),
      ...(list === "values"
        ? [operand("projection/dict values", 0, owner, [], false, "dict")]
        : []),
    ];
  }
  const c = program.opOf.get(value);
  if (c === undefined) return [];
  if (c.kind === "fallback")
    return [
      operand("otherwise/operand", 0, c.left, []),
      operand("otherwise/fallback", 1, c.right, [], true),
    ];
  if (c.kind === "get")
    return [
      operand("get/receiver", 0, c.receiver, ["element"]),
      operand("get/default", 2, c.fallback, [], true),
    ];
  if (c.kind === "load")
    return c.fallback === null ? [] : [operand("load default/default", 1, c.fallback, [], true)];
  if (c.kind !== "operation") return [];
  const { family, name } = c.contract;
  if (family === "conversion" && conversionCategory(name)?.kind === "parses") {
    const fallback = defaultOf(c);
    const position = fallback === undefined ? -1 : c.arguments.indexOf(fallback);
    return fallback === undefined
      ? []
      : [operand("parse default/default", position < 0 ? 1 : position, fallback, [], true)];
  }
  if (family === "method" && c.receiver !== null) {
    const gives = methodCategory(name)?.gives;
    if (gives?.kind === "copy")
      return [operand("copy/receiver", 0, c.receiver, [], false, "elements")];
    if (gives?.kind === "removed")
      return [
        operand(
          "removal/receiver",
          0,
          c.receiver,
          ["element"],
          false,
          gives.fromList === "element" ? null : "dict",
        ),
      ];
    return [];
  }
  if (family === "operator" && name === "+")
    return c.arguments.map((argument, index) =>
      operand("concatenation/operand", index, argument, [], false, "elements"),
    );
  if (family === "interaction" && interactionCategory(name)?.kind === "options") {
    const labels = choiceLabels(c);
    // V30 §19: an unlabelled option's button value, a choice object's selected `value` or `text`, or each of a list's
    return c.arguments.flatMap((argument, index) =>
      labels[index] === undefined
        ? [
            operand("choice/option value", index, argument, [SELECTED_VALUE]),
            operand("choice/option text", index, argument, [SELECTED_TEXT]),
            operand("choice/option element value", index, argument, ["element", SELECTED_VALUE]),
            operand("choice/option element text", index, argument, ["element", SELECTED_TEXT]),
          ]
        : [],
    );
  }
  return [];
}

/**
 * The value side's decisions a walk asks before it carries (F19a's RECEIVER decision, the contract's kinds, and whether
 * a list `+` keeps an operand admission did not reject from it: A6, `joinElements`).
 */
export interface Dispatch {
  kinds(of: PlaceId): ReadonlySet<ItemTag>;
  reference(receiver: PlaceId): boolean;
  joined(operand: PlaceId): boolean;
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

/** Whether a value is an `askChoice`'s answer. */
function isChoice(program: CoreProgram, value: PlaceId): boolean {
  const c = program.opOf.get(value);
  return (
    c?.kind === "operation" &&
    c.contract.family === "interaction" &&
    interactionCategory(c.contract.name)?.kind === "options"
  );
}

/**
 * The values a value carries, each with the path into it its own value is read at (`strip`: the path below it still to
 * read), its role and its evaluation position, after the value side's decisions: nothing where the operation keeps its
 * own value (F19a, F19), and each operand only where its decision allows it.
 */
export function carried(
  program: CoreProgram,
  value: PlaceId,
  strip: readonly string[],
  dispatch: Dispatch,
): readonly (readonly [PlaceId, readonly string[], CarrierRole, number])[] {
  if (keepsOwn(program, value, dispatch)) return [];
  if (isChoice(program, value)) {
    // r4.93: a choice's answer is a scalar button (V30 §19, TSV029), so an outer choice's rows reach it once: its
    // `#value` row as the button itself, its `#text` row the same button again, its element rows nothing
    const selection = (step: string | undefined): boolean =>
      step === SELECTED_VALUE || step === SELECTED_TEXT;
    if (strip[0] === SELECTED_TEXT || (strip[0] === "element" && selection(strip[1]))) return [];
    if (strip[0] === SELECTED_VALUE) return carried(program, value, strip.slice(1), dispatch);
  }
  const elements = strip.length === 0 || strip[0] === "element";
  const out: (readonly [PlaceId, readonly string[], CarrierRole, number])[] = [];
  let kinds: ReadonlySet<ItemTag> | null = null;
  for (const { operand, below, when, role, position } of operandsOf(program, value)) {
    if (when === "elements" && !elements) continue;
    if (role === "concatenation/operand" && !dispatch.joined(operand)) continue;
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
    out.push([operand, keptSteps(program.work, below, strip), role, position]);
  }
  return out;
}
