# Phase 2C Player preview

This is the Greenfield preview, not the production Player entry point.
Keep experimental fixtures separate from the components that own settled behavior.

## Design lint

The required [Player design lint](../../../../docs/LINTING.md#player-design-lint) checks this preview,
shared UI definitions and the story-button wrapper. `components.json` selects the preview theme for
utility resolution; it does not change the maintained Player theme or select a production UI.

## Responsibility boundaries

- `App.vue` composes the Player, development scenarios and tool contents. It installs `usePlayerKeyboardFocus.ts`
  once, including for body-portaled controls; the [focus contract](../../../../docs/ui/PLAYER-UI.md#input-growth-focus-and-keyboard-behavior)
  defines input modality and composer/Send focus.
- `PlayerToolsShell.vue` owns tool selection, pinning, order, resizing, retained content and dock/drawer focus.
  Its tool slot supplies content; its default slot supplies the Player. Closing a visited panel retains its content.
  Tool bodies scroll vertically; the outer carousel handles overflow between panels. Shared shadcn-vue/Reka
  `components/ui/scroll-area` supports per-location visibility without reserving width. The transcript currently
  reveals its thumb during scrolling or track hover; native textareas keep browser editing/scrolling. Visibility
  remains a visual trial.
- `ResizeHandle.vue` supplies the separator, marker and tooltip for menu/panel widths. Panel handles sit outside
  scrolling content; menu handles share existing right padding. Dotted grips move entire panels.
- `PlayerTopBar.vue` owns control placement and translucent material. Fullscreen is rightmost; the title truncates
  inside a pill without clipping its shadow. Sidebar and display controls share `--player-top-control-radius`.
- `PlayerComposition.vue` uses Reka Splitter, also underlying shadcn-vue Resizable, for pointer/keyboard allocation
  between stage and conversation. Starting ratio and minimum sizes remain visual trials.
- `ConversationSurface.vue` places the overlay and forwards margin wheel input to `Transcript.vue`, excluding nested
  tools, composer input, horizontal gestures and browser zoom. Its measured composer inset keeps final content reachable.
- `Transcript.vue` owns virtualization, grouping and scrolling. Its scrollport includes conversation padding to avoid
  clipping bubble borders; the scrollbar ends above the composer. The trailing slot contributes foreground-control
  height to the end inset. Message rendering and contrast are split into `TranscriptMessage.vue`, `TranscriptMarkup.vue`,
  `TranscriptLine.vue`, `transcriptPresentation.ts` and `messageContrast.ts`.
- `RuntimeInteraction.vue` composes `Composer.vue` and `ForegroundControls.vue` and alone submits runtime actions,
  with shared submission guards and focus handling. The composer uses shadcn Textarea/Button and VueUse autosizing;
  foreground controls use `components/PlayerActionButton.vue` in the transcript's trailing slot.
  `playerRuntimeForeground` maps authored backgrounds from live/restored actions; `player/theme/story-choice.ts`
  supplies theme/authored button material. See [ADR 0018](../../../../docs/decisions/0018-first-standard-library-poc-contract.md)
  for syntax and completion semantics.
- `usePlayerTheme.ts` applies/restores document variables; `player/theme` calculates colours and Theme Lab edits intent.
  See [theme evaluation](../../../README.md#experimental-dynamic-theme-evaluation).
- `StageRightRail.vue` owns the rail, `TimerRegion.vue` its timer collection and `TimerDisplay.vue` individual timers.
  `BackgroundControlsFixture.vue` demonstrates repeatable, removable, boolean and disabled buttons using the shared
  action material. These local interactions and timer allocation remain experimental, without runtime wiring.

The preview opens with choices. Visual Lab restarts that scenario, selects text/number/choice interaction, or loads a
spacing sample with grouped guide bubbles, a player reply, another speaker, and active choices. Its 8px/12px/16px
separate-message gap selector changes that sample and the regular preview without changing the 3px grouped-bubble gap.
The `?spacing-sample` preview URL opens that sample directly with a 45/55 stage/conversation split so all messages and
choices can be compared together. Transcript fixtures switch App back to local preview replies. Composer dimensions and
height caps remain visual trials.

Story-button ink and transcript readability follow the current Player treatment in
[Player UI](../../../../docs/ui/PLAYER-UI.md); Visual Lab does not offer contrast-method switches.

Shared chrome geometry lives in `style.css`; the
[Player geometry contract](../../../../docs/ui/PLAYER-UI.md#global-geometry-and-overflow) records dimensions and their tuning status.
Top controls, menu and tool headers share edge/control tokens. The menu width ruler avoids a second JavaScript
formula; its resize target shares right padding. The right rail derives top clearance from header height and width
from the timer plus halo, independently of root font size.

Component-specific presentation belongs with its component. Shared theme-token
mapping and overall composition remain in `style.css`. Do not change settled
behavior as part of a structural extraction. Provisional palette values and rail
policies are not permanent product contracts.
