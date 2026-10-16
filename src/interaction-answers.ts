/** Answer rules shared by prefills, plan and checkpoint validation, and interaction completion. */

import {
  formatIsoDate,
  formatIsoDateTime,
  formatIsoTime,
  parseIsoDate,
  parseIsoDateTime,
  parseIsoTime,
  presentDate,
  presentDateTime,
  presentTime,
  type DateFields,
  type DateTimeFields,
  type TemporalContext,
  type TimeFields,
} from "./temporal.js";

/** Whether text is blank, which `askText` rejects as an answer. */
export function isBlankTextAnswer(text: string): boolean {
  return /^\s*$/u.test(text);
}

/** The accepted TeaseScript decimal or scientific number form of a trimmed `askNumber` answer. */
export function isNumberAnswerText(text: string): boolean {
  return /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u.test(text);
}

/** The whole-number form of a trimmed `askInteger` answer: an optional sign, then digits. */
export function isIntegerAnswerText(text: string): boolean {
  return /^[+-]?\d+$/u.test(text);
}

/** The text that prefills `askNumber` for a finite prefill number; submitting it returns the same number. */
export function numberAnswerText(value: number): string {
  return String(Object.is(value, -0) ? 0 : value);
}

/** What a typed ask or a typed form field asks for. */
export type TypedAnswerKind = "text" | "number" | "integer" | TemporalAnswerKind;

/**
 * What the player is told about a wrong answer, V30 §20's default `invalidMessage`: an answer that is not of the kind a
 * typed ask or form field asks for, or typed text that matches no button of a choice (`choice`) or more than one
 * (`ambiguousChoice`). A malformed host payload gets a protocol message instead.
 */
const INVALID_ANSWER_MESSAGES: Readonly<
  Record<TypedAnswerKind | "choice" | "ambiguousChoice", string>
> = {
  text: "That is wrong. I asked for some text.",
  number: "That is wrong. I asked for a number.",
  integer: "That is wrong. I asked for a whole number.",
  date: "That is wrong. I asked for a date.",
  time: "That is wrong. I asked for a time.",
  datetime: "That is wrong. I asked for a date and time.",
  choice: "That is wrong. Type the exact text of one button, or use the buttons above.",
  ambiguousChoice: "More than one button has this text. Use the buttons above.",
};

/** The message for a wrong answer to a typed ask, a typed form field, or a choice. */
export function invalidAnswerMessage(kind: keyof typeof INVALID_ANSWER_MESSAGES): string {
  return INVALID_ANSWER_MESSAGES[kind];
}

/** Whether prefill text is an answer the field accepts unchanged. */
export function isValidInteractionPrefill(kind: TypedAnswerKind, prefill: string): boolean {
  if (kind === "text") return !isBlankTextAnswer(prefill);
  if (kind === "date" || kind === "time" || kind === "datetime")
    return temporalAnswer(kind, prefill) !== undefined;
  if (/[\r\n\u2028\u2029]/u.test(prefill)) return false;
  return kind === "integer"
    ? isIntegerAnswerText(prefill.trim()) && Number.isSafeInteger(Number(prefill))
    : isNumberAnswerText(prefill.trim()) && Number.isFinite(Number(prefill));
}

/** What `askDate`, `askTime`, and `askDateTime` ask for. */
export type TemporalAnswerKind = "date" | "time" | "datetime";

export type TemporalAnswer =
  | ({ readonly kind: "date" } & DateFields)
  | ({ readonly kind: "time" } & TimeFields)
  | ({ readonly kind: "datetime" } & DateTimeFields);

/**
 * The value of a trimmed date or time answer in strict ISO form (V30 §35), or `undefined`. A local time inside a gap in
 * the player's zone is a valid answer: local values have no zone.
 */
export function temporalAnswer(kind: TemporalAnswerKind, text: string): TemporalAnswer | undefined {
  const trimmed = text.trim();
  switch (kind) {
    case "date": {
      const parsed = parseIsoDate(trimmed);
      return parsed.ok ? { kind, ...parsed.value } : undefined;
    }
    case "time": {
      const parsed = parseIsoTime(trimmed);
      return parsed.ok ? { kind, ...parsed.value } : undefined;
    }
    case "datetime": {
      const parsed = parseIsoDateTime(trimmed);
      return parsed.ok ? { kind, ...parsed.value } : undefined;
    }
  }
}

/** The ISO text that prefills a date or time field for a prefill value; submitting it returns the same value. */
export function temporalAnswerText(value: TemporalAnswer): string {
  switch (value.kind) {
    case "date":
      return formatIsoDate(value);
    case "time":
      return formatIsoTime(value);
    case "datetime":
      return formatIsoDateTime(value);
  }
}

/** A typed field's value as its button and the transcript show it: a number as typed, a date or time as `say` does. */
export function formValueText(
  value: boolean | number | string | TemporalAnswer,
  presentation: TemporalContext["presentation"],
): string {
  if (typeof value === "number") return numberAnswerText(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return value.kind === "date"
    ? presentDate(presentation, value)
    : value.kind === "time"
      ? presentTime(presentation, value)
      : presentDateTime(presentation, value);
}
