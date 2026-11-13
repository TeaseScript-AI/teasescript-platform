// Editing a form: the request a host sees, an update to a field or its editor, and parsing an editor's text.

import {
  invalidAnswerMessage,
  isBlankTextAnswer,
  isIntegerAnswerText,
  isNumberAnswerText,
  numberAnswerText,
  temporalAnswer,
  temporalAnswerText,
} from "../../../interaction-answers.js";
import { interactionStringFits } from "../../../interaction-limits.js";
import type { FormScalarField, FormUi, InteractionChoiceOption } from "../../../plan/model.js";
import { type SerializableRuntimeValue } from "../../values/serializable-values.js";
import { messageText } from "../../values/text-length.js";
import type { RuntimeFormStateSnapshot, RuntimeFormValue } from "../model.js";
import { withinBounds, boundsText, refused, isPlainRecord } from "./shared-helpers.js";

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
export function commitEditor(ui: FormUi, state: RuntimeFormStateSnapshot): FormStep {
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
    if (!valid) return refused(invalidAnswerMessage(field.kind));
    const value = Object.is(parsed, -0) ? 0 : parsed;
    if (!withinBounds(field, value))
      return refused(`That is wrong. ${field.text} must be ${boundsText(field)}.`);
    return { ok: true, value };
  }
  const answer = temporalAnswer(field.kind, trimmed);
  if (answer === undefined) return refused(invalidAnswerMessage(field.kind));
  return { ok: true, value: answer };
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
