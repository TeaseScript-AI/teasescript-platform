/** Answer rules shared by default answers, plan and checkpoint validation, and interaction completion. */

/** Whether text is blank, which `askText` rejects as an answer. */
export function isBlankTextAnswer(text: string): boolean {
  return /^\s*$/u.test(text);
}

/** The accepted TeaseScript decimal or scientific number form of a trimmed `askNumber` answer. */
export function isNumberAnswerText(text: string): boolean {
  return /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/u.test(text);
}

/** The text that prefills `askNumber` for a finite default number; submitting it returns the same number. */
export function numberAnswerText(value: number): string {
  return String(Object.is(value, -0) ? 0 : value);
}

/** Whether prefill text is an answer the field accepts unchanged. */
export function isValidInteractionPrefill(kind: "text" | "number", prefill: string): boolean {
  return kind === "text"
    ? !isBlankTextAnswer(prefill)
    : !/[\r\n\u2028\u2029]/u.test(prefill) &&
        isNumberAnswerText(prefill.trim()) &&
        Number.isFinite(Number(prefill));
}
