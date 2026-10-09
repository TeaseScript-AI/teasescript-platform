import { isNormalizedOpaqueColor, normalizeOpaqueColor } from "../../color.js";
import { isInteractionChoiceValue } from "../../choice-values.js";
import {
  formValueText,
  isBlankTextAnswer,
  isIntegerAnswerText,
  isNumberAnswerText,
  numberAnswerText,
  temporalAnswer,
  temporalAnswerText,
} from "../../interaction-answers.js";
import {
  interactionStringFits,
  MAX_INTERACTION_OPTION_ENTRIES,
  MAX_INTERACTION_STRING_UTF8_BYTES,
} from "../../interaction-limits.js";
import type {
  FormField,
  FormFieldKind,
  FormScalarField,
  FormUi,
  InteractionAccessibleName,
  InteractionChoiceOption,
  InteractionChoiceValue,
  PlanSourceLocation,
  PreparedFormShape,
  TypePlan,
} from "../../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../../source.js";
import type { TemporalContext } from "../../temporal.js";
import { expandChoiceOptions } from "../choice-options.js";
import { internalFault, RuntimeFault } from "../errors.js";
import { copySpan } from "../operations/support.js";
import {
  getSerializableProperty,
  serializableEquals,
  type SerializableRuntimeObject,
  type SerializableRuntimeValue,
} from "../serializable-values.js";
import {
  describeRuntimeValue,
  isAnyDuration,
  isDate,
  isDateTime,
  isDict,
  isList,
  isObject,
  isTime,
} from "../value-predicates.js";
import { fieldText } from "../value-text.js";
import { exactDurationMilliseconds } from "../temporal-operations.js";
import {
  describeShownValue,
  describeType,
  describeValue,
  matchesValueType,
} from "../value-types.js";
import { escapedMarkupLength, escapeMarkup } from "../../message-markup.js";
import { checkTextLength, MAX_TEXT_LENGTH, messageText } from "../text-length.js";
import {
  FORM_FIELD_PROPERTIES,
  FORM_FIELD_PROPERTIES_TEXT,
  isFormFieldKind,
  unknownFormTypeMessage,
} from "../../form-fields.js";
import type {
  InteractionResultValue,
  RuntimeFormStateSnapshot,
  RuntimeFormValue,
} from "./model.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

const DEFAULT_SUBMIT_TEXT = "OK";

/**
 * A form as it opens: its definition, the starting answers, and the prose the asking speaker says as it opens: a line
 * `<label> — <description>` for each field with a description, then the outro, or `null` without either.
 */
export interface MaterializedForm {
  readonly ui: FormUi;
  readonly state: RuntimeFormStateSnapshot;
  readonly prose: string | null;
}

/**
 * Builds a form from its prepared request (V30 §20): `fields`, an object or dict of starting values and field
 * descriptors, or for `askBooleans` its parallel `texts` and `defaults` (its `prefill:`), and the optional `hint` and
 * `submit`. Each
 * field is checked once, here; an invalid one fails with `TSR052` and a message that names it.
 */
