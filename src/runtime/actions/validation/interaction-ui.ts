// An interaction UI's shape, and whether two UIs, a prepared and a presented one, or a settlement and its presented UI
// agree.

import { isNormalizedOpaqueColor } from "../../../color.js";
import { isValidInteractionPrefill } from "../../../interaction-answers.js";
import { isInteractionChoiceValue } from "../../../choice-values.js";
import { serializableEquals } from "../../values/serializable-values.js";
import { canonicalWebUrl } from "../../../web-url.js";
import {
  type InteractionChoiceOption,
  type InteractionKind,
  type InteractionUiPayload,
  DEFAULT_EXPORT_FILE_NAME,
  DEFAULT_EXPORT_TITLE,
  DEFAULT_OPEN_URL_BUTTON_TEXT,
  DEFAULT_POPUP_BUTTON_TEXT,
} from "../../../plan/model.js";
import {
  boundedInteractionUtf8ByteLength,
  interactionStringHasNonWhitespace,
  MAX_INTERACTION_AGGREGATE_UTF8_BYTES,
  MAX_INTERACTION_OPTION_ENTRIES,
} from "../../../interaction-limits.js";
import { formShapeFits, isFormUi, validFormResult, validFormUi } from "../form.js";
import { validImageRequestFields } from "../../../image-input.js";
import { recordValidationTestWork } from "../../../validation-testing.js";
import { isPlainRecord } from "../../values/plain-data.js";
import {
  nonNegativeSafeInteger,
  hasExactKeys,
  silentInteraction,
  isTemporalAnswerKind,
} from "./shared-checks.js";

export function accessibleNameEqual(
  expected: import("../../../plan/model.js").InteractionAccessibleName,
  actual: unknown,
): boolean {
  if (!isPlainRecord(actual) || actual.kind !== expected.kind) return false;
  return expected.kind === "localizedDefault"
    ? actual.key === expected.key
    : actual.text === expected.text;
}

export function validInteractionUiShape(kind: InteractionKind, value: unknown): boolean {
  if (!isPlainRecord(value) || value.kind !== kind || !isPlainRecord(value.accessibleName))
    return false;
  const expectedUiKeys =
    kind === "button"
      ? ["kind", "buttonLabel", "accessibleName", ...("background" in value ? ["background"] : [])]
      : kind === "text" || kind === "number" || kind === "temporal" || kind === "password"
        ? [
            "kind",
            "hint",
            "accessibleName",
            // A password is never suggested.
            ...("prefill" in value && kind !== "password" ? ["prefill"] : []),
            ...(kind === "number" && "integer" in value ? ["integer"] : []),
            ...(kind === "temporal" ? ["temporalKind"] : []),
          ]
        : kind === "image"
          ? [
              "kind",
              "question",
              "hint",
              "accessibleName",
              "allowCamera",
              "allowFile",
              "allowSkip",
              "types",
              "mime",
            ]
          : kind === "form"
            ? ["kind", "shape", "fields", "hint", "submit", "cancel", "timeout", "accessibleName"]
            : kind === "popup"
              ? ["kind", "message", "buttonText", "accessibleName"]
              : kind === "url"
                ? ["kind", "url", "buttonText", "alwaysButton", "accessibleName"]
                : kind === "export"
                  ? ["kind", "text", "title", "fileName", "accessibleName"]
                  : [
                      "kind",
                      "options",
                      "accessibleName",
                      ...("preselected" in value ? ["preselected"] : []),
                    ];
  if (
    !hasExactKeys(value, expectedUiKeys) ||
    ("integer" in value && value.integer !== true) ||
    (kind === "temporal" && !isTemporalAnswerKind(value.temporalKind))
  )
    return false;
  let aggregate = 0;
  let measurementExhausted = false;
  const count = (text: unknown): text is string => {
    if (typeof text !== "string") return false;
    if (measurementExhausted) {
      return text.length <= Math.max(0, MAX_INTERACTION_AGGREGATE_UTF8_BYTES - aggregate);
    }
    recordValidationTestWork("interactionUtf8Measurements");
    const bytes = boundedInteractionUtf8ByteLength(
      text,
      MAX_INTERACTION_AGGREGATE_UTF8_BYTES - aggregate,
    );
    if (bytes === null) {
      measurementExhausted = true;
      return false;
    }
    aggregate += bytes;
    return true;
  };
  const expectedKey =
    kind === "button" || silentInteraction(kind)
      ? "continue"
      : kind === "number"
        ? "number"
        : kind === "choice"
          ? "chooseOption"
          : kind === "password"
            ? "password"
            : "answer";
  if (value.accessibleName.kind === "text") {
    if (
      !hasExactKeys(value.accessibleName, ["kind", "text"]) ||
      !count(value.accessibleName.text) ||
      measurementExhausted ||
      !interactionStringHasNonWhitespace(value.accessibleName.text)
    )
      return false;
  } else if (
    !hasExactKeys(value.accessibleName, ["kind", "key"]) ||
    value.accessibleName.kind !== "localizedDefault" ||
    value.accessibleName.key !== expectedKey
  )
    return false;
  if (kind === "button") {
    return (
      count(value.buttonLabel) &&
      !measurementExhausted &&
      (!("background" in value) || isNormalizedOpaqueColor(value.background))
    );
  }
  if (kind === "popup")
    return count(value.message) && count(value.buttonText) && !measurementExhausted;
  if (kind === "password")
    return (value.hint === null || count(value.hint)) && !measurementExhausted;
  // The address is canonical.
  if (kind === "url")
    return (
      count(value.url) &&
      count(value.buttonText) &&
      !measurementExhausted &&
      canonicalWebUrl(value.url) === value.url &&
      typeof value.alwaysButton === "boolean"
    );
  // The exported text may be as long as any text, outside the interaction's text limit.
  if (kind === "export")
    return (
      typeof value.text === "string" &&
      count(value.title) &&
      count(value.fileName) &&
      !measurementExhausted
    );
  if (kind === "form") return validFormUi(value, count) && !measurementExhausted;
  if (kind === "image")
    return (
      (value.question === null || count(value.question)) &&
      (value.hint === null || count(value.hint)) &&
      validImageRequestFields(value, count) &&
      !measurementExhausted
    );
  if (kind === "text" || kind === "number" || kind === "temporal") {
    const answerKind = isTemporalAnswerKind(value.temporalKind)
      ? value.temporalKind
      : value.integer === true
        ? "integer"
        : kind === "number"
          ? "number"
          : "text";
    return (
      (value.hint === null || count(value.hint)) &&
      (!("prefill" in value) ||
        (count(value.prefill) && isValidInteractionPrefill(answerKind, value.prefill))) &&
      !measurementExhausted
    );
  }
  if (
    !Array.isArray(value.options) ||
    value.options.length === 0 ||
    value.options.length > MAX_INTERACTION_OPTION_ENTRIES
  )
    return false;
  for (const option of value.options) {
    if (
      !isPlainRecord(option) ||
      !hasExactKeys(option, ["text", "value", ...("background" in option ? ["background"] : [])])
    ) {
      return false;
    }
    if ("background" in option && !isNormalizedOpaqueColor(option.background)) return false;
    if (!count(option.text) && !measurementExhausted) return false;
    const value = option.value;
    if (!isInteractionChoiceValue(value)) return false;
    if (
      typeof value === "string" &&
      value !== option.text &&
      !count(value) &&
      !measurementExhausted
    )
      return false;
  }
  // A preselected button is one of the buttons.
  const preselected = "preselected" in value ? value.preselected : 0;
  if (!nonNegativeSafeInteger(preselected) || preselected >= value.options.length) return false;
  return !measurementExhausted;
}

