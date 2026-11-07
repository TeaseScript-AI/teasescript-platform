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
