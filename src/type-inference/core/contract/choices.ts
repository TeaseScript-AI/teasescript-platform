import { VALUE_KINDS, type ValueKind } from "../../../value-kinds.js";
import type { ChoiceObjectEvidence, ChoiceOptionEvidence, PlaceId } from "../../graph.js";
import { joinSteps } from "../budget.js";
import { SELECTED_TEXT, SELECTED_VALUE } from "../definitions.js";
import { withoutEmpty } from "../exact-path.js";
import { differsIn, makeItem, REASON, weaken, type Item } from "../items.js";
import type { ValueConstraint } from "../program.js";
import type { Work } from "../solver.js";
import type { ChoiceGroup, ChoicePart, StoredChoiceKeys } from "./model.js";

// A choice's items: its options' labels and values as its answer reads them.

/** The contributions of one kind a value-side gather reads inline; past it, a balanced tree of demands (`gathered`). */
export const WIDE = 8;

/**
 * V30 §19: per option of an `askChoice`, by index, the kind its written label gives, `null` for a labelled list or set
 * written empty (no button), or `undefined` without a label.
 */
export function choiceLabels(c: ValueConstraint): readonly (ValueKind | null | undefined)[] {
  const known = LABELS.get(c);
  if (known !== undefined) return known;
  const evidence = "evidence" in c ? c.evidence : undefined;
  if (evidence?.kind !== "choice") return [];
  const labels = evidence.options.map((option) =>
    option.label === null
      ? undefined
      : (option.content.kind === "list" || option.content.kind === "set") &&
          option.content.elements.length === 0
        ? null
        : option.label.kind,
  );
  LABELS.set(c, labels);
  return labels;
}

/** Per written list or set option's elements, whether every one is a choice object (`choiceItems`), asked once. */
const OBJECTS_ONLY = new WeakMap<readonly unknown[], boolean>();

/** Each choice's labels (`choiceLabels`), made once: a wide choice's every part reads them. */
const LABELS = new WeakMap<ValueConstraint, readonly (ValueKind | null | undefined)[]>();

/**
 * V30 §19, TABLE r4.46 (1): an `askChoice`'s answer at `rest`, read by `read`: per option its label's kind, or each of
 * its buttons' values. Whether a choice object gives its `value` or its `text` is decided by the key's presence in the
 * object, never by what the key's value resolves to (an empty answer is unresolved, the solver's bottom, never an absent
 * key): a written choice object (the whole option, or an element of a written list or set) by the keys it writes; one
 * the options hold without writing it (a variable's, a call's) per record alternative where its path meets the records
 * (`SELECTED_VALUE`, `SELECTED_TEXT`, the literal's objects). Where a store goes below a property of that name after
 * a record is made (`stored`), that key is read by its key instead, as the literal's records no longer say what it
 * holds: the `value` as its key gives it, and every record's `text` where some record lacks the `value` (F11's
 * `missing`), possible where some has one. Only the `options` are read (`Contract.choiceOptions`: one of each class),
 * in order, those of the `part` asked (a wide choice's, `Values.choiceRange`, `Values.choiceElements`).
 */
