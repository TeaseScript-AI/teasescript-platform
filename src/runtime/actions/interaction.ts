import { cloneInteractionChoiceValue } from "../../choice-values.js";
import { isBlankTextAnswer, isNumberAnswerText } from "../../interaction-answers.js";
import { interactionStringFits } from "../../interaction-limits.js";
import type { InteractionChoiceOption, InteractionChoiceValue } from "../../plan/model.js";
import { recordValidationTestWork } from "../../validation-testing.js";
import type { RuntimeInteractionActionSnapshot } from "./model.js";

/**
 * The milliseconds of a `showButton` timeout: a number of seconds or an elapsed duration that is finite and greater
 * than zero. Returns `null` for any other value.
 */
export function buttonTimeoutMilliseconds(value: unknown): number | null {
  const milliseconds =
    typeof value === "number"
      ? value * 1_000
      : isPlainRecord(value) && value.kind === "duration" && typeof value.milliseconds === "number"
        ? value.milliseconds
        : Number.NaN;
  return milliseconds > 0 && Number.isFinite(milliseconds) ? milliseconds : null;
}

export type ResolvedInteraction =
  | { readonly ok: true; readonly result: InteractionChoiceValue; readonly transcriptText: string }
  | { readonly ok: false; readonly message: string };

export function resolveInteractionCompletion(
  action: RuntimeInteractionActionSnapshot,
  payload: unknown,
): ResolvedInteraction {
  if (!isPlainRecord(payload)) {
    return { ok: false, message: "Interaction completion payload must be an object." };
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
            : "Choice text is ambiguous; select a rendered control.",
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

function completionStringFits(value: string): boolean {
  recordValidationTestWork("interactionUtf8Measurements");
  return interactionStringFits(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}
