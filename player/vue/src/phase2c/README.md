# Phase 2C Player preview

This is the Greenfield preview, not the production Player entry point.
Keep experimental fixtures separate from the components that own settled behavior.

## Responsibility boundaries

- `App.vue` composes the Player and supplies development scenarios and tool contents.
  It installs `usePlayerKeyboardFocus.ts` once for Player and body-portaled controls.
  Pointer input hides focus rings; navigation keys reveal them without treating text
  editing as navigation. Composer input marks its shell; Send retains its own focus target.
- `PlayerToolsShell.vue` owns tool selection, pinning, ordering, resizing, retained
  content lifetime, focus and dock/drawer presentation. Its tool slot supplies
  content; its default slot supplies the Player. Closing a panel does not destroy
  its visited content. Tool bodies scroll vertically; the outer carousel handles
  horizontal overflow between panels. Player scroll regions share the shadcn-vue/Reka
  ScrollArea composition in `components/ui/scroll-area`: theme-colored overlay
  thumbs appear on hover or scrolling, without reserving layout width. The chat
  transcript scrollbar currently appears on scrolling or hovering
  the narrow scrollbar track, not the content. This remains a visual trial; the
  shared component accepts a per-location visibility type. Native
  textarea scrollbars retain browser editing behavior with matching theme colors.
  `ResizeHandle.vue` provides one shared
  separator rail, line marker and tooltip for menu and panel width controls. The
  panel rail sits outside vertically scrolling content; the menu resize target
  overlays its existing right padding without adding width; dotted grips remain reserved for moving complete panels.
- `PlayerTopBar.vue` owns top-control placement and translucent material. The
  control row consumes the shared Player control size with fixed outer spacing. Fullscreen is the
  rightmost action. The title truncates inside its capsule without clipping the
  outer shadow.
  The title is pill-shaped. The Sidebar trigger and display-control group share
  `--player-top-control-radius`; the group keeps its existing rounded corners.
- `PlayerComposition.vue` owns the adjustable stage/conversation allocation through Reka Splitter,
  the primitive underlying shadcn-vue Resizable. The initial 70/30 split and minimum sizes are visual trials;
  dragging and keyboard resizing use the primitive without a custom pointer controller.
- `ConversationSurface.vue` owns the conversation overlay placement and measured
  bottom-region wheel surface: empty left/right margins forward vertical wheel
  input to the existing Transcript scroll owner without changing reading width.
  Nested tools, composer input, horizontal gestures and browser zoom retain their own behavior.
  It supplies the measured
  bottom inset. Transcript consumes that inset so its final content remains
  reachable. The transcript scrollport extends into the existing conversation
  padding so bubble borders stay inside its clipping boundary; its scrollbar uses
  that side space and ends above the measured composer overlay. Input interaction
  remains in `RuntimeInteraction.vue`, which alone submits canonical runtime actions.
  `Composer.vue` owns the integrated surface, shadcn-vue Textarea/Button, VueUse
  autosizing, feedback association and Enter/Shift+Enter behavior. `ForegroundControls.vue`
  renders wrapping shadcn buttons in Transcript’s measured trailing slot. They share
  the transcript scrollport and disappear on completion; its end inset includes
  their measured height plus the composer overlay. RuntimeInteraction composes
  those surfaces and retains the shared submission guard and focus handling.
  The standalone development preview appends local plain-text replies through App;
  starting a runtime scenario switches submission to the existing adapter. Composer
  dimensions and the input height cap remain visual trials; no new visual assertions
  freeze them. The Textarea comes from the shadcn-vue new-york registry and uses the
  existing VueUse dependency (no package added).
- `usePlayerTheme.ts` applies and restores document theme variables, including
  body-portaled menus. The framework-independent `player/theme` module calculates
  colors; Theme Lab only edits intent. Material is the sole surface hierarchy,
  with light/dark modes and the retained accent, tint and contrast controls.
- `StageRightRail.vue` owns the rail; `TimerRegion.vue` owns the timer collection;
  `TimerDisplay.vue` renders an individual timer. Multiple-timer space allocation
  and future rail controls remain experimental.

Shared chrome geometry lives in `style.css`: `--player-edge-space` is the fixed
8px outer inset; `--player-control-padding` is fixed 8px internal control space;
`--player-control-size` adds that space to a 1rem icon/text allowance. The top bar,
menu and tool headers consume those values. Compact menu width contains the control and outer padding only; its resize target
shares the right padding. JavaScript measures a CSS ruler instead of duplicating
the width formula. The right rail uses the same outer inset and derives its top
clearance from header height. The fixed 132px timer and its 12px halo clearance
also determine rail width, independently of root font size.

Component-specific presentation belongs with its component. Shared theme-token
mapping and overall composition remain in `style.css`. Do not change settled
behavior as part of a structural extraction. Provisional palette values and rail
policies are not permanent product contracts.