export function interactionUiEqual(expected: InteractionUiPayload, actual: unknown): boolean {
  if (!isPlainRecord(actual) || actual.kind !== expected.kind) return false;
  if (!isPlainRecord(actual.accessibleName)) return false;
  if (actual.accessibleName.kind !== expected.accessibleName.kind) return false;
  if (expected.accessibleName.kind === "text") {
    if (actual.accessibleName.text !== expected.accessibleName.text) return false;
  } else if (actual.accessibleName.key !== expected.accessibleName.key) return false;
  if (expected.kind === "button")
    return actual.buttonLabel === expected.buttonLabel && actual.background === expected.background;
  if (expected.kind === "popup")
    return actual.message === expected.message && actual.buttonText === expected.buttonText;
  if (expected.kind === "url")
    return (
      actual.url === expected.url &&
      actual.buttonText === expected.buttonText &&
      actual.alwaysButton === expected.alwaysButton
    );
  if (expected.kind === "export")
    return (
      actual.text === expected.text &&
      actual.title === expected.title &&
      actual.fileName === expected.fileName
    );
  if (expected.kind === "text" || expected.kind === "number")
    return (
      actual.hint === expected.hint &&
      actual.prefill === expected.prefill &&
      actual.integer === (expected.kind === "number" ? expected.integer : undefined)
    );
  if (expected.kind === "temporal")
    return (
      actual.temporalKind === expected.temporalKind &&
      actual.hint === expected.hint &&
      actual.prefill === expected.prefill
    );
  if (expected.kind === "password") return actual.hint === expected.hint;
  if (expected.kind === "image")
    return (
      actual.question === expected.question &&
      actual.hint === expected.hint &&
      actual.allowCamera === expected.allowCamera &&
      actual.allowFile === expected.allowFile &&
      actual.allowSkip === expected.allowSkip &&
      textsEqual(expected.types, actual.types) &&
      textsEqual(expected.mime, actual.mime)
    );
  // A form is always prepared.
  if (expected.kind === "form") return false;
  return (
    choiceOptionsEqual(expected.options, actual.options) &&
    actual.preselected === expected.preselected
  );
}

function textsEqual(expected: readonly string[] | null, actual: unknown): boolean {
  if (expected === null) return actual === null;
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((text, index) => actual[index] === text)
  );
}

