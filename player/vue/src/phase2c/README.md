# Phase 2C Player preview

This is the Greenfield preview, not the production Player entry point.
Keep experimental fixtures separate from the components that own settled behavior.

## Responsibility boundaries

- `App.vue` composes the Player and supplies development scenarios and tool contents.
- `PlayerToolsShell.vue` owns tool selection, pinning, ordering, resizing, retained
  content lifetime, focus and dock/drawer presentation. Its tool slot supplies
  content; its default slot supplies the Player. Closing a panel does not destroy
  its visited content. Tool bodies scroll vertically; the outer carousel handles
  horizontal overflow between panels.
- `PlayerTopBar.vue` owns top-control placement and translucent material. The
  control row is `calc(1rem + 16px)` with 8px outer padding. Fullscreen is the
  rightmost action. The title truncates inside its capsule without clipping the
  outer shadow.
- `ConversationSurface.vue` owns the composer overlay, its material and measured
  bottom inset. Transcript consumes that inset so its final content remains
  reachable. Input interaction remains in `RuntimeInteraction.vue`.
- `usePlayerTheme.ts` applies and restores document theme variables, including
  body-portaled menus. The framework-independent `player/theme` module calculates
  colors; Theme Lab only edits intent. Material is the sole surface hierarchy,
  with light/dark modes and the retained accent, tint and contrast controls.
- `StageRightRail.vue` owns the rail; `TimerRegion.vue` owns the timer collection;
  `TimerDisplay.vue` renders an individual timer. Multiple-timer space allocation
  and future rail controls remain experimental.

Component-specific presentation belongs with its component. Shared theme-token
mapping and overall composition remain in `style.css`. Do not change settled
behavior as part of a structural extraction. Provisional palette values and rail
policies are not permanent product contracts.
