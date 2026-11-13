/**
 * Marks where the focus is now, for a focus the Player schedules a tick or two on: into the composer, or back to a
 * form field's button. The returned check holds while the focus has not gone to another control since: it is still
 * where it was, on nothing, or in a composer field. A focus whose check fails is dropped, so a scheduled focus never
 * takes the focus from a control that took it meanwhile, such as a form field's button after its commit, or a dialog.
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