export function materializeForm(
  request: SerializableRuntimeValue,
  prepared: PreparedFormShape,
  accessibleName: InteractionAccessibleName,
  context: TemporalContext,
  span: SourceSpan,
): MaterializedForm {
  if (!isObject(request))
    throw fault(internalFault("The prepared askForm request is malformed."), span);
  let fieldsValue: SerializableRuntimeValue | undefined;
  let texts: SerializableRuntimeValue | undefined;
  let defaults: SerializableRuntimeValue | undefined;
  let hint: string | null = null;
  let outro: string | null = null;
  let submit: FormUi["submit"] = { text: DEFAULT_SUBMIT_TEXT };
  let cancel: FormUi["cancel"] = null;
  let timeoutValue: SerializableRuntimeValue | undefined;
  let onTimeout: SerializableRuntimeValue | undefined;
  for (const { name, value } of request.properties) {
    if (name === "message") continue;
    if (name === "fields") fieldsValue = value;
    else if (name === "texts") texts = value;
    else if (name === "defaults") defaults = value;
    else if (name === "hint") hint = fieldText(value, span, context);
    else if (name === "outro") outro = fieldText(value, span, context);
    else if (name === "submit") submit = formButton(name, value, context, span);
    else if (name === "cancel") cancel = formButton(name, value, context, span);
    else if (name === "timeout") timeoutValue = value;
    else if (name === "onTimeout") onTimeout = value;
    else throw fault(internalFault("The prepared askForm request is malformed."), span);
  }

  const fields: FormField[] = [];
  const values: RuntimeFormValue[] = [];
  const descriptions: { readonly label: string; readonly description: string }[] = [];
  // The length of the description lines, without the line breaks between them, counted as they are added.
  let described = 0;
  // Fields and their options share the interaction's entry limit, checked as each field is added.
  let entries = 0;
  const add = (field: FormField, value: RuntimeFormValue) => {
    entries +=
      1 + (field.kind === "boolean" || field.kind === "cycle" ? (field.options?.length ?? 0) : 0);
    if (entries > MAX_INTERACTION_OPTION_ENTRIES)
      throw fault(
        `A form can have at most ${MAX_INTERACTION_OPTION_ENTRIES} fields and options together.`,
        span,
      );
    fields.push(field);
    values.push(value);
  };
  let shape: FormUi["shape"] = "booleanList";
  if (prepared.kind === "booleanList") {
    if (texts === undefined || defaults === undefined || fieldsValue !== undefined)
      throw fault(internalFault("The prepared askForm request is malformed."), span);
    if (!isList(texts) || !isList(defaults))
      throw fault("askBooleans takes a list of texts and a prefill list.", span);
    if (texts.items.length !== defaults.items.length)
      throw new RuntimeFault(
        "TSR058",
        `askBooleans has ${texts.items.length} ${texts.items.length === 1 ? "text" : "texts"} but ${defaults.items.length} prefill ${defaults.items.length === 1 ? "value" : "values"}. Give one prefill value for each text.`,
        copySpan(span),
      );
    texts.items.forEach((text, index) => {
      const start = defaults.items[index]!;
      if (typeof start !== "boolean")
        throw fault(
          `askBooleans prefill ${index} (${JSON.stringify(messageText(fieldText(text, span, context)))}): takes true or false, not ${describeRuntimeValue(start)}.`,
          span,
        );
      add(
        { id: String(index), text: fieldText(text, span, context), kind: "boolean", options: null },
        start,
      );
    });
  } else {
    if (fieldsValue === undefined || texts !== undefined || defaults !== undefined)
      throw fault(internalFault("The prepared askForm request is malformed."), span);
    // An unknown form takes the shape of its fields.
    const written =
      prepared.kind !== "dict" && isObject(fieldsValue)
        ? fieldsValue.properties.map(({ name, value }) => ({ id: name, value }))
        : prepared.kind !== "object" && isDict(fieldsValue)
          ? fieldsValue.entries.map(({ key, value }) => ({ id: key, value }))
          : undefined;
    if (written === undefined)
      throw fault(
        `askForm fields: must be ${prepared.kind === "object" ? "an object" : prepared.kind === "dict" ? "a dict" : "an object or a dict"} of fields, not ${describeRuntimeValue(fieldsValue)}.`,
        span,
      );
    shape = isObject(fieldsValue) ? "object" : "dict";
    const numericKinds = new Map(
      prepared.kind === "object"
        ? prepared.numericKinds.map((entry) => [entry.name, entry.numericKind] as const)
        : [],
    );
    for (const { id, value } of written) {
      const numericKind =
        prepared.kind === "dict" ? prepared.numericKind : (numericKinds.get(id) ?? null);
      const field = fieldWithContext(id, () =>
        materializeField(id, value, numericKind, context, span),
      );
      add(field.field, field.value);
      // The label is shown as written; the description is said as `say` says text.
      if (field.description !== null) {
        // Escaping puts a backslash before some characters, so only a label that could get too long is measured first.
        if (field.field.text.length * 2 > MAX_TEXT_LENGTH)
          checkTextLength(escapedMarkupLength(field.field.text), "askForm", span);
        const label = escapeMarkup(field.field.text);
        descriptions.push({ label, description: field.description });
        described += label.length + 3 + field.description.length;
      }
    }
  }
  if (fields.length === 0) throw fault("A form needs at least one field.", span);
  const mismatch = formAnswerMismatch(fields, prepared);
  if (mismatch !== null)
    throw new RuntimeFault(
      "TSR058",
      `askForm field '${messageText(mismatch.field.id)}' was checked to answer ${describeType(mismatch.type)}, but it can answer ${describeValue(mismatch.answer)}. Write type: where the field's starting object is created, so the compiler sees its kind.`,
      copySpan(span),
    );
  const timeout = formTimeout(timeoutValue, onTimeout, span);
  // Submitting at the time limit returns the answers as they stand, so every field needs one from the start.
  if (timeout?.onTimeout === "submit") {
    const unset = fields.find((_field, index) => values[index] === null);
    if (unset !== undefined)
      throw fault(
        `askForm field '${unset.id}': onTimeout: "submit" needs a value in every field, but it has none.`,
        span,
      );
  }
  // Each description is `<label> — <description>` on a line of its own, and the outro follows after a blank line.
  const lines = described + Math.max(0, descriptions.length - 1);
  checkTextLength(lines + (outro ? outro.length + (lines > 0 ? 2 : 0) : 0), "askForm", span);
  const prose = [
    descriptions.map(({ label, description }) => `${label} — ${description}`).join("\n"),
    outro ?? "",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
  return {
    ui: { kind: "form", shape, fields, hint, submit, cancel, timeout, accessibleName },
    state: { values, editor: null },
    prose: prose === "" ? null : prose,
  };
}

/**
 * The first field that can answer outside the type the compiler gave it, with that answer, or `null`. Each kind is
 * checked by its possible answers: a toggle's two states, each option of a cycle, a value of its kind for a typed
 * field, and `null` for an optional one. The compiler infers what a computed descriptor shows, which a value may not
 * keep, so this check keeps every answer within its checked type.
 */
export function formAnswerMismatch(
  fields: readonly FormField[],
  prepared: PreparedFormShape,
): {
  readonly field: FormField;
  readonly type: TypePlan;
  readonly answer: SerializableRuntimeValue;
} | null {
  const answers =
    prepared.kind === "object"
      ? new Map(prepared.answers.map((answer) => [answer.name, answer.type] as const))
      : null;
  for (const field of fields) {
    const type =
      prepared.kind === "dict"
        ? prepared.answer
        : prepared.kind === "object"
          ? (answers!.get(field.id) ?? null)
          : null;
    if (type === null) continue;
    const answer = possibleFormAnswers(field).find((value) => !matchesValueType(value, type));
    if (answer !== undefined) return { field, type, answer };
  }
  return null;
}

/** Whether an open form's shape fits its prepared one: the same, or an object or a dict for an unknown one. */
export function formShapeFits(prepared: PreparedFormShape, shape: unknown): boolean {
  return prepared.kind === "unknown"
    ? shape === "object" || shape === "dict"
    : shape === prepared.kind;
}

/** One answer of each type a field can give. */
function possibleFormAnswers(field: FormField): readonly SerializableRuntimeValue[] {
  if (field.kind === "boolean") return [false, true];
  if (field.kind === "cycle") return field.options.map((option) => option.value);
  const sample: SerializableRuntimeValue =
    field.kind === "integer"
      ? 0
      : field.kind === "number"
        ? 0.5
        : field.kind === "text"
          ? "text"
          : temporalAnswer(field.kind, SAMPLE_TEMPORAL_TEXT[field.kind])!;
  return field.optional ? [sample, null] : [sample];
}

const SAMPLE_TEMPORAL_TEXT = {
  date: "2000-01-01",
  time: "00:00",
  datetime: "2000-01-01T00:00",
} as const;

/**
 * A form's time limit: `timeout:`, an elapsed duration greater than zero, with `onTimeout:` `"submit"` or `"cancel"`;
 * each needs the other.
 */
function formTimeout(
  value: SerializableRuntimeValue | undefined,
  onTimeout: SerializableRuntimeValue | undefined,
  span: SourceSpan,
): FormUi["timeout"] {
  if (value === undefined && onTimeout === undefined) return null;
  if (onTimeout !== "submit" && onTimeout !== "cancel")
    throw fault(
      `askForm onTimeout: takes "submit" or "cancel"${value === undefined ? "" : ", and timeout: needs it"}.`,
      span,
    );
  if (value === undefined)
    throw fault("askForm onTimeout: needs timeout:, such as 'timeout: 30 s'.", span);
  // A calendar duration has no fixed length.
  const milliseconds = isAnyDuration(value)
    ? exactDurationMilliseconds(value, "An askForm timeout", span)
    : Number.NaN;
  if (!(milliseconds > 0) || !Number.isFinite(milliseconds))
    throw fault(
      typeof value === "number"
        ? `An askForm timeout is a duration, but this is ${describeShownValue(value)}. Give the number a unit, such as '${describeShownValue(value)} s'.`
        : `An askForm timeout must be a duration greater than zero, but this is ${describeShownValue(value)}.`,
      span,
    );
  return { milliseconds, onTimeout };
}

/** Names the field in a failure of its text or options, such as an invalid colour. */
function fieldWithContext<T>(id: string, build: () => T): T {
  try {
    return build();
  } catch (error) {
    const prefix = `askForm field '${id}': `;
    if (!(error instanceof RuntimeFault) || error.message.startsWith(prefix)) throw error;
    throw new RuntimeFault(error.code, `${prefix}${error.message}`, error.span);
  }
}

function materializeField(
  id: string,
  raw: SerializableRuntimeValue,
  numericKind: "integer" | "number" | null,
  context: TemporalContext,
  span: SourceSpan,
): {
  readonly field: FormField;
  readonly value: RuntimeFormValue;
  readonly description: string | null;
} {
  const problem = (message: string) => fault(`askForm field '${id}': ${message}`, span);
  const descriptor: SerializableRuntimeObject | null = isObject(raw) ? raw : null;
  const unknown = descriptor?.properties.find(
    (property) => !FORM_FIELD_PROPERTIES.includes(property.name),
  );
  if (unknown !== undefined)
    throw problem(`unknown property '${unknown.name}'. ${FORM_FIELD_PROPERTIES_TEXT}`);
  const read = (name: string): SerializableRuntimeValue | undefined =>
    descriptor === null ? undefined : getSerializableProperty(descriptor, name);
  const start = descriptor !== null ? read("value") : isList(raw) ? undefined : raw;
  const typeValue = read("type");
  const options = descriptor === null ? (isList(raw) ? raw : undefined) : read("options");

  let kind: FormFieldKind;
  if (typeValue !== undefined) {
    if (!isFormFieldKind(typeValue))
      throw problem(
        typeof typeValue === "string"
          ? unknownFormTypeMessage(typeValue)
          : `type: must be text such as "integer", not ${describeRuntimeValue(typeValue)}.`,
      );
    kind = typeValue;
  } else if (options !== undefined) kind = typeof start === "boolean" ? "boolean" : "cycle";
  else if (start === undefined || start === null)
    throw problem('add a type, such as type: "integer", because it has no value to infer it from.');
  else if (typeof start === "boolean") kind = "boolean";
  else if (typeof start === "string") kind = "text";
  else if (typeof start === "number") {
    if (numericKind === null)
      throw problem('add type: "integer" or type: "number" for its number.');
    kind = numericKind;
  } else if (isDate(start)) kind = "date";
  else if (isTime(start)) kind = "time";
  else if (isDateTime(start)) kind = "datetime";
  else throw problem(`a field cannot start as ${describeRuntimeValue(start)}.`);

  const textValue = read("text");
  const text = textValue === undefined ? id : fieldText(textValue, span, context);
  const backgroundValue = read("background");
  let background: string | undefined;
  if (backgroundValue !== undefined) {
    const normalized = normalizeOpaqueColor(backgroundValue);
    if (normalized === null) throw problem("background: must be an opaque CSS colour.");
    background = normalized;
  }
  const base = { id, text, ...(background === undefined ? {} : { background }) };
  const descriptionValue = read("description");
  const description =
    descriptionValue === undefined ? null : fieldText(descriptionValue, span, context);

  if (kind === "boolean" || kind === "cycle") {
    for (const name of ["optional", "min", "max", "hint"])
      if (read(name) !== undefined)
        throw problem(
          `${name}: is for fields typed in the composer, not ${kind === "boolean" ? "a toggle" : "a cycle"}.`,
        );
    const buttons =
      options === undefined
        ? null
        : isList(options) && options.items.length > 0
          ? expandChoiceOptions([options], [null], context, span)
          : null;
    if (options !== undefined && buttons === null)
      throw problem("options: must be a list with at least one option.");
    if (kind === "boolean") {
      if (start !== undefined && typeof start !== "boolean")
        throw problem(`a toggle starts true or false, not ${describeRuntimeValue(start)}.`);
      if (
        buttons !== null &&
        !(
          buttons.length === 2 &&
          buttons.some((option) => option.value === false) &&
          buttons.some((option) => option.value === true)
        )
      )
        throw problem("a toggle's options are one with value: false and one with value: true.");
      return { field: { ...base, kind, options: buttons }, value: start ?? false, description };
    }
    if (buttons === null) throw problem("a cycle needs options:.");
    const valueKind = cycleValueKind(buttons[0]!.value);
    if (buttons.some((option) => option.value === null))
      throw problem("each cycle option needs a value other than null.");
    if (buttons.some((option) => cycleValueKind(option.value) !== valueKind))
      throw problem("the options of a cycle must all have the same type.");
    const index =
      start === undefined
        ? 0
        : buttons.findIndex((option) => serializableEquals(option.value, start));
    if (index === -1) throw problem(`its value is not one of its options.`);
    return { field: { ...base, kind, options: buttons }, value: index, description };
  }

  if (options !== undefined) throw problem(`options: is for a toggle or a cycle, not a ${kind}.`);
  const optionalValue = read("optional");
  if (optionalValue !== undefined && typeof optionalValue !== "boolean")
    throw problem("optional: takes true or false.");
  const hintValue = read("hint");
  const bound = (name: "min" | "max"): number | null => {
    const value = read(name);
    if (value === undefined) return null;
    if (kind !== "integer" && kind !== "number")
      throw problem(`${name}: is for integer and number fields, not a ${kind}.`);
    if (typeof value !== "number" || !Number.isFinite(value))
      throw problem(`${name}: must be a number, not ${describeRuntimeValue(value)}.`);
    if (kind === "integer" && !Number.isSafeInteger(value))
      throw problem(`${name}: must be a whole number for an integer field.`);
    return Object.is(value, -0) ? 0 : value;
  };
  const min = bound("min");
  const max = bound("max");
  if (min !== null && max !== null && min > max)
    throw problem(`min ${numberAnswerText(min)} exceeds max ${numberAnswerText(max)}.`);
  const field: FormScalarField = {
    ...base,
    kind,
    optional: optionalValue === true,
    min,
    max,
    hint: hintValue === undefined ? null : fieldText(hintValue, span, context),
  };
  const value = scalarStart(field, start === undefined ? null : start);
  if (value === undefined)
    throw problem(
      kind === "text" && typeof start === "string"
        ? `its text is longer than an answer may be (${MAX_INTERACTION_STRING_UTF8_BYTES} UTF-8 bytes).`
        : `a ${kind} field cannot start as ${describeRuntimeValue(start!)}.`,
    );
  if (typeof value === "number" && !withinBounds(field, value))
    throw problem(`its value ${numberAnswerText(value)} is outside ${boundsText(field)}.`);
  return { field, value, description };
}

/** A typed field's starting value, `null` when it starts without one, or `undefined` when it does not fit. */
function scalarStart(
  field: FormScalarField,
  start: SerializableRuntimeValue,
): RuntimeFormValue | undefined {
  // Like an ask's prefill, `null` or blank text prefills nothing.
  if (start === null || (typeof start === "string" && isBlankTextAnswer(start))) return null;
  switch (field.kind) {
    case "integer":
      return typeof start === "number" && Number.isSafeInteger(start)
        ? Object.is(start, -0)
          ? 0
          : start
        : undefined;
    case "number":
      return typeof start === "number" && Number.isFinite(start)
        ? Object.is(start, -0)
          ? 0
          : start
        : undefined;
    case "text":
      // A text start must also be an answer the composer could submit.
      return typeof start === "string" && interactionStringFits(start)
        ? start.replace(/\r\n?/gu, "\n")
        : undefined;
    case "date":
      return isDate(start) ? { ...start } : undefined;
    case "time":
      return isTime(start) ? { ...start } : undefined;
    case "datetime":
      return isDateTime(start) ? { ...start } : undefined;
  }
}

/** The type a cycle option's value has, which all options of one cycle share. */
function cycleValueKind(value: InteractionChoiceValue): string {
  if (value === null) return "null";
  if (typeof value !== "object") return typeof value;
  return value.kind;
}

function formButton(
  name: string,
  value: SerializableRuntimeValue,
  context: TemporalContext,
  span: SourceSpan,
): FormUi["submit"] {
  if (!isObject(value)) return { text: fieldText(value, span, context) };
  if (
    value.properties.some((property) => property.name !== "text" && property.name !== "background")
  )
    throw fault(`askForm ${name}: takes text or a button object { text, background? }.`, span);
  const text = getSerializableProperty(value, "text");
  if (text === undefined) throw fault(`askForm ${name}: needs text.`, span);
  const background = getSerializableProperty(value, "background");
  if (background === undefined) return { text: fieldText(text, span, context) };
  const normalized = normalizeOpaqueColor(background);
  if (normalized === null)
    throw fault(`askForm ${name}: background must be an opaque CSS colour.`, span);
  return { text: fieldText(text, span, context), background: normalized };
}

/**
 * The canonical runtime value of a form's definition. The request temporary holds it while the form is open, so a
 * restore can check the pending form against it.
 */
export function formRequestValue(ui: FormUi): SerializableRuntimeValue {
  const object = (
    properties: readonly (readonly [string, SerializableRuntimeValue | undefined])[],
  ): SerializableRuntimeValue => ({
    kind: "object",
    properties: properties
      .filter(
        (entry): entry is readonly [string, SerializableRuntimeValue] => entry[1] !== undefined,
      )
      .map(([name, value]) => ({ name, value })),
  });
  const options = (items: readonly InteractionChoiceOption[] | null) =>
    items === null
      ? null
      : {
          kind: "list" as const,
          items: items.map((option) =>
            object([
              ["text", option.text],
              ["value", option.value],
              ["background", option.background],
            ]),
          ),
        };
  return object([
    ["shape", ui.shape],
    ["hint", ui.hint],
    [
      "submit",
      object([
        ["text", ui.submit.text],
        ["background", ui.submit.background],
      ]),
    ],
    [
      "timeout",
      ui.timeout === null
        ? null
        : object([
            ["milliseconds", ui.timeout.milliseconds],
            ["onTimeout", ui.timeout.onTimeout],
          ]),
    ],
    [
      "cancel",
      ui.cancel === null
        ? null
        : object([
            ["text", ui.cancel.text],
            ["background", ui.cancel.background],
          ]),
    ],
    [
      "fields",
      {
        kind: "list",
        items: ui.fields.map((field) =>
          object([
            ["id", field.id],
            ["text", field.text],
            ["kind", field.kind],
            ["background", field.background],
            ...(field.kind === "boolean" || field.kind === "cycle"
              ? ([["options", options(field.options)]] as const)
              : ([
                  ["optional", field.optional],
                  ["min", field.min],
                  ["max", field.max],
                  ["hint", field.hint],
                ] as const)),
          ]),
        ),
      },
    ],
  ]);
}

/** The text that the composer opens with for a typed field: its value as an answer would be typed, or nothing. */
function formEditorText(value: RuntimeFormValue): string {
  if (value === null) return "";
  if (typeof value === "number") return numberAnswerText(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") throw new Error("A typed field holds no boolean.");
  return temporalAnswerText(value);
}

export type FormStep =
  | { readonly ok: true; readonly state: RuntimeFormStateSnapshot }
  | { readonly ok: false; readonly message: string };

/**
 * Applies one validated edit to an open form without settling it (`updateInteraction`). Every edit names its field by ID
 * and is absolute, so a repeated edit changes nothing more:
 *
 * - `select` sets a toggle or cycle to the option at `optionIndex`; a toggle without options has `false` at 0 and
 *   `true` at 1;
 * - `edit` opens a typed field in the composer with its current value as text;
 * - `draft` replaces the text of the field being edited;
 * - `commit` checks that text and makes it the field's value; blank text unsets an optional field;
 * - `clear` unsets an optional field;
 * - `dismiss` closes the composer and drops its text.
 *
 * Opening, selecting, or clearing another field first commits the text being edited; when that text is invalid, the
 * whole edit is refused and nothing changes. Blank text is invalid for a required field.
 */
export function applyFormUpdate(
  ui: FormUi,
  state: RuntimeFormStateSnapshot,
  update: unknown,
): FormStep {
  if (!isPlainRecord(update) || typeof update.fieldId !== "string")
    return refused("A form update needs a kind and the fieldId of a field.");
  const index = ui.fields.findIndex((field) => field.id === update.fieldId);
  if (index === -1)
    return refused(`The form has no field ${JSON.stringify(messageText(update.fieldId))}.`);
  const field = ui.fields[index]!;
  const keys = (names: readonly string[]) =>
    Object.keys(update).length === names.length && names.every((name) => name in update);
  const editing = state.editor?.fieldId === field.id;
  switch (update.kind) {
    case "select": {
      if (!keys(["kind", "fieldId", "optionIndex"]))
        return refused("A select update has kind, fieldId, and optionIndex.");
      if (field.kind !== "boolean" && field.kind !== "cycle")
        return refused(`Field ${JSON.stringify(messageText(field.id))} is typed in the composer.`);
      const count = field.options?.length ?? 2;
      const optionIndex = update.optionIndex;
      if (
        typeof optionIndex !== "number" ||
        !Number.isSafeInteger(optionIndex) ||
        optionIndex < 0 ||
        optionIndex >= count
      )
        return refused(
          `Field ${JSON.stringify(messageText(field.id))} has no option ${String(optionIndex)}.`,
        );
      const committed = commitEditor(ui, state);
      if (!committed.ok) return committed;
      const value =
        field.kind === "cycle"
          ? optionIndex
          : field.options === null
            ? optionIndex === 1
            : field.options[optionIndex]!.value === true;
      return { ok: true, state: withValue(committed.state, index, value) };
    }
    case "edit": {
      if (!keys(["kind", "fieldId"])) return refused("An edit update has kind and fieldId.");
      if (field.kind === "boolean" || field.kind === "cycle")
        return refused(
          `Field ${JSON.stringify(messageText(field.id))} is not typed in the composer.`,
        );
      if (editing) return { ok: true, state };
      const committed = commitEditor(ui, state);
      if (!committed.ok) return committed;
      return {
        ok: true,
        state: {
          values: committed.state.values,
          editor: { fieldId: field.id, text: formEditorText(committed.state.values[index]!) },
        },
      };
    }
    case "draft": {
      if (!keys(["kind", "fieldId", "text"]))
        return refused("A draft update has kind, fieldId, and text.");
      if (typeof update.text !== "string" || !interactionStringFits(update.text))
        return refused("Draft text must be text within the shared UTF-8 byte limit.");
      if (!editing)
        return refused(`Field ${JSON.stringify(messageText(field.id))} is not being edited.`);
      return {
        ok: true,
        state: { values: state.values, editor: { fieldId: field.id, text: update.text } },
      };
    }
    case "commit": {
      if (!keys(["kind", "fieldId"])) return refused("A commit update has kind and fieldId.");
      // A repeated commit finds the field already closed.
      if (state.editor === null) return { ok: true, state };
      if (!editing)
        return refused(`Field ${JSON.stringify(messageText(field.id))} is not being edited.`);
      return commitEditor(ui, state);
    }
    case "clear": {
      if (!keys(["kind", "fieldId"])) return refused("A clear update has kind and fieldId.");
      if (field.kind === "boolean" || field.kind === "cycle")
        return refused(
          `Field ${JSON.stringify(messageText(field.id))} is not typed in the composer.`,
        );
      if (!field.optional) return refused(`That is wrong. ${field.text} needs a value.`);
      const committed = editing ? { ok: true as const, state } : commitEditor(ui, state);
      if (!committed.ok) return committed;
      return {
        ok: true,
        state: { values: withValue(committed.state, index, null).values, editor: null },
      };
    }
    case "dismiss": {
      if (!keys(["kind", "fieldId"])) return refused("A dismiss update has kind and fieldId.");
      return { ok: true, state: editing ? { values: state.values, editor: null } : state };
    }
    default:
      return refused("A form update kind is select, edit, draft, commit, clear, or dismiss.");
  }
}

/**
 * Commits the text being edited, also before another field changes or the form is submitted. Invalid text, and blank
 * text for a required field, refuse the commit and keep the editor open.
 */
function commitEditor(ui: FormUi, state: RuntimeFormStateSnapshot): FormStep {
  if (state.editor === null) return { ok: true, state };
  const editorFieldId = state.editor.fieldId;
  const index = ui.fields.findIndex((field) => field.id === editorFieldId);
  const field = ui.fields[index];
  if (field === undefined || field.kind === "boolean" || field.kind === "cycle")
    throw new Error("A form editor names a typed field.");
  const parsed = parseFormText(field, state.editor.text);
  if (!parsed.ok) return parsed;
  if (parsed.value === null && !field.optional)
    return refused(`That is wrong. ${field.text} needs a value.`);
  return {
    ok: true,
    state: { values: withValue(state, index, parsed.value).values, editor: null },
  };
}

/** The value of composer text for a typed field, `null` for blank text, as the matching ask reads its answer. */
function parseFormText(
  field: FormScalarField,
  text: string,
):
  | { readonly ok: true; readonly value: RuntimeFormValue }
  | { readonly ok: false; readonly message: string } {
  const normalized = text.replace(/\r\n?/gu, "\n");
  if (isBlankTextAnswer(normalized)) return { ok: true, value: null };
  if (field.kind === "text") return { ok: true, value: normalized };
  const trimmed = text.trim();
  if (field.kind === "integer" || field.kind === "number") {
    const oneLine = !/[\r\n\u2028\u2029]/u.test(text);
    const parsed = Number(trimmed);
    const valid =
      oneLine &&
      (field.kind === "integer"
        ? isIntegerAnswerText(trimmed) && Number.isSafeInteger(parsed)
        : isNumberAnswerText(trimmed) && Number.isFinite(parsed));
    if (!valid)
      return refused(
        field.kind === "integer"
          ? "That is wrong. I asked for a whole number."
          : "That is wrong. I asked for a number.",
      );
    const value = Object.is(parsed, -0) ? 0 : parsed;
    if (!withinBounds(field, value))
      return refused(`That is wrong. ${field.text} must be ${boundsText(field)}.`);
    return { ok: true, value };
  }
  const answer = temporalAnswer(field.kind, trimmed);
  if (answer === undefined)
    return refused(
      `That is wrong. I asked for ${field.kind === "date" ? "a date" : field.kind === "time" ? "a time" : "a date and time"}.`,
    );
  return { ok: true, value: answer };
}

function withinBounds(field: FormScalarField, value: number): boolean {
  return (field.min === null || value >= field.min) && (field.max === null || value <= field.max);
}

function boundsText(field: FormScalarField): string {
  if (field.min !== null && field.max !== null)
    return `from ${numberAnswerText(field.min)} to ${numberAnswerText(field.max)}`;
  return field.min !== null
    ? `at least ${numberAnswerText(field.min)}`
    : `at most ${numberAnswerText(field.max!)}`;
}

function withValue(
  state: RuntimeFormStateSnapshot,
  index: number,
  value: RuntimeFormValue,
): RuntimeFormStateSnapshot {
  const values = [...state.values];
  values[index] = value;
  return { values, editor: state.editor };
}

export type FormSubmission =
  | {
      readonly ok: true;
      readonly result: InteractionResultValue;
      readonly transcriptText: string;
      readonly shownOptions: readonly (number | null)[];
    }
  | { readonly ok: false; readonly message: string };

/**
 * Submits a form: commits the text being edited, requires a value for every required field, and returns the answers
 * in field order as the form's shape: an object, a dict, or a list of booleans. An optional field without a value
 * returns `null`. The transcript line is the overview of the answers in `presentation`, the player's presentation now.
 */
export function submitForm(
  ui: FormUi,
  state: RuntimeFormStateSnapshot,
  presentation: TemporalContext["presentation"],
): FormSubmission {
  const committed = commitEditor(ui, state);
  if (!committed.ok) return committed;
  const values = committed.state.values;
  const missing = ui.fields.find(
    (field, index) =>
      field.kind !== "boolean" &&
      field.kind !== "cycle" &&
      !field.optional &&
      values[index] === null,
  );
  if (missing !== undefined) return refused(`That is wrong. ${missing.text} needs a value.`);
  const answers = ui.fields.map((field, index) => formAnswer(field, values[index]!));
  // The form's state, not its result, knows which of several cycle options with the same value is shown.
  const transcriptText = formSummaryText(formSummaryLines(ui, values, presentation));
  // Every answer is shown in full; answers too long for one transcript line are refused rather than cut.
  if (!interactionStringFits(transcriptText))
    return refused("That is wrong. These answers are too long to send at once.");
  return {
    ok: true,
    result: formResult(ui, answers),
    transcriptText,
    shownOptions: formShownOptions(ui, values),
  };
}

/** For each field, the position of the option a cycle shows, else `null` (see the form settlement's `shownOptions`). */
export function formShownOptions(
  ui: FormUi,
  values: readonly RuntimeFormValue[],
): readonly (number | null)[] {
  return ui.fields.map((field, index) => {
    const value = values[index];
    return field.kind === "cycle" && typeof value === "number" ? value : null;
  });
}

/**
 * What a form returns when its time limit is reached: `null` for `onTimeout: "cancel"`, or for `"submit"` its answers
 * as they stand, without the text being edited. Every required field has had a value from the start.
 */
export function timedOutFormResult(
  ui: FormUi,
  state: RuntimeFormStateSnapshot,
): InteractionResultValue {
  if (ui.timeout?.onTimeout !== "submit") return null;
  return formResult(
    ui,
    ui.fields.map((field, index) => formAnswer(field, state.values[index]!)),
  );
}

/** The answers as the form's shape: an object, a dict, or a list of booleans. */
function formResult(
  ui: FormUi,
  answers: readonly SerializableRuntimeValue[],
): InteractionResultValue {
  return ui.shape === "object"
    ? {
        kind: "object",
        properties: ui.fields.map((field, index) => ({ name: field.id, value: answers[index]! })),
      }
    : ui.shape === "dict"
      ? {
          kind: "dict",
          entries: ui.fields.map((field, index) => ({ key: field.id, value: answers[index]! })),
        }
      : { kind: "list", items: [...answers] };
}

/** A field's returned value: a toggle's boolean, a cycle's option value, or a typed value or `null`. */
function formAnswer(field: FormField, value: RuntimeFormValue): SerializableRuntimeValue {
  if (field.kind === "cycle") {
    if (typeof value !== "number") throw new Error("A cycle holds its option index.");
    const option = field.options[value]!.value;
    return typeof option === "object" && option !== null ? { ...option } : option;
  }
  return typeof value === "object" && value !== null ? { ...value } : value;
}

/** One line of a submitted form's summary: a toggle with its state, or another field with its value as shown. */
export type FormSummaryLine =
  | { readonly kind: "toggle"; readonly label: string; readonly on: boolean }
  | { readonly kind: "value"; readonly label: string; readonly value: string };

/**
 * The summary of a form's settled `result` with the options its cycles showed (V30 askForm; owner decision
 * 2026-10-07): every field in field order, a toggle with its state and any other field with its value as its button
 * shows it, `Not set` for an optional field without one. `null` when they are not what this form settles with.
 */
export function formSummaryOf(
  ui: FormUi,
  result: unknown,
  shownOptions: unknown,
  presentation: TemporalContext["presentation"],
): readonly FormSummaryLine[] | null {
  const values = formValuesOf(ui, result, shownOptions);
  return values === null ? null : formSummaryLines(ui, values, presentation);
}

function formSummaryLines(
  ui: FormUi,
  values: readonly RuntimeFormValue[],
  presentation: TemporalContext["presentation"],
): readonly FormSummaryLine[] {
  return ui.fields.map((field, index): FormSummaryLine => {
    const value = values[index] ?? null;
    if (field.kind === "boolean" && field.options === null)
      return { kind: "toggle", label: field.text, on: value === true };
    const shown =
      field.kind === "boolean"
        ? field.options?.find((option) => option.value === value)?.text
        : field.kind === "cycle"
          ? typeof value === "number"
            ? field.options[value]?.text
            : undefined
          : value === null
            ? "Not set"
            : formValueText(value, presentation);
    return { kind: "value", label: field.text, value: shown ?? "" };
  });
}

/**
 * The plain text of a form's summary, for the transcript, exports, and screen readers: `✓ label` or `✗ label` for a
 * toggle and `label: value` for any other field, joined with `, `.
 */
function formSummaryText(lines: readonly FormSummaryLine[]): string {
  return lines
    .map((line) =>
      line.kind === "toggle"
        ? `${line.on ? "✓" : "✗"} ${line.label}`
        : `${line.label}: ${line.value}`,
    )
    .join(", ");
}

/**
 * The field values a form's settled `result` holds, as its form state held them (a cycle by the position of the option
 * it showed, from `shownOptions`), or `null` when they are not what this form settles with: one answer per field, and
 * for each cycle the position of an option with its answer as value.
 */
function formValuesOf(
  ui: FormUi,
  result: unknown,
  shownOptions: unknown,
): readonly RuntimeFormValue[] | null {
  const answers = formAnswersOf(ui, result);
  if (answers === null || !Array.isArray(shownOptions) || shownOptions.length !== ui.fields.length)
    return null;
  const values: RuntimeFormValue[] = [];
  for (const [index, field] of ui.fields.entries()) {
    const answer = answers[index]!;
    const shown: unknown = shownOptions[index];
    if (field.kind !== "cycle") {
      if (shown !== null) return null;
      // EVIDENCE: validation: formAnswersOf checked every answer as a value of its field.
      values.push(answer as RuntimeFormValue);
      continue;
    }
    if (
      typeof shown !== "number" ||
      !Number.isSafeInteger(shown) ||
      shown < 0 ||
      shown >= field.options.length ||
      !serializableEquals(field.options[shown]!.value, answer)
    )
      return null;
    values.push(shown);
  }
  return values;
}

function refused(message: string): { readonly ok: false; readonly message: string } {
  return { ok: false, message };
}

/** Whether two form states hold the same answers and editor. */
export function formStatesEqual(a: RuntimeFormStateSnapshot, b: RuntimeFormStateSnapshot): boolean {
  return (
    a.values.length === b.values.length &&
    a.values.every((value, index) => serializableEquals(value, b.values[index]!)) &&
    (a.editor === null
      ? b.editor === null
      : b.editor !== null &&
        a.editor.fieldId === b.editor.fieldId &&
        a.editor.text === b.editor.text)
  );
}

export function cloneFormState(state: RuntimeFormStateSnapshot): RuntimeFormStateSnapshot {
  return {
    values: state.values.map((value) =>
      typeof value === "object" && value !== null ? { ...value } : value,
    ),
    editor: state.editor === null ? null : { ...state.editor },
  };
}

export function cloneFormUi(ui: FormUi, accessibleName: InteractionAccessibleName): FormUi {
  const options = (items: readonly InteractionChoiceOption[]) =>
    items.map((option) => ({
      text: option.text,
      value:
        typeof option.value === "object" && option.value !== null
          ? { ...option.value }
          : option.value,
      ...(option.background === undefined ? {} : { background: option.background }),
    }));
  return {
    kind: "form",
    shape: ui.shape,
    fields: ui.fields.map((field): FormField => {
      const base = {
        id: field.id,
        text: field.text,
        ...(field.background === undefined ? {} : { background: field.background }),
      };
      if (field.kind === "boolean")
        return {
          ...base,
          kind: "boolean",
          options: field.options === null ? null : options(field.options),
        };
      if (field.kind === "cycle")
        return { ...base, kind: "cycle", options: options(field.options) };
      return {
        ...base,
        kind: field.kind,
        optional: field.optional,
        min: field.min,
        max: field.max,
        hint: field.hint,
      };
    }),
    hint: ui.hint,
    submit: {
      text: ui.submit.text,
      ...(ui.submit.background === undefined ? {} : { background: ui.submit.background }),
    },
    cancel:
      ui.cancel === null
        ? null
        : {
            text: ui.cancel.text,
            ...(ui.cancel.background === undefined ? {} : { background: ui.cancel.background }),
          },
    timeout: ui.timeout === null ? null : { ...ui.timeout },
    accessibleName,
  };
}

/** Every text a form definition retains, for the interaction's aggregate byte limit. */
export function formUiTexts(ui: FormUi): string[] {
  const texts: string[] = [ui.submit.text];
  if (ui.cancel !== null) texts.push(ui.cancel.text);
  if (ui.hint !== null) texts.push(ui.hint);
  for (const field of ui.fields) {
    texts.push(field.id);
    if (field.text !== field.id) texts.push(field.text);
    if (field.kind === "boolean" || field.kind === "cycle") {
      for (const option of field.options ?? []) {
        texts.push(option.text);
        if (typeof option.value === "string" && option.value !== option.text)
          texts.push(option.value);
      }
    } else if (field.hint !== null) texts.push(field.hint);
  }
  return texts;
}

/** Whether `value` is a well-formed form definition, without measuring its texts. */
export function isFormUi(value: unknown): value is FormUi {
  return (
    isPlainRecord(value) &&
    value.kind === "form" &&
    validFormUi(value, (text): text is string => typeof text === "string")
  );
}

/**
 * Whether `value` is a well-formed form definition. `count` measures each retained text against the interaction's
 * aggregate byte limit and returns `false` when it does not fit.
 */
export function validFormUi(
  value: Record<string, unknown>,
  count: (text: unknown) => text is string,
): boolean {
  if (
    !hasExactKeys(value, [
      "kind",
      "shape",
      "fields",
      "hint",
      "submit",
      "cancel",
      "timeout",
      "accessibleName",
    ]) ||
    !validTimeout(value.timeout) ||
    (value.shape !== "object" && value.shape !== "dict" && value.shape !== "booleanList") ||
    (value.hint !== null && !count(value.hint)) ||
    !validButton(value.submit, count) ||
    (value.cancel !== null && !validButton(value.cancel, count)) ||
    !Array.isArray(value.fields) ||
    value.fields.length === 0 ||
    value.fields.length > MAX_INTERACTION_OPTION_ENTRIES
  )
    return false;
  const ids = new Set<string>();
  let entries = 0;
  return value.fields.every((field: unknown, index) => {
    if (isPlainRecord(field) && Array.isArray(field.options)) entries += field.options.length;
    if (++entries > MAX_INTERACTION_OPTION_ENTRIES) return false;
    if (
      !isPlainRecord(field) ||
      typeof field.id !== "string" ||
      ids.has(field.id) ||
      !count(field.id) ||
      typeof field.text !== "string" ||
      (field.text !== field.id && !count(field.text)) ||
      !isFormFieldKind(field.kind) ||
      ("background" in field && !isNormalizedOpaqueColor(field.background))
    )
      return false;
    ids.add(field.id);
    const background = "background" in field ? ["background"] : [];
    if (value.shape === "booleanList" && (field.kind !== "boolean" || field.id !== String(index)))
      return false;
    if (field.kind === "boolean" || field.kind === "cycle") {
      if (!hasExactKeys(field, ["id", "text", "kind", "options", ...background])) return false;
      if (field.kind === "boolean" && field.options === null) return true;
      const options = field.options;
      if (!validOptions(options, count)) return false;
      if (field.kind === "boolean")
        return (
          options.length === 2 &&
          options.some((option) => option.value === false) &&
          options.some((option) => option.value === true)
        );
      const valueKind = cycleValueKind(options[0]!.value);
      return options.every(
        (option) => option.value !== null && cycleValueKind(option.value) === valueKind,
      );
    }
    if (
      !hasExactKeys(field, [
        "id",
        "text",
        "kind",
        "optional",
        "min",
        "max",
        "hint",
        ...background,
      ]) ||
      typeof field.optional !== "boolean" ||
      (field.hint !== null && !count(field.hint))
    )
      return false;
    const numeric = field.kind === "integer" || field.kind === "number";
    const validBound = (bound: unknown): bound is number | null =>
      bound === null ||
      (numeric &&
        typeof bound === "number" &&
        Number.isFinite(bound) &&
        !Object.is(bound, -0) &&
        (field.kind !== "integer" || Number.isSafeInteger(bound)));
    const { min, max } = field;
    return validBound(min) && validBound(max) && (min === null || max === null || min <= max);
  });
}

function validTimeout(value: unknown): boolean {
  return (
    value === null ||
    (isPlainRecord(value) &&
      hasExactKeys(value, ["milliseconds", "onTimeout"]) &&
      typeof value.milliseconds === "number" &&
      value.milliseconds > 0 &&
      Number.isFinite(value.milliseconds) &&
      (value.onTimeout === "submit" || value.onTimeout === "cancel"))
  );
}

/** A submit or cancel button: its text and an optional background. */
function validButton(value: unknown, count: (text: unknown) => text is string): boolean {
  return (
    isPlainRecord(value) &&
    hasExactKeys(value, ["text", ...("background" in value ? ["background"] : [])]) &&
    count(value.text) &&
    (!("background" in value) || isNormalizedOpaqueColor(value.background))
  );
}

function validOptions(
  value: unknown,
  count: (text: unknown) => text is string,
): value is readonly InteractionChoiceOption[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_INTERACTION_OPTION_ENTRIES &&
    value.every(
      (option: unknown) =>
        isPlainRecord(option) &&
        hasExactKeys(option, [
          "text",
          "value",
          ...("background" in option ? ["background"] : []),
        ]) &&
        (!("background" in option) || isNormalizedOpaqueColor(option.background)) &&
        count(option.text) &&
        isInteractionChoiceValue(option.value) &&
        (typeof option.value !== "string" || option.value === option.text || count(option.value)),
    )
  );
}

/** Whether `value` is a well-formed state of an open form with this valid definition. */
export function validFormState(ui: FormUi, value: unknown): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["values", "editor"])) return false;
  const values = value.values;
  if (
    !Array.isArray(values) ||
    values.length !== ui.fields.length ||
    !ui.fields.every((field, index) => validFieldValue(field, values[index], true))
  )
    return false;
  const editor = value.editor;
  if (editor === null) return true;
  return (
    isPlainRecord(editor) &&
    hasExactKeys(editor, ["fieldId", "text"]) &&
    typeof editor.text === "string" &&
    interactionStringFits(editor.text) &&
    ui.fields.some(
      (field) => field.id === editor.fieldId && field.kind !== "boolean" && field.kind !== "cycle",
    )
  );
}

