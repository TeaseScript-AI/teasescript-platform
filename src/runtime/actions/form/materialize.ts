// askForm's materialization: the form UI an instruction's fields, button and timeout make, and whether an answer could
// fit the form.

import { normalizeOpaqueColor } from "../../../color.js";
import { isTimeoutLength, timeoutLengthMessage } from "../../../delay-rules.js";
import {
  isBlankTextAnswer,
  numberAnswerText,
  temporalAnswer,
} from "../../../interaction-answers.js";
import {
  interactionStringFits,
  MAX_INTERACTION_OPTION_ENTRIES,
  MAX_INTERACTION_STRING_UTF8_BYTES,
} from "../../../interaction-limits.js";
import type {
  FormField,
  FormFieldKind,
  FormScalarField,
  FormUi,
  InteractionAccessibleName,
  PreparedFormShape,
  TypePlan,
} from "../../../plan/model.js";
import { type TemporalContext } from "../../../temporal.js";
import { expandChoiceOptions } from "../choice-options.js";
import { internalFault, RuntimeFault } from "../../errors.js";
import {
  getSerializableProperty,
  serializableEquals,
  type SerializableRuntimeObject,
  type SerializableRuntimeValue,
} from "../../values/serializable-values.js";
import {
  isAnyDuration,
  isDate,
  isDateTime,
  isDict,
  isList,
  isObject,
  isTime,
} from "../../values/value-predicates.js";
import { fieldText } from "../../values/value-text.js";
import { exactDurationMilliseconds } from "../../values/temporal-operations.js";
import { describeShownValue, describeType, matchesValueType } from "../../values/value-types.js";
import { escapedMarkupLength, escapeMarkup } from "../../../message-markup.js";
import { checkTextLength, MAX_TEXT_LENGTH, messageText } from "../../values/text-length.js";
import {
  FORM_FIELD_PROPERTIES,
  FORM_FIELD_PROPERTIES_TEXT,
  isFormFieldKind,
  unknownFormTypeMessage,
} from "../../../form-fields.js";
import type { RuntimeFormStateSnapshot, RuntimeFormValue } from "../model.js";
import { describeValue } from "../../../value-kinds.js";
import { copySpan } from "../../../plan/source-location.js";
import {
  type SourceSpan,
  cycleValueKind,
  withinBounds,
  boundsText,
  fault,
} from "./shared-helpers.js";

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
          `askBooleans prefill ${index} (${JSON.stringify(messageText(fieldText(text, span, context)))}): takes true or false, not ${describeValue(start)}.`,
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
        `askForm fields: must be ${prepared.kind === "object" ? "an object" : prepared.kind === "dict" ? "a dict" : "an object or a dict"} of fields, not ${describeValue(fieldsValue)}.`,
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
  if (!isTimeoutLength(milliseconds))
    throw fault(
      typeof value === "number"
        ? `An askForm timeout is a duration, but this is ${describeShownValue(value)}. Give the number a unit, such as '${describeShownValue(value)} s'.`
        : timeoutLengthMessage("askForm", describeShownValue(value)),
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
          : `type: must be text such as "integer", not ${describeValue(typeValue)}.`,
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
  else throw problem(`a field cannot start as ${describeValue(start)}.`);

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
        throw problem(`a toggle starts true or false, not ${describeValue(start)}.`);
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
      throw problem(`${name}: must be a number, not ${describeValue(value)}.`);
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
        : `a ${kind} field cannot start as ${describeValue(start!)}.`,
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
