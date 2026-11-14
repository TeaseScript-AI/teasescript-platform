// A form's UI and state: copying and comparing them, the UI's request value, the texts a UI shows, and their restore
// checks.

import { isNormalizedOpaqueColor } from "../../../color.js";
import { isInteractionChoiceValue } from "../../../choice-values.js";
import { isBlankTextAnswer } from "../../../interaction-answers.js";
import {
  MAX_INTERACTION_OPTION_ENTRIES,
  interactionStringFits,
  interactionStringHasNonWhitespace,
} from "../../../interaction-limits.js";
import type {
  FormField,
  FormUi,
  InteractionAccessibleName,
  InteractionChoiceOption,
} from "../../../plan/model.js";
import {
  serializableEquals,
  type SerializableRuntimeValue,
} from "../../values/serializable-values.js";
import { isFormFieldKind } from "../../../form-fields.js";
import type { RuntimeFormStateSnapshot } from "../model.js";
import { hasExactKeys } from "../../../plan/validation-support.js";
import { isPlainRecord } from "../../values/plain-data.js";
import { cycleValueKind, withinBounds } from "./shared-helpers.js";

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

/** A copy of `ui` with `accessibleName` as its accessible name. */
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

/**
 * Narrows a form UI: every field of `FormUi` has its type, its fields, buttons, hint and timeout are well formed, and its
 * accessible name is a form's. It does not measure the texts against the interaction's byte limit, which
 * `validInteractionUiShape` does.
 */
export function isFormUi(value: unknown): value is FormUi {
  return (
    isPlainRecord(value) &&
    value.kind === "form" &&
    isFormAccessibleName(value.accessibleName) &&
    validFormUi(value, (text): text is string => typeof text === "string")
  );
}

/** A form's accessible name: a text that is not blank, or the form's default (`answer`). */
function isFormAccessibleName(value: unknown): value is InteractionAccessibleName {
  if (!isPlainRecord(value)) return false;
  if (value.kind === "text")
    return (
      hasExactKeys(value, ["kind", "text"]) &&
      typeof value.text === "string" &&
      interactionStringHasNonWhitespace(value.text)
    );
  return (
    value.kind === "localizedDefault" &&
    hasExactKeys(value, ["kind", "key"]) &&
    value.key === "answer"
  );
}

/**
 * A form UI's shape, fields, hint, buttons and timeout; of the accessible name, only that the key is there. Its two
 * callers check the name themselves: `validInteractionUiShape`, whose `count` measures each retained text against the
 * interaction's aggregate byte limit and returns `false` when it does not fit, and `isFormUi`, whose `count` checks only
 * that each text is a string.
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

/**
 * Whether `value` is a well-formed state of an open form with this valid definition. A form that submits at its time
 * limit holds a value in every required field, as it has since it opened.
 */
export function validFormState(ui: FormUi, value: unknown): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["values", "editor"])) return false;
  const values = value.values;
  // Only a form without a time limit, or one that cancels at it, may hold a required field without a value.
  const requiredMayBeUnset = ui.timeout === null || ui.timeout.onTimeout === "cancel";
  if (
    !Array.isArray(values) ||
    values.length !== ui.fields.length ||
    !ui.fields.every((field, index) => validFieldValue(field, values[index], requiredMayBeUnset))
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
export function validFieldValue(field: FormField, value: unknown, unset: boolean): boolean {
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