/** Whether `value` is a field's held value; `unset` admits `null` for a typed field that has none yet. */
function validFieldValue(field: FormField, value: unknown, unset: boolean): boolean {
  if (field.kind === "boolean") return typeof value === "boolean";
  if (field.kind === "cycle")
    return (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value < field.options.length
    );
  if (value === null) return unset || field.optional;
  if (field.kind === "text")
    return (
      typeof value === "string" &&
      interactionStringFits(value) &&
      !value.includes("\r") &&
      !isBlankTextAnswer(value)
    );
  if (field.kind === "integer" || field.kind === "number")
    return (
      typeof value === "number" &&
      Number.isFinite(value) &&
      !Object.is(value, -0) &&
      (field.kind === "number" || Number.isSafeInteger(value)) &&
      withinBounds(field, value)
    );
  return (
    isInteractionChoiceValue(value) &&
    typeof value === "object" &&
    value !== null &&
    value.kind === field.kind
  );
}

/**
 * Whether `result` is what this valid form definition can return, with a transcript that fits it: one answer per field,
 * by ID and in order, with only optional fields `null`.
 */
export function validFormResult(
  ui: FormUi,
  result: unknown,
  transcriptText: unknown,
  shownOptions: unknown,
  timedOut = false,
): boolean {
  // A form that returns `null` showed no options; one with answers shows, for each cycle, an option with its answer.
  if (result === null ? shownOptions !== null : formValuesOf(ui, result, shownOptions) === null)
    return false;
  // At its time limit a form says nothing for the player, and returns `null` or its answers as its limit says.
  if (timedOut) {
    if (ui.timeout === null || transcriptText !== null) return false;
    return (ui.timeout.onTimeout === "cancel") === (result === null);
  }
  // A cancelled form returns `null`, with its cancel button's text.
  if (result === null) return ui.cancel !== null && transcriptText === ui.cancel.text;
  // A submitted form's line shows a date or time answer in the player's presentation then, which a later capture may
  // have replaced, so it is checked as text, as a date or time ask's line is.
  return typeof transcriptText === "string";
}

