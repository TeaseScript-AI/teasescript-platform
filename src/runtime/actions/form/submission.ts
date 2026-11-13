// Submitting a form: its result and answer, a timed-out result, the summary a transcript shows, the values a result
// holds, and the result's restore check.

import { isInteractionChoiceValue } from "../../../choice-values.js";
import { formValueText } from "../../../interaction-answers.js";
import { interactionStringFits } from "../../../interaction-limits.js";
import type { FormField, FormUi } from "../../../plan/model.js";
import { presentationSettingsProblem, type PresentationSettings } from "../../../temporal.js";
import {
  serializableEquals,
  type SerializableRuntimeValue,
} from "../../values/serializable-values.js";
import type {
  InteractionResultValue,
  RuntimeFormStateSnapshot,
  RuntimeFormValue,
} from "../model.js";
import { hasExactKeys } from "../../../plan/validation-support.js";
import { isPlainRecord } from "../../values/plain-data.js";
import { refused } from "./shared-helpers.js";
import { commitEditor } from "./editing.js";
import { validFieldValue } from "./ui-state.js";

export type FormSubmission =
  | {
      readonly ok: true;
      readonly result: InteractionResultValue;
      readonly transcriptText: string;
      readonly shownOptions: readonly (number | null)[];
      readonly temporalPresentation: PresentationSettings;
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
  presentation: PresentationSettings,
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
    temporalPresentation: presentation,
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
  presentation: PresentationSettings,
): readonly FormSummaryLine[] | null {
  const values = formValuesOf(ui, result, shownOptions);
  return values === null ? null : formSummaryLines(ui, values, presentation);
}

function formSummaryLines(
  ui: FormUi,
  values: readonly RuntimeFormValue[],
  presentation: PresentationSettings,
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

/**
 * Whether `result` is what this valid form definition can return, with a transcript that fits it: one answer per field,
 * by ID and in order, with only optional fields `null`, and for submitted answers the summary of them in
 * `temporalPresentation`.
 */
export function validFormResult(
  ui: FormUi,
  result: unknown,
  transcriptText: unknown,
  shownOptions: unknown,
  temporalPresentation: unknown,
  timedOut = false,
): boolean {
  // A form that returns `null` showed no options; one with answers shows, for each cycle, an option with its answer.
  const values = result === null ? null : formValuesOf(ui, result, shownOptions);
  if (result === null ? shownOptions !== null : values === null) return false;
  // At its time limit a form says nothing for the player, and returns `null` or its answers as its limit says.
  if (timedOut) {
    if (ui.timeout === null || transcriptText !== null || temporalPresentation !== null)
      return false;
    return (ui.timeout.onTimeout === "cancel") === (result === null);
  }
  // A cancelled form returns `null`, with its cancel button's text.
  if (result === null)
    return ui.cancel !== null && transcriptText === ui.cancel.text && temporalPresentation === null;
  if (values === null || presentationSettingsProblem(temporalPresentation) !== null) return false;
  // EVIDENCE: validation: presentationSettingsProblem accepted the presentation above.
  const presentation = temporalPresentation as PresentationSettings;
  // A submitted form's line is the summary of its answers in the presentation they were shown in.
  return transcriptText === formSummaryText(formSummaryLines(ui, values, presentation));
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
