# Player components

This is the Player implementation. Keep development fixtures separate from the components that own Player presentation.

## Design lint

The required [Player design lint](../../../docs/LINTING.md#player-design-lint) checks these Player components,
shared UI definitions and the story-button wrapper. `player/vue/components.json` selects `src/style.css` for utility
resolution; the component and theme boundaries remain defined by the Player implementation and its maintained UI
specification.

## Responsibility boundaries

- `PlayerApp.vue` composes the product Player from props and slots. It installs `usePlayerKeyboardFocus.ts`
  once, including for body-portaled controls; the [focus contract](../../../docs/ui/PLAYER-UI.md#input-growth-focus-and-keyboard-behavior)
  defines input modality and composer/Send focus.
- `usePlayerSession.ts` hosts the canonical adapter session for presentation: starting a session remounts the
  transcript and resets interaction-local state. Vue derives everything else from that session. Its
  `useRuntimeSceneClock.ts` maps browser time onto the session's scene time: it observes time at the next runtime
  deadline, before input (`RuntimeInteraction.vue` rejects input when the presented interaction changed), before a
  checkpoint capture, and on `visibilitychange`, `pagehide`, and `pageshow`; hidden pages keep running. Starting or
  restoring a session rebases the clock so no gap is consumed; see
  [timers and scene time](../../../docs/RUNTIME.md#timers-and-scene-time). The host prepares a new session for
  the explicit Start control (`SessionActivation.vue`) and creates it only on that click; a restored session waits for
  Continue. The host also owns the framework-independent `player/media-device.ts`: it reconciles the session's media
  projection onto `Audio` elements, reports loading through the adapter, and contributes measured progress to every
  clock observation, which runs every 100 ms while media loads or plays. With the camera capability, Start
  first opens the session camera (`player/session-camera.ts`) before the session is created; without it, the session
  starts within the click. Because some browsers (Safari) allow playback per element only from a user activation, which
  the session may outlive while a camera permission prompt is open, the host reuses released elements and, within a
  Start or Continue click that waits for the camera, plays silence on every spare one, ensuring at least two; elements
  allocated beyond the pool fall back to the refused-playback retry. In a Player that can capture or read stored
  photos, a save first stores the captured photos its value references (`player/captured-media-persistence.ts`);
  captured references resolve only through that trusted store, and authored
  media references only through the host-supplied `resolveAsset`. `PlayerApp.vue` derives the Stage image from
  runtime state and provides the same resolver to `TranscriptMessage.vue` for speaker avatars.
- `DevelopmentPreview.vue` opens one runtime choice scenario, with a Stage image and a short chime that
  `developmentMedia.ts` resolves, and supplies Visual Lab's Theme Lab, Stage media picker,
  and timer/background-button presentation fixtures, plus Layout Debug; `?scenario=camera` instead opens a camera
  scenario with persistent script storage that shows the saved photo again in a later run. `main.ts` loads it as a
  separate chunk on the development server, or in a build only with the `?dev` URL opt-in. The default build mounts `PlayerApp.vue` with the
  repository demo: `demoHost.ts` supplies its source and resolves its package-relative references to the package's
  SVG files and to sounds that `generatedAudio.ts` synthesizes.
- `PlayerToolsShell.vue` receives its tool list from the root and owns tool selection, pinning, order, resizing, retained content and dock/drawer focus.
  Its tool slot supplies content; its default slot supplies the Player. Closing a visited panel retains its content.
  Tool bodies scroll vertically; the outer carousel handles overflow between panels. Shared shadcn-vue/Reka
  `components/ui/scroll-area` supports per-location visibility without reserving width. The transcript currently
  reveals its thumb during scrolling or track hover; native textareas keep browser editing/scrolling. Visibility
  remains a visual trial.
- `usePlayerConditions.ts` owns the five independent Player conditions: horizontal and vertical space, touch/hover
  capability, raised keyboard, and composer edge clearance. The shell exposes these as `data-player-*` attributes;
  descendants consume the provided signals. Keep feature-specific fit calculations with their layout owner and use
  actual pointer events for hybrid mouse/touch interactions. See [Player conditions](../../../docs/ui/PLAYER-UI.md#player-conditions)
  before adding a responsive rule.
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
  including [pacing skips](../../../docs/ui/PLAYER-UI.md#composer-and-foreground-interactions), with shared
  submission guards and focus handling. The composer uses shadcn Textarea/Button and VueUse autosizing;
  foreground controls use `components/PlayerActionButton.vue` in the transcript's trailing slot.
  `playerRuntimeForeground` maps authored backgrounds from live/restored actions; `player/theme/story-choice.ts`
  supplies theme/authored button material. See [ADR 0018](../../../docs/decisions/0018-first-standard-library-poc-contract.md)
  for syntax and completion semantics.
- `usePlayerTheme.ts` applies/restores document variables; `player/theme` calculates colours and Theme Lab edits intent.
  See [theme evaluation](../../README.md#experimental-dynamic-theme-evaluation).
- `StageRightRail.vue` owns the right overlay rail and its viewport-centred control placement, `TimerRegion.vue` its
  timer collection and `TimerDisplay.vue` individual timers. `PlayerApp.vue` presents runtime timers in the rail; the
  development preview's fixture timers fill it only while no runtime timer is presented, and `BackgroundControlsFixture.vue` samples
  action, local-toggle and disabled states. The sample actions have no scripted handlers or canonical history; runtime
  background-control wiring remains separate work.

The development preview opens with one runtime choice scenario. Composer dimensions and height caps remain visual
trials.

Story-button ink and transcript readability follow the current Player treatment in
[Player UI](../../../docs/ui/PLAYER-UI.md); Visual Lab does not offer contrast-method switches.

Shared chrome geometry lives in `style.css`; the
[Player geometry contract](../../../docs/ui/PLAYER-UI.md#global-geometry-and-overflow) records dimensions and their tuning status.
Top controls, menu and tool headers share edge/control tokens. The menu width ruler avoids a second JavaScript formula;
its resize target shares right padding. The right rail derives top clearance from header height. Timer diameter and rail
width are selected separately from the shared space conditions, independently of root font size; no outside halo space
is reserved.

Component-specific presentation belongs with its component. Shared theme-token
mapping and overall composition remain in `style.css`. Do not change settled
behavior as part of a structural extraction. Provisional palette values and rail
policies are not permanent product contracts.
