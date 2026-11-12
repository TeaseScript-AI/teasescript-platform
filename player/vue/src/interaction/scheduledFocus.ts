/**
 * Marks where the focus is now, for a focus the composer moves later (a tick or two on). The returned check holds while the
 * focus has not gone to another control since: it is still where it was, on nothing, or in a composer field. A focus whose
 * check fails is dropped, so the composer never takes the focus from a control that took it meanwhile, such as a form
 * field's button after its commit, or a dialog.
 */
export function focusMark(): () => boolean {
  const from = document.activeElement;
  return () => {
    const now = document.activeElement;
    return (
      now === from ||
      now === null ||
      now === document.body ||
      (now instanceof Element && now.matches("[data-composer-input]"))
    );
  };
}
