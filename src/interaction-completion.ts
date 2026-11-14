/**
 * The answer rules of the interactions the Playroom answers: what each payload answers, its result and its transcript
 * text (`resolveAnswer`, which the runtime settles an answer with), and where the composer's text goes
 * (`routeComposerText`, which the Playroom's adapter routes it with). Every import is one the Playroom's page may load.
 * Request shape, identity, time, settlement and events stay with the runtime (`runtime/actions/interaction.ts`,
 * `runtime/operations/complete-action.ts`), and so does the check of a password answer's hash. Apart from the test-only
 * work counter, every function here reads only its arguments.
 */

import { cloneInteractionChoiceValue } from "./choice-values.js";
import {
  invalidAnswerMessage,
  isBlankTextAnswer,
  isIntegerAnswerText,
  isNumberAnswerText,
  temporalAnswer,
} from "./interaction-answers.js";
import { interactionStringFits } from "./interaction-limits.js";
import { IMAGE_ANSWER_TRANSCRIPT_TEXT, IMAGE_SKIP_TEXT } from "./image-input.js";
import type { InteractionChoiceOption } from "./plan/model.js";
import type { CapturedMediaAdmission } from "./runtime/actions/capture.js";
import { submitForm } from "./runtime/actions/form/submission.js";
import type {
  InteractionResultValue,
  RuntimeInteractionActionSnapshot,
} from "./runtime/actions/model.js";
import {
  presentDate,
  presentDateTime,
  presentTime,
  type PresentationSettings,
  type TemporalContext,
} from "./temporal.js";
import { recordValidationTestWork } from "./validation-testing.js";

export type ResolvedInteraction =
  | {
      readonly ok: true;
      readonly result: InteractionResultValue;
      /** `null` for a popup, `openUrl`, `exportText`, or `askPassword`, which add nothing to the transcript. */
      readonly transcriptText: string | null;
      /** Only a form's: the options its cycles showed, `null` when it returns `null`. */
      readonly shownOptions?: readonly (number | null)[] | null;
      /** Only a form's: the presentation its answers were shown in, `null` when it sent none. */
      readonly temporalPresentation?: PresentationSettings | null;
    }
  | { readonly ok: false; readonly message: string };

/**
 * What `payload` answers for `action`. `context` is the player's presentation now, which shows a date or time answer in
 * the transcript. `capturedMedia` vouches for an image reference; without it only a skip answers an image request. A password action
 * is not answered here.
 */