/**
 * The answers of `result` in field order when it is what this valid form definition can return: one answer per
 * field, by ID and in order, with only optional fields `null`; otherwise `null`.
 */
function formAnswersOf(ui: FormUi, result: unknown): readonly SerializableRuntimeValue[] | null {
  if (!isPlainRecord(result)) return null;
  let answers: readonly unknown[];
  if (ui.shape === "object") {
    if (!hasExactKeys(result, ["kind", "properties"]) || result.kind !== "object") return null;
    const properties = result.properties;
    if (
      !Array.isArray(properties) ||
      properties.length !== ui.fields.length ||
      !properties.every(
        (property: unknown, index) =>
          isPlainRecord(property) &&
          hasExactKeys(property, ["name", "value"]) &&
          property.name === ui.fields[index]!.id,
      )
    )
      return null;
    answers = properties.map((property: Record<string, unknown>) => property.value);
  } else if (ui.shape === "dict") {
    if (!hasExactKeys(result, ["kind", "entries"]) || result.kind !== "dict") return null;
    const entries = result.entries;
    if (
      !Array.isArray(entries) ||
      entries.length !== ui.fields.length ||
      !entries.every(
        (entry: unknown, index) =>
          isPlainRecord(entry) &&
          hasExactKeys(entry, ["key", "value"]) &&
          entry.key === ui.fields[index]!.id,
      )
    )
      return null;
    answers = entries.map((entry: Record<string, unknown>) => entry.value);
  } else {
    if (!hasExactKeys(result, ["kind", "items"]) || result.kind !== "list") return null;
    if (!Array.isArray(result.items) || result.items.length !== ui.fields.length) return null;
    answers = result.items;
  }
  const valid = ui.fields.every((field, index) => {
    const answer = answers[index];
    if (field.kind !== "cycle") return validFieldValue(field, answer, false);
    return (
      isInteractionChoiceValue(answer) &&
      field.options.some((option) => serializableEquals(option.value, answer))
    );
  });
  // EVIDENCE: validation: every answer was checked as a value of its field above.
  return valid ? (answers as readonly SerializableRuntimeValue[]) : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function fault(message: string, span: SourceSpan): RuntimeFault {
  return new RuntimeFault("TSR052", message, copySpan(span));
}
