import { onBeforeUpdate, onUpdated, type Ref } from "vue";

/**
 * Keeps keyboard focus when an update removes the focused control from `container`, such as a dismissed or withdrawn
 * notice: focus moves to the control now at the same position, or the last one; with none left, `fallback` decides.
 */
export function useFocusRecovery(
  container: Readonly<Ref<HTMLElement | null>>,
  fallback: () => void,
) {
  let focusedIndex: number | null = null;
  const controls = () => [...(container.value?.querySelectorAll<HTMLElement>("button") ?? [])];
  onBeforeUpdate(() => {
    const index = controls().findIndex((control) => control === document.activeElement);
    focusedIndex = index < 0 ? null : index;
  });
  onUpdated(() => {
    const index = focusedIndex;
    focusedIndex = null;
    if (index === null || container.value?.contains(document.activeElement)) return;
    // Focus moved on purpose stays where it went; only focus dropped to the document or to a surrounding element, such
    // as a popover's own content box, is recovered.
    const active = document.activeElement;
    if (
      active &&
      active !== document.body &&
      !(container.value && active.contains(container.value))
    )
      return;
    const remaining = controls();
    const next = remaining[Math.min(index, remaining.length - 1)];
    if (next) next.focus();
    else fallback();
  });
}
