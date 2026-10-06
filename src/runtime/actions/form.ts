import { isNormalizedOpaqueColor, normalizeOpaqueColor } from "../../color.js";
import { isInteractionChoiceValue } from "../../choice-values.js";
import {
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
} from "../../plan/model.js";
import type { SourceSpan as RichSourceSpan } from "../../source.js";
import type { TemporalContext } from "../../temporal.js";
import { expandChoiceOptions } from "../choice-options.js";
import { RuntimeFault } from "../errors.js";
import { copySpan } from "../operations/support.js";
import {
  getSerializableProperty,
  serializableEquals,
  type SerializableRuntimeObject,
  type SerializableRuntimeValue,
} from "../serializable-values.js";
import {
  describeRuntimeValue,
  isDate,
  isDateTime,
  isDict,
  isList,
  isObject,
  isTime,
} from "../value-predicates.js";
import { fieldText } from "../value-text.js";
import type {
  InteractionResultValue,
  RuntimeFormStateSnapshot,
  RuntimeFormValue,
} from "./model.js";

type SourceSpan = RichSourceSpan | PlanSourceLocation;

const FIELD_KINDS: readonly FormFieldKind[] = [
  "boolean",
  "cycle",
  "integer",
  "number",
  "text",
  "date",
  "time",
  "datetime",
];
const DESCRIPTOR_PROPERTIES = [
  "type",
  "value",
  "text",
  "options",
  "optional",
  "min",
  "max",
  "hint",
  "background",
];
const DEFAULT_SUBMIT_TEXT = "OK";

/** A form as it opens: its definition and the starting answers. */
export interface MaterializedForm {
  readonly ui: FormUi;
  readonly state: RuntimeFormStateSnapshot;
}

/**
 * Builds a form from its prepared request (V30 §20): `fields`, an object or dict of starting values and field
 * descriptors, or for `askBooleans` its parallel `texts` and `defaults`, and the optional `hint` and `submit`. Each
 * field is checked once, here; an invalid one fails with `TSR052` and a message that names it.
 */
export function materializeForm(
  request: SerializableRuntimeValue,
  prepared: PreparedFormShape,
  accessibleName: InteractionAccessibleName,
  context: TemporalContext,
  span: SourceSpan,
): MaterializedForm {
  if (!isObject(request)) throw fault("The prepared form request is malformed.", span);
  let fieldsValue: SerializableRuntimeValue | undefined;
  let texts: SerializableRuntimeValue | undefined;
  let defaults: SerializableRuntimeValue | undefined;
  let hint: string | null = null;
  let submit: FormUi["submit"] = { text: DEFAULT_SUBMIT_TEXT };
  for (const { name, value } of request.properties) {
    if (name === "message") continue;
    if (name === "fields") fieldsValue = value;
    else if (name === "texts") texts = value;
    else if (name === "defaults") defaults = value;
    else if (name === "hint") hint = fieldText(value, span, context);
    else if (name === "submit") submit = formButton(name, value, context, span);
    else throw fault("The prepared form request is malformed.", span);
  }

  const fields: FormField[] = [];
  const values: RuntimeFormValue[] = [];
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
  if (prepared.kind === "booleanList") {
    if (texts === undefined || defaults === undefined || fieldsValue !== undefined)
      throw fault("The prepared form request is malformed.", span);
    if (!isList(texts) || !isList(defaults))
      throw fault("askBooleans takes a list of texts and a list of defaults.", span);
    if (texts.items.length !== defaults.items.length)
      throw fault(
        `askBooleans has ${texts.items.length} texts but ${defaults.items.length} defaults; give one default for each text.`,
        span,
      );
    texts.items.forEach((text, index) => {
      const start = defaults.items[index]!;
      if (typeof start !== "boolean")
        throw fault(
          `askBooleans takes true or false as each default, not ${describeRuntimeValue(start)}.`,
          span,
        );
      add(
        { id: String(index), text: fieldText(text, span, context), kind: "boolean", options: null },
        start,
      );
    });
  } else {
    if (fieldsValue === undefined || texts !== undefined || defaults !== undefined)
      throw fault("The prepared form request is malformed.", span);
    const written =
      prepared.kind === "object" && isObject(fieldsValue)
        ? fieldsValue.properties.map(({ name, value }) => ({ id: name, value }))
        : prepared.kind === "dict" && isDict(fieldsValue)
          ? fieldsValue.entries.map(({ key, value }) => ({ id: key, value }))
          : undefined;
    if (written === undefined)
      throw fault(
        `askForm fields: must be ${prepared.kind === "object" ? "an object" : "a dict"} of fields, not ${describeRuntimeValue(fieldsValue)}.`,
        span,
      );
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
    }
  }
  if (fields.length === 0) throw fault("A form needs at least one field.", span);
  return {
    ui: { kind: "form", shape: prepared.kind, fields, hint, submit, accessibleName },
    state: { values, editor: null },
  };
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
): { readonly field: FormField; readonly value: RuntimeFormValue } {
  const problem = (message: string) => fault(`askForm field '${id}': ${message}`, span);
  const descriptor: SerializableRuntimeObject | null = isObject(raw) ? raw : null;
  const unknown = descriptor?.properties.find(
    (property) => !DESCRIPTOR_PROPERTIES.includes(property.name),
  );
  if (unknown !== undefined)
    throw problem(
      `unknown property '${unknown.name}'. A field has type, value, text, options, optional, min, max, hint, and background.`,
    );
  const read = (name: string): SerializableRuntimeValue | undefined =>
    descriptor === null ? undefined : getSerializableProperty(descriptor, name);
  const start = descriptor !== null ? read("value") : isList(raw) ? undefined : raw;
  const typeValue = read("type");
  const options = descriptor === null ? (isList(raw) ? raw : undefined) : read("options");

  let kind: FormFieldKind;
  if (typeValue !== undefined) {
    if (!isFieldKind(typeValue)) throw problem(unknownTypeMessage(typeValue));
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
      return { field: { ...base, kind, options: buttons }, value: start ?? false };
    }
    if (buttons === null) throw problem("a cycle needs options:.");
    const valueKind = cycleValueKind(buttons[0]!.value);
    if (buttons.some((option) => option.value === null))
      throw problem("each cycle option needs a value; null is not one.");
    if (buttons.some((option) => cycleValueKind(option.value) !== valueKind))
      throw problem("the options of a cycle must all have the same type.");
    const index =
      start === undefined
        ? 0
        : buttons.findIndex((option) => serializableEquals(option.value, start));
    if (index === -1) throw problem(`its value is not one of its options.`);
    return { field: { ...base, kind, options: buttons }, value: index };
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
  return { field, value };
}