export function resolveAnswer(
  action: RuntimeInteractionActionSnapshot,
  payload: Readonly<Record<string, unknown>>,
  context: TemporalContext,
  capturedMedia: CapturedMediaAdmission | undefined,
): ResolvedInteraction {
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
        : {
            ok: true,
            result: null,
            transcriptText: action.ui.cancel.text,
            shownOptions: null,
            temporalPresentation: null,
          };
    return submitForm(action.ui, action.form, context.presentation);
  }
  if (action.interactionKind === "button") {
    return payload.kind === "activate" && action.ui.kind === "button"
      ? { ok: true, result: null, transcriptText: action.ui.buttonLabel }
      : { ok: false, message: "Button completion requires activation only." };
  }
  if (action.interactionKind === "popup") {
    return payload.kind === "activate" && Object.keys(payload).length === 1
      ? { ok: true, result: null, transcriptText: null }
      : { ok: false, message: "Popup completion requires { kind: 'activate' } only." };
  }
  // The Playroom reports that it opened the address in a new tab.
  if (action.interactionKind === "url") {
    return payload.kind === "opened" && Object.keys(payload).length === 1
      ? { ok: true, result: null, transcriptText: null }
      : { ok: false, message: "openUrl completion requires { kind: 'opened' } only." };
  }
  // Copying and downloading are the player's own actions; only closing the dialog completes it.
  if (action.interactionKind === "export") {
    return payload.kind === "close" && Object.keys(payload).length === 1
      ? { ok: true, result: null, transcriptText: null }
      : { ok: false, message: "exportText completion requires { kind: 'close' } only." };
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
    if (isBlankTextAnswer(normalized)) return { ok: false, message: invalidAnswerMessage("text") };
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
      : { ok: false, message: invalidAnswerMessage("integer") };
  }
  // `askNumber` accepts one line of decimal or scientific notation with a finite value.
  if (action.interactionKind === "number") {
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
      isNumberAnswerText(submitted) &&
      Number.isFinite(parsed)
      ? { ok: true, result: Object.is(parsed, -0) ? 0 : parsed, transcriptText: submitted }
      : { ok: false, message: invalidAnswerMessage("number") };
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
      return { ok: false, message: invalidAnswerMessage(action.ui.temporalKind) };
    const transcriptText =
      answer.kind === "date"
        ? presentDate(context.presentation, answer)
        : answer.kind === "time"
          ? presentTime(context.presentation, answer)
          : presentDateTime(context.presentation, answer);
    return { ok: true, result: answer, transcriptText };
  }
  // The answer is an image the trusted host stored, by its reference; the transcript never shows the reference. A
  // request that allows it may be skipped instead, which answers `null`.
  if (action.ui.kind === "image") {
    if (payload.kind === "skip" && Object.keys(payload).length === 1)
      return action.ui.allowSkip
        ? { ok: true, result: null, transcriptText: IMAGE_SKIP_TEXT }
        : { ok: false, message: "This image request cannot be skipped, so it needs an image." };
    const reference =
      payload.kind === "image" && Object.keys(payload).length === 2 ? payload.reference : undefined;
    if (typeof reference !== "string" || reference.length === 0 || !completionStringFits(reference))
      return {
        ok: false,
        message: action.ui.allowSkip
          ? "Image completion requires { kind: 'image', reference } with a stored image reference, or { kind: 'skip' }."
          : "Image completion requires { kind: 'image', reference } with a stored image reference.",
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
    if (matches.length !== 1)
      return {
        ok: false,
        message: invalidAnswerMessage(matches.length === 0 ? "choice" : "ambiguousChoice"),
      };
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

/** Where the composer's text goes for the presented interaction (`routeComposerText`). */
export type ComposerRoute =
  | { readonly kind: "complete"; readonly payload: Readonly<Record<string, unknown>> }
  | { readonly kind: "password"; readonly text: string }
  | { readonly kind: "imageSkip" }
  | { readonly kind: "formCommit"; readonly text: string }
  | { readonly kind: "formSubmit" }
  | { readonly kind: "formCancel" }
  | { readonly kind: "formStep"; readonly fieldId: string };

/**
 * Where the composer's `submittedText` goes for `action`, the presented interaction, or `null` when it answers nothing
 * there. The answer itself is checked by `resolveAnswer` or the form's own update.
 */
export function routeComposerText(
  action: RuntimeInteractionActionSnapshot | null,
  submittedText: string,
): ComposerRoute | null {
  if (action?.ui.kind === "button") {
    return submittedText !== "" && submittedText === action.ui.buttonLabel
      ? { kind: "complete", payload: { kind: "activate" } }
      : null;
  }
  // While a form field is edited, the composer's text is its answer. Otherwise the composer takes the exact text of
  // one visible button: a field's label steps it, the submit label submits.
  if (action?.ui.kind === "form") {
    if (action.form?.editor != null) return { kind: "formCommit", text: submittedText };
    const fields = action.ui.fields.filter((field) => field.text === submittedText);
    const submits = action.ui.submit.text === submittedText ? 1 : 0;
    const cancels = action.ui.cancel?.text === submittedText ? 1 : 0;
    if (submittedText === "" || fields.length + submits + cancels !== 1) return null;
    return submits === 1
      ? { kind: "formSubmit" }
      : cancels === 1
        ? { kind: "formCancel" }
        : { kind: "formStep", fieldId: fields[0]!.id };
  }
  // As askText needs text, askPassword needs a password: an empty field answers nothing.
  if (action?.ui.kind === "password")
    return submittedText === "" ? null : { kind: "password", text: submittedText };
  // The exact text of a skippable image request's skip control skips it; other text never answers an image request.
  if (action?.ui.kind === "image")
    return submittedText === IMAGE_SKIP_TEXT ? { kind: "imageSkip" } : null;
  if (
    action === null ||
    (action.interactionKind !== "text" &&
      action.interactionKind !== "number" &&
      action.interactionKind !== "temporal" &&
      action.interactionKind !== "choice")
  ) {
    return null;
  }
  return { kind: "complete", payload: { kind: "submittedText", submittedText } };
}

function completionStringFits(value: string): boolean {
  recordValidationTestWork("interactionUtf8Measurements");
  return interactionStringFits(value);
}
