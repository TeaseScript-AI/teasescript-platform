import { cloneInteractionChoiceValue } from "../../choice-values.js";
import {
  isBlankTextAnswer,
  isIntegerAnswerText,
  isNumberAnswerText,
  temporalAnswer,
} from "../../interaction-answers.js";
import { interactionStringFits } from "../../interaction-limits.js";
import { IMAGE_ANSWER_TRANSCRIPT_TEXT } from "../../image-input.js";
import type {
  InteractionAccessibleName,
  InteractionChoiceOption,
  InteractionUiPayload,
} from "../../plan/model.js";
import type { SerializableRuntimeValue } from "../serializable-values.js";
import type { CapturedMediaAdmission } from "./capture.js";
import { presentDate, presentDateTime, presentTime, type TemporalContext } from "../../temporal.js";
import { recordValidationTestWork } from "../../validation-testing.js";
import type { InteractionResultValue, RuntimeInteractionActionSnapshot } from "./model.js";
import { submitForm } from "./form.js";

/**
 * The milliseconds of a `showButton` timeout: an elapsed duration that is finite and greater than zero. Returns `null`
 * for any other value.
 */
export function buttonTimeoutMilliseconds(value: unknown): number | null {
  const milliseconds =
    isPlainRecord(value) && value.kind === "duration" && typeof value.milliseconds === "number"
      ? value.milliseconds
      : Number.NaN;
  return milliseconds > 0 && Number.isFinite(milliseconds) ? milliseconds : null;
}

export type ResolvedInteraction =
  | { readonly ok: true; readonly result: InteractionResultValue; readonly transcriptText: string }
  | { readonly ok: false; readonly message: string };

/**
 * `context` is the player's presentation now, which shows a date or time answer in the transcript. `capturedMedia`
 * vouches for an image answer; without it no image request completes.
 */
