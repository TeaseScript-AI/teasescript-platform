import { useEventListener } from "@vueuse/core";
import { SIDEBAR_KEYBOARD_SHORTCUT } from "@/components/ui/sidebar/utils";

// While the random draw picker asks (DEBUGGER.md "Random draws"), the page stays visible and readable, but only these
// controls take input: the picker itself with the large view of its code and the dimmed page behind it, the display
// controls (theme, fullscreen, notifications), panel resizing, and reading the Debug panel's tabs. Everything else,
// such as the tools menu, Settings, the Debug panel's switches and buttons, and the chat, waits for the outcome.
const USABLE = [
  "[data-random-draw-picker]",
  "[data-code-block-lightbox]",
  // Only a modal dialog dims the page, and the large view is the only one that can open meanwhile.
  '[data-slot="dialog-overlay"]',
  "[data-theme-mode-control]",
  "[data-fullscreen-control]",
  "[data-notification-bell]",
  "[data-player-notification-panel]",
  '[role="separator"]',
  '[data-debug-panel] [role="tablist"]',
  "[data-debug-now]",
  "[data-debug-variables]",
  "[data-debug-log]",
].join(",");
// Inside a usable area, what still acts on the session.
const UNUSABLE = "[data-notice-action]";
// Keys that only move focus or close a menu, which stay available everywhere.
const NAVIGATION_KEYS: ReadonlySet<string> = new Set(["Tab", "Escape", "Shift"]);
const CONTROLS =
  'button, input, textarea, select, [contenteditable="true"], [role="button"], [role="switch"], [role="tab"], [role="menuitem"], [role="radio"], [role="checkbox"], [role="option"], [role="slider"]';

/** Keeps only the usable controls working while `active` holds. */
export function useRandomDrawGuard(active: () => boolean) {
  const guard = (event: Event) => {
    if (!active() || !(event.target instanceof Element)) return;
    const target = event.target;
    // The page's own shortcut for the tools sidebar waits too, from wherever it is pressed.
    const shortcut =
      event instanceof KeyboardEvent &&
      event.key === SIDEBAR_KEYBOARD_SHORTCUT &&
      (event.metaKey || event.ctrlKey);
    if (!shortcut && target.closest(USABLE) !== null && target.closest(UNUSABLE) === null) return;
    // Keys go to the page for scrolling; only a control's keys act.
    if (
      !shortcut &&
      event instanceof KeyboardEvent &&
      (NAVIGATION_KEYS.has(event.key) || target.closest(CONTROLS) === null)
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  // Releases stay free, so a resize that started on a usable handle ends wherever the pointer is let go.
  for (const type of ["pointerdown", "mousedown", "click", "dblclick", "keydown"] as const)
    useEventListener(window, type, guard, { capture: true });
}
