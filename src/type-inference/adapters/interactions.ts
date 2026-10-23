import { isFormFieldKind } from "../../form-fields.js";
import type { FormFieldKind } from "../../plan/model.js";
import { isCalendar } from "../../duration.js";
import { PERSON_FIELDS, SPEAKER_NAME_LISTS } from "../../speaker-terms.js";
import {
  BOOLEAN_TYPE,
  DATE_TYPE,
  DATETIME_TYPE,
  DURATION_TYPE,
  INTEGER_TYPE,
  isKnown,
  isNullable,
  isScalar,
  isScalarKind,
  joinTypes,
  members,
  nonNullType,
  NUMBER_TYPE,
  optional,
  plainType,
  PropertyTable,
  resolved,
  STRING_TYPE,
  TIME_TYPE,
  union,
  UNKNOWN_TYPE,
  valueKindOfType,
  withValues,
  type ScalarValue,
  type StaticType,
} from "../../static-types.js";
import { VALUE_KIND_NAMES, VALUE_KINDS } from "../../value-kinds.js";
import type {
  ChoiceElementEvidence,
  ChoiceObjectEvidence,
  ContractFamily,
  DynamicWhy,
  FormDescriptorEvidence,
  PlaceId,
  SyntaxEvidence,
  WrittenLiteral,
} from "../graph.js";
import type { OperationInputs, OperationRelation, OperationResult } from "./relation.js";
import {
  closedType,
  dynamicResult,
  INVALID,
  isBottom,
  typeResult,
  UNCONSTRAINED,
} from "./views.js";

/**
 * The interactions and the command expressions (O4 stage 2b, work note §5.6 and §5.7): the asks with a fixed answer,
 * `askChoice` as `#interactionTask` and `#choiceEntry` of the legacy checker decide a button's value, `askForm` as
 * `#formAnswersTask`, `#formField`, `#writtenFormField`, `#computedFormField` and `#cycleAnswerType` decide a
 * field's answer, and the handles the commands give. What the legacy reads from the source (labels, literals,
 * written choice objects and descriptors) comes from the `choice` and `form` evidence; the operands' types from
 * their places. The rows of `tests/fixtures/type-inference/adapter-cases/{choice,form}.jsonl` pin each branch
 * against the legacy; what it reports and leaves unknown is `invalid`, and what it leaves unknown without a report is
 * `dynamic` of the operand's provenance, or of `unknown member` where it does not look into a closed operand.
 */

/** The answer of a field whose kind only the runtime knows (the legacy's `GENERIC_FORM_ANSWER_TYPE`). */
const GENERIC_FORM_ANSWER_TYPE: StaticType = union([
  BOOLEAN_TYPE,
  NUMBER_TYPE,
  STRING_TYPE,
  DATE_TYPE,
  TIME_TYPE,
  DATETIME_TYPE,
  ...VALUE_KIND_NAMES.flatMap((kind): StaticType[] =>
    VALUE_KINDS[kind].choice && isScalarKind(kind) ? [{ kind: "scalar", name: kind }] : [],
  ),
]);

/** Whether a button may return a value of this member type (`choice`), or may. */
function isChoiceValue(member: StaticType): boolean {
  const kind = valueKindOfType(member);
  return kind === undefined || VALUE_KINDS[kind].choice;
}

function unknownPart(type: StaticType): boolean {
  return type.kind === "unknown" || type.kind === "open";
}

/** A relation waits for a bottom operand: thrown where one is met, answered at the top. */
class Unconstrained extends Error {}

/**
 * The types at the places an interaction's evidence names, with the provenance of the ones the compiler cannot
 * know: the legacy's `unknown` there, and the relation's `dynamic` when the answer rests on one.
 */
class Places {
  readonly whys: DynamicWhy[] = [];
  constructor(private readonly inputs: OperationInputs) {}

  type(place: PlaceId): StaticType {
    const view = this.inputs.view(place);
    if (isBottom(view)) throw new Unconstrained();
    // A value that may also be one the compiler cannot know is, as the legacy holds it, not known at all.
    if (view.dynamic !== null) {
      this.whys.push(view.dynamic);
      return UNKNOWN_TYPE;
    }
    return closedType(view)!;
  }

  /** The legacy's `unknown` without a report: of the operand's provenance, or of its own limit. */
  dynamic(): OperationResult {
    return dynamicResult(this.whys[0] ?? "unknown member");
  }
}