export function* choiceItems(
  c: Extract<ValueConstraint, { readonly kind: "operation" }>,
  rest: readonly string[],
  read: (value: PlaceId, path: readonly string[], element?: true) => Work<readonly Item[]>,
  stored: StoredChoiceKeys,
  options: readonly ChoiceGroup[],
  part: ChoicePart = {},
): Work<Item[]> {
  // r4.93: the answer is a scalar button (V30 §19, TSV029): an outer choice's selection of it is the button itself
  if (rest[0] === SELECTED_VALUE || rest[0] === SELECTED_TEXT)
    return yield* choiceItems(c, rest.slice(1), read, stored, options, part);
  const out: Item[] = [];
  const evidence = "evidence" in c && c.evidence?.kind === "choice" ? c.evidence.options : [];
  const labels = choiceLabels(c);
  // a button's value is a choice value, a scalar (V30 §19, TSV029, TABLE r4.93): a value of another type is no answer,
  // as the run stops at it (`choiceValues`' error or check), and nothing stands below a scalar but an unknown's own
  // parts, so no record a button holds is ever composed into the answer
  const buttonValue = function* (
    place: PlaceId,
    path: readonly string[],
    element?: true,
  ): Work<Item[]> {
    const value = withoutEmpty(yield* read(place, path, element));
    if (rest.length === 0) return value.filter(returned);
    if (!value.some((item) => item.tag === "unknown")) return [];
    return withoutEmpty(yield* read(place, joinSteps(path, rest), element)).filter(
      (item) => item.tag === "unknown",
    );
  };
  // a choice object the options hold without writing it: per record alternative its `value` or its `text`; a key with a
  // store below it by its key: the `value` as its key gives it, the `text` of every record where some lacks the `value`,
  // possible where some has one
  const held = function* (option: PlaceId, at: readonly string[]): Work<void> {
    const value =
      stored.value || stored.text
        ? withoutEmpty(yield* read(option, joinSteps(at, ["value"])))
        : [];
    const lacking = value.some(isMissing);
    const present = withoutMissing(value);
    if (!stored.value) out.push(...(yield* buttonValue(option, joinSteps(at, [SELECTED_VALUE]))));
    else if (present.length > 0 || !lacking)
      out.push(
        ...(rest.length === 0
          ? present.filter(returned)
          : yield* buttonValue(option, joinSteps(at, ["value"]))),
      );
    if (!stored.text) out.push(...(yield* buttonValue(option, joinSteps(at, [SELECTED_TEXT]))));
    else if (lacking) {
      const text = yield* buttonValue(option, joinSteps(at, ["text"]));
      out.push(...(present.length > 0 ? weaken(text) : text));
    }
  };
  // a written choice object's `value`, or its `text` without one; any other option or element by its value
  const button = function* (
    place: PlaceId,
    object: ChoiceObjectEvidence | null,
    element: boolean,
  ): Work<void> {
    const selected = object === null ? null : (object.value ?? object.text);
    if (object !== null && selected !== null) {
      // an element of a written list or set reads as its literal analogue, below the list's element step (F12 r4.7)
      const key = object.value !== null ? "value" : "text";
      out.push(...(yield* element ? buttonValue(place, [key], true) : buttonValue(selected, [])));
      return;
    }
    const items = withoutEmpty(yield* read(place, []));
    if (items.some((item) => item.tag === "object")) yield* held(place, []);
    for (const item of items)
      if (item.tag !== "object" && (rest.length === 0 ? returned(item) : item.tag === "unknown"))
        out.push(item);
  };
  const option = function* (index: number): Work<void> {
    const argument = c.arguments[index]!;
    const label = labels[index];
    if (label !== undefined) {
      if (label !== null && rest.length === 0) out.push(makeItem(label));
      return;
    }
    const content: ChoiceOptionEvidence["content"] | undefined = evidence[index]?.content;
    if (content?.kind === "object") {
      yield* button(argument, content.object, false);
      return;
    }
    if (content?.kind === "list" || content?.kind === "set") {
      // written choice objects alone: together below the list's element step, as its literal analogue reads them
      // (§3.4: several elements), each by the keys it writes, which no store reaches before the choice (once per list:
      // a wide choice's every part asks it)
      let objects = OBJECTS_ONLY.get(content.elements);
      if (objects === undefined)
        OBJECTS_ONLY.set(
          content.elements,
          (objects =
            content.elements.length > 0 &&
            content.elements.every((element) => element.object !== null)),
        );
      if (objects)
        for (const step of [SELECTED_VALUE, SELECTED_TEXT])
          out.push(...(yield* buttonValue(argument, ["element", step])));
      else if (part.wide !== undefined && content.elements.length > WIDE)
        out.push(...(yield* part.wide(index, content.elements.length, rest)));
      else
        for (const element of content.elements) yield* button(element.place, element.object, true);
      return;
    }
    // a computed option: a list's or a set's elements, a choice object, or a value
    const items = withoutEmpty(yield* read(argument, []));
    if (items.some((item) => item.tag === "list" || item.tag === "set"))
      for (const item of withoutEmpty(yield* read(argument, ["element"])))
        if (item.tag === "object") yield* held(argument, ["element"]);
        else if (rest.length === 0 ? returned(item) : item.tag === "unknown") out.push(item);
    if (items.some((item) => item.tag === "object")) yield* held(argument, []);
    for (const item of items)
      if (item.tag === "list" || item.tag === "set" || item.tag === "object") continue;
      else if (rest.length === 0 ? returned(item) : item.tag === "unknown") out.push(item);
  };
  // (a wide written list's elements of [lo, hi), `Values.choiceElements`)
  if (part.elements !== undefined) {
    const content = evidence[part.elements.index]?.content;
    if (content?.kind === "list" || content?.kind === "set")
      for (const element of content.elements.slice(part.elements.lo, part.elements.hi))
        yield* button(element.place, element.object, true);
    return out;
  }
  for (const { read: chosen, rest: others, mixed } of options.slice(part.lo, part.hi)) {
    const from = out.length;
    for (const index of chosen) yield* option(index);
    // (a mixed class's options differ where their answer holds a leaf or an operand's identity: each is read)
    if (others.length > 0 && out.slice(from).some((item) => differsIn(item, mixed)))
      for (const index of others) yield* option(index);
  }
  return out;
}

/** Whether an answer may hold this item: a choice value a button returns, or an unknown the run checks. */
const returned = (item: Item): boolean =>
  item.tag === "unknown" || (item.tag !== "empty" && VALUE_KINDS[item.tag].choice);

/** A property read that found no such property. */
const isMissing = (item: Item): boolean =>
  item.tag === "unknown" && (item.reasons & REASON.missing) !== 0;

/** Items without their missing alternative: an unknown only missing goes, one with another reason keeps that reason. */
function withoutMissing(items: readonly Item[]): Item[] {
  return items.flatMap((item) =>
    !isMissing(item)
      ? [item]
      : item.reasons === REASON.missing
        ? []
        : [{ ...item, reasons: item.reasons & ~REASON.missing }],
  );
}