/** A typed field's starting value, `null` when it starts without one, or `undefined` when it does not fit. */
function scalarStart(
  field: FormScalarField,
  start: SerializableRuntimeValue,
): RuntimeFormValue | undefined {
  // Like an ask's default, `null` or blank text prefills nothing.
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

function isFieldKind(value: unknown): value is FormFieldKind {
  return FIELD_KINDS.some((kind) => kind === value);
}

function unknownTypeMessage(value: SerializableRuntimeValue): string {
  if (typeof value !== "string")
    return `type: must be text such as "integer", not ${describeRuntimeValue(value)}.`;
  const suggestion = FIELD_KINDS.find((kind) => editDistance(kind, value.toLowerCase()) <= 2);
  return suggestion === undefined
    ? `unknown type '${value}' (use ${FIELD_KINDS.map((kind) => `'${kind}'`).join(", ")}).`
    : `unknown type '${value}' (use '${suggestion}').`;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2 || b.length > 16) return 3;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1)
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    previous = current;
  }
  return previous[b.length]!;
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
  if (index === -1) return refused(`The form has no field ${JSON.stringify(update.fieldId)}.`);
  const field = ui.fields[index]!;
  const keys = (names: readonly string[]) =>
    Object.keys(update).length === names.length && names.every((name) => name in update);
  const editing = state.editor?.fieldId === field.id;
  switch (update.kind) {
    case "select": {
      if (!keys(["kind", "fieldId", "optionIndex"]))
        return refused("A select update has kind, fieldId, and optionIndex.");
      if (field.kind !== "boolean" && field.kind !== "cycle")
        return refused(`Field ${JSON.stringify(field.id)} is typed in the composer.`);
      const count = field.options?.length ?? 2;
      const optionIndex = update.optionIndex;
      if (
        typeof optionIndex !== "number" ||
        !Number.isSafeInteger(optionIndex) ||
        optionIndex < 0 ||
        optionIndex >= count
      )
        return refused(`Field ${JSON.stringify(field.id)} has no option ${String(optionIndex)}.`);
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
        return refused(`Field ${JSON.stringify(field.id)} is not typed in the composer.`);
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
      if (!editing) return refused(`Field ${JSON.stringify(field.id)} is not being edited.`);
      return {
        ok: true,
        state: { values: state.values, editor: { fieldId: field.id, text: update.text } },
      };
    }
    case "commit": {
      if (!keys(["kind", "fieldId"])) return refused("A commit update has kind and fieldId.");
      // A repeated commit finds the field already closed.
      if (state.editor === null) return { ok: true, state };
      if (!editing) return refused(`Field ${JSON.stringify(field.id)} is not being edited.`);
      return commitEditor(ui, state);
    }
    case "clear": {
      if (!keys(["kind", "fieldId"])) return refused("A clear update has kind and fieldId.");
      if (field.kind === "boolean" || field.kind === "cycle")
        return refused(`Field ${JSON.stringify(field.id)} is not typed in the composer.`);
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
  | { readonly ok: true; readonly result: InteractionResultValue; readonly transcriptText: string }
  | { readonly ok: false; readonly message: string };

/**
 * Submits a form: commits the text being edited, requires a value for every required field, and returns the answers
 * in field order as the form's shape: an object, a dict, or a list of booleans. An optional field without a value
 * returns `null`.
 */
export function submitForm(ui: FormUi, state: RuntimeFormStateSnapshot): FormSubmission {
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
  const result: InteractionResultValue =
    ui.shape === "object"
      ? {
          kind: "object",
          properties: ui.fields.map((field, index) => ({ name: field.id, value: answers[index]! })),
        }
      : ui.shape === "dict"
        ? {
            kind: "dict",
            entries: ui.fields.map((field, index) => ({ key: field.id, value: answers[index]! })),
          }
        : { kind: "list", items: answers };
  return { ok: true, result, transcriptText: formSummaryText(ui, answers) };
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

/**
 * The player's transcript line for a submitted form: how many toggles are on when every field is a toggle, such as
 * `12 of 43 selected`, and otherwise how many fields have a value, such as `5 of 6 fields set`.
 */
function formSummaryText(ui: FormUi, answers: readonly SerializableRuntimeValue[]): string {
  const total = ui.fields.length;
  if (ui.fields.every((field) => field.kind === "boolean"))
    return `${answers.filter((answer) => answer === true).length} of ${total} selected`;
  return `${answers.filter((answer) => answer !== null).length} of ${total} ${total === 1 ? "field" : "fields"} set`;
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
    accessibleName,
  };
}

/** Every text a form definition retains, for the interaction's aggregate byte limit. */
export function formUiTexts(ui: FormUi): string[] {
  const texts: string[] = [ui.submit.text];
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
    !hasExactKeys(value, ["kind", "shape", "fields", "hint", "submit", "accessibleName"]) ||
    (value.shape !== "object" && value.shape !== "dict" && value.shape !== "booleanList") ||
    (value.hint !== null && !count(value.hint)) ||
    !isPlainRecord(value.submit) ||
    !hasExactKeys(value.submit, [
      "text",
      ...("background" in value.submit ? ["background"] : []),
    ]) ||
    !count(value.submit.text) ||
    ("background" in value.submit && !isNormalizedOpaqueColor(value.submit.background)) ||
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
      !isFieldKind(field.kind) ||
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
 * Whether `result` is what this valid form definition can return, and `transcriptText` its summary: one answer per
 * field, by ID and in order, with only optional fields `null`.
 */
export function validFormResult(ui: FormUi, result: unknown, transcriptText: unknown): boolean {
  if (!isPlainRecord(result)) return false;
  let answers: readonly unknown[];
  if (ui.shape === "object") {
    if (!hasExactKeys(result, ["kind", "properties"]) || result.kind !== "object") return false;
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
      return false;
    answers = properties.map((property: Record<string, unknown>) => property.value);
  } else if (ui.shape === "dict") {
    if (!hasExactKeys(result, ["kind", "entries"]) || result.kind !== "dict") return false;
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
      return false;
    answers = entries.map((entry: Record<string, unknown>) => entry.value);
  } else {
    if (!hasExactKeys(result, ["kind", "items"]) || result.kind !== "list") return false;
    if (!Array.isArray(result.items) || result.items.length !== ui.fields.length) return false;
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
  if (!valid) return false;
  // EVIDENCE: validation: every answer was checked as a value of its field above.
  const checked = answers as readonly SerializableRuntimeValue[];
  return transcriptText === formSummaryText(ui, checked);
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