function answer(
  evidence: SyntaxEvidence | undefined,
  inputs: OperationInputs,
  decide: (places: Places) => OperationResult,
): OperationResult {
  const places = new Places(inputs);
  try {
    return decide(places);
  } catch (error) {
    if (error instanceof Unconstrained) return UNCONSTRAINED;
    throw error;
  } finally {
    void evidence;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// askChoice

/** `#checkMembers`: a value is rejected when a known non-null member is not accepted (a mix is reported as may-be). */
function rejects(type: StaticType, accepts: (member: StaticType) => boolean): boolean {
  const known = members(nonNullType(type)).filter(isKnown);
  return known.length > 0 && !known.every(accepts);
}

/** `#checkElements`: whether a collection's known elements, or the members beside it, fail the check. */
function rejectsElements(type: StaticType, accepts: (element: StaticType) => boolean): boolean {
  for (const member of members(type).map(resolved))
    if (member.kind === "list" || member.kind === "set")
      for (const element of members(member.element).filter(isKnown))
        if (!accepts(element)) return true;
  return false;
}

/** The value a written literal stands for in a restricted choice: a duration its milliseconds, an angle its degrees. */
function literalOf(literal: WrittenLiteral): ScalarValue | null | undefined {
  if (literal === null) return undefined;
  const known = literal.value;
  if (known === null || typeof known !== "object") return known;
  if (known.kind === "angle") return known.degrees;
  return isCalendar(known) ? undefined : known.milliseconds;
}

/** `restrictedChoice`: the values' types, each scalar restricted to the literals its buttons return. */
function restrictedChoice(
  types: readonly StaticType[],
  values: readonly (ScalarValue | null)[],
): StaticType {
  const families = new Map<string, { name: string; values: ScalarValue[] }>();
  const parts: StaticType[] = [];
  for (const [index, type] of types.entries()) {
    const value = resolved(type);
    const literal = values[index];
    if (value.kind !== "scalar" || literal === null || literal === undefined) {
      parts.push(type);
      continue;
    }
    const key = value.name === "integer" ? "number" : value.name;
    const family = families.get(key) ?? { name: value.name, values: [] };
    if (family.name !== value.name) family.name = "number";
    family.values.push(literal);
    families.set(key, family);
  }
  for (const family of families.values()) {
    const kind = VALUE_KIND_NAMES.find((candidate) => candidate === family.name);
    if (kind !== undefined && isScalarKind(kind))
      parts.push(withValues({ kind: "scalar", name: kind }, family.values));
  }
  return union(parts);
}

/**
 * `#choiceEntry`: what gives one button, a value or a choice object whose value, else its text, the button returns.
 * Rejected means the legacy reports and takes `unknown`; a computed choice object's value is not known.
 */
function choiceEntry(
  places: Places,
  type: StaticType,
  object: ChoiceObjectEvidence | null,
  inList: boolean,
): { readonly type: StaticType; readonly rejected: boolean } {
  const value = resolved(nonNullType(type));
  const accepted = (member: StaticType): boolean => {
    const kind = resolved(member).kind;
    return (
      isChoiceValue(member) || kind === "object" || (!inList && (kind === "list" || kind === "set"))
    );
  };
  if (rejects(type, accepted)) return { type: UNKNOWN_TYPE, rejected: true };
  if (object === null)
    return { type: value.kind === "object" ? UNKNOWN_TYPE : type, rejected: false };
  // A written choice object without `text` is reported (the visitor's check); without `value` too, what its button
  // returns is not known.
  const returned = object.value ?? object.text;
  return { type: returned === null ? UNKNOWN_TYPE : places.type(returned), rejected: false };
}

function choice(inputs: OperationInputs): OperationResult {
  const evidence = inputs.evidence;
  if (evidence?.kind !== "choice") return INVALID;
  return answer(evidence, inputs, (places) => {
    const values: StaticType[] = [];
    let literals: (ScalarValue | null)[] | null = [];
    const add = (type: StaticType, literal: ScalarValue | null | undefined): void => {
      values.push(type);
      if (literal === undefined) literals = null;
      else literals?.push(literal);
    };
    let rejected = false;
    let empty = true;
    for (const option of evidence.options) {
      const label = option.label;
      if (label !== null) {
        // A label is the button's value whatever the option holds (the visitor checks the option): a written list
        // or set gives it once when it has elements, anything else once.
        const written: StaticType =
          label.kind === "string"
            ? STRING_TYPE
            : label.kind === "integer"
              ? INTEGER_TYPE
              : NUMBER_TYPE;
        const elements =
          option.content.kind === "list" || option.content.kind === "set"
            ? option.content.elements.length
            : null;
        if (elements === null || elements > 0) {
          empty = false;
          add(written, label.value);
        }
        continue;
      }
      if (option.content.kind === "list" || option.content.kind === "set") {
        const elements = option.content.elements;
        if (elements.length > 0) empty = false;
        for (const element of elements) {
          const entry = choiceEntry(places, places.type(element.place), element.object, true);
          rejected ||= entry.rejected;
          add(entry.type, literalOf(element.literal));
        }
        continue;
      }
      empty = false;
      const type = places.type(option.place);
      const parts = members(nonNullType(type)).map(resolved);
      if (parts.some((part) => part.kind === "list" || part.kind === "set")) {
        // Each member gives buttons: a collection its elements, a value itself. A choice object among the elements of
        // a computed collection may return its value or its text, so only scalar elements give a known result type.
        const entry = choiceEntry(places, type, null, false);
        const accepted =
          entry.type !== UNKNOWN_TYPE &&
          !rejectsElements(
            type,
            (element) => isChoiceValue(element) || resolved(element).kind === "object",
          );
        rejected ||= entry.rejected || !accepted;
        const results = parts.map((part) => {
          const button =
            part.kind === "list" || part.kind === "set" ? resolved(part.element) : part;
          return button.kind === "object" ? UNKNOWN_TYPE : button;
        });
        add(
          accepted && !isNullable(type) ? (joinTypes(results) ?? UNKNOWN_TYPE) : UNKNOWN_TYPE,
          undefined,
        );
        continue;
      }
      const entry = choiceEntry(
        places,
        type,
        option.content.kind === "object" ? option.content.object : null,
        false,
      );
      rejected ||= entry.rejected;
      add(entry.type, literalOf(option.literal));
    }
    // An empty list or set gives no buttons, which the legacy reports.
    if (empty && evidence.options.length > 0) return INVALID;
    if (values.length === 0) return INVALID;
    const known: readonly (ScalarValue | null)[] | null = literals;
    const joined = joinTypes(values);
    const type = known === null ? (joined ?? union(values)) : restrictedChoice(values, known);
    if (members(type).some(unknownPart)) return rejected ? INVALID : places.dynamic();
    return typeResult(type);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// askForm

/** The kind of a field that starts with a value of `type`, or `null` when its kind is not known. */
function formKindOfStart(type: StaticType): FormFieldKind | null {
  if (type.kind === "list") return "cycle";
  if (type.kind !== "scalar") return null;
  switch (type.name) {
    case "boolean":
      return "boolean";
    case "integer":
    case "number":
    case "date":
    case "time":
    case "datetime":
      return type.name;
    case "string":
      return "text";
    default:
      return null;
  }
}

const FORM_ANSWER_TYPES: Readonly<Record<Exclude<FormFieldKind, "boolean" | "cycle">, StaticType>> =
  {
    text: STRING_TYPE,
    integer: INTEGER_TYPE,
    number: NUMBER_TYPE,
    date: DATE_TYPE,
    time: TIME_TYPE,
    datetime: DATETIME_TYPE,
  };

function formAnswerType(kind: Exclude<FormFieldKind, "boolean" | "cycle">): StaticType {
  return FORM_ANSWER_TYPES[kind];
}

/** The answer of a kind: a toggle, a cycle of its options (read only then), or the kind's value. */
function fieldAnswer(
  places: Places,
  kind: FormFieldKind,
  options: () => StaticType | undefined,
  elements: readonly ChoiceElementEvidence[] | undefined,
): StaticType {
  return kind === "cycle"
    ? cycleAnswer(places, options, elements)
    : kind === "boolean"
      ? BOOLEAN_TYPE
      : formAnswerType(kind);
}

/**
 * `#cycleAnswerType`: each option's value, or the text of a choice object without one. Written choice objects are
 * read one by one; for a computed one, whether it has a `value` is not known, so either may be returned.
 */
function cycleAnswer(
  places: Places,
  options: () => StaticType | undefined,
  elements: readonly ChoiceElementEvidence[] | undefined,
): StaticType {
  const computedOption = (member: StaticType): StaticType => {
    const option = resolved(member);
    if (option.kind !== "object") return plainType(option);
    const returned = [option.properties?.get("value"), option.properties?.get("text")].filter(
      (part): part is StaticType => part !== undefined,
    );
    return returned.length === 0 ? UNKNOWN_TYPE : union(returned.map(plainType));
  };
  if (elements !== undefined)
    return union(
      elements.map((element) => {
        if (element.object === null)
          return union(members(places.type(element.place)).map(computedOption));
        const returned = element.object.value ?? element.object.text;
        return returned === null ? UNKNOWN_TYPE : plainType(places.type(returned));
      }),
    );
  // The options' type is read only here, for a cycle whose options are not written one by one.
  const type = options();
  const list = type === undefined ? undefined : resolved(nonNullType(type));
  if (list?.kind !== "list") return UNKNOWN_TYPE;
  return union(members(resolved(list.element)).map(computedOption));
}

/** `#writtenFormField`: a descriptor written where the form is asked has exactly the written properties. */
function writtenField(
  places: Places,
  descriptor: Extract<FormDescriptorEvidence, { kind: "object" }>,
): StaticType {
  const typeOf = (place: PlaceId | null): StaticType | undefined =>
    place === null ? undefined : resolved(nonNullType(places.type(place)));
  const tag: FormFieldKind | null | undefined =
    descriptor.type === null
      ? undefined
      : isFormFieldKind(descriptor.type)
        ? descriptor.type
        : null;
  // The start value decides the kind only without a written `type:`; the result rule reads nothing else of it.
  const startKind = (): FormFieldKind | null => {
    const valueType = typeOf(descriptor.value);
    if (descriptor.options !== null)
      return valueType !== undefined && isScalar(valueType, "boolean") ? "boolean" : "cycle";
    return valueType === undefined ? null : formKindOfStart(valueType);
  };
  const kind = tag !== undefined ? tag : startKind();
  // A written `optional: false` keeps the answer required; any other value may make it optional.
  const required = descriptor.optional === null || descriptor.optional === false;
  if (kind === null) return optional(GENERIC_FORM_ANSWER_TYPE);
  const result = fieldAnswer(
    places,
    kind,
    () => (descriptor.options === null ? undefined : typeOf(descriptor.options.place)),
    descriptor.options?.elements ?? undefined,
  );
  return !required && kind !== "boolean" && kind !== "cycle" ? optional(result) : result;
}

/**
 * `#computedFormField`: a descriptor's type merges every value it may hold, so it gives one kind only without `type:`,
 * and with `options:` only when no `value:` other than a toggle's beside it can make some fields typed.
 */
function computedField(
  places: Places,
  descriptor: Extract<StaticType, { kind: "object" }>,
): StaticType {
  const properties = descriptor.properties;
  if (properties === null) return optional(GENERIC_FORM_ANSWER_TYPE);
  const part = (key: string): StaticType | undefined => {
    const found = properties.get(key);
    return found === undefined ? undefined : resolved(nonNullType(found));
  };
  const valueType = part("value");
  const options = part("options");
  let result: StaticType | null;
  if (properties.has("type")) result = null;
  else if (options !== undefined) {
    const cycle = cycleAnswer(places, () => options, undefined);
    result =
      valueType === undefined
        ? cycle
        : isScalar(valueType, "boolean") && isScalar(resolved(cycle), "boolean")
          ? BOOLEAN_TYPE
          : null;
  } else {
    const kind = valueType === undefined ? null : formKindOfStart(valueType);
    result =
      kind === null || kind === "cycle"
        ? null
        : kind === "boolean"
          ? BOOLEAN_TYPE
          : properties.has("optional")
            ? optional(formAnswerType(kind))
            : formAnswerType(kind);
  }
  return result ?? optional(GENERIC_FORM_ANSWER_TYPE);
}

/** `#formField`: the answer of one field from its type and, where it is written, its descriptor. */
function field(
  places: Places,
  type: StaticType,
  written: FormDescriptorEvidence | undefined,
): StaticType {
  const value = resolved(nonNullType(type));
  if (value.kind === "object")
    return written?.kind === "object"
      ? writtenField(places, written)
      : computedField(places, value);
  const kind = formKindOfStart(value);
  if (kind === null) return optional(GENERIC_FORM_ANSWER_TYPE);
  return fieldAnswer(
    places,
    kind,
    () => value,
    written?.kind === "list" ? written.elements : undefined,
  );
}

function form(inputs: OperationInputs): OperationResult {
  const evidence = inputs.evidence;
  if (evidence?.kind !== "form") return INVALID;
  const fields = inputs.named.get("fields");
  if (fields === undefined) return INVALID;
  return answer(evidence, inputs, (places) => {
    if (isBottom(fields)) throw new Unconstrained();
    const cancellable =
      evidence.cancel || (evidence.onTimeout !== null && evidence.onTimeout !== "submit");
    if (fields.dynamic !== null) return dynamicResult(fields.dynamic);
    const container = resolved(nonNullType(closedType(fields)!));
    const written = evidence.fields === "computed" ? undefined : evidence.fields;
    let answers: StaticType;
    if (container.kind === "dict") {
      if (written?.shape === "dict" && written.entries.length > 0)
        // A written dict shows every field, so its answers are typed field by field.
        answers = {
          kind: "dict",
          element: union(
            written.entries.map((entry) => field(places, places.type(entry.place), entry.written)),
          ),
        };
      else answers = { kind: "dict", element: field(places, container.element, undefined) };
    } else if (container.kind !== "object") {
      // Fields of another kind are reported; fields the compiler cannot know take the shape of the value when the
      // form opens.
      return isKnown(container) ? INVALID : places.dynamic();
    } else {
      if (container.properties === null) return dynamicResult("unknown member");
      const descriptors = new Map(
        written?.shape === "object"
          ? written.entries.map((entry) => [entry.name, entry.written])
          : [],
      );
      const result = new PropertyTable();
      for (const [name, type] of container.properties)
        result.set(name, field(places, type, descriptors.get(name)));
      answers = { kind: "object", properties: result };
    }
    return typeResult(cancellable && isKnown(answers) ? optional(answers) : answers);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The asks with a fixed answer, and the command expressions

function fixed(
  family: ContractFamily,
  name: string,
  type: StaticType,
): [string, OperationRelation] {
  return [`${family}.${name}`, { contract: { family, name }, result: () => typeResult(type) }];
}

function askImage(inputs: OperationInputs): OperationResult {
  const evidence = inputs.evidence;
  // The answer is an image reference, or also `null` unless `allowSkip:` is left out or written `false`.
  const skippable =
    evidence?.kind === "image" && evidence.allowSkip !== null && evidence.allowSkip !== false;
  return typeResult(skippable ? optional(STRING_TYPE) : STRING_TYPE);
}

function askBooleans(inputs: OperationInputs): OperationResult {
  const answers: StaticType = { kind: "list", element: BOOLEAN_TYPE };
  const cancellable = inputs.evidence?.kind === "booleans" && inputs.evidence.cancel;
  return typeResult(cancellable ? optional(answers) : answers);
}

function speakerField(name: string): OperationRelation {
  const property = name.replace(/^playerProfile\./, "");
  return {
    contract: { family: "speakerField", name },
    result: () =>
      SPEAKER_NAME_LISTS.has(property)
        ? typeResult({ kind: "list", element: STRING_TYPE })
        : PERSON_FIELDS.has(property)
          ? typeResult(STRING_TYPE)
          : INVALID,
  };
}

const SCRIPT_TYPE: StaticType = { kind: "scalar", name: "script" };

export const RELATIONS: ReadonlyMap<string, OperationRelation> = new Map<string, OperationRelation>(
  [
    fixed("interaction", "text", STRING_TYPE),
    fixed("interaction", "password", STRING_TYPE),
    fixed("interaction", "number", NUMBER_TYPE),
    fixed("interaction", "integer", INTEGER_TYPE),
    fixed("interaction", "date", DATE_TYPE),
    fixed("interaction", "time", TIME_TYPE),
    fixed("interaction", "datetime", DATETIME_TYPE),
    fixed("interaction", "boolean", BOOLEAN_TYPE),
    [
      "interaction.booleans",
      { contract: { family: "interaction", name: "booleans" }, result: askBooleans },
    ],
    ["interaction.choice", { contract: { family: "interaction", name: "choice" }, result: choice }],
    ["interaction.form", { contract: { family: "interaction", name: "form" }, result: form }],
    [
      "interaction.askImage",
      { contract: { family: "interaction", name: "askImage" }, result: askImage },
    ],
    fixed("say", "say", { kind: "messageHandle" }),
    fixed("showButton", "showButton", DURATION_TYPE),
    fixed("showButton", "showPermanentButton", { kind: "permanentButton" }),
    fixed("popup", "showPopup", DURATION_TYPE),
    fixed("timer", "short", { kind: "timer" }),
    fixed("timer", "named", { kind: "timer" }),
    fixed("camera", "showCamera", { kind: "camera" }),
    fixed("capture", "takePhoto", optional(STRING_TYPE)),
    fixed("tagQuery", "images.list", { kind: "list", element: STRING_TYPE }),
    fixed("tagQuery", "images.random", STRING_TYPE),
    fixed("tagQuery", "scripts.list", { kind: "list", element: SCRIPT_TYPE }),
    fixed("tagQuery", "scripts.random", SCRIPT_TYPE),
  ],
);

/** The relation of a media key (`media.<name>`), a handle whatever the media, and of a speaker field. */
export function relationOf(family: ContractFamily, name: string): OperationRelation | undefined {
  if (family === "media")
    return { contract: { family, name }, result: () => typeResult({ kind: "media" }) };
  if (family === "speakerField") return speakerField(name);
  return RELATIONS.get(`${family}.${name}`);
}