/** Whether `actual` holds the same buttons, in order: text, value, and background. */
export function choiceOptionsEqual(
  expected: readonly InteractionChoiceOption[],
  actual: unknown,
): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return expected.every((option, index) => {
    const candidate: unknown = actual[index];
    return (
      isPlainRecord(candidate) &&
      candidate.text === option.text &&
      isInteractionChoiceValue(candidate.value) &&
      serializableEquals(candidate.value, option.value) &&
      candidate.background === option.background
    );
  });
}

/**
 * The settled transcript and result must be what the recorded UI offered. The settlement carries that UI because the
 * instruction's prepared temporaries are cleared after completion and may be prepared anew by a later run.
 */
export function settlementMatchesPresentedUi(settlement: Record<string, unknown>): boolean {
  const ui = settlement.ui;
  if (!isPlainRecord(ui)) return false;
  if (ui.kind === "button")
    return (
      settlement.transcriptText ===
      (settlement.settlementKind === "timedOut" ? null : ui.buttonLabel)
    );
  if (ui.kind === "form")
    return (
      isFormUi(ui) &&
      validFormResult(
        ui,
        settlement.result,
        settlement.transcriptText,
        settlement.shownOptions,
        settlement.temporalPresentation,
        settlement.settlementKind === "timedOut",
      )
    );
  if (ui.kind !== "choice") return true;
  const result = settlement.result;
  if (!isInteractionChoiceValue(result)) return false;
  return (
    Array.isArray(ui.options) &&
    ui.options.some(
      (option) =>
        isPlainRecord(option) &&
        option.text === settlement.transcriptText &&
        isInteractionChoiceValue(option.value) &&
        serializableEquals(option.value, result),
    )
  );
}

/**
 * The recorded UI has the shape the prepared instruction produces. A choice's captured options are cleared after
 * completion, so its buttons are checked only against the values written in the plan.
 */
export function preparedUiFitsPresentedUi(
  prepared: import("../../../plan/model.js").PreparedInteractionUiPayload,
  ui: unknown,
): boolean {
  if (
    !isPlainRecord(ui) ||
    ui.kind !== prepared.kind ||
    !accessibleNameEqual(prepared.accessibleName, ui.accessibleName)
  )
    return false;
  if (prepared.kind === "button")
    return "background" in ui === (prepared.backgroundTemporary !== undefined);
  // The temporaries are cleared after completion; the recorded request was checked by its shape. A request without
  // `buttonText:` or `alwaysButton:` shows the defaults.
  if (prepared.kind === "url")
    return (
      (prepared.buttonTextTemporary !== undefined ||
        ui.buttonText === DEFAULT_OPEN_URL_BUTTON_TEXT) &&
      (prepared.alwaysButtonTemporary !== undefined || ui.alwaysButton === false)
    );
  // A popup without `buttonText:` shows the default text.
  if (prepared.kind === "popup")
    return (
      prepared.buttonTextTemporary !== undefined || ui.buttonText === DEFAULT_POPUP_BUTTON_TEXT
    );
  // An `exportText` without `title:` or `fileName:` shows the defaults.
  if (prepared.kind === "export")
    return (
      (prepared.titleTemporary !== undefined || ui.title === DEFAULT_EXPORT_TITLE) &&
      (prepared.fileNameTemporary !== undefined || ui.fileName === DEFAULT_EXPORT_FILE_NAME)
    );
  if (prepared.kind === "text" || prepared.kind === "number")
    return (
      (ui.hint === null) === (prepared.hintTemporary === null) &&
      // Only a `prefill:` prefills, and one that was empty when the field opened did not.
      (!("prefill" in ui) || prepared.prefillTemporary !== undefined) &&
      ui.integer === (prepared.kind === "number" ? prepared.integer : undefined)
    );
  if (prepared.kind === "temporal")
    return (
      ui.temporalKind === prepared.temporalKind &&
      (ui.hint === null) === (prepared.hintTemporary === null) &&
      (!("prefill" in ui) || prepared.prefillTemporary !== undefined)
    );
  if (prepared.kind === "password") return (ui.hint === null) === (prepared.hintTemporary === null);
  // The request temporary is cleared after completion; the recorded request was checked by its shape.
  if (prepared.kind === "image") return true;
  if (prepared.kind === "form") return formShapeFits(prepared.shape, ui.shape);
  return (
    Array.isArray(ui.options) &&
    buttonsFitWrittenValues(prepared.values, ui.options) &&
    // Only a `prefill:` preselects; its temporary is cleared after completion.
    (!("preselected" in ui) || prepared.prefillTemporary !== undefined)
  );
}

/**
 * Whether `options` can be the buttons of options with these written values. An option with a written value gives
 * buttons that all return it, one or, for a list, any number; an option without one may give any buttons. So when
 * every option has a written value, the buttons are runs of those values in order.
 */
function buttonsFitWrittenValues(
  values: readonly (string | number | null)[],
  options: readonly unknown[],
): boolean {
  if (values.includes(null)) return true;
  let slot = 0;
  for (const option of options) {
    if (!isPlainRecord(option) || !isInteractionChoiceValue(option.value)) return false;
    const value = option.value;
    while (slot < values.length && !serializableEquals(values[slot]!, value)) slot += 1;
    if (slot === values.length) return false;
  }
  return true;
}
