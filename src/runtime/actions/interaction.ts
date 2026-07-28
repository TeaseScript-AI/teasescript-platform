import { interactionStringFits } from "../../interaction-limits.js";
import { recordValidationTestWork } from "../validation-testing.js";
import type { RuntimeInteractionActionSnapshot } from "../state.js";

export type ResolvedInteraction =
  | { readonly ok: true; readonly result: string | number | null; readonly transcriptText: string }
  | { readonly ok: false; readonly message: string };

export function resolveInteractionCompletion(
  action: RuntimeInteractionActionSnapshot,
  payload: unknown,
): ResolvedInteraction {
  if (!isPlainRecord(payload)) return { ok: false, message: "Interaction completion payload must be an object." };
  if (action.interactionKind === "button") {
    return payload.kind === "activate" && action.ui.kind === "button"
      ? { ok: true, result: null, transcriptText: action.ui.buttonLabel }
      : { ok: false, message: "Button completion requires activation only." };
  }
  if (action.interactionKind === "text") {
    if (payload.kind !== "submittedText" || typeof payload.submittedText !== "string" || !completionStringFits(payload.submittedText)) return { ok: false, message: "Text completion requires submitted text within the shared UTF-8 byte limit." };
    const normalized = payload.submittedText.replace(/\r\n?/gu, "\n");
    if (/^\s*$/u.test(normalized)) return { ok: false, message: "Text completion must contain a non-whitespace character." };
    return { ok: true, result: normalized, transcriptText: normalized };
  }
  if (action.interactionKind === "number") {
    if (payload.kind !== "submittedText" || typeof payload.submittedText !== "string" || !completionStringFits(payload.submittedText) || /[\r\n\u2028\u2029]/u.test(payload.submittedText)) return { ok: false, message: "Number completion requires one line of text within the shared UTF-8 byte limit." };
    const submitted = payload.submittedText.trim();
    if (!/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u.test(submitted)) return { ok: false, message: "Number completion is not an accepted decimal or scientific number." };
    const parsed = Number(submitted);
    if (!Number.isFinite(parsed)) return { ok: false, message: "Number completion must be finite." };
    return { ok: true, result: Object.is(parsed, -0) ? 0 : parsed, transcriptText: submitted };
  }
  if (action.ui.kind !== "choice") return { ok: false, message: "Choice action payload is malformed." };
  let matches: readonly { readonly text: string; readonly label: string | number | null }[] = [];
  if (payload.kind === "submittedText" && typeof payload.submittedText === "string" && completionStringFits(payload.submittedText)) {
    matches = action.ui.options.filter((option) => option.text === payload.submittedText);
    if (matches.length !== 1) return { ok: false, message: matches.length === 0 ? "Choice text is not available." : "Choice text is ambiguous; select a labelled control." };
  } else if (payload.kind === "selectedLabel" && action.ui.labelType !== "none" && (typeof payload.selectedLabel === "string" || typeof payload.selectedLabel === "number")) {
    if (typeof payload.selectedLabel === "string" && !completionStringFits(payload.selectedLabel)) return { ok: false, message: "Choice label exceeds the shared UTF-8 byte limit." };
    matches = action.ui.options.filter((option) => option.label === payload.selectedLabel);
  } else if (payload.kind === "selectedText" && action.ui.labelType === "none" && typeof payload.selectedText === "string" && completionStringFits(payload.selectedText)) {
    matches = action.ui.options.filter((option) => option.text === payload.selectedText);
  } else {
    return { ok: false, message: "Choice completion payload does not match the choice domain." };
  }
  if (matches.length !== 1) return { ok: false, message: "Choice selection is not available." };
  const selected = matches[0]!;
  return { ok: true, result: selected.label ?? selected.text, transcriptText: selected.text };
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
