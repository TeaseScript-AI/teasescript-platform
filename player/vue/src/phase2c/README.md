# Phase 2C Player preview

This is the Greenfield preview, not the production Player entry point.
Keep experimental fixtures separate from the components that own settled behavior.

## Optional design lint trial

`npm run lint:design:phase2c` checks the preview and its local `components/ui` source with
`@shadcn/lint` through ESLint. The nearby `components.json` selects the preview theme rather than
the maintained Player theme. Warnings are advisory while this design candidate is evaluated.

The enabled warnings are `no-raw-colors`, `no-unknown-classes`, `require-static-classes`, and
`no-arbitrary-values`. The last rule exempts Tailwind's `layout` category for responsive geometry,
plus exactly `rounded-[inherit]`, `transition-[width]`, and `transition-[left,right,width]` for
component mechanics. `no-unknown-classes` exempts seven exact structural or debug hooks listed in
`eslint.design.config.mjs`; these hooks do not claim to generate Tailwind CSS.

The enabled rules currently produce no warnings and use no `eslint-disable` directives. The preview
theme declares the shared `destructive` and `input` roles. `TranscriptMessage.vue` exposes its four
literal corner classes to Tailwind and the linter. In this ESLint/Vue setup, HTML
`eslint-disable` comments do not suppress template diagnostics; a directive in `<script>` disables
a rule for the whole file.

`no-restyle` and `no-inline-styles` are entirely off in this trial; no files or components receive
partial enforcement. The full-rule trial reported 20 warnings from each. Before considering a
`no-restyle` contract, assess whether Composer's Textarea overrides, the panel settings Button's
spacing, and transcript typography belong in shared component variants or local Player components.
In this trial, authored content styles, virtualizer positions, and measured debug geometry remain
direct runtime values. The inline-style rule cannot exempt every unreadable dynamic object through
property or component contracts, so its warnings alone do not justify indirect CSS.

ESLint and its Vue/TypeScript parsers are needed because Oxlint cannot inspect Vue templates through
JavaScript plugins; the existing Oxlint check remains the normal repository lint. These pinned
packages run only during development checks and read local source/theme files, adding no browser
runtime code. Reassess parser compatibility, package audit results, and the trial's value before
making it a required check or carrying it into the selected Player.

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

The preview opens with choices. Visual Lab restarts that scenario or selects text/number/choice interaction;
transcript fixtures switch App back to local preview replies. Composer dimensions and height caps remain visual trials.

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
