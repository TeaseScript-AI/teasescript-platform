// A password field is a textarea masked by style, not an `<input type="password">`: browsers offer, fill and save
// passwords in a password-type field whatever its `autocomplete`. The composer's and the lock dialog's share these.

/** Keyboard and completion hints for a masked password field; a phone's keyboard may still suggest words. */
export const passwordAttributes = {
  autocomplete: "off",
  autocapitalize: "off",
  autocorrect: "off",
  spellcheck: "false",
} as const;

/**
 * A password has one line: a line break pasted or dropped into its field goes before the field's text is read, as a
 * text input strips it, with the caret where it was. Listen in the capture phase, before the field's own listeners.
 */
export function keepOneLine(event: Event): void {
  const field = event.target;
  if (!(field instanceof HTMLTextAreaElement) || !/[\r\n]/u.test(field.value)) return;
  const caret = field.value.slice(0, field.selectionEnd).replace(/[\r\n]/gu, "").length;
  field.value = field.value.replace(/[\r\n]/gu, "");
  field.setSelectionRange(caret, caret);
}
