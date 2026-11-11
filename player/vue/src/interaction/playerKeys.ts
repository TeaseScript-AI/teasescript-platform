/**
 * The keys of the Player's keyboard shortcuts in the empty composer (PLAYER-UI.md, "Input growth, focus, and keyboard
 * behavior"). Each is a `KeyboardEvent.key` and its `aria-keyshortcuts` name; a shortcut changes here.
 */
export const playerKeys = Object.freeze({
  /** Settles a skippable pacing gate. */
  skipPacing: Object.freeze({ key: " ", name: "Space" }),
  /** Activates the preselected button: a `showButton`, or the button that `prefill:` preselects. */
  preselectedButton: Object.freeze({ key: " ", name: "Space" }),
});

/** What a key does in the composer: a shortcut's, nothing (`consume`), or the browser's typing (`type`). */
export type ShortcutOutcome = "skip" | "activate" | "consume" | "type";

/**
 * The one decision of a shortcut key in the composer, for the key handler and for a key held while an answer was in
 * flight. A key does something of its own only in the empty composer (no text, no selection): it settles a skippable
 * pacing gate, or, while only buttons wait or one is preselected, types nothing and activates a preselected button on a
 * fresh press (not held down, not begun before the interaction appeared).
 */
export function shortcutOutcome(
  key: string,
  state: {
    readonly empty: boolean;
    readonly fresh: boolean;
    readonly pacing: boolean;
    readonly preselected: boolean;
    readonly buttonsOnly: boolean;
  },
): ShortcutOutcome {
  if (!state.empty) return "type";
  if (key === playerKeys.skipPacing.key && state.pacing) return "skip";
  if (key === playerKeys.preselectedButton.key && (state.preselected || state.buttonsOnly))
    return state.preselected && state.fresh ? "activate" : "consume";
  return "type";
}