export function resolveInteractionCompletion(
  action: RuntimeInteractionActionSnapshot,
  payload: unknown,
  context: TemporalContext,
  capturedMedia: CapturedMediaAdmission | undefined,
): ResolvedInteraction {
  if (!isPlainRecord(payload)) {
    return { ok: false, message: "Interaction completion payload must be an object." };
  }
  // A form is submitted with the answers its edits gave it; the payload carries none.
  if (action.ui.kind === "form") {
    if (
      (payload.kind !== "submit" && payload.kind !== "cancel") ||
      Object.keys(payload).length !== 1 ||
      action.form === undefined
    )
      return {
        ok: false,
        message: "Form completion payload must be { kind: 'submit' } or { kind: 'cancel' }.",
      };
    // Cancelling drops every edit, also text that is not an answer, and returns `null`.
    if (payload.kind === "cancel")
      return action.ui.cancel === null
        ? { ok: false, message: "This form has no cancel button, so it can only be submitted." }
        : { ok: true, result: null, transcriptText: action.ui.cancel.text };
    return submitForm(action.ui, action.form, context.presentation);
  }
  if (action.interactionKind === "button") {
    return payload.kind === "activate" && action.ui.kind === "button"
      ? { ok: true, result: null, transcriptText: action.ui.buttonLabel }
      : { ok: false, message: "Button completion requires activation only." };
  }
  if (action.interactionKind === "text") {
    if (
      payload.kind !== "submittedText" ||
      typeof payload.submittedText !== "string" ||
      !completionStringFits(payload.submittedText)
    ) {
      return {
        ok: false,
        message: "Text completion requires submitted text within the shared UTF-8 byte limit.",
      };
    }
    const normalized = payload.submittedText.replace(/\r\n?/gu, "\n");
    if (isBlankTextAnswer(normalized)) {
      return { ok: false, message: "Text completion must contain a non-whitespace character." };
    }
    return { ok: true, result: normalized, transcriptText: normalized };
  }
  // `askInteger` accepts only whole-number notation within the safe integer range, on one line like `askNumber`.
  if (action.ui.kind === "number" && action.ui.integer === true) {
    if (
      payload.kind !== "submittedText" ||
      typeof payload.submittedText !== "string" ||
      !completionStringFits(payload.submittedText)
    )
      return {
        ok: false,
        message: "Number completion requires text within the shared UTF-8 byte limit.",
      };
    const submitted = payload.submittedText.trim();
    const parsed = Number(submitted);
    return !/[\r\n\u2028\u2029]/u.test(payload.submittedText) &&
      isIntegerAnswerText(submitted) &&
      Number.isSafeInteger(parsed)
      ? { ok: true, result: Object.is(parsed, -0) ? 0 : parsed, transcriptText: submitted }
      : { ok: false, message: "That is wrong. I asked for a whole number." };
  }
  if (action.interactionKind === "number") {
    if (
      payload.kind !== "submittedText" ||
      typeof payload.submittedText !== "string" ||
      !completionStringFits(payload.submittedText) ||
      /[\r\n\u2028\u2029]/u.test(payload.submittedText)
    ) {
      return {
        ok: false,
        message: "Number completion requires one line of text within the shared UTF-8 byte limit.",
      };
    }
    const submitted = payload.submittedText.trim();
    if (!isNumberAnswerText(submitted)) {
      return {
        ok: false,
        message: "Number completion is not an accepted decimal or scientific number.",
      };
    }
    const parsed = Number(submitted);
    if (!Number.isFinite(parsed)) {
      return { ok: false, message: "Number completion must be finite." };
    }
    return { ok: true, result: Object.is(parsed, -0) ? 0 : parsed, transcriptText: submitted };
  }
  // A date or time control submits strict ISO text; the transcript shows the answer as `say` would.
  if (action.ui.kind === "temporal") {
    if (
      payload.kind !== "submittedText" ||
      typeof payload.submittedText !== "string" ||
      !completionStringFits(payload.submittedText)
    )
      return {
        ok: false,
        message: "Date and time completion requires text within the shared UTF-8 byte limit.",
      };
    const answer = temporalAnswer(action.ui.temporalKind, payload.submittedText);
    if (answer === undefined)
      return {
        ok: false,
        message: `That is wrong. I asked for ${
          action.ui.temporalKind === "date"
            ? "a date"
            : action.ui.temporalKind === "time"
              ? "a time"
              : "a date and time"
        }.`,
      };
    const transcriptText =
      answer.kind === "date"
        ? presentDate(context.presentation, answer)
        : answer.kind === "time"
          ? presentTime(context.presentation, answer)
          : presentDateTime(context.presentation, answer);
    return { ok: true, result: answer, transcriptText };
  }
  // The answer is an image the trusted host stored, by its reference; the transcript never shows the reference.
  if (action.ui.kind === "image") {
    const reference =
      payload.kind === "image" && Object.keys(payload).length === 2 ? payload.reference : undefined;
    if (typeof reference !== "string" || reference.length === 0 || !completionStringFits(reference))
      return {
        ok: false,
        message:
          "Image completion requires { kind: 'image', reference } with a stored image reference.",
      };
    if (capturedMedia?.holds(reference, "image") !== true)
      return { ok: false, message: "The image is not stored media of this host." };
    return { ok: true, result: reference, transcriptText: IMAGE_ANSWER_TRANSCRIPT_TEXT };
  }
  if (action.ui.kind !== "choice") {
    return { ok: false, message: "Choice action payload is malformed." };
  }
  const options = action.ui.options;
  let selected: InteractionChoiceOption;
  if (
    payload.kind === "submittedText" &&
    typeof payload.submittedText === "string" &&
    completionStringFits(payload.submittedText)
  ) {
    const matches = options.filter((option) => option.text === payload.submittedText);
    if (matches.length !== 1) {
      return {
        ok: false,
        message:
          matches.length === 0
            ? "Choice text is not available."
            : "More than one button has this text. Select one of the buttons instead.",
      };
    }
    selected = matches[0]!;
  } else if (
    payload.kind === "selectedOption" &&
    typeof payload.optionIndex === "number" &&
    Number.isSafeInteger(payload.optionIndex) &&
    payload.optionIndex >= 0 &&
    payload.optionIndex < options.length
  ) {
    selected = options[payload.optionIndex]!;
  } else {
    return { ok: false, message: "Choice completion payload does not match the offered options." };
  }
  return {
    ok: true,
    result: cloneInteractionChoiceValue(selected.value),
    transcriptText: selected.text,
  };
}

type ImageInteractionUi = Extract<InteractionUiPayload, { kind: "image" }>;

export function cloneImageUi(
  ui: ImageInteractionUi,
  accessibleName: InteractionAccessibleName,
): ImageInteractionUi {
  return {
    kind: "image",
    question: ui.question,
    hint: ui.hint,
    allowCamera: ui.allowCamera,
    allowFile: ui.allowFile,
    types: ui.types === null ? null : [...ui.types],
    mime: ui.mime === null ? null : [...ui.mime],
    accessibleName,
  };
}

/**
 * What an open image request keeps in its request temporary: its arguments as they apply, with the question (`message`)
 * and hint as text and no question, hint, `types`, or `mime` when there is none. Reading it again gives the same request.
 */
export function imageRequestValue(
  ui: Pick<
    ImageInteractionUi,
    "question" | "hint" | "allowCamera" | "allowFile" | "types" | "mime"
  >,
): SerializableRuntimeValue {
  const texts = (items: readonly string[]): SerializableRuntimeValue => ({
    kind: "list",
    items: [...items],
  });
  return {
    kind: "object",
    properties: [
      ...(ui.question === null ? [] : [{ name: "message", value: ui.question }]),
      ...(ui.hint === null ? [] : [{ name: "hint", value: ui.hint }]),
      { name: "allowCamera", value: ui.allowCamera },
      { name: "allowFile", value: ui.allowFile },
      ...(ui.types === null ? [] : [{ name: "types", value: texts(ui.types) }]),
      ...(ui.mime === null ? [] : [{ name: "mime", value: texts(ui.mime) }]),
    ],
  };
}

function completionStringFits(value: string): boolean {
  recordValidationTestWork("interactionUtf8Measurements");
  return interactionStringFits(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
